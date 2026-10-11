# Claude Code Module Documentation

## Purpose

The Claude Code backend is OpenChamber's second agent backend beside OpenCode. This module owns one Claude session end to end: the session registry, the per-session transcripts, the live Agent SDK runners, the OpenCode v2 HTTP subset a Claude session serves, and the wire events of all of it. OpenCode stays the default backend; this module answers only for sessions its registry owns, and every other `/api` request passes through to the OpenCode proxy unchanged (`../opencode/DOCUMENTATION.md`).

The trust boundary is the user's own `claude` CLI. A Claude session runs that CLI through `@anthropic-ai/claude-agent-sdk`, with the user's own authentication and configuration; OpenChamber reads, stores, and forwards no Claude credentials. The module's only durable state is the session index, the transcripts, and the Claude session uuid each session resumes on. Where the CLI comes from — a configured binary, a PATH install, or the SDK's bundled executable — is resolved per session (`cli-resolution.js`); the credential exchange stays between the CLI and Anthropic.

## Entrypoints and structure

- `packages/web/server/lib/claude-code/index.js`: the composition root. `createClaudeCodeRuntime({ dataDir, eventHub, getSettings, ... })` builds the registry, transcripts, lazy runners, router, and the adapters the server wires into the proxy and the OpenChamber session routes. `start()` loads the index; `stop()` disposes every live runner and drains index writes.
- `packages/web/server/lib/claude-code/routes.js`: the OpenCode v2 route subset, mounted by the proxy at `/api` ahead of the OpenCode readiness gate.
- `packages/web/server/lib/claude-code/runner.js`: one live Agent SDK `query()` per session — streaming input, turn lifecycle, permissions, interrupt, idle reaping, dispose. The SDK spawns one `claude` process per query, so a live session is one child process of this server.
- `packages/web/server/lib/claude-code/translator.js`: a pure state machine mapping SDK messages to OpenCode v2 wire events. No IO, no SDK import; an unknown or malformed message maps to no events.
- `packages/web/server/lib/claude-code/transcript.js`: the wire message records and their append-only JSONL persistence; the source of `message.list`.
- `packages/web/server/lib/claude-code/cli-resolution.js`: resolves the user's `claude` CLI and builds a spawn spec for a caller that spawns it itself.
- `packages/web/server/lib/claude-code/ids.js`: `ses_`/`msg_` id minting in OpenCode's own time-sortable format. A JS mirror of `packages/ui/src/lib/opencode/ids.ts` (the plain-JS server cannot import from `packages/ui`), so the two must stay compatible: the UI special-cases the `ses_` prefix, and OpenCode sorts ids by the 6-byte time/counter prefix.

## HTTP surface

### The route subset

The shared UI talks to every backend through `@opencode/client` 2.x, whose generated methods join their `/api/...` paths onto the base URL. The router answers exactly the routes a Claude session uses, with the same methods, statuses, and envelopes (pinned to the generated client):

| Route | Method | Answer |
| --- | --- | --- |
| `/api/session` | POST | `200 { data }` — only when the create names this backend |
| `/api/session/:sessionID` | GET | `200 { data }` |
| `/api/session/:sessionID` | PATCH | `204` — rename only; metadata goes through the OpenChamber route |
| `/api/session/:sessionID` | DELETE | `204` |
| `/api/session/:sessionID/move` | POST | `204` |
| `/api/session/:sessionID/model` | POST | `204` |
| `/api/session/:sessionID/agent` | POST | `204` |
| `/api/session/:sessionID/prompt` | POST | `200 { data }` |
| `/api/session/:sessionID/synthetic` | POST | `200 { data }` |
| `/api/session/:sessionID/interrupt` | POST | `200 { interrupted }` |
| `/api/session/:sessionID/message` | GET | `200 { data, cursor }` |
| `/api/session/:sessionID/permission/:permID/reply` | POST | `204` |

Every session-scoped route answers only for a session the registry owns (`isClaudeSession`); anything else leaves the router through `next('router')`, and the OpenCode proxy keeps serving it. Errors use OpenCode's tagged body `{ _tag, message }`: `400 InvalidRequestError` for a missing title, directory, prompt text, synthetic text, or decision; `404 SessionNotFoundError` / `PermissionNotFoundError` for an unknown session or permission. The shared UI maps the tag back to a status. `session.synthetic` is the context channel the UI uses ahead of a prompt: it answers `200 { data }` with the recorded message and never starts a turn (see Synthetic context below).

`message.list` keeps the OpenCode v2 page semantics: `order` defaults to newest first, `cursor` is a message id the page starts strictly after, and `next` is present only while more records remain in the walk direction. History answers from the transcript, so it works with no runner at all.

