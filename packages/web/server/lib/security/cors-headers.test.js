import { describe, expect, test } from 'bun:test';
import { CORS_ALLOWED_HEADERS } from './cors-headers.js';

// Every custom request header a shared-UI client can send must be named in
// CORS_ALLOWED_HEADERS. When a client adds one, extend the constant and this
// list together: a header missing from the constant makes the packaged desktop
// UI and the dev UI fail at CORS preflight, before the request reaches a route.
const REQUIRED_HEADERS = [
  // Bearer token, JSON bodies, SSE, cache directives (runtime-auth.ts,
  // opencode/client.ts, stores/useSnippetsStore.ts).
  'content-type',
  'authorization',
  'accept',
  'cache-control',
  // No sender in this repo; kept because an older client may still send it.
  'x-requested-with',
  // OpenCode 2.x directory scoping (runtime-fetch.ts, opencode/client.ts).
  'x-opencode-directory',
  'x-opencode-directory-encoding',
  // ngrok tunneled runtimes (runtime-fetch.ts).
  'ngrok-skip-browser-warning',
  // Legacy settings surface, still honoured for older clients
  // (packages/web/server/lib/opencode/settings-files.js).
  'x-openchamber-surface',
  // Guest generate scoping (guests/generate.ts).
  'x-openchamber-provider',
  'x-openchamber-model',
  // Claude backend session create (sessionBackend.ts).
  'x-openchamber-backend',
];

const parseAllowedHeaders = () => CORS_ALLOWED_HEADERS.split(',').map((entry) => entry.trim());

describe('CORS allowed headers', () => {
  test('lists every header a shared-UI client can send', () => {
    const allowed = parseAllowedHeaders().map((entry) => entry.toLowerCase());
    for (const header of REQUIRED_HEADERS) {
      expect(allowed).toContain(header);
    }
  });

  test('has no duplicates or empty entries', () => {
    const entries = parseAllowedHeaders();
    expect(entries.every((entry) => entry.length > 0)).toBe(true);
    expect(new Set(entries.map((entry) => entry.toLowerCase())).size).toBe(entries.length);
  });
});
