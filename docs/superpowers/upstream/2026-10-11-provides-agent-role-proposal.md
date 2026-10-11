# Proposal draft: `provides: ["agent"]` — an SDK service role for agent backends

**Date:** 2026-10-11
**Status:** Draft for review. Nothing has been posted upstream, and no upstream interest is claimed.
**Origin:** OpenChamber fork at this checkout, branch `feat/claude-code-backend` (base `main` at `7bd52e1`).
**Purpose:** an upstream proposal draft plus a ready-to-post Ideas discussion text (section 5). The fork maintainer reviews this and decides whether and when to post it.

This document has two jobs: to lay out the proposal for a maintainer review, and to carry the exact text to post if the review says yes. Everything below is grounded in files named in the References section; claims that are fork design decisions rather than existing upstream behavior are marked as such.

## 1. Problem: one hard-coded agent backend

OpenChamber has exactly one agent backend today: OpenCode.

- The server forwards `/api/*` to `opencode serve`; the shared UI consumes OpenCode v2 wire events and data shapes, centralized in `packages/ui/src/lib/opencode/`. The session lifecycle is stateless REST plus an event stream: `session.create/list/get/update/remove`, `message.list`, `session.prompt`, `session.interrupt`, `session.switchModel/switchAgent`, `permission.reply`, with events on the WS channel (`/api/global/event/ws`) and the SSE fallback (`/api/event`). (design spec §2.1–2.3)
- The extension system cannot replace the chat backend. Panels are sandboxed iframes with no terminal, no git, and no access beyond declared grants. A `service` adds a host-spawned local process, but the only host role a service can stand in for is `browser` (`GUEST_SERVICE_PROVIDES = ['browser']`). The third-party `@openchamber/opencode-claude` is a model-provider plugin for OpenCode, not a backend. (README §Scope; `manifest.ts`; design spec §2.5)

This fork implements Claude Code as a second backend in core code: `packages/web/server/lib/claude-code/` answers the OpenCode v2 route subset for the sessions it owns, translates the Agent SDK's message stream into OpenCode v2 wire events, and injects them into the global event hub. The existing chat UI renders those sessions with no client change, because the server speaks the shapes the UI already consumes. (module doc §Purpose, §Wire-event contract)

That is the feasibility evidence: an agent backend can be an adapter behind the existing wire contract. But shipping one CLI's adapter as core code is not a shape upstream should take for every backend, and the fork's own design says the upstream-friendly path is an SDK role following the existing `provides: ["browser"]` precedent. (design spec §1, §9)

The fork was built for a per-session choice between backends (design spec §1). This document does not claim that demand is shared upstream; it proposes a mechanism, not a roadmap item.

## 2. Precedent: `provides: ["browser"]`

### What the role does

The host's `openchamber_web` tool gives agents ten `browser.*` actions. By default a connected desktop app answers them with its in-app browser panel; on a server with no desktop client the agent gets nothing. A service that declares `provides: ["browser"]` can answer instead, from a browser it runs itself. The agent sees one tool either way. (GUEST_SERVICES.md §Browser provider)

The role solves the same class of problem this proposal has: a host capability that is normally served in-process (or by a renderer) can be delegated to a host-spawned extension service without changing what the caller sees.

### How a provider is selected

- The user picks it in Settings → General → OpenChamber Tools → Browser provider. The dropdown lists installed, enabled, fully approved extensions with the role; with none it shows only "OpenChamber Web", disabled. (GUEST_SERVICES.md §Browser provider)
- The choice is `browserProvider` in the instance's `settings.json`: `builtin` or the extension id. It is read on every action, so a change applies to the next action without a restart. (GUEST_SERVICES.md §Browser provider)
- Pausing, removing, or withdrawing approval from the selected extension puts `builtin` back and every open client shows a toast saying so; the same happens on the next action if the extension became unusable any other way. (GUEST_SERVICES.md §Browser provider)
- The host-side code re-checks the catalog on every action (`isBrowserProviderGuest`: enabled, fully approved, has the role). A settings or catalog read that fails is not a reset: the action fails with 503, nothing runs anywhere, and the choice stays — an action must never land in a browser the user did not pick. (browser-control/DOCUMENTATION.md §Boundaries; `provider.js`)