### Synthetic context

`POST /api/session/:sessionID/synthetic` admits one context item (a quoted selection, terminal output, PR checks, skill instructions) as a `synthetic` message before the prompt that carries it. The registry records it in the transcript — so it shows in `message.list` history and, as the `session.synthetic` wire event, in every live stream — and answers `200 { data }` with the recorded wire record; the envelope id is the client's message id in the event id space (`msg_` → `evt_`), so the optimistic context block the UI already rendered reconciles in place. Nothing starts a turn: the admitted texts wait on the session record, and the next `sendPrompt` hands them to the runner, which leads the SDK turn's content with them separated by blank lines (the transcript's user record keeps the user's own text). The list is cleared once the prompt is sent — a failed send does not roll it back — and the payload's `delivery` and `resume` are ignored in v1.

### Creating a Claude session

A create is routed to this backend by the `x-openchamber-backend: claude` request header (trimmed, case-insensitive) — not by the body, because the proxy re-serializes some bodies and a header cannot be lost to that. The client mints the session id and may name the initial title, agent, model, and metadata; the directory comes from the body's `location.directory`, else the `x-opencode-directory` header (decoded once, or twice when `x-opencode-directory-encoding: uri` marks an extra layer). Whatever metadata the caller sent, the stored record carries `metadata.openchamber.backend = 'claude'`; that marker is what the sidebar badge and the UI's backend checks read.

### Mounting and the proxy carve-outs

`server/index.js` creates the runtime with the instance data directory and the global event hub; `server-utils-runtime.js` passes its router, list merge, event hub, and session check into `registerOpenCodeProxy`. The proxy mounts the router at `/api` before the OpenCode readiness gate, so a Claude request never waits on an OpenCode start or restart it does not touch. Because the common middleware leaves `/api/session` bodies unparsed for the streaming proxy, the proxy runs `express.json` first for requests this backend owns — a create with the backend header, or a `/api/session/:id...` path whose session the registry holds — and leaves every other request's bytes untouched for OpenCode. The proxy also appends Claude records to the first page of `GET /api/session` and multiplexes Claude frames into the SSE streams; both are documented in `../opencode/DOCUMENTATION.md`.

## Wire-event contract

