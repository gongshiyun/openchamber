/**
 * The `Access-Control-Allow-Headers` value for the OpenChamber backend.
 *
 * The packaged desktop UI (`openchamber-ui://app`) and a development UI run on
 * an origin of their own, so the browser sends a CORS preflight for any request
 * that carries a header outside the CORS-safelisted set. A custom header that
 * is missing from this list makes the browser refuse the request at preflight,
 * before it reaches a route. The Claude backend's session create broke that way
 * once: the UI sent `x-openchamber-backend` while the list did not name it.
 *
 * Why each custom entry is here, with its sender:
 * - `X-OpenCode-Directory` and `X-OpenCode-Directory-Encoding`: OpenCode 2.x
 *   directory scoping. The encoding marker says the directory value is
 *   URI-encoded (`packages/ui/src/lib/runtime-fetch.ts`).
 * - `Ngrok-Skip-Browser-Warning`: skips the ngrok interstitial for tunneled
 *   runtimes (`packages/ui/src/lib/runtime-fetch.ts`).
 * - `X-OpenChamber-Backend`: routes a session create to the Claude backend
 *   (`packages/ui/src/lib/sessionBackend.ts`).
 * - `X-OpenChamber-Provider` and `X-OpenChamber-Model`: guest generate scoping
 *   (`packages/ui/src/lib/guests/generate.ts`).
 * - `X-OpenChamber-Surface`: legacy settings-surface header. The server still
 *   honours it for older clients; current clients send the query parameter
 *   instead (`packages/web/server/lib/opencode/settings-files.js`).
 * - `Authorization`, `Content-Type`, `Accept` and `Cache-Control`: the bearer
 *   token, JSON or SSE bodies, and cache directives the shared UI and the
 *   OpenCode SDK send (`packages/ui/src/lib/runtime-auth.ts`,
 *   `packages/ui/src/lib/opencode/client.ts`, `packages/ui/src/stores/useSnippetsStore.ts`).
 * - `X-Requested-With`: no sender in this repo; kept because a client built
 *   before the header was dropped may still send it.
 *
 * `cors-headers.test.js` asserts this list carries every header a shared-UI
 * client can send. When a client adds a custom request header, add it here and
 * to that test in the same change.
 */
export const CORS_ALLOWED_HEADERS = 'Content-Type,Authorization,Accept,X-Requested-With,Cache-Control,X-OpenCode-Directory,X-OpenCode-Directory-Encoding,Ngrok-Skip-Browser-Warning,X-OpenChamber-Surface,X-OpenChamber-Provider,X-OpenChamber-Model,X-OpenChamber-Backend';
