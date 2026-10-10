# OpenChamber Sessions Module Documentation

## Purpose

This module owns the OpenChamber-specific session features that live beside OpenCode's session records: the archive state OpenCode 2.x no longer has a route for, the per-session metadata read/write path, fork-inheritance repair, agent-written session links, and the HTTP routes that compose them. `routes.js` also builds the session service the OpenChamber control service calls (`../openchamber-control/DOCUMENTATION.md` documents that service's invariants — selection validation, worktree and pull-request creation, prompt dispatch confirmation, goal handling); this document covers the module's own state and routes.

## Entrypoints and structure

- `packages/web/server/lib/openchamber-sessions/routes.js`: `createOpenChamberSessionService(dependencies)` and `registerOpenChamberSessionRoutes(app, dependencies)` — the service surface and its HTTP routes.
- `packages/web/server/lib/openchamber-sessions/archive-store.js`: OpenChamber-owned archive state (`sessions-archive.json`), with batched, transactional writes.
- `packages/web/server/lib/openchamber-sessions/session-metadata-store.js`: OpenChamber metadata on the OpenCode session record (`PATCH /api/session/{id}`), plus the legacy `sessions-metadata.json` migration; `mergeMetadataPatch` (RFC 7386) is exported here and reused by the Claude backend.
- `packages/web/server/lib/openchamber-sessions/fork-inheritance.js`: server-side repair of what a fork made through this API keeps from its source session's metadata.
- `packages/web/server/lib/openchamber-sessions/session-link.js`: turns an agent's link record into the `openchamber.linked_issues` entry the UI reads; only adds or refreshes links.
- `packages/web/server/lib/openchamber-sessions/opencode-client.js`: one directory-scoped `@opencode/client` for a session-route call, with the percent-encoded directory header OpenCode expects and `assertOpenCodeApiResponse` so an HTML app-shell answer is rejected at the dispatch boundary.

## Routes

`registerOpenChamberSessionRoutes` registers:

- `POST /api/openchamber/sessions` — create a session through the OpenCode SDK, optionally with a worktree or pull-request worktree, an initial prompt, and a goal.
- `POST /api/openchamber/sessions/archive`, `POST /api/openchamber/sessions/unarchive` — batch archive/unarchive (a non-empty array of at most 500 session ids per request).
- `GET /api/openchamber/sessions/:sessionId/metadata`, `POST /api/openchamber/sessions/:sessionId/metadata` — the metadata path described below.
- `POST /api/openchamber/sessions/:sessionId/send`, `POST /api/openchamber/sessions/:sessionId/fork` — dispatch to an existing session through the OpenCode SDK.

Errors answer `{ error, ... }`; an error that happened after a partial effect also carries `partial`, `partialAction`, `sessionId`, and `directory`.

## Session metadata (dual backend)

OpenCode 2.0.15 added `PATCH /api/session/{id}` with `metadata`, so an OpenCode session's OpenChamber state (goal progress, session assist, obligatory context, pinned notes, linked issues) lives on the OpenCode record, under the `openchamber` namespace. Writes are RFC 7386 merge patches: the store reads the record, merges, and writes the result back, one write per session at a time, so two writers cannot interleave. A record that cannot be read stops the write. Entries an older OpenChamber left in `sessions-metadata.json` are the newest metadata their sessions have: the store serves them and pushes them to OpenCode, lazily on the session's first write and in one sweep after OpenCode is up; a pushed entry leaves the file, and an emptied file is renamed `sessions-metadata.json.migrated`. The proxy lays unmigrated entries over OpenCode's records until then (`../opencode/DOCUMENTATION.md`).

A Claude session has no OpenCode record. `server/index.js` injects a `claudeSessionMetadata` adapter (`{ isClaudeSession, get, merge }`, backed by the Claude registry), and both metadata routes branch to it when it says the session is Claude's:

- `GET` answers `{ metadata }` from the registry's stored object, or `{}` for a session the registry does not know — the same envelope the OpenCode path answers.
- `POST` applies the same RFC 7386 merge patch on the registry record through `mergeSessionMetadata`, which re-asserts `openchamber.backend = 'claude'` after the merge (a patch cannot turn a Claude session into anything else), persists the index, and emits the runtime's own `session.metadata.updated` wire event. The route then broadcasts `openchamber:session-metadata` with the full merged object on the UI control stream — the broadcast this route always sends. The OpenCode metadata store is not touched, and the runtime's wire event is not duplicated by the route.

`directory` is accepted on both routes for call-shape parity with the OpenCode store; a Claude session is found by id alone. Without the injected adapter the routes serve OpenCode alone, which is what module tests use.

## Archive state

OpenCode 2.x still carries `SessionInfo.time.archived` on the wire (sessions migrated from v1 keep the flag) but has no route that sets or clears it, so archiving is OpenChamber's own state: one JSON file per data dir, `sessions-archive.json`, shaped `{ [sessionID]: archivedAt | null }`.

- Writes stay disabled until one load has told the store what is already on disk; a failed read is not evidence that nothing is archived, so the store answers reads from memory and refuses writes, and a later call retries the load. Malformed bytes are renamed to a `.corrupt-<timestamp>` backup instead of being overwritten, and whatever the process already knows stays in memory.
- `archive`/`unarchive` apply a batch as one transaction: memory mutates, the file is rewritten atomically (temp file in the same directory, then a rename), and a failed write rolls the memory back. Batches are serialized, so a rollback cannot erase a later batch.
- A successful mutation broadcasts `openchamber:session-archived` per session with the new stamp (`null` for unarchive). The proxy folds the state onto the session records it serves: a number archives, `null` drops a stamp OpenCode still carries, and a session the file does not mention keeps OpenCode's answer.

## Fork inheritance

OpenCode 2.x copies the source session's `metadata` wholesale into a fork, so the goal already arrives. `applyForkInheritance` repairs the two things that must not: source-owned links (`btwSessionID`, `reviewSessionID`, and the btw marker keys when the source is itself a btw side thread) are removed, an active goal arrives paused (`paused in fork`), and a file-backed goal objective is copied to the fork — when the copy fails, the fork's goal carries the text inline instead. It is best-effort: the fork already exists and is usable, so every failure is logged and swallowed. The module is the server twin of the UI's `packages/ui/src/lib/sessionForkInheritance.ts`: UI forks call OpenCode directly and repair themselves; forks made through this API are repaired here.

## Session links

`session-link.js` turns the agent's service-neutral record (`url`, `title`, `kind`, optional `identifier`) into the `openchamber.linked_issues` entry the UI reads. Only the URL decides what the thing is: a GitHub pull or issue address becomes that entry, a Linear issue address the Linear entry, anything else an `external` entry. Re-linking refreshes the snapshot (a renamed pull request) and keeps the original link time and position; a link that is already there unchanged writes nothing. Linking only adds or refreshes — removing a link stays with the user. `createSessionLinker` is what the control service's `session.link` calls.

## Testing

- `bunx vitest run server/lib/openchamber-sessions` from `packages/web` runs the whole module: `routes.test.js`, `archive-store.test.js`, `session-metadata-store.test.js`, `fork-inheritance.test.js`, `opencode-client.test.js`, and `session-link.test.js` (the last is a `bun:test` suite, run through the repo's shim).

## Notes for contributors

- Archive state and the metadata store are per data dir; both are keyed by session id and hold no directory.
- Keep the metadata route envelopes identical across backends: clients read `{ metadata }` without knowing which backend answered.
- The store's writes are per-session serialized; do not add a second write path to a session's metadata without going through `sessionMetadataStore` (or, for Claude sessions, the registry's `mergeSessionMetadata`).
