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
 *     selection, metadata updates, usage updates), injected into the server's
 *     global hub so every client sees them next to the OpenCode events;
 *   - one-shot SDK queries that never enter history: `session.generate` (a
 *     transient text the caller asked for) and the best-effort title
 *     generation after a session's first prompt.
 *
 * Records are the wire shape the shared UI reads: `projectSession`
 * (packages/ui/src/lib/opencode/projection.ts) turns `location.directory` into
 * the domain `Session.directory`, and `projectID` is derived with the same
 * helper the projects runtime uses, so a Claude session groups into its
 * project exactly like an OpenCode one. A record carries the session's running
 * usage (`cost`, `tokens`): the SDK's cumulative cost is replaced, per-turn
 * token counts accumulate, and the result is persisted with the index.
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
import {
  CLAUDE_EFFORT_LEVELS,
  CLAUDE_PERMISSION_MODES,
  createRunnerFactory,
  defaultSpawnQuery,
  effortLevelOrNull,
  permissionModeOrDefault,
} from './runner.js';
import { createTranscript } from './transcript.js';
import { createTranslator } from './translator.js';

const BACKEND = 'claude';
const PROVIDER_ID = 'claude-code';
// The model aliases this backend accepts, in picker order. Mirrors the UI's
// static list (`CLAUDE_MODEL_ALIASES` in packages/ui/src/lib/sessionBackend.ts);
// the plain-JS server cannot import from packages/ui, so keep the two in sync.
const CLAUDE_MODEL_ALIASES = ['opus', 'sonnet', 'haiku', 'fable'];
const DEFAULT_CLAUDE_MODEL = 'opus';
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

/**
 * The metadata every Claude session carries, whatever the caller sent: the
 * backend marker is re-asserted, and the session's own selections under
 * `openchamber` are healed to their valid forms — a permission mode that was
 * stored heals to `'default'` when it is unknown, and an unknown effort level
 * is dropped. An absent mode is left absent: it reads as `'default'`
 * everywhere (`permissionModeOrDefault`), so a fresh record carries only the
 * selections its caller made. Applied on create, on every metadata merge, and
 * on load, so a stored record and a fresh one read the same.
 */
const withBackendMetadata = (metadata) => {
  const base = isPlainObject(metadata) ? metadata : {};
  const openchamber = isPlainObject(base.openchamber) ? base.openchamber : {};
  const next = { ...openchamber, backend: BACKEND };
  if (openchamber.permissionMode !== undefined) {
    next.permissionMode = permissionModeOrDefault(openchamber.permissionMode);
  }
  const effort = effortLevelOrNull(openchamber.effort);
  if (effort === null) delete next.effort;
  else next.effort = effort;
  return { ...base, openchamber: next };
};

const numberOr = (value, fallback) => (Number.isFinite(value) ? value : fallback);

// A fresh session has no usage yet; the wire record the UI projects requires
// cost and tokens (they are non-optional on its `Session`), so every record
// starts at zero and the SDK's results accumulate from there.
const zeroTokens = () => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });

/**
 * A stored `tokens` value in the runtime's own shape: every field a finite
 * number or 0, so a legacy or malformed entry reads like a fresh session's.
 */
const tokensFromStored = (value) => {
  const source = isPlainObject(value) ? value : {};
  const cache = isPlainObject(source.cache) ? source.cache : {};
  return {
    input: numberOr(source.input, 0),
    output: numberOr(source.output, 0),
    reasoning: numberOr(source.reasoning, 0),
    cache: { read: numberOr(cache.read, 0), write: numberOr(cache.write, 0) },
  };
};

/**
 * Token usage adds up per field across a session's turns; a result that names
 * no field adds zero. The cost of a Claude session is the SDK's own running
 * total (`total_cost_usd`), so it is replaced (see `onUsage`), never added.
 */
const accumulateTokens = (current, delta) => {
  const source = isPlainObject(delta) ? delta : {};
  const cache = isPlainObject(source.cache) ? source.cache : {};
  return {
    input: current.input + numberOr(source.input, 0),
    output: current.output + numberOr(source.output, 0),
    reasoning: current.reasoning + numberOr(source.reasoning, 0),
    cache: {
      read: current.cache.read + numberOr(cache.read, 0),
      write: current.cache.write + numberOr(cache.write, 0),
    },
  };
};

// A derived title is the first prompt's first line, collapsed and cut to this
// many characters (plus an ellipsis), so a sidebar entry stays readable. A
// model-generated title may run a little longer and is cut without one.
const TITLE_MAX_LENGTH = 60;
const GENERATED_TITLE_MAX_LENGTH = 80;
// One-shot queries never hold a request open forever: `session.generate`
// answers within 60 s, and the best-effort title generation gives up after
// 30 s and stays silent.
const GENERATE_TIMEOUT_MS = 60_000;
const TITLE_GENERATION_TIMEOUT_MS = 30_000;
// The title prompt carries the first user text cut to this many characters.
const TITLE_PROMPT_MAX_CHARS = 500;

