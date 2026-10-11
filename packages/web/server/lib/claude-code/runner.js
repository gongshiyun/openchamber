// Claude Code session runner: one live Agent SDK `query()` per session.
//
// The runner is the live half of a Claude session. The registry (index.js)
// creates one runner per session; it keeps a single streaming-input `query()`
// alive across turns, feeds prompts in as they are sent, maps the SDK message
// stream through translator.js, persists every wire event through the session
// transcript, and publishes them through the injected `emit` callback.
//
// One turn: `send()` starts the query on first use, begins a translator turn
// (`session.execution.started`), records the user message, and pushes it into
// the SDK input queue. The turn settles on the SDK `result` message (success
// or failure), on an interrupt (`session.execution.interrupted`), or on a
// transport failure (`session.execution.failed`). A prompt sent while a turn
// runs waits in a FIFO and starts the next turn, so the translator always
// owns exactly one open turn.
//
// Permissions: the SDK calls `canUseTool` before each tool execution. The
// runner mints a `per_...` id, emits `permission.asked` in the wire shape the
// shared UI already renders, and parks the call until `resolvePermission`
// answers. `once` allows the call; `always` allows it and remembers the tool
// name for the session (the SDK's suggestions are passed back as
// `updatedPermissions` so the CLI remembers too); `reject` denies with
// "Rejected by the user". An aborted signal (interrupted turn) or a disposed
// session answers with a deny so no call stays parked; a call that stays
// unanswered for `permissionParkMaxMs` is denied with "Permission request
// timed out" and reported, so a forgotten prompt cannot park the turn forever.
// Each parked request is kept in the wire shape so a client that reloads while
// it waits can find it again (`pendingPermissionRequests`), and it leaves the
// map the moment the request settles.
// The session's mode travels in `options.permissionMode` (the registry reads
// it from the record) and a live query can be switched with
// `setPermissionMode`; `options.effort` is read when the runner is created.
//
// Interrupt: `interrupt()` asks the SDK to stop and settles the turn from the
// next result or stream end. The SDK is expected to settle within
// INTERRUPT_SETTLE_MS; when it does not, the runner settles the turn itself so
// the session does not stay busy forever.
//
// Idle: the idle timer resets on send, on every SDK message, and on permission
// activity. On fire the runner settles an open turn as interrupted, disposes
// itself, and reports to `onIdle` so the registry can drop it. A turn parked
// on a permission request is waiting on the user, not idle: the fire resets
// the window and keeps the runner alive instead. The next prompt resumes the
// Claude session through `resume`.
//
// Usage: a turn that settles from an SDK `result` carries the session's
// running `total_cost_usd` and the turn's token `usage`; the runner reports
// them through `onUsage` so the registry can keep the session's totals. Abort
// and transport-failure paths carry no usage and report none.
//
// SDK facts assumed here, verified against @anthropic-ai/claude-agent-sdk
// 0.3.296 types (re-verify when the dependency lands, Task 10/12):
//   - `query({ prompt, options })` returns an AsyncGenerator of SDK messages
//     with `interrupt()`, `setModel(model?)`, `setPermissionMode(mode)` and
//     `close()`; `prompt` may be an AsyncIterable of user messages (streaming
//     input). `setPermissionMode` is only available in streaming input mode,
//     which the runner uses.
//   - Streaming input messages are `{ type: 'user', message: { role: 'user',
//     content }, parent_tool_use_id: null }`, where `content` is a string or
//     an array of Messages API content blocks (text, image, ...).
//   - `options.permissionMode` is the SDK's `PermissionMode` union;
//     `'bypassPermissions'` also requires `allowDangerouslySkipPermissions:
//     true`. `options.effort` is `'low' | 'medium' | 'high' | 'xhigh' | 'max'`.
//   - `canUseTool(toolName, input, { signal, suggestions, toolUseID, title })`
//     resolves `{ behavior: 'allow', updatedPermissions? }` or
//     `{ behavior: 'deny', message }`.
//   - Messages carry `session_id`; a `system`/`init` message opens the stream.

import { isString } from '../shared/guards.js';
import { createMessageId } from './ids.js';

