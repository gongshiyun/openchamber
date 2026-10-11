/**
 * Claude Code backend runtime: the composition root of the Claude sessions a
 * server serves.
 *
 * One instance owns everything a Claude session needs between HTTP requests:
 *
 *   - the session registry (`records`), the source of truth for what is a
 *     Claude session, persisted to `dataDir/claude-code/sessions.json` with an
 *     atomic write (temp file + rename) so a crash never tears the index;
 *   - per-session transcripts, one JSONL file per session under
 *     `dataDir/claude-code/sessions/` (transcript.js owns the format);
 *   - the live runners, one per session, built lazily on the first prompt and
 *     dropped when the runner idles out (`onIdle`) or the session is removed;
 *   - the OpenCode v2 route subset a Claude session serves (`routes.js`),
 *     mounted by the server ahead of the OpenCode proxy;
 *   - the wire events of the registry itself (`session.created`,
 *     `session.renamed`, `session.moved`, `session.deleted`, model/agent
 *     selection, metadata updates), injected into the server's global hub so
 *     every client sees them next to the OpenCode events.
 *
 * Records are the wire shape the shared UI reads: `projectSession`
 * (packages/ui/src/lib/opencode/projection.ts) turns `location.directory` into
 * the domain `Session.directory`, and `projectID` is derived with the same
 * helper the projects runtime uses, so a Claude session groups into its
 * project exactly like an OpenCode one.
 *
 * `getMessages` answers from the transcript and works without a runner: after
 * a restart the history is on disk, and a session only spawns a `claude`
 * process when it is prompted again.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { mergeMetadataPatch } from '../openchamber-sessions/session-metadata-store.js';
import { createProjectIdFromPath } from '../projects/project-id.js';
import { isPlainObject, isString } from '../shared/guards.js';
import { resolveClaudeCliPath } from './cli-resolution.js';
import { createMessageId, createSessionId } from './ids.js';
import { createClaudeRoutes } from './routes.js';
import { createRunnerFactory } from './runner.js';
import { createTranscript } from './transcript.js';
import { createTranslator } from './translator.js';

const BACKEND = 'claude';
const PROVIDER_ID = 'claude-code';
// The model aliases this backend accepts, in picker order. Mirrors the UI's
// static list (`CLAUDE_MODEL_ALIASES` in packages/ui/src/lib/sessionBackend.ts);
// the plain-JS server cannot import from packages/ui, so keep the two in sync.
const CLAUDE_MODEL_ALIASES = ['opus', 'sonnet', 'haiku', 'fable'];
const DEFAULT_CLAUDE_MODEL = 'opus';
// A fresh session has no usage yet; `session.created` carries the zeroes the
// UI's `Session` requires (cost and tokens are non-optional there).
const ZERO_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
// Session ids name transcript files, so an id that could escape the sessions
// directory (or name a file Windows rejects) is refused at the door.
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// A Windows drive root keeps its slash: `C:/` is absolute, `C:` is
// drive-relative. Mirrors the UI's own pattern in `pathNormalization.ts`.
const WINDOWS_DRIVE_ROOT = /^(?:\/\/\?\/)?[A-Za-z]:\/+$/u;

/**
 * A directory in the canonical form every OpenChamber surface compares:
 * trimmed, backslashes replaced with forward slashes, a lowercase drive
 * letter uppercased, and a trailing slash dropped (a root keeps its slash).
 * Mirrors `normalizePath` in packages/ui/src/lib/pathNormalization.ts: the
 * shared UI normalizes every directory this way, while the proxy's realpath
 * canonicalization yields backslashes on Windows, so the registry must store
 * and compare this form or a session never matches its own directory list.
 * Returns `null` for a value that names no directory (non-string, empty,
 * whitespace-only, or only slashes).
 */
const normalizeClaudeDirectory = (value) => {
  if (!isString(value)) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const replaced = trimmed
    .replace(/\\/g, '/')
    .replace(/^([a-z]):/, (_, letter) => `${letter.toUpperCase()}:`);
  if (replaced === '/') return '/';
  if (WINDOWS_DRIVE_ROOT.test(replaced)) return replaced.replace(/\/+$/u, '/');
  const stripped = replaced.length > 1 ? replaced.replace(/\/+$/, '') : replaced;
  return stripped || null;
};

