# Lessons

## 2026-10-11 — Trial packaging must rebuild the web assets

**What happened.** The desktop trial app was rebuilt several times with
`bun run bundle:main` + `node ./scripts/package.mjs` only. Those two steps
package whatever `packages/electron/resources/web-dist` already holds, so the
app kept serving the UI built at 10:46 while the sprint's UI commits landed at
15:xx–16:31. The user hit the stale UI (no Claude permission-mode/effort
controls, OpenCode-only entries not hidden) and reported it as missing
features.

**Rule.** A trial rebuild that should reflect UI changes must run
`bun run --cwd packages/electron build:web-assets` first (it builds
`packages/web/dist` and stages it into `resources/web-dist`), then
`bundle:main`, then `package.mjs`. Verify by checking the timestamps of
`dist/win-unpacked/resources/web-dist/assets/*` against the last UI commit.

**Why it was missed.** The server-side verification scripts all passed
(they exercise the API, not the packaged UI), so nothing failed loudly. Any
"UI change verified" claim about the trial app needs a look at the packaged
assets or the running app, not just tests.

## 2026-10-11 — Trial rebuild needs the app stopped

`electron-builder` cannot overwrite `dist/win-unpacked` while the trial app
runs from it (DLL locks). Kill `win-unpacked` processes first; if the user is
mid-turn, ask or wait, because killing the app interrupts their running turn.