### What the host owns, what the service owns

- Host: the tool surface and its parameter validation, spawn/kill of the service, the loopback proxy, the timeouts (45 s for `browser.open`, 20 s for other actions), the response cap (12 MB), and the idle stop (10 minutes without an action; the next action starts the service again). The host starts the service on the first action, so the agent can browse with no panel open. (GUEST_SERVICES.md §Browser provider)
- Service: the browser itself. It answers with the same data shapes the desktop app's own panel answers, so an agent prompt written against one works against the other. The types are exported from `@openchamber/sdk` (`BrowserProviderData`, `BrowserOpenParameters`, …). (GUEST_SERVICES.md §Browser provider; `service-providers.ts`)

### Manifest and wire

- Manifest: `contributes.service.provides: ["browser"]`. A service that provides a role needs no `panel.entry` or `background.entry`; the host starts it itself. (GUEST_SERVICES.md §Manifest; `manifest.ts`)
- Wire: `POST /browser-control` on the service loopback, same bearer token as every service request, JSON body `{ requestId, action, parameters, context }`; the answer is `{ ok: true, data }` or `{ ok: false, error }`. `readBrowserProviderRequest` from `@openchamber/sdk` parses the body; `browserProviderResultSchema` parses the answer. (GUEST_SERVICES.md §Wire; `service-providers.ts`)
- `context` (`{ directory, sessionId }`, either `null` when unknown) says which project and chat the action came from; the host fills it from the tool call, the model never types it. (GUEST_SERVICES.md §Wire)

## 3. Proposal: `service.provides: ["agent"]`

### Manifest sketch

Mirrors the browser precedent and the checked-in `browser-provider-stub` example. A panel is optional; the `panel` object alone carries the extension's identity for Settings and the approval dialog, and only `panel.entry` creates a visible rail icon. (README; `examples/browser-provider-stub/package.json`)

```json
{
  "name": "@acme/claude-code",
  "version": "1.0.0",
  "openchamber": {
    "apiVersion": 1,
    "engines": { "openchamber": ">=1.xx.0" },
    "contributes": {
      "panel": { "id": "acme-claude-code", "name": "Claude Code", "icon": "robot" },
      "service": {
        "entry": "service/main.js",
        "runtime": "host",
        "provides": ["agent"],
        "permissions": { "exec": ["claude"] }
      }
    }
  }
}
```

The parse side today accepts only `"browser"` in `provides`; an unknown role is refused as `invalid-service`. Adding a role is a small, additive manifest/parse change. (`parse.ts`, `parse.test.ts`)

### Host-side selection: `agentProvider`

Proposed to mirror `browserProvider`, with one intentional difference — binding is per session, not per action:

- `agentProvider` in the instance's `settings.json`: `builtin` (OpenCode) or an installed extension id. Read when the host builds the backend picker and when a session is created, so a change applies to new sessions without a restart.
- The picker offers OpenCode plus every installed, enabled, fully approved extension with the `agent` role (in the common case, one). Per-session selection is the fork's design: a new session picks its backend, the session record is bound to it, and the list mixes backends and badges the source. (design spec §1, §3.2)
- In the fork, the session record carries `metadata.openchamber.backend = 'claude'` and the sidebar badge and UI checks read that marker. A generalized role would store the provider extension id in the same place; the exact field is a host-side detail. (module doc §Creating a Claude session)
- Deactivation semantics mirror the browser role: pausing, removing, or withdrawing approval from the selected extension resets `agentProvider` to `builtin` and tells open clients. Existing sessions keep their bound backend; their next request fails visibly rather than being silently rerouted. A settings or catalog read failure fails the request; it never substitutes another backend. (GUEST_SERVICES.md §Browser provider; browser-control/DOCUMENTATION.md §Boundaries)