/** True when the value names one of the Claude model aliases the UI offers. */
const isClaudeModelAlias = (value) => CLAUDE_MODEL_ALIASES.includes(value);

/**
 * The stored model selection: this backend's provider id plus a known alias.
 * Anything else — another provider, an unknown id — falls back to the default
 * alias, because a foreign id poisons the record and every later turn would
 * fail on a model the Claude CLI cannot resolve.
 */
const modelRefOf = (model) => {
  if (!isPlainObject(model) || model.providerID !== PROVIDER_ID || !isClaudeModelAlias(model.id)) {
    return { providerID: PROVIDER_ID, id: DEFAULT_CLAUDE_MODEL };
  }
  const ref = { providerID: PROVIDER_ID, id: model.id };
  if (isString(model.variant) && model.variant !== '') ref.variant = model.variant;
  return ref;
};

/** The metadata every Claude session carries, whatever the caller sent. */
const withBackendMetadata = (metadata) => {
  const base = isPlainObject(metadata) ? metadata : {};
  const openchamber = isPlainObject(base.openchamber) ? base.openchamber : {};
  return { ...base, openchamber: { ...openchamber, backend: BACKEND } };
};

const numberOr = (value, fallback) => (Number.isFinite(value) ? value : fallback);

// A derived title is the first prompt's first line, collapsed and cut to this
// many characters (plus an ellipsis), so a sidebar entry stays readable.
const TITLE_MAX_LENGTH = 60;

/**
 * The title a session takes from its first prompt: the first non-empty line,
 * trimmed and whitespace-collapsed, cut to `TITLE_MAX_LENGTH` characters with
 * `...` when longer. An all-blank prompt derives nothing (`null`), so the
 * title stays empty.
 */
const deriveTitleFromPrompt = (text) => {
  if (!isString(text)) return null;
  const firstLine = text.split('\n').map((line) => line.trim()).find((line) => line !== '');
  if (!firstLine) return null;
  const collapsed = firstLine.replace(/\s+/g, ' ');
  return collapsed.length > TITLE_MAX_LENGTH ? `${collapsed.slice(0, TITLE_MAX_LENGTH)}...` : collapsed;
};

/**
 * Build the Claude Code runtime for one instance data directory.
 *
 * @param {{
 *   dataDir: string, Absolute instance data directory; the runtime owns
 *     `claude-code/` inside it.
 *   eventHub: { injectEvent: (input: { payload: object, directory: string, spaceId: string | null }) => void },
 *     The server's global hub; every wire event goes through it.
 *   getSettings?: () => object | Promise<object>, Instance settings, read
 *     lazily per runner so a changed `claudeBinary` applies to the next
 *     session. May be sync or async.
 *   createRunnerFactoryImpl?: object | (() => object), Test seam: the runner
 *     factory (or a function building one). Defaults to `createRunnerFactory()`.
 *   resolveCliPath?: () => string | null | Promise<string | null>, Test seam
 *     for the CLI lookup. Defaults to `resolveClaudeCliPath` against
 *     `getSettings()`.
 *   now?: () => number,
 * }} deps
 * @returns {{
 *   router: object,
 *   isClaudeSession: (sessionID: string) => boolean,
 *   listSessionsForProxy: (query: { directory?: string, limit?: number, search?: string }) => object[],
 *   activeSessions: () => { [sessionID: string]: { type: 'running' } },
 *   getSessionMetadata: (sessionID: string) => object | null,
 *   mergeSessionMetadata: (sessionID: string, patch: object, options?: { directory?: string }) => Promise<object>,
 *   start: () => Promise<void>,
 *   stop: () => Promise<void>,
 * }}
 */