const DEFAULT_IDLE_MS = 15 * 60 * 1000;
// How long an interrupted turn may take to settle before the runner settles it
// locally. A control request that never completes (or a stream that never
// ends) must not leave the session busy forever.
const INTERRUPT_SETTLE_MS = 10_000;
// A parked permission request the user never answers would hold its turn (and
// its child process) open forever; the safety net denies it after this long.
const DEFAULT_PERMISSION_PARK_MAX_MS = 30 * 60 * 1000;

// The SDK permission modes v1 accepts. Mirrors the SDK's `PermissionMode`
// union minus `plan`/`dontAsk`/`auto`; `index.js` stores the selection and
// `routes.js` validates the request against this list.
export const CLAUDE_PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions'];
// The SDK's `EffortLevel` union, the values a session's effort may take.
export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_PERMISSION_MODE = 'default';

/** The stored/requested permission mode when it is one of v1's, else the default. */
export const permissionModeOrDefault = (value) =>
  (CLAUDE_PERMISSION_MODES.includes(value) ? value : DEFAULT_PERMISSION_MODE);

/** The stored/requested effort level when it is one of the SDK's, else `null` (none). */
export const effortLevelOrNull = (value) =>
  (CLAUDE_EFFORT_LEVELS.includes(value) ? value : null);

// One text attachment is folded into the turn at this decoded size; past it
// the text is cut and a truncation marker appended.
const TEXT_ATTACHMENT_MAX_BYTES = 256 * 1024;
const TEXT_ATTACHMENT_TRUNCATION = '\n[Attachment truncated at 256 KB]';
// The base64 payloads one turn's attachments may carry in total.
const ATTACHMENT_PAYLOAD_MAX_BYTES = 5 * 1024 * 1024;

const PERMISSION_ID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const PERMISSION_ID_LENGTH = 22;