### Service wire sketch

The host proxies its session-scoped routes for the sessions a service owns to that service's loopback (same bearer, same spawn model as every service), and the service answers with OpenCode v2 methods, statuses, and envelopes. The fork's adapter already implements exactly this subset, pinned to the generated client, which is what makes it the evidence for this sketch: (module doc §The route subset)

| Route (host → service, prefix as proposed) | Method | Answer |
| --- | --- | --- |
| `/agent/session` | POST | `200 { data }` — only when the create names this backend |
| `/agent/session/:id` | GET | `200 { data }` |
| `/agent/session/:id` | PATCH | `204` — rename only |
| `/agent/session/:id` | DELETE | `204` |
| `/agent/session/:id/move` | POST | `204` |
| `/agent/session/:id/model` | POST | `204` |
| `/agent/session/:id/agent` | POST | `204` |
| `/agent/session/:id/prompt` | POST | `200 { data }` |
| `/agent/session/:id/synthetic` | POST | `200 { data }` |
| `/agent/session/:id/interrupt` | POST | `200 { interrupted }` |
| `/agent/session/:id/message` | GET | `200 { data, cursor }` |
| `/agent/session/:id/permission/:permID/reply` | POST | `204` |

Notes grounded in the implemented adapter:

- **Create.** The host decides which backend owns the create and calls that service. In the fork the marker is the `x-openchamber-backend: claude` request header, chosen because the server's streaming proxy leaves `/api/session` bodies unparsed and the re-serialization path has a history of bugs. For a role contract the marker mechanism is host-internal; the point to keep is that it must not depend on parsing the create body. (design spec §2.4, §3.3; module doc §Creating a Claude session)
- **Prompt.** The call answers `200 { data }` quickly; the turn's progress arrives as events. That is OpenCode v2 semantics, and the adapter keeps it. (module doc §The route subset)
- **Errors.** OpenCode's tagged body `{ _tag, message }`: `400 InvalidRequestError`, `404 SessionNotFoundError` / `PermissionNotFoundError`. The shared UI maps the tag back to a status. (module doc §The route subset)
- **History.** `message.list` keeps OpenCode v2 page semantics: `order` defaults to newest first, `cursor` is a message id the page starts strictly after, `next` is present only while more records remain. History answers from the service's own transcript, with no live process needed. (module doc §The route subset)
- **Permissions.** The service emits `permission.asked` (`{ id, action, resources, message, metadata: { toolName, input } }`) when its agent wants approval, and parks the call. The reply route takes `{ decision: "once" | "always" | "reject" }`; every decision emits `permission.replied`. Which tools reach the callback is the service's own policy. The fork's adapter mints `per_` ids, remembers `always` per session, and denies parked calls on abort or dispose so nothing stays parked. (module doc §Permissions)

**Events.** The service emits OpenCode v2 wire events; the host injects them into the global hub exactly as the fork's adapter does (`injectEvent({ payload, directory, spaceId: null })`), so the WS channel and the SSE fallback carry them and no client changes. The exact vocabulary the adapter emits, and the one a role contract would need to cover: (module doc §Wire-event contract)

- Registry: `session.created`, `session.renamed`, `session.moved`, `session.deleted`, `session.model.selected`, `session.agent.selected`, `session.metadata.updated`, `session.synthetic`
- Execution: `session.execution.started`, `session.execution.succeeded`, `session.execution.interrupted`, `session.execution.failed`
- Steps: `session.step.started`, `session.step.ended`, `session.step.failed`
- Content: `session.text.started/delta/ended`, `session.reasoning.started/delta/ended`
- Tools: `session.tool.input.started/delta/ended`, `session.tool.called`, `session.tool.success`, `session.tool.failed`
- Permissions: `permission.asked`, `permission.replied`

