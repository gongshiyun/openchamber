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
// session answers with a deny so no call stays parked.
//
// Interrupt: `interrupt()` asks the SDK to stop and settles the turn from the
// next result or stream end. The SDK is expected to settle within
// INTERRUPT_SETTLE_MS; when it does not, the runner settles the turn itself so
// the session does not stay busy forever.
//
// Idle: the idle timer resets on send and on every SDK message. On fire the
// runner settles an open turn as interrupted, disposes itself, and reports to
// `onIdle` so the registry can drop it; the next prompt resumes the Claude
// session through `resume`.
//
// SDK facts assumed here, verified against @anthropic-ai/claude-agent-sdk
// 0.3.296 types (re-verify when the dependency lands, Task 10/12):
//   - `query({ prompt, options })` returns an AsyncGenerator of SDK messages
//     with `interrupt()`, `setModel(model?)` and `close()`; `prompt` may be an
//     AsyncIterable of user messages (streaming input).
//   - Streaming input messages are `{ type: 'user', message: { role: 'user',
//     content }, parent_tool_use_id: null }`.
//   - `canUseTool(toolName, input, { signal, suggestions, toolUseID, title })`
//     resolves `{ behavior: 'allow', updatedPermissions? }` or
//     `{ behavior: 'deny', message }`.
//   - Messages carry `session_id`; a `system`/`init` message opens the stream.

import { createMessageId } from './ids.js';

const DEFAULT_IDLE_MS = 15 * 60 * 1000;
// How long an interrupted turn may take to settle before the runner settles it
// locally. A control request that never completes (or a stream that never
// ends) must not leave the session busy forever.
const INTERRUPT_SETTLE_MS = 10_000;

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
 * Build a factory for per-session Claude runners.
 *
 * `spawnQuery` defaults to a lazy dynamic import of the Agent SDK `query()`;
 * tests inject a fake and production wiring may inject the import explicitly.
 *
 * @param {{
 *   spawnQuery?: (params: { prompt: AsyncIterable<object>, options: object }) => object | Promise<object>,
 *   createPermissionId?: () => string,
 *   idleMs?: number,
 *   now?: () => number,
 * }} [options]
 */
export function createRunnerFactory({
  spawnQuery = async (params) => {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    return query(params);
  },
  createPermissionId = defaultPermissionId,
  idleMs = DEFAULT_IDLE_MS,
  now = Date.now,
} = {}) {
  const createRunner = (session) => {
    const { sessionID, directory, transcript, translator, emit, onSessionId, onIdle } = session;
    const cwd = session.cwd ? session.cwd : directory;

    const state = {
      input: createInputQueue(),
      query: null,
      model: session.model ?? null,
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

    // Translator events are durable: the transcript records them first, then
    // the live stream publishes them.
    const publishTranslated = (events) => {
      for (const event of events) {
        transcript.applyWireEvent(event);
        if (event.type === 'session.step.started' && event.data?.assistantMessageID) {
          state.assistantMessageID = event.data.assistantMessageID;
        }
        emitEvent(event);
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
        permissionMode: 'default',
        resume: state.claudeSessionUuid || undefined,
      };
      if (session.cliPath) options.pathToClaudeCodeExecutable = session.cliPath;
      if (state.model) options.model = state.model;
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
      if (state.busy) settleTurnAsAborted('idle');
      await dispose();
      onIdle(runner);
    };

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    const send = async ({ text, messageID, context } = {}) => {
      if (state.disposed) throw new Error(`Claude session ${sessionID} is no longer running`);
      const id = messageID ?? createMessageId();
      transcript.beginUserMessage({ text, messageID: id });
      // The transcript keeps the user's own text; the synthetic records carry
      // the context, and the SDK turn leads with it (see `promptContent`).
      const content = promptContent(text, context);
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
        if (state.interruptPending) settleTurnAsAborted('user');
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

      let resolveRequest = null;
      const request = new Promise((resolve) => {
        resolveRequest = resolve;
      });

      const onAbort = () => {
        if (!pendingPermissions.delete(permissionID)) return;
        emitEvent(wire('permission.replied', { requestID: permissionID, reply: 'reject' }));
        resolveRequest({ behavior: 'deny', message: 'Interrupted' });
      };

      pendingPermissions.set(permissionID, {
        toolName,
        suggestions: options.suggestions,
        resolve: resolveRequest,
        cleanup: () => options.signal?.removeEventListener?.('abort', onAbort),
      });
      options.signal?.addEventListener?.('abort', onAbort, { once: true });

      emitEvent(
        wire('permission.asked', {
          id: permissionID,
          action: toolName,
          resources,
          message: permissionMessage(toolName, resources, options.title),
          metadata: { toolName, input },
          source,
        }),
      );

      return request;
    };

    const resolvePermission = (permissionID, decision) => {
      const entry = pendingPermissions.get(permissionID);
      if (!entry) return false;
      if (decision !== 'once' && decision !== 'always' && decision !== 'reject') return false;
      pendingPermissions.delete(permissionID);
      entry.cleanup();
      if (decision === 'always') alwaysAllowed.add(entry.toolName);
      emitEvent(wire('permission.replied', { requestID: permissionID, reply: decision }));
      entry.resolve(permissionResult(decision, entry.suggestions));
      return true;
    };

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

    const runner = { send, interrupt, setModel, resolvePermission, dispose, isBusy };
    return runner;
  };

  return { createRunner };
}