/** `per_` + 22 base62 characters, the id shape OpenCode v2 uses for requests. */
const defaultPermissionId = () => {
  const bytes = new Uint8Array(PERMISSION_ID_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  let id = 'per_';
  for (let index = 0; index < PERMISSION_ID_LENGTH; index += 1) {
    id += PERMISSION_ID_CHARS[bytes[index] % PERMISSION_ID_CHARS.length];
  }
  return id;
};

// Input keys that name what a tool call targets, most specific first. The
// shared UI reads `resources` as the request's targets (permissionSummary.ts).
const TARGET_KEYS = ['command', 'file_path', 'notebook_path', 'url', 'pattern', 'query'];

const permissionResources = (input) => {
  for (const key of TARGET_KEYS) {
    const value = input?.[key];
    if (value) return [String(value)];
  }
  return [];
};

const permissionMessage = (toolName, resources, title) => {
  if (title) return title;
  const target = resources[0];
  return target ? `Claude wants to use ${toolName}: ${target}` : `Claude wants to use ${toolName}`;
};

const permissionResult = (decision, suggestions) => {
  if (decision === 'reject') return { behavior: 'deny', message: 'Rejected by the user' };
  if (decision === 'always' && suggestions?.length > 0) {
    return { behavior: 'allow', updatedPermissions: suggestions };
  }
  return { behavior: 'allow' };
};

const errorMessage = (error) => {
  if (error?.message) return String(error.message);
  if (error) return String(error);
  return 'Claude Code run failed';
};

/**
 * The content of the one user turn v1 sends. OpenCode delivers synthetic
 * messages as context messages of their own ahead of a prompt; v1 folds their
 * texts into the turn ahead of the user's, separated by blank lines.
 */
const promptContent = (text, context) => {
  if (!Array.isArray(context) || context.length === 0) return text;
  return `${context.join('\n\n')}\n\n${text}`;
};

/**
 * A `data:` URI split into its mime type and base64 payload. The shared UI
 * encodes every attachment that way (`toPromptFile` in
 * `packages/ui/src/lib/opencode/client.ts`); anything else — a non-string, a
 * URI without a comma, a non-base64 encoding — returns `null` and the caller
 * reports it as skipped.
 */
const parseDataUri = (uri) => {
  if (!isString(uri) || !uri.startsWith('data:')) return null;
  const comma = uri.indexOf(',');
  if (comma === -1) return null;
  const parts = uri.slice('data:'.length, comma).split(';');
  if (!parts.slice(1).some((part) => part.trim().toLowerCase() === 'base64')) return null;
  return {
    mime: parts[0].trim().toLowerCase() || 'application/octet-stream',
    payload: uri.slice(comma + 1),
  };
};

/** The mime types whose attachments are inlined as decoded text. */
const isTextLikeMime = (mime) =>
  mime.startsWith('text/')
  || mime === 'application/json'
  || mime === 'application/xml'
  || mime === 'application/yaml'
  || mime === 'application/x-yaml'
  || mime.endsWith('+json')
  || mime.endsWith('+xml');

/** The name an attachment is reported under; the shared UI always sends one. */
const attachmentName = (file, index) =>
  (isString(file?.name) && file.name !== '' ? file.name : `attachment ${index + 1}`);

/**
 * The SDK user-message content of one turn. Without files it stays the plain
 * string v1 always sent; with files it becomes Messages API blocks: the text
 * (synthetic context folded in) first when the turn has any, then one block
 * per attachment.
 *
 *   - `image/*` travels as a base64 image block.
 *   - A text-like file is decoded to UTF-8 behind a `[File: <name>]` header,
 *     cut at TEXT_ATTACHMENT_MAX_BYTES with a truncation marker.
 *   - Anything else — an unparsable data URI, another mime type, and every
 *     file once the turn's base64 payloads pass ATTACHMENT_PAYLOAD_MAX_BYTES —
 *     is skipped with a warning and named in an `[Attachment skipped: ...]`
 *     text block, so the model knows something was dropped.
 */
const buildPromptContent = (text, context, files) => {
  const body = promptContent(text, context);
  if (!Array.isArray(files) || files.length === 0) return body;
  const blocks = [];
  // A file-only prompt is a valid send (the shared UI allows it), and an
  // empty text block is not, so the text block is omitted when there is none.
  if (body !== '') blocks.push({ type: 'text', text: body });
  let carriedPayload = 0;
  let overPayloadCap = false;
  files.forEach((file, index) => {
    const name = attachmentName(file, index);
    const parsed = parseDataUri(file?.uri);
    const skip = (mime) => {
      console.warn(`[claude-code] skipped attachment ${name} (${mime})`);
      blocks.push({ type: 'text', text: `[Attachment skipped: ${name} (${mime})]` });
    };
    if (!parsed) {
      skip('unknown');
      return;
    }
    if (overPayloadCap || carriedPayload + parsed.payload.length > ATTACHMENT_PAYLOAD_MAX_BYTES) {
      overPayloadCap = true;
      skip(parsed.mime);
      return;
    }
    if (parsed.mime.startsWith('image/')) {
      carriedPayload += parsed.payload.length;
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: parsed.mime, data: parsed.payload },
      });
      return;
    }
    if (isTextLikeMime(parsed.mime)) {
      carriedPayload += parsed.payload.length;
      const buffer = Buffer.from(parsed.payload, 'base64');
      const decoded = buffer.subarray(0, TEXT_ATTACHMENT_MAX_BYTES).toString('utf8');
      const truncated = buffer.length > TEXT_ATTACHMENT_MAX_BYTES ? TEXT_ATTACHMENT_TRUNCATION : '';
      blocks.push({ type: 'text', text: `[File: ${name}]\n${decoded}${truncated}` });
      return;
    }
    skip(parsed.mime);
  });
  return blocks;
};

/** Push-based async iterable: the SDK pulls user messages as they are sent. */
const createInputQueue = () => {
  const values = [];
  let wake = null;
  let closed = false;

  const take = () => {
    if (values.length > 0) return { value: values.shift(), done: false };
    return { value: undefined, done: true };
  };

  const next = () => {
    if (values.length > 0 || closed) return Promise.resolve(take());
    return new Promise((resolve) => {
      wake = resolve;
    }).then(take);
  };

  return {
    push(value) {
      if (closed) return;
      if (wake) {
        const resume = wake;
        wake = null;
        values.push(value);
        resume();
        return;
      }
      values.push(value);
    },
    close() {
      if (closed) return;
      closed = true;
      if (wake) {
        const resume = wake;
        wake = null;
        resume();
      }
    },
    [Symbol.asyncIterator]() {
      return { next };
    },
  };
};