The vocabulary is load-bearing: the UI's `translateWireEvent` silently drops unknown types, so emitting a translator's output-side name (`message.updated`, `session.error`, …) instead of a wire name makes streaming content vanish. The fork pins this with contract tests that feed the UI's own `translateWireEvent`. (module doc §Wire-event contract, §Notes for contributors)

**The streaming gap.** A request/response proxy is not enough for an agent: turns stream events over time. Service → host streaming is explicitly deferred in the SDK today ("Streaming from a service to the panel … is deferred; it needs a streaming call on the SDK first"). This role therefore needs a new service → host event channel — one possible shape is a long-lived `GET /agent/events` SSE on the service loopback that the host subscribes to and re-publishes through `injectEvent`. That channel's exact form is the main open design question in this proposal. (GUEST_SERVICES.md §Example)

**Lifecycle.** The host starts the service on the first routed request, like the browser provider starts on the first action, and stops it after an idle window. The fork implements the same pattern: one process per live session, lazy start on the first prompt, a 15-minute idle reap, and `resume` on the next prompt so a reaped session continues its history. Idle policy could be provider-defined, with the host only enforcing the stop. (module doc §Lifecycle; GUEST_SERVICES.md §Browser provider)

### Open questions

1. **Wire vocabulary.** Reuse the OpenCode v2 subset (what the fork speaks and what the UI already consumes; zero UI change, but ties extensions to internal shapes) or define a backend-neutral shape (cleaner, but every UI consumer changes). The fork is evidence for the former; the choice is the maintainer's.
2. **Streaming channel.** What service → host event call the SDK adds: SSE, chunked response, WebSocket, or something else. Ordering, reconnect, and backpressure semantics need defining either way.
3. **Selection granularity.** `browserProvider` is one global choice; an agent backend wants per-session binding (fork design §1). One provider per instance, or a picker listing every installed `agent`-role extension per session?
4. **Trust text.** An agent-role service is far more powerful than a browser provider (see section 4). The approval dialog and extension card need a specific, plain-words description of what it can do, and the role may deserve a stronger gate than the standard `service` capability.
5. **Reach.** The guest catalog is unsupported in VS Code and mobile (they do not spawn services), so an extension-provided backend would not exist there, unlike a server-side adapter. (GUEST_SERVICES.md §Host hole)

## 4. Trust and scope notes

- **Services run with the user's full access.** `exec`/`sockets` permission lists are advisory and shown in the approval dialog, which says in plain words that an allowed service can run any command, use git, and read or write any file the user can. There is no OS sandbox. (GUEST_SERVICES.md §Security invariants, §Manifest)
- **The host does not hand a service its secrets.** A service does not inherit the host environment: only PATH, HOME, temp, locale, and the Windows system variables are copied. API keys, the UI password, and other host secrets never reach it. (GUEST_SERVICES.md §Model)
- **Credentials stay with the agent CLI.** The fork's adapter reads, stores, and forwards no Claude credentials; the user's own `claude` CLI configuration authenticates the agent. A generalized role should keep that boundary: OpenChamber's own provider credentials must not be passed to a service. (module doc §Purpose)
- **An agent role is a bigger trust step than browser.** The service receives prompts and project content and can act on the machine with the user's rights. The approval text should say exactly that, and the extension card should say which CLI or runtime it drives.
- **Per-session visibility.** The user must be able to see which backend a session is on (the fork badges the session and marks the record). Changing `agentProvider` affects new sessions; existing sessions keep their backend. Deactivation resets the setting for future sessions with a visible notice; it never silently reroutes a live session. (Mirror of `browserProvider` reset semantics; per-session part is fork design §1, §3.2.)
- **What stays OpenChamber's:** the chat UI, the sessions list, the permission dialog, the backend picker, badges, the event hub, routing and ownership checks, spawn/proxy, and the selection setting with its reset semantics. The service owns its agent loop, its process, its transcript, resume state, and its permission decisions. This is the same host/service split the browser role uses. (module doc §What this module does not own; GUEST_SERVICES.md §Browser provider)
- **Scope difference to accept knowingly:** the fork's adapter is server-side and shared by the surfaces that connect to that server (the fork's plan verifies Web/Desktop; VS Code and mobile are out of its v1 scope). An extension role exists only where extensions exist. (design spec §6, Appendix B; GUEST_SERVICES.md §Host hole)