export function createClaudeCodeRuntime({
  dataDir,
  eventHub,
  getSettings,
  createRunnerFactoryImpl = createRunnerFactory,
  resolveCliPath,
  now = Date.now,
}) {
  if (!isString(dataDir) || dataDir === '') {
    throw new TypeError('createClaudeCodeRuntime requires an instance data directory');
  }
  if (!(eventHub?.injectEvent instanceof Function)) {
    throw new TypeError('createClaudeCodeRuntime requires an event hub with injectEvent');
  }

  const baseDir = path.join(dataDir, 'claude-code');
  const indexPath = path.join(baseDir, 'sessions.json');
  const sessionsDir = path.join(baseDir, 'sessions');
  const runnerFactory = createRunnerFactoryImpl instanceof Function
    ? createRunnerFactoryImpl()
    : createRunnerFactoryImpl;
  const resolveCli = resolveCliPath ?? (async () => resolveClaudeCliPath({ settings: await getSettings?.() }));

  /** sessionID -> stored record, the registry's source of truth. */
  const records = new Map();
  /** sessionID -> { transcript, loaded }, one memoized transcript per session. */
  const transcripts = new Map();
  /** sessionID -> { runner, promise }, one lazy runner per session. */
  const runners = new Map();
  /** Index writes run one at a time, so an older snapshot never lands last. */
  let writeChain = Promise.resolve();

  // -------------------------------------------------------------------------
  // Wire events
  // -------------------------------------------------------------------------

  const emitWire = (event, record) => {
    eventHub.injectEvent({
      payload: event,
      directory: event.location?.directory ?? record.directory,
      spaceId: null,
    });
  };

  const wireEvent = (type, data, directory) => ({
    id: createMessageId(),
    type,
    created: now(),
    data,
    location: { directory },
  });

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  const storedOf = (record) => {
    const stored = {
      directory: record.directory,
      projectID: record.projectID,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      model: record.model,
      claudeSessionUuid: record.claudeSessionUuid ?? null,
      metadata: record.metadata,
    };
    if (record.agent !== undefined) stored.agent = record.agent;
    return stored;
  };

  /**
   * Writes the index atomically: a temp file in the same directory, then a
   * rename. The snapshot is taken when the write is queued, and the queue
   * keeps writes in call order, so the last write always holds the newest
   * state.
   */
  const persistIndex = () => {
    const entries = {};
    for (const [sessionID, record] of records) entries[sessionID] = storedOf(record);
    const write = async () => {
      await fs.mkdir(baseDir, { recursive: true });
      const temporary = `${indexPath}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
        await fs.rename(temporary, indexPath);
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    };
    const next = writeChain.then(write, write);
    writeChain = next.then(() => undefined, () => undefined);
    return next;
  };

  /**
   * One persisted entry as a record. `directory` is authoritative, so
   * `projectID` is derived from it rather than trusted from the file; a field
   * that no longer has the right type falls back to its default instead of
   * poisoning every later read. The directory and the model are healed to
   * their canonical forms here, so a legacy record reads like a fresh one.
   */
  const recordFromStored = (sessionID, value) => {
    const directory = normalizeClaudeDirectory(value.directory) ?? '';
    const record = {
      id: sessionID,
      directory,
      projectID: createProjectIdFromPath(directory),
      title: isString(value.title) ? value.title : '',
      createdAt: numberOr(value.createdAt, 0),
      updatedAt: numberOr(value.updatedAt, 0),
      model: modelRefOf(value.model),
      claudeSessionUuid: isString(value.claudeSessionUuid) ? value.claudeSessionUuid : null,
      metadata: isPlainObject(value.metadata) ? value.metadata : {},
    };
    if (isString(value.agent) && value.agent !== '') record.agent = value.agent;
    return record;
  };

  /**
   * Loads the persisted index. A missing file is an empty registry; an
   * unreadable one throws, because starting empty would silently forget every
   * session and the next write would then overwrite the file. A record the
   * load healed (a legacy directory spelling, a foreign model) makes the
   * canonical index be written back, so the file and the memory agree.
   */
  const start = async () => {
    let raw;
    try {
      raw = await fs.readFile(indexPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Claude session index at ${indexPath} is unreadable: ${error?.message ?? error}`);
    }
    if (!isPlainObject(parsed)) {
      throw new Error(`Claude session index at ${indexPath} is not a JSON object`);
    }
    const loaded = new Map();
    let healed = false;
    for (const [sessionID, value] of Object.entries(parsed)) {
      // An id that could not have been created here (it would escape the
      // sessions directory) is not a session this runtime serves.
      if (!SESSION_ID_PATTERN.test(sessionID) || !isPlainObject(value)) continue;
      const record = recordFromStored(sessionID, value);
      loaded.set(sessionID, record);
      // The stored form a load writes back is the runtime's own; any entry
      // that differs from it was healed above and needs the rewrite.
      if (!isDeepStrictEqual(storedOf(record), value)) healed = true;
    }
    records.clear();
    for (const [sessionID, record] of loaded) records.set(sessionID, record);
    if (healed) await persistIndex();
  };

  // -------------------------------------------------------------------------
  // Records
  // -------------------------------------------------------------------------

  /** The wire record the UI projects; `location.directory` is the load-bearing field. */
  const wireRecord = (record) => {
    const wire = {
      id: record.id,
      projectID: record.projectID,
      location: { directory: record.directory },
      title: record.title,
      model: { ...record.model },
      cost: 0,
      tokens: { ...ZERO_TOKENS, cache: { ...ZERO_TOKENS.cache } },
      time: { created: record.createdAt, updated: record.updatedAt },
      metadata: record.metadata,
    };
    if (record.agent !== undefined) wire.agent = record.agent;
    return wire;
  };

  const requireRecord = (sessionID) => {
    const record = records.get(sessionID);
    if (!record) throw new Error(`Claude session ${sessionID} was not found`);
    return record;
  };

  const isClaudeSession = (sessionID) => records.has(sessionID);

  const getSession = (sessionID) => {
    const record = records.get(sessionID);
    return record ? wireRecord(record) : null;
  };

  const createSession = async (input = {}) => {
    const sessionID = input.id === undefined || input.id === '' ? createSessionId() : input.id;
    if (!isString(sessionID) || !SESSION_ID_PATTERN.test(sessionID)) {
      throw new TypeError(`invalid Claude session id: ${String(sessionID)}`);
    }
    if (records.has(sessionID)) throw new Error(`Claude session ${sessionID} already exists`);

    const directory = normalizeClaudeDirectory(input.directory) ?? '';
    const createdAt = now();
    const record = {
      id: sessionID,
      directory,
      projectID: createProjectIdFromPath(directory),
      title: isString(input.title) ? input.title : '',
      createdAt,
      updatedAt: createdAt,
      model: modelRefOf(input.model),
      claudeSessionUuid: null,
      metadata: withBackendMetadata(input.metadata),
    };
    if (isString(input.agent) && input.agent !== '') record.agent = input.agent;
    records.set(sessionID, record);
    await persistIndex();
    const created = {
      sessionID,
      projectID: record.projectID,
      location: { directory: record.directory },
      title: record.title,
      model: record.model,
      metadata: record.metadata,
    };
    if (record.agent !== undefined) created.agent = record.agent;
    emitWire(
      wireEvent('session.created', created, record.directory),
      record,
    );
    return wireRecord(record);
  };

  const renameSession = async (sessionID, title) => {
    const record = requireRecord(sessionID);
    if (!isString(title)) throw new TypeError('a title is required to rename a Claude session');
    record.title = title;
    record.updatedAt = now();
    await persistIndex();
    emitWire(wireEvent('session.renamed', { sessionID, title }, record.directory), record);
  };

  const moveSession = async (sessionID, directory) => {
    const record = requireRecord(sessionID);
    const normalized = normalizeClaudeDirectory(directory);
    if (normalized === null) {
      throw new TypeError('a directory is required to move a Claude session');
    }
    record.directory = normalized;
    record.projectID = createProjectIdFromPath(normalized);
    record.updatedAt = now();
    await persistIndex();
    emitWire(
      wireEvent('session.moved', { sessionID, location: { directory: normalized }, projectID: record.projectID }, normalized),
      record,
    );
  };

  const removeSession = async (sessionID) => {
    const record = requireRecord(sessionID);

    const entry = runners.get(sessionID);
    runners.delete(sessionID);
    if (entry) {
      const runner = entry.runner ?? await entry.promise.catch(() => null);
      await runner?.dispose();
    }

    // Close and drain the transcript before deleting its file: a queued
    // append must not recreate the file after the removal.
    const transcriptEntry = transcripts.get(sessionID);
    transcripts.delete(sessionID);
    if (transcriptEntry) {
      const transcript = await transcriptEntry.loaded.catch(() => null);
      if (transcript) {
        transcript.close();
        await transcript.flush().catch(() => {});
      }
    }
    await fs.rm(path.join(sessionsDir, `${sessionID}.jsonl`), { force: true });

    records.delete(sessionID);
    await persistIndex();
    emitWire(wireEvent('session.deleted', { sessionID }, record.directory), record);
  };

  const switchModel = async (sessionID, model) => {
    const record = requireRecord(sessionID);
    // Only this backend's own aliases are switchable: a foreign provider or an
    // unknown id would poison the record and every later turn would fail on a
    // model the Claude CLI cannot resolve. The selection is ignored (the route
    // still answers 204), so the record keeps the last valid alias.
    if (!isPlainObject(model) || model.providerID !== PROVIDER_ID || !isClaudeModelAlias(model.id)) {
      console.warn(`[claude-code] ignored a model switch for ${sessionID}: only ${PROVIDER_ID} aliases (${CLAUDE_MODEL_ALIASES.join(', ')}) are accepted`);
      return;
    }
    const previous = { ...record.model };
    const next = modelRefOf(model);
    record.model = next;
    record.updatedAt = now();
    await persistIndex();
    const runner = runners.get(sessionID)?.runner;
    // The live process is an optimization: the runner stores the alias
    // before it tells the SDK, so a control-call failure still leaves the
    // next turn on the new model.
    if (runner) await runner.setModel(next.id).catch(() => {});
    emitWire(wireEvent('session.model.selected', { sessionID, model: next, previous }, record.directory), record);
  };

  const switchAgent = async (sessionID, agent) => {
    const record = requireRecord(sessionID);
    if (!isString(agent) || agent === '' || agent === record.agent) return;
    const previous = record.agent;
    record.agent = agent;
    record.updatedAt = now();
    await persistIndex();
    emitWire(wireEvent('session.agent.selected', { sessionID, agent, previous }, record.directory), record);
  };

  /**
   * The records the proxy's `GET /api/session` merge appends: wire records of
   * one directory (every directory when none is named), newest first by id,
   * filtered by a case-insensitive title substring and cut to `limit`. The
   * query directory arrives as the proxy canonicalized it (a realpath, so
   * backslashes on Windows) while records are stored canonically, so both
   * sides are compared in the UI's canonical form.
   */
  const listSessionsForProxy = ({ directory, limit, search } = {}) => {
    const normalized = normalizeClaudeDirectory(directory);
    const scoped = normalized !== null;
    const needle = isString(search) && search !== '' ? search.toLowerCase() : null;
    const size = Number.isInteger(limit) && limit > 0 ? limit : null;
    const matching = [];
    for (const record of records.values()) {
      if (scoped && normalizeClaudeDirectory(record.directory) !== normalized) continue;
      if (needle && !record.title.toLowerCase().includes(needle)) continue;
      matching.push(record);
    }
    // Ids are time-sortable, so descending id order is newest first.
    matching.sort((a, b) => {
      if (a.id === b.id) return 0;
      return a.id > b.id ? -1 : 1;
    });
    return (size ? matching.slice(0, size) : matching).map(wireRecord);
  };

  // -------------------------------------------------------------------------
  // OpenChamber metadata
  // -------------------------------------------------------------------------

  const getSessionMetadata = (sessionID) => {
    const record = records.get(sessionID);
    return record ? { ...record.metadata } : null;
  };

  /**
   * Applies a JSON Merge Patch (RFC 7386) to the stored record and returns the
   * full merged metadata, the same semantics `session-metadata-store.js` gives
   * an OpenCode session. The backend marker is re-asserted after the merge: a
   * patch may not turn a Claude session into anything else. `directory` is
   * accepted for call-shape parity with that store; a Claude session is found
   * by id alone.
   */
  const mergeSessionMetadata = async (sessionID, patch, { directory } = {}) => {
    const record = requireRecord(sessionID);
    if (!isPlainObject(patch)) throw new TypeError('a session metadata patch must be an object');
    const metadata = withBackendMetadata(mergeMetadataPatch(record.metadata, patch));
    record.metadata = metadata;
    await persistIndex();
    emitWire(wireEvent('session.metadata.updated', { sessionID, metadata }, record.directory), record);
    return metadata;
  };

  // -------------------------------------------------------------------------
  // Transcripts and runners
  // -------------------------------------------------------------------------

  /**
   * The session's transcript, loaded from its JSONL before first use. A load
   * failure is not memoized: the next call retries, like the transcript's own
   * failed writes.
   */
  const transcriptFor = (record) => {
    let entry = transcripts.get(record.id);
    if (!entry) {
      const transcript = createTranscript({
        sessionID: record.id,
        directory: record.directory,
        filePath: path.join(sessionsDir, `${record.id}.jsonl`),
      });
      entry = { transcript, loaded: transcript.load() };
      entry.loaded = entry.loaded.catch((error) => {
        if (transcripts.get(record.id) === entry) transcripts.delete(record.id);
        throw error;
      });
      transcripts.set(record.id, entry);
    }
    return entry.loaded.then(() => entry.transcript);
  };

  /**
   * The session's runner, created on first use and memoized as a promise so
   * two concurrent prompts cannot spawn two `claude` processes for one session.
   * The CLI path is resolved here, not at construction, so a settings change
   * applies to the next session without a restart.
   */
  const runnerEntryFor = (record) => {
    let entry = runners.get(record.id);
    if (entry) return entry;
    entry = { runner: null, promise: null };
    entry.promise = (async () => {
      const transcript = await transcriptFor(record);
      const cliPath = await resolveCli();
      // The model is canonicalized on every write and on load; healing once
      // more keeps the runner on an alias even if a record ever drifted.
      const model = modelRefOf(record.model);
      if (model.providerID !== record.model?.providerID || model.id !== record.model?.id) {
        record.model = model;
      }
      const runner = runnerFactory.createRunner({
        sessionID: record.id,
        directory: record.directory,
        cwd: record.directory,
        model: record.model.id,
        claudeSessionUuid: record.claudeSessionUuid,
        cliPath,
        transcript,
        translator: createTranslator({ sessionID: record.id, directory: record.directory }),
        emit: (event) => emitWire(event, record),
        onSessionId: (claudeSessionUuid) => {
          if (record.claudeSessionUuid === claudeSessionUuid) return;
          record.claudeSessionUuid = claudeSessionUuid;
          void persistIndex().catch((error) => {
            console.warn(`[claude-code] could not persist the Claude session id for ${record.id}:`, error?.message ?? error);
          });
        },
        onIdle: () => {
          if (runners.get(record.id) === entry) runners.delete(record.id);
        },
      });
      entry.runner = runner;
      return runner;
    })();
    entry.promise = entry.promise.catch((error) => {
      if (runners.get(record.id) === entry) runners.delete(record.id);
      throw error;
    });
    runners.set(record.id, entry);
    return entry;
  };

  /**
   * The live sessions with a turn in flight, in the shape `GET /api/session/active`
   * serves: `{ [sessionID]: { type: 'running' } }`. Only runners that already
   * exist are asked — this read never creates one.
   */
  const activeSessions = () => {
    const active = {};
    for (const [sessionID, entry] of runners) {
      if (entry.runner?.isBusy?.() === true) active[sessionID] = { type: 'running' };
    }
    return active;
  };

  /**
   * Records one synthetic context message, publishes it as the wire event the
   * UI projects into a context block, and keeps its text for the next prompt.
   * OpenCode delivers synthetic messages as context messages of their own
   * ahead of a turn; v1 folds the pending texts into the next user turn (see
   * `sendPrompt`), so nothing starts a turn here. `delivery` and `resume` from
   * the payload are ignored for the same reason.
   */
  const synthetic = async (sessionID, input = {}) => {
    const record = requireRecord(sessionID);
    const text = isString(input.text) ? input.text : '';
    const messageID = isString(input.id) && input.id !== '' ? input.id : createMessageId();
    const transcript = await transcriptFor(record);
    transcript.beginSyntheticMessage({
      messageID,
      text,
      description: input.description,
      metadata: input.metadata,
    });
    (record.pendingContext ??= []).push(text);
    // The event data carries the same fields the transcript record kept.
    const data = { sessionID, text };
    if (isString(input.description)) data.description = input.description;
    if (isPlainObject(input.metadata)) data.metadata = input.metadata;
    emitWire(
      {
        // The UI derives the message id from the envelope (`messageIdFromEvent`
        // in packages/ui/src/lib/opencode/events.ts`), so the event id is the
        // message id in the event id space.
        id: messageID.replace(/^msg_/, 'evt_'),
        type: 'session.synthetic',
        created: now(),
        data,
        location: { directory: record.directory },
      },
      record,
    );
    return transcript.getRecord(messageID)?.info ?? null;
  };

  const sendPrompt = async (sessionID, input = {}) => {
    const record = requireRecord(sessionID);
    const runner = await runnerEntryFor(record).promise;
    // The first prompt with text names the session, like OpenCode's own
    // auto-titling; a title already set (by that prompt, a rename, or the
    // create) is never overwritten. The rename is synchronous up to its
    // persistence, so two concurrent first prompts cannot both name it.
    if (record.title.trim() === '') {
      const title = deriveTitleFromPrompt(input.text);
      if (title !== null) await renameSession(record.id, title);
    }
    const messageID = isString(input.id) && input.id !== '' ? input.id : createMessageId();
    // v1 carries the text, the client-minted message id, and the synthetic
    // context admitted since the last prompt. Files, agent mentions, skills,
    // metadata and delivery reach this route but have no runner path yet;
    // they are dropped until a later task adds them.
    const context = record.pendingContext ?? [];
    record.pendingContext = [];
    const send = { text: input.text, messageID };
    if (context.length > 0) send.context = context;
    await runner.send(send);
    return { id: messageID };
  };

  const interrupt = async (sessionID) => {
    const entry = runners.get(sessionID);
    if (!entry) return false;
    const runner = entry.runner ?? await entry.promise.catch(() => null);
    if (!runner) return false;
    await runner.interrupt();
    return true;
  };

  const replyPermission = (sessionID, requestID, decision) => {
    const runner = runners.get(sessionID)?.runner;
    if (!runner) return false;
    return runner.resolvePermission(requestID, decision) === true;
  };

  const getMessages = async (sessionID, query = {}) => {
    const record = requireRecord(sessionID);
    const transcript = await transcriptFor(record);
    const page = transcript.listRecords({ limit: query.limit, cursor: query.cursor, order: query.order });
    return { data: page.items.map((item) => item.info), cursor: { next: page.next } };
  };

  // -------------------------------------------------------------------------
  // Lifecycle and surface
  // -------------------------------------------------------------------------

  /** Disposes every live runner and drains index writes still in flight. */
  const stop = async () => {
    const entries = [...runners.values()];
    runners.clear();
    await Promise.all(entries.map(async (entry) => {
      const runner = entry.runner ?? await entry.promise.catch(() => null);
      await runner?.dispose();
    }));
    await writeChain;
  };

  const registry = {
    isClaudeSession,
    createSession,
    getSession,
    renameSession,
    removeSession,
    moveSession,
    sendPrompt,
    synthetic,
    interrupt,
    switchModel,
    switchAgent,
    getMessages,
    replyPermission,
  };

  return {
    router: createClaudeRoutes({ registry }),
    isClaudeSession,
    listSessionsForProxy,
    activeSessions,
    getSessionMetadata,
    mergeSessionMetadata,
    start,
    stop,
  };
}