/** The first non-empty line of `text`, trimmed and whitespace-collapsed, or `null` when there is none. */
const firstLineOf = (text) => {
  if (!isString(text)) return null;
  const firstLine = text.split('\n').map((line) => line.trim()).find((line) => line !== '');
  if (!firstLine) return null;
  return firstLine.replace(/\s+/g, ' ');
};

/**
 * The title a session takes from its first prompt: the first non-empty line,
 * cut to `TITLE_MAX_LENGTH` characters with `...` when longer. An all-blank
 * prompt derives nothing (`null`), so the title stays empty.
 */
const deriveTitleFromPrompt = (text) => {
  const line = firstLineOf(text);
  if (line === null) return null;
  return line.length > TITLE_MAX_LENGTH ? `${line.slice(0, TITLE_MAX_LENGTH)}...` : line;
};

/** The title a one-shot model query produced: the reply's first line, cut to `GENERATED_TITLE_MAX_LENGTH` characters. */
const generatedTitleFromText = (text) => {
  const line = firstLineOf(text);
  return line === null ? null : line.slice(0, GENERATED_TITLE_MAX_LENGTH);
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
 *   spawnQueryImpl?: (params: { prompt: string, options: object }) => object | Promise<object>,
 *     Test seam: the one-shot SDK `query()` spawn used by `session.generate`
 *     and generated titles, and passed to a runner factory this runtime
 *     builds. Defaults to the runner factory's own lazy SDK import.
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
  spawnQueryImpl = defaultSpawnQuery,
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
  // A runner factory this runtime builds spawns through the same one-shot
  // seam, so a test that fakes `spawnQueryImpl` fakes every SDK spawn.
  const runnerFactory = createRunnerFactoryImpl instanceof Function
    ? createRunnerFactoryImpl({ spawnQuery: spawnQueryImpl })
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
      cost: record.cost,
      tokens: record.tokens,
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
   * their canonical forms here, and the metadata's permission mode and effort
   * to theirs, so a legacy record reads like a fresh one.
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
      cost: numberOr(value.cost, 0),
      tokens: tokensFromStored(value.tokens),
      model: modelRefOf(value.model),
      claudeSessionUuid: isString(value.claudeSessionUuid) ? value.claudeSessionUuid : null,
      metadata: withBackendMetadata(value.metadata),
    };
    if (isString(value.agent) && value.agent !== '') record.agent = value.agent;
    return record;
  };

  /**
   * Loads the persisted index. A missing file is an empty registry; an
   * unreadable one throws, because starting empty would silently forget every
   * session and the next write would then overwrite the file. A record the
   * load healed (a legacy directory spelling, a foreign model, an unknown
   * permission mode or effort) makes the canonical index be written back, so
   * the file and the memory agree.
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
      cost: record.cost,
      tokens: { ...record.tokens, cache: { ...record.tokens.cache } },
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
      cost: 0,
      tokens: zeroTokens(),
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
  // One-shot queries
  // -------------------------------------------------------------------------

  /**
   * One one-shot SDK query: spawn it, read the `result` message's text, and
   * close it. The timeout covers the whole call — including the spawn, whose
   * late query is closed as soon as it resolves — and rejects with a clear
   * error, so no `claude` process outlives the call; the loser of the race
   * keeps a handler attached, so a late failure cannot surface as unhandled.
   */
  const runOneShotQuery = async ({ prompt, options, timeoutMs }) => {
    let query = null;
    const closeQuery = () => {
      try {
        query?.close?.();
      } catch {
        // The process may already be gone.
      }
    };
    let expired = false;
    let timer = null;
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        closeQuery();
        reject(new Error(`did not settle within ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
    });
    const collected = (async () => {
      query = await spawnQueryImpl({ prompt, options });
      // The timeout may have fired while the spawn was still starting; close
      // the late process so it cannot outlive the call.
      if (expired) {
        closeQuery();
        throw new Error(`did not settle within ${timeoutMs} ms`);
      }
      for await (const message of query) {
        if (message?.type === 'result') {
          // A success result carries the answer; `is_error: true` on it means
          // the turn ended on an API error and the same field holds the error
          // text, which must not be handed back as generated text.
          if (message.is_error !== true && isString(message.result)) return message.result;
          throw new Error('the Claude Code query failed before returning text');
        }
      }
      throw new Error('the Claude Code query ended before returning a result');
    })();
    void collected.catch(() => {});
    try {
      return await Promise.race([collected, timedOut]);
    } finally {
      clearTimeout(timer);
      closeQuery();
    }
  };

  /**
   * `session.generate`: one transient text in the session's context, run as a
   * single one-shot query and recorded nowhere — no runner, no transcript, no
   * wire event — so the text never enters history. The record's Claude
   * session id is resumed when there is one, so the generation sees the
   * session's past; the CLI path is resolved per call like the runner's.
   */
  const generate = async (sessionID, prompt) => {
    const record = requireRecord(sessionID);
    const cliPath = await resolveCli();
    const options = {
      cwd: record.directory,
      resume: record.claudeSessionUuid || undefined,
      maxTurns: 1,
      tools: [],
    };
    if (cliPath) options.pathToClaudeCodeExecutable = cliPath;
    try {
      return { text: await runOneShotQuery({ prompt, options, timeoutMs: GENERATE_TIMEOUT_MS }) };
    } catch (error) {
      throw new Error(`Claude Code generate failed: ${error?.message ?? error}`);
    }
  };

  /** The prompt a title generation sends: the instructions plus the user's own text. */
  const buildTitlePrompt = (text) =>
    `Reply with a title only: max 6 words, no quotes, no punctuation at the end, same language as the text. Text: ${text.slice(0, TITLE_PROMPT_MAX_CHARS)}`;

  /**
   * Fire-and-forget: ask a one-shot `haiku` query for a better title than the
   * prompt's first line, and apply it only while the record still carries the
   * derived title captured at send time — a user rename or a newer title
   * wins. Every failure is silent; the derived title stays.
   */
  const generateSessionTitle = async (record, derivedTitle, text) => {
    try {
      const result = await runOneShotQuery({
        prompt: buildTitlePrompt(text),
        options: { cwd: record.directory, maxTurns: 1, tools: [], model: 'haiku' },
        timeoutMs: TITLE_GENERATION_TIMEOUT_MS,
      });
      const title = generatedTitleFromText(result);
      if (title === null || record.title !== derivedTitle) return;
      await renameSession(record.id, title);
    } catch (error) {
      console.debug(`[claude-code] title generation failed for ${record.id}:`, error?.message ?? error);
    }
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

  /**
   * The session's permission mode: stored in the record's metadata through the
   * same merge semantics as any metadata write, and handed to a live runner
   * through the query's own `setPermissionMode` (streaming input mode supports
   * it). The live process is an optimization: the record is written first, so
   * a control-call failure still leaves the next runner on the new mode.
   */
  const setPermissionMode = async (sessionID, mode) => {
    if (!CLAUDE_PERMISSION_MODES.includes(mode)) {
      throw new TypeError(`unknown Claude permission mode: ${String(mode)}`);
    }
    await mergeSessionMetadata(sessionID, { openchamber: { permissionMode: mode } });
    const runner = runners.get(sessionID)?.runner;
    if (runner) await runner.setPermissionMode(mode).catch(() => {});
    return mode;
  };

  /**
   * The session's reasoning effort, stored like the permission mode. The
   * runner reads it when it is created (`buildOptions`), so a change applies
   * from the session's next runner — an idle reap or a restart — not to a live
   * one; `null` clears the selection.
   */
  const setEffort = async (sessionID, effort) => {
    if (effort !== null && !CLAUDE_EFFORT_LEVELS.includes(effort)) {
      throw new TypeError(`unknown Claude effort level: ${String(effort)}`);
    }
    await mergeSessionMetadata(sessionID, { openchamber: { effort } });
    return effort;
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
        // The mode is re-read on every runner creation and a live query can be
        // switched (`setPermissionMode`); effort is read here only, so a change
        // applies from the next runner. The metadata was healed on write and
        // on load; healing once more keeps the runner on a valid value even if
        // a record ever drifted.
        permissionMode: permissionModeOrDefault(record.metadata?.openchamber?.permissionMode),
        effort: effortLevelOrNull(record.metadata?.openchamber?.effort),
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
        onUsage: (usage) => {
          // The SDK's `total_cost_usd` is cumulative across the session's turns
          // and resumed queries, so the latest value replaces the record's; the
          // per-turn token counts add up.
          if (Number.isFinite(usage?.cost)) record.cost = usage.cost;
          record.tokens = accumulateTokens(record.tokens, usage?.tokens);
          void persistIndex().catch((error) => {
            console.warn(`[claude-code] could not persist usage for ${record.id}:`, error?.message ?? error);
          });
          emitWire(
            wireEvent('session.usage.updated', {
              sessionID: record.id,
              cost: record.cost,
              tokens: { ...record.tokens, cache: { ...record.tokens.cache } },
            }, record.directory),
            record,
          );
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
      if (title !== null) {
        await renameSession(record.id, title);
        // A model-written title beats the prompt's first line when it arrives;
        // it is best effort and loses to any later rename (see the helper).
        void generateSessionTitle(record, title, input.text);
      }
    }
    const messageID = isString(input.id) && input.id !== '' ? input.id : createMessageId();
    // v1 carries the text, the client-minted message id, the synthetic context
    // admitted since the last prompt, and the file attachments the route
    // validated; agent mentions, skills, metadata and delivery reach this
    // route but have no runner path yet and are dropped until a later task
    // adds them.
    const context = record.pendingContext ?? [];
    record.pendingContext = [];
    const send = { text: input.text, messageID };
    if (context.length > 0) send.context = context;
    if (Array.isArray(input.files) && input.files.length > 0) send.files = input.files;
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
    generate,
    synthetic,
    interrupt,
    switchModel,
    switchAgent,
    setPermissionMode,
    setEffort,
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