/**
 * The production `spawnQuery`: the Agent SDK is imported lazily, so a process
 * that never prompts a Claude session never loads it. Exported so the
 * runtime's one-shot callers (`session.generate`, generated titles) spawn
 * through the same import the runner factory defaults to.
 *
 * @param {{ prompt: AsyncIterable<object> | string, options: object }} params
 */
export const defaultSpawnQuery = async (params) => {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  return query(params);
};

/**
 * Build a factory for per-session Claude runners.
 *
 * `spawnQuery` defaults to a lazy dynamic import of the Agent SDK `query()`;
 * tests inject a fake and production wiring may inject the import explicitly.
 *
 * @param {{
 *   spawnQuery?: (params: { prompt: AsyncIterable<object> | string, options: object }) => object | Promise<object>,
 *   createPermissionId?: () => string,
 *   idleMs?: number,
 *   permissionParkMaxMs?: number,
 *   now?: () => number,
 * }} [options]
 */
export function createRunnerFactory({
  spawnQuery = defaultSpawnQuery,
  createPermissionId = defaultPermissionId,
  idleMs = DEFAULT_IDLE_MS,
  permissionParkMaxMs = DEFAULT_PERMISSION_PARK_MAX_MS,
  now = Date.now,
} = {}) {
  const createRunner = (session) => {
    const { sessionID, directory, transcript, translator, emit, onSessionId, onIdle, onUsage } = session;
    const cwd = session.cwd ? session.cwd : directory;

    const state = {
      input: createInputQueue(),
      query: null,
      model: session.model ?? null,
      // The mode a query starts on and the live query is switched to; an
      // unknown value heals to the default. Effort is read once, here, so a
      // change applies from the next runner — unlike the permission mode.
      permissionMode: permissionModeOrDefault(session.permissionMode),
      effort: effortLevelOrNull(session.effort),
      claudeSessionUuid: session.claudeSessionUuid ?? null,
      reportedSessionId: null,
      assistantMessageID: null,
      // Results the SDK still owes: one per turn pushed into the input queue.
      // A force-settled interrupt leaves its result outstanding, so the count
      // tells a late result apart from the running turn's own.
      outstandingResults: 0,
      busy: false,
      awaitingResult: false,
      interruptPending: false,
      disposed: false,
    };
    const pendingSends = [];
    const pendingPermissions = new Map();
    const alwaysAllowed = new Set();
    let idleTimer = null;
    let interruptTimer = null;

    // The translator reports the model alias on each step; seed it with the
    // session's selection so the first turn already carries it.
    if (state.model) translator.setModel(state.model);

    // -----------------------------------------------------------------------
    // Event plumbing
    // -----------------------------------------------------------------------

    const wire = (type, data) => ({
      id: createMessageId(),
      type,
      created: now(),
      data: { sessionID, ...data },
      location: { directory },
    });

    // A subscriber failure must not take down a background session loop; the
    // transcript below already holds the durable record of the same event.
    const emitEvent = (event) => {
      if (state.disposed) return;
      try {
        emit(event);
      } catch {
        // Best effort: the live stream is a projection of the transcript.
      }
    };

    // Usage is a side channel like the live stream: a reporting failure must
    // not take down the loop, and the transcript keeps the step's own record.
    const reportUsage = (data) => {
      try {
        onUsage?.(data);
      } catch {
        // Best effort.
      }
    };

    // Translator events are durable: the transcript records them first, then
    // the live stream publishes them. A step settled by an SDK result carries
    // the session's running usage; the abort and transport-failure paths
    // carry none.
    const publishTranslated = (events) => {
      for (const event of events) {
        transcript.applyWireEvent(event);
        if (event.type === 'session.step.started' && event.data?.assistantMessageID) {
          state.assistantMessageID = event.data.assistantMessageID;
        }
        emitEvent(event);
        if (
          (event.type === 'session.step.ended' || event.type === 'session.step.failed')
          && (event.data?.cost !== undefined || event.data?.tokens !== undefined)
        ) {
          reportUsage({ cost: event.data.cost, tokens: event.data.tokens });
        }
      }
    };

    // -----------------------------------------------------------------------
    // Turn lifecycle
    // -----------------------------------------------------------------------

    // Closing a dead transport is not a failure of the session.
    const closeQuery = (query) => {
      try {
        query?.close?.();
      } catch {
        // Ignore: the process may already be gone.
      }
    };

    const clearInterruptTimer = () => {
      if (interruptTimer) clearTimeout(interruptTimer);
      interruptTimer = null;
    };

    const finishTurn = () => {
      state.busy = false;
      state.assistantMessageID = null;
      resetIdleTimer();
      const next = pendingSends.shift();
      if (next) void startTurn(next);
    };

    const settleTurnAsAborted = (reason) => {
      state.awaitingResult = false;
      state.interruptPending = false;
      clearInterruptTimer();
      publishTranslated(translator.abort({ reason }));
      finishTurn();
    };

    const failTurn = (error) => {
      if (!state.busy || state.disposed) return;
      state.awaitingResult = false;
      state.interruptPending = false;
      clearInterruptTimer();
      publishTranslated(translator.fail({ error: { type: 'error', message: errorMessage(error) } }));
      finishTurn();
    };

    const buildOptions = () => {
      const options = {
        cwd,
        includePartialMessages: true,
        canUseTool,
        permissionMode: state.permissionMode,
        resume: state.claudeSessionUuid || undefined,
      };
      // The SDK refuses `bypassPermissions` without this explicit flag.
      if (state.permissionMode === 'bypassPermissions') options.allowDangerouslySkipPermissions = true;
      if (session.cliPath) options.pathToClaudeCodeExecutable = session.cliPath;
      if (state.model) options.model = state.model;
      if (state.effort) options.effort = state.effort;
      return options;
    };

    const ensureQuery = async () => {
      if (state.query) return;
      const query = await spawnQuery({ prompt: state.input, options: buildOptions() });
      state.query = query;
      // A fresh query cannot owe results to the previous one: its generator
      // has ended, so nothing of the old stream can still arrive.
      state.outstandingResults = 0;
      void consumeStream(query);
    };

    const consumeStream = async (query) => {
      let failure = null;
      try {
        for await (const message of query) handleMessage(message);
      } catch (error) {
        failure = error;
      }
      if (state.query === query) state.query = null;
      if (failure) {
        // The loop died on an internal error, not on the stream's own end, so
        // the process may still be alive; close it before the next prompt
        // spawns a replacement.
        closeQuery(query);
      }
      if (state.disposed || !state.awaitingResult) return;
      state.awaitingResult = false;
      if (state.interruptPending) {
        settleTurnAsAborted('user');
        return;
      }
      failTurn(failure ?? new Error('Claude Code process ended before the turn completed'));
    };

    const handleResult = (message) => {
      if (state.outstandingResults > 0) state.outstandingResults -= 1;
      // Results arrive in turn order. While one is still owed to an earlier
      // turn (a force-settled interrupt), this result belongs to that turn
      // and must not settle the running one.
      if (state.outstandingResults > 0) return;
      if (!state.awaitingResult) return;
      state.awaitingResult = false;
      if (state.interruptPending) {
        settleTurnAsAborted('user');
        return;
      }
      publishTranslated(translator.translate(message));
      finishTurn();
    };

    const reportSessionId = (message) => {
      const sessionId = message?.session_id;
      // Persisted once per runner: the first message of a resumed session
      // carries the same id, and a respawn must resume the same session.
      if (!sessionId || state.reportedSessionId) return;
      state.reportedSessionId = sessionId;
      state.claudeSessionUuid = sessionId;
      onSessionId(sessionId);
    };

    const handleMessage = (message) => {
      if (state.disposed) return;
      resetIdleTimer();
      reportSessionId(message);
      if (message?.type === 'result') {
        handleResult(message);
        return;
      }
      publishTranslated(translator.translate(message));
    };

    const startTurn = async ({ text, messageID }) => {
      if (state.disposed) return;
      state.busy = true;
      state.awaitingResult = true;
      state.assistantMessageID = null;
      resetIdleTimer();
      publishTranslated(translator.beginTurn());
      try {
        await ensureQuery();
      } catch (error) {
        failTurn(error);
        return;
      }
      if (state.disposed) return;
      state.outstandingResults += 1;
      state.input.push({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
      });
    };

    // -----------------------------------------------------------------------
    // Idle reaping
    // -----------------------------------------------------------------------

    const clearIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
    };

    const resetIdleTimer = () => {
      if (state.disposed) return;
      clearIdleTimer();
      idleTimer = setTimeout(() => {
        // The reaper runs off the request path; a failure while reaping must
        // not take the process down.
        void handleIdle().catch(() => {});
      }, idleMs);
      idleTimer.unref?.();
    };

    const handleIdle = async () => {
      idleTimer = null;
      if (state.disposed) return;
      // A parked request is a turn waiting on the user, not an idle session:
      // restart the window instead of settling and disposing under it.
      if (pendingPermissions.size > 0) {
        resetIdleTimer();
        return;
      }
      if (state.busy) settleTurnAsAborted('idle');
      await dispose();
      onIdle(runner);
    };

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    const send = async ({ text, messageID, context, files } = {}) => {
      if (state.disposed) throw new Error(`Claude session ${sessionID} is no longer running`);
      const id = messageID ?? createMessageId();
      transcript.beginUserMessage({ text, messageID: id });
      // The transcript keeps the user's own text; the synthetic records carry
      // the context, and the SDK turn leads with it (see `promptContent`). A
      // turn with attachments travels as content blocks instead (see
      // `buildPromptContent`).
      const content = buildPromptContent(text, context, files);
      if (state.busy) {
        pendingSends.push({ text: content, messageID: id });
        return;
      }
      await startTurn({ text: content, messageID: id });
    };

    const interrupt = async () => {
      if (state.disposed || !state.busy || state.interruptPending) return;
      state.interruptPending = true;
      interruptTimer = setTimeout(() => {
        interruptTimer = null;
        if (state.interruptPending) {
          // A control request that never completes (or a stream that never
          // ends) is force-settled; the warning names the session so the event
          // is diagnosable.
          console.warn(`[claude-code] interrupt for ${sessionID} did not settle within ${INTERRUPT_SETTLE_MS} ms; settling the turn as interrupted`);
          settleTurnAsAborted('user');
        }
      }, INTERRUPT_SETTLE_MS);
      interruptTimer.unref?.();
      const query = state.query;
      try {
        await query?.interrupt?.();
      } catch {
        // The stream still has to settle the turn; the timeout above covers a
        // control request that never completes.
      }
    };

    const setModel = async (modelId) => {
      state.model = modelId ?? null;
      if (modelId) translator.setModel(modelId);
      const query = state.query;
      if (query) await query.setModel(modelId ?? undefined);
    };

    // The mode is stored before the SDK is told, like a model switch: a
    // control-call failure still leaves the next turn on the new mode. A
    // value outside v1's set heals to the default rather than reaching the SDK.
    const setPermissionMode = async (mode) => {
      state.permissionMode = permissionModeOrDefault(mode);
      const query = state.query;
      if (query) await query.setPermissionMode(state.permissionMode);
    };

    const canUseTool = async (toolName, input, options = {}) => {
      if (state.disposed) return { behavior: 'deny', message: 'Session closed' };
      if (alwaysAllowed.has(toolName)) return { behavior: 'allow' };

      const permissionID = createPermissionId();
      const resources = permissionResources(input);
      const source = state.assistantMessageID
        ? {
            type: 'tool',
            messageID: state.assistantMessageID,
            // The SDK names the tool call; the permission id stands in when a
            // caller predates the field and the wire type still needs an id.
            id: options.toolUseID ?? permissionID,
          }
        : undefined;
      // The request in the wire shape `permission.asked` carries and
      // `GET /api/permission/request` serves: kept on the pending entry so a
      // client that reloads while the request is parked can find it again.
      const wireRequest = {
        sessionID,
        id: permissionID,
        action: toolName,
        resources,
        message: permissionMessage(toolName, resources, options.title),
        metadata: { toolName, input },
        source,
      };

      let resolveRequest = null;
      const request = new Promise((resolve) => {
        resolveRequest = resolve;
      });

      // The safety net: a request nobody answers is denied after
      // `permissionParkMaxMs`, so a forgotten prompt cannot park the turn (and
      // the child process) forever. The timer is cleared on answer, abort, and
      // dispose; a fired timer is a no-op once the request has left the map.
      let parkTimer = null;
      const clearParkTimer = () => {
        if (parkTimer) clearTimeout(parkTimer);
        parkTimer = null;
      };

      const onAbort = () => {
        if (!pendingPermissions.delete(permissionID)) return;
        clearParkTimer();
        emitEvent(wire('permission.replied', { requestID: permissionID, reply: 'reject' }));
        resolveRequest({ behavior: 'deny', message: 'Interrupted' });
      };

      const onParkTimeout = () => {
        parkTimer = null;
        if (!pendingPermissions.delete(permissionID)) return;
        options.signal?.removeEventListener?.('abort', onAbort);
        console.warn(`[claude-code] permission request ${permissionID} for ${sessionID} was not answered within ${permissionParkMaxMs} ms; denying ${toolName}`);
        // Answering is activity: the turn resumes with a fresh idle window.
        resetIdleTimer();
        emitEvent(wire('permission.replied', { requestID: permissionID, reply: 'reject' }));
        resolveRequest({ behavior: 'deny', message: 'Permission request timed out' });
      };

      pendingPermissions.set(permissionID, {
        toolName,
        suggestions: options.suggestions,
        wireRequest,
        resolve: resolveRequest,
        cleanup: () => {
          options.signal?.removeEventListener?.('abort', onAbort);
          clearParkTimer();
        },
      });
      options.signal?.addEventListener?.('abort', onAbort, { once: true });
      parkTimer = setTimeout(onParkTimeout, permissionParkMaxMs);
      parkTimer.unref?.();
      // Parking is activity: the turn is waiting on the user's answer.
      resetIdleTimer();

      emitEvent(wire('permission.asked', wireRequest));

      return request;
    };

    const resolvePermission = (permissionID, decision) => {
      const entry = pendingPermissions.get(permissionID);
      if (!entry) return false;
      if (decision !== 'once' && decision !== 'always' && decision !== 'reject') return false;
      pendingPermissions.delete(permissionID);
      entry.cleanup();
      // Answering is activity too: the turn resumes with a fresh window.
      resetIdleTimer();
      if (decision === 'always') alwaysAllowed.add(entry.toolName);
      emitEvent(wire('permission.replied', { requestID: permissionID, reply: decision }));
      entry.resolve(permissionResult(decision, entry.suggestions));
      return true;
    };

    /**
     * The parked requests in the wire shape `permission.asked` emitted
     * (`Permission.Request`), for a client that reloads and must find them
     * again (`GET /api/permission/request`). Empty when nothing is parked; an
     * answered, aborted, timed-out, or disposed request leaves the map, so the
     * list shrinks as requests settle.
     */
    const pendingPermissionRequests = () => [...pendingPermissions.values()].map((entry) => entry.wireRequest);

    const dispose = async () => {
      if (state.disposed) return;
      state.disposed = true;
      state.busy = false;
      state.awaitingResult = false;
      state.interruptPending = false;
      clearIdleTimer();
      clearInterruptTimer();
      for (const entry of pendingPermissions.values()) {
        entry.cleanup();
        entry.resolve({ behavior: 'deny', message: 'Session closed' });
      }
      pendingPermissions.clear();
      // Queued prompts are dropped with the runner: their user records stay in
      // the transcript, but they never reached the SDK, so a resumed Claude
      // session does not know them. The client resends what still matters.
      pendingSends.length = 0;
      state.input.close();
      const query = state.query;
      state.query = null;
      closeQuery(query);
      try {
        await transcript.flush();
      } catch {
        // The transcript keeps failed lines queued; the next flush retries.
      }
    };

    const isBusy = () => state.busy;

    const runner = { send, interrupt, setModel, setPermissionMode, resolvePermission, pendingPermissionRequests, dispose, isBusy };
    return runner;
  };

  return { createRunner };
}