Every event is an OpenCode v2 wire shape, injected into the server's global hub with `injectEvent({ payload, directory, spaceId: null })`. The hub numbers, coalesces, replays, and fans it out beside OpenCode's own events, so the browser WS channel and the SSE fallback carry Claude sessions with no client change, and server-side consumers translate them through the same `translateWireEvent` (live status for a Claude session comes from its `session.execution.*` events, exactly as for OpenCode's). The payload carries its own wire event id; the hub's replay cursor is assigned on entry. See `../event-stream/DOCUMENTATION.md`.

The exact list:

- Registry events (`index.js`): `session.created`, `session.renamed`, `session.moved`, `session.deleted`, `session.model.selected`, `session.agent.selected` (only when the value changes), `session.metadata.updated`, `session.synthetic`.
- Runner events (`runner.js` / `translator.js`):
  - execution: `session.execution.started`, `session.execution.succeeded`, `session.execution.interrupted` (`reason: 'user' | 'idle'`), `session.execution.failed`
  - steps: `session.step.started`, `session.step.ended`, `session.step.failed`
  - content: `session.text.started` / `session.text.delta` / `session.text.ended`, `session.reasoning.started` / `session.reasoning.delta` / `session.reasoning.ended`
  - tools: `session.tool.input.started` / `session.tool.input.delta` / `session.tool.input.ended`, `session.tool.success`, `session.tool.failed`
  - permissions: `permission.asked`, `permission.replied`

`session.synthetic` is the one registry event whose envelope id is load-bearing: it is the client's message id with `msg_` swapped for `evt_`, because the UI derives the message it updates from the event id (`messageIdFromEvent` in `packages/ui/src/lib/opencode/events.ts`). Its data is `{ sessionID, text, description?, metadata? }`, with the optional fields present only when the caller sent them.

The module emits no `session.status` and no `session.idle` of its own; v2 derives live status from the execution events, and the UI's `session.error` comes from `session.execution.failed` — the same reading as OpenCode's own stream. The translator's output-side vocabulary (`message.updated`, `session.error`, ...) is never emitted as a wire event.

### Permissions

The SDK calls the runner's `canUseTool` before a tool execution; which tools reach it is the CLI's own `permissionMode: 'default'` policy, the mode the runner sets explicitly. The runner mints a `per_` + 22 base62 id, emits `permission.asked` (`{ id, action, resources, message, metadata: { toolName, input }, source? }`; `resources` is the first of `command`, `file_path`, `notebook_path`, `url`, `pattern`, `query` present in the tool input, and `source` names the assistant message and tool call when one is open), and parks the call until a reply:

- `once` — allow.
- `always` — allow, remember the tool name for the rest of the runner (later calls are allowed without asking), and hand the SDK's own permission suggestions back as `updatedPermissions` so the CLI remembers too.
- `reject` — deny with "Rejected by the user".

Every decision emits `permission.replied` with the reply. An aborted tool signal (an interrupted turn) and a disposed runner answer with a deny so no call stays parked. An unknown request id answers `false`, which the route turns into `404` — permission-auto-accept reads that as "already replied".

## Persistence

Everything lives under `<dataDir>/claude-code/`:

- `sessions.json` — the registry index, one JSON object keyed by session id. An entry holds `directory`, `projectID`, `title`, `createdAt`, `updatedAt`, `model`, `claudeSessionUuid`, `metadata`, and optionally `agent`. Writes are atomic (a temp file in the same directory, then a rename) and serialized on one chain, so an older snapshot never lands last; the snapshot is taken when the write is queued.
- `sessions/<sessionID>.jsonl` — one append-only transcript per session, the message records behind `message.list`. `load()` replays the lines through the same code that applies live events; a malformed last line is a torn append from a crash and is ignored, and a malformed line before it throws with the 1-based line number. A failed load is not memoized — the next call retries. `close()` stops accepting records; `flush()` drains queued lines, and failed writes stay queued for the next flush.

On load, `directory` is authoritative: `projectID` is re-derived from it rather than trusted from the file, and a field that no longer has the right type falls back to its default. Session ids must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`; an id that could escape the sessions directory or name a file Windows rejects is refused at the door and skipped in a stored index.

`claudeSessionUuid` is the SDK session id the runner learns from the stream's first message; it is persisted (best effort) and passed back as `resume` when a later runner for the session starts, so an idle-reaped session continues its Claude-side history.

Boot: `start()` rejects on an unreadable or malformed index, because starting empty would silently forget every session and the next write would then overwrite the file. `server/index.js` catches that failure, logs it, and keeps booting — the routes answer from an empty registry and the transcripts stay on disk, but the next registry write replaces the unreadable index. A missing index file is the normal first run.

## Lifecycle

- Lazy start. A session has no process until its first prompt: `getSession`, `message.list`, the list merge, and metadata all answer from disk. After a restart the history is on disk, and a prompt starts a new `query()`.
- One runner per session, created on first prompt and memoized as a promise so two concurrent prompts cannot spawn two processes. The CLI path is resolved when the runner is created, not at boot, so a changed `claudeBinary` applies to the next session without a restart. A failed runner creation is not memoized; the next prompt retries.
- Streaming input. The runner keeps one `query()` open across turns and feeds prompts through an async-iterable input queue the SDK pulls from. One turn at a time: a prompt sent while a turn runs waits in a FIFO and starts the next turn, so the translator always owns exactly one open turn.
- A turn settles on the SDK `result` (`session.step.ended` + `session.execution.succeeded`, or the failure pair), on an interrupt, on a transport failure, or on an idle reap.
- Interrupt. `interrupt()` asks the SDK to stop and settles the turn from the next result or stream end. The SDK gets 10 seconds (`INTERRUPT_SETTLE_MS`) to settle; when it does not, the runner settles the turn itself as interrupted, so a control request that never completes cannot leave the session busy forever. A force-settled turn may leave its SDK result outstanding; the runner counts outstanding results so a late result cannot settle a later turn.
- Idle reaping. The idle timer resets on send and on every SDK message; after 15 minutes (`DEFAULT_IDLE_MS`) the runner settles an open turn as interrupted, disposes itself, and reports to `onIdle`, so the registry drops it. The next prompt creates a fresh runner that resumes the Claude session through `resume`.
- Dispose. Answers parked permission calls with a deny, closes the input queue, closes the query, drops queued prompts (their user records stay in the transcript, but they never reached the SDK, so a resumed Claude session does not know them), and drains the transcript. `stop()` disposes every live runner and waits for index writes still in flight; `server/index.js` calls it from graceful shutdown.
- Move. `moveSession` updates the record and emits `session.moved`, but a live runner keeps the `cwd` it was created with; the new directory applies to the next runner, after the live one is reaped or disposed. v1 does not dispose the runner on move.

## CLI resolution

`resolveClaudeCliPath` returns the absolute path of the user's `claude` CLI or null, in this order:

1. `settings.claudeBinary` (the instance setting), then `CLAUDE_BINARY`; every candidate must exist, and a stale override falls through instead of being returned.
2. A PATH search, best candidate first: on Windows `claude.exe`, `claude.cmd`, then a bare `claude`; elsewhere `claude`.
3. Known install locations a PATH-less process (packaged Electron, a service) still has to find: `~/.claude/local/claude`, `%APPDATA%/npm/claude.cmd` on Windows, and `~/.local/bin/claude`.

All IO is injectable (`env`, `settings`, `platform`, `exists`, `searchPath`), so tests never touch the real filesystem.

`buildClaudeLaunchSpec` builds the spawn spec for a caller that spawns the CLI itself: on Windows a `.cmd`/`.bat` shim goes through the command interpreter (`%ComSpec%`, args `/d /s /c call <path>`), `.exe` and extensionless executables run as-is, and a bare `.js` entry is refused because it needs a Node interpreter the module does not own. The current runner does not use it: it hands the resolved path to the SDK as `pathToClaudeCodeExecutable`, and the SDK owns the spawn. When resolution returns null, that option is omitted and the SDK runs its bundled executable.

## Known v1 limitations

- Permission mode is fixed at the SDK's `'default'`; there is no plan / acceptEdits / bypass switch, and no UI for one.
- No usage or cost display. Session records carry `cost: 0` and zero tokens (the UI's `Session` requires the fields); per-message cost and tokens from the SDK result are recorded in the transcript, but v1 surfaces no session-level usage view for Claude sessions.
- The prompt route accepts files, agent mentions, skills, metadata, and a delivery mode, but v1 carries only the text, the client-minted message id, and the context admitted through `session.synthetic` to the runner; files, agent mentions, skills, metadata, and delivery are dropped.
- `POST /api/session/:id/agent` records the selection and emits `session.agent.selected`, but the runner's step events always report the translator's fixed agent (`claude`).
- SSE: Claude frames ride every `/api/event` stream, not only global ones — the proxy filters by session id, not by directory, so a directory-scoped stream also carries Claude frames of other directories. This is deliberate: a Claude session has no OpenCode upstream of its own (see `../opencode/DOCUMENTATION.md`).
- A move does not dispose a live runner (see Lifecycle).
- Goals, multi-run, walkthrough, scheduled tasks, and quota stay OpenCode-only: their server modules do not branch on the Claude registry. The backend picker is a desktop composer control; the mobile control cluster is out of v1 scope (`packages/ui/src/components/chat/composer/ui/DraftBackendControls.tsx`).

## What this module does not own

- UI controls: the backend picker, the Claude model control, and the sidebar badge live in `packages/ui` (`packages/ui/src/lib/sessionBackend.ts` holds the backend header constants, the static model alias list, and the record checks).
- The provider/model catalog: the module serves no provider or model route. The UI's Claude model control uses its own static alias list (`opus`, `sonnet`, `haiku`, `fable`); a session's model ref is stored on the record as `{ providerID: 'claude-code', id: '<alias>' }`.
- Quota, cost, and usage reporting.
- The OpenCode proxy and the event hub: this module injects events and answers a route subset; it never forwards or owns OpenCode transport (`../opencode/DOCUMENTATION.md`, `../event-stream/DOCUMENTATION.md`).
- OpenChamber session metadata storage for OpenCode sessions (`../openchamber-sessions/DOCUMENTATION.md`); this module only answers that route for Claude sessions through its injected adapter.

## Notes for contributors

- Keep the wire shapes pinned: `translator.contract.test.js` and `transcript.contract.test.js` feed the UI's own `translateWireEvent` and projection, so a vocabulary or field drift fails in this package.
- Keep `translator.js` pure; IO belongs in the runner and the transcript.
- The transcript is the durable record: a live event is applied to the transcript before it is published, so a subscriber failure cannot lose history.
- The SDK facts the runner assumes are listed at the top of `runner.js`; re-verify them when the dependency version changes.
- Route paths, statuses, and envelopes come from the generated client (`node_modules/@opencode/client`); re-check them when the client version changes.

## Testing

- `bunx vitest run server/lib/claude-code` from `packages/web` runs the whole module: the `bun:test` suites through the repo's shim, the vitest suites natively.
- Individual suites: `bun test packages/web/server/lib/claude-code/index.test.js` (registry, persistence, routes through the real `@opencode/client`), `routes.test.js`, `runner.test.js`, `translator.test.js`, `transcript.test.js`, `wiring.test.js` (the proxy end to end against a fake OpenCode), and the contract tests; `bunx vitest run server/lib/claude-code/cli-resolution.test.js` for the CLI resolution.
