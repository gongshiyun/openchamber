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

import { mergeMetadataPatch } from '../openchamber-sessions/session-metadata-store.js';
import { createProjectIdFromPath } from '../projects/project-id.js';
import { isPlainObject } from '../shared/guards.js';
import { resolveClaudeCliPath } from './cli-resolution.js';
import { createMessageId, createSessionId } from './ids.js';
import { createClaudeRoutes } from './routes.js';
import { createRunnerFactory } from './runner.js';
import { createTranscript } from './transcript.js';
import { createTranslator } from './translator.js';

const BACKEND = 'claude';
const PROVIDER_ID = 'claude-code';
const DEFAULT_MODEL_ID = 'opus';
// A fresh session has no usage yet; `session.created` carries the zeroes the
// UI's `Session` requires (cost and tokens are non-optional there).
const ZERO_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
// Session ids name transcript files, so an id that could escape the sessions
// directory (or name a file Windows rejects) is refused at the door.
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A stored model selection: this backend's provider id plus the alias. */
const modelRefOf = (model, fallbackId) => {
  const id = typeof model?.id === 'string' && model.id !== '' ? model.id : fallbackId;
  return {
    providerID: PROVIDER_ID,
    id,
    ...(typeof model?.variant === 'string' && model.variant !== '' ? { variant: model.variant } : {}),
  };
};

/** The metadata every Claude session carries, whatever the caller sent. */
const withBackendMetadata = (metadata) => {
  const base = isPlainObject(metadata) ? metadata : {};
  const openchamber = isPlainObject(base.openchamber) ? base.openchamber : {};
  return { ...base, openchamber: { ...openchamber, backend: BACKEND } };
};