## 5. Ready-to-post discussion text

Posting is the maintainer's decision. If approved, this is the text to post as an upstream Ideas discussion; the contribution process expects an agreed idea before any pull request.

**Suggested title:** Proposal: an extension service role for agent backends (`provides: ["agent"]`)

**Body:**

```text
OpenChamber has one agent backend today, OpenCode. I wanted to use Claude Code for
some sessions, so I built an adapter in a fork: it answers the OpenCode v2 session
routes for the sessions it owns and emits the same wire events, so the existing UI
renders those sessions without changes.

The extension system already has this shape for one host role: provides: ["browser"]
lets a service answer the agent's browser actions in place of the in-app browser,
with the provider picked by browserProvider in settings.json. I would like to
propose the same for agent backends: provides: ["agent"], where a service owns the
agent loop for the sessions the host routes to it, and an agentProvider setting
picks the installed extension that plays that role. Selection would be per session,
so a project can mix OpenCode and extension-backed chats.

A reference implementation exists in my fork (branch feat/claude-code-backend, not
published yet); happy to share it or open a PR if the direction seems right.
Open questions I would not want to guess at:

- the wire vocabulary: reuse the OpenCode v2 subset my adapter already speaks, or
  define a backend-neutral shape;
- the service-to-host event channel: streaming from a service is deferred in the
  SDK today, and an agent backend needs one;
- selection: one provider for the instance, or the per-session pick my fork does.
```

## 6. Status and next steps

- This document is a draft. Nothing has been posted upstream, and no upstream interest is claimed anywhere in it.
- Decisions that belong to the maintainer before posting or code:
  1. Whether the role belongs in the SDK at all.
  2. Wire vocabulary: OpenCode v2 subset vs. a neutral shape.
  3. The service → host event channel and its semantics.
  4. Selection granularity and reset behavior.
  5. Trust text and gating for an agent-role service.
  6. Whether the fork's adapter should be offered as the reference implementation.
- Posting requires the maintainer. After posting, add the discussion link to this file; do not open a PR before the idea is agreed.

## References

What each file grounds in this document:

- `packages/sdk/GUEST_SERVICES.md` — the service contract, the `provides: ["browser"]` role and its selection, the `browserProvider` setting and reset semantics, host vs. service ownership, the wire shape, the deferred service streaming, security invariants, and the VS Code/mobile limitation.
- `packages/sdk/README.md` — manifest shape, extension capabilities, the service summary, and the no-panel identity rule.
- `packages/sdk/src/manifest.ts`, `packages/sdk/src/parse.ts`, `packages/sdk/src/parse.test.ts` — `GUEST_SERVICE_PROVIDES = ['browser']`, parse rules for roles, `requestedGuestCapabilities`/`isGuestApproved`.
- `packages/sdk/src/service-providers.ts` — the browser provider wire types, path constant, timeouts, idle stop, and `readBrowserProviderRequest`.
- `packages/web/server/lib/browser-control/DOCUMENTATION.md` and `provider.js` — how the host selects the provider today: read per action, reset on deactivation, read failure is not a reset.
- `packages/sdk/examples/browser-provider-stub/package.json` — the checked-in manifest example for a role-providing service.
- `docs/superpowers/specs/2026-10-10-claude-code-backend-design.md` — fork goals (per-session backend choice), the evidence for the adapter approach, the upstream intent (following the browser precedent), the v1 matrix, and the acceptance plan.
- `packages/web/server/lib/claude-code/DOCUMENTATION.md` — the implemented adapter: route subset and envelopes, wire-event vocabulary and injection, permission bridge, lifecycle (lazy start, idle reap, resume), persistence, and what the module does not own.