const numberOr = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

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
  if (typeof dataDir !== 'string' || dataDir === '') {
    throw new TypeError('createClaudeCodeRuntime requires an instance data directory');
  }
  if (typeof eventHub?.injectEvent !== 'function') {
    throw new TypeError('createClaudeCodeRuntime requires an event hub with injectEvent');
  }

  const baseDir = path.join(dataDir, 'claude-code');
  const indexPath = path.join(baseDir, 'sessions.json');
  const sessionsDir = path.join(baseDir, 'sessions');
  const runnerFactory = typeof createRunnerFactoryImpl === 'function'
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

  const storedOf = (record) => ({
    directory: record.directory,
    projectID: record.projectID,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    model: record.model,
    claudeSessionUuid: record.claudeSessionUuid ?? null,
    metadata: record.metadata,
    ...(record.agent !== undefined ? { agent: record.agent } : {}),
  });

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
   * poisoning every later read.
   */
  const recordFromStored = (sessionID, value) => {
    const directory = typeof value.directory === 'string' ? value.directory : '';
    return {
      id: sessionID,
      directory,
      projectID: createProjectIdFromPath(directory),
      title: typeof value.title === 'string' ? value.title : '',
      createdAt: numberOr(value.createdAt, 0),
      updatedAt: numberOr(value.updatedAt, 0),
      model: modelRefOf(value.model, DEFAULT_MODEL_ID),
      claudeSessionUuid: typeof value.claudeSessionUuid === 'string' ? value.claudeSessionUuid : null,
      metadata: isPlainObject(value.metadata) ? value.metadata : {},
      ...(typeof value.agent === 'string' && value.agent !== '' ? { agent: value.agent } : {}),
    };
  };

  /**
   * Loads the persisted index. A missing file is an empty registry; an
   * unreadable one throws, because starting empty would silently forget every
   * session and the next write would then overwrite the file.
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
    for (const [sessionID, value] of Object.entries(parsed)) {
      // An id that could not have been created here (it would escape the
      // sessions directory) is not a session this runtime serves.
      if (!SESSION_ID_PATTERN.test(sessionID) || !isPlainObject(value)) continue;
      loaded.set(sessionID, recordFromStored(sessionID, value));
    }
    records.clear();
    for (const [sessionID, record] of loaded) records.set(sessionID, record);
  };

  // -------------------------------------------------------------------------
  // Records
  // -------------------------------------------------------------------------

  /** The wire record the UI projects; `location.directory` is the load-bearing field. */
  const wireRecord = (record) => ({
    id: record.id,
    projectID: record.projectID,
    location: { directory: record.directory },
    title: record.title,
    ...(record.agent !== undefined ? { agent: record.agent } : {}),
    model: { ...record.model },
    cost: 0,
    tokens: { ...ZERO_TOKENS, cache: { ...ZERO_TOKENS.cache } },
    time: { created: record.createdAt, updated: record.updatedAt },
    metadata: record.metadata,
  });

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
    if (typeof sessionID !== 'string' || !SESSION_ID_PATTERN.test(sessionID)) {
      throw new TypeError(`invalid Claude session id: ${String(sessionID)}`);
    }
    if (records.has(sessionID)) throw new Error(`Claude session ${sessionID} already exists`);

    const directory = typeof input.directory === 'string' ? input.directory : '';
    const createdAt = now();
    const record = {
      id: sessionID,
      directory,
      projectID: createProjectIdFromPath(directory),
      title: typeof input.title === 'string' ? input.title : '',
      createdAt,
      updatedAt: createdAt,
      model: modelRefOf(input.model, DEFAULT_MODEL_ID),
      claudeSessionUuid: null,
      metadata: withBackendMetadata(input.metadata),
      ...(typeof input.agent === 'string' && input.agent !== '' ? { agent: input.agent } : {}),
    };
    records.set(sessionID, record);
    await persistIndex();
    emitWire(
      wireEvent('session.created', {
        sessionID,
        projectID: record.projectID,
        location: { directory },
        title: record.title,
        ...(record.agent !== undefined ? { agent: record.agent } : {}),
        model: record.model,
        metadata: record.metadata,
      }, directory),
      record,
    );
    return wireRecord(record);
  };

  const renameSession = async (sessionID, title) => {
    const record = requireRecord(sessionID);
    if (typeof title !== 'string') throw new TypeError('a title is required to rename a Claude session');
    record.title = title;
    record.updatedAt = now();
    await persistIndex();
    emitWire(wireEvent('session.renamed', { sessionID, title }, record.directory), record);
  };

  const moveSession = async (sessionID, directory) => {
    const record = requireRecord(sessionID);
    if (typeof directory !== 'string' || directory === '') {
      throw new TypeError('a directory is required to move a Claude session');
    }
    record.directory = directory;
    record.projectID = createProjectIdFromPath(directory);
    record.updatedAt = now();
    await persistIndex();
    emitWire(
      wireEvent('session.moved', { sessionID, location: { directory }, projectID: record.projectID }, directory),
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
    if (typeof model?.id !== 'string' || model.id === '') {
      throw new TypeError('a model with an id is required to switch a Claude session');
    }
    const previous = { ...record.model };
    const next = modelRefOf(model, record.model.id);
    record.model = next;
    record.updatedAt = now();
    await persistIndex();
    if (model.providerID === PROVIDER_ID) {
      const runner = runners.get(sessionID)?.runner;
      // The live process is an optimization: the runner stores the alias
      // before it tells the SDK, so a control-call failure still leaves the
      // next turn on the new model.
      if (runner) await runner.setModel(next.id).catch(() => {});
    }
    emitWire(wireEvent('session.model.selected', { sessionID, model: next, previous }, record.directory), record);
  };

  const switchAgent = async (sessionID, agent) => {
    const record = requireRecord(sessionID);
    if (typeof agent !== 'string' || agent === '' || agent === record.agent) return;
    const previous = record.agent;
    record.agent = agent;
    record.updatedAt = now();
    await persistIndex();
    emitWire(wireEvent('session.agent.selected', { sessionID, agent, previous }, record.directory), record);
  };

  /**
   * The records the proxy's `GET /api/session` merge appends: wire records of
   * one directory (every directory when none is named), newest first by id,
   * filtered by a case-insensitive title substring and cut to `limit`.
   */
  const listSessionsForProxy = ({ directory, limit, search } = {}) => {
    const scoped = typeof directory === 'string' && directory !== '';
    const needle = typeof search === 'string' && search !== '' ? search.toLowerCase() : null;
    const size = Number.isInteger(limit) && limit > 0 ? limit : null;
    const matching = [];
    for (const record of records.values()) {
      if (scoped && record.directory !== directory) continue;
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

  const sendPrompt = async (sessionID, input = {}) => {
    const record = requireRecord(sessionID);
    const runner = await runnerEntryFor(record).promise;
    const messageID = typeof input.id === 'string' && input.id !== '' ? input.id : createMessageId();
    // v1 carries the text and the client-minted message id only. Files, agent
    // mentions, skills, metadata and delivery reach this route but have no
    // runner path yet; they are dropped until a later task adds them.
    await runner.send({ text: input.text, messageID });
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
    getSessionMetadata,
    mergeSessionMetadata,
    start,
    stop,
  };
}
