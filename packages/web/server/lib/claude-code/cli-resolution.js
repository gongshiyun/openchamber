import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Windows shims are batch scripts: spawn(shell: false) cannot execute them
// directly, and `cmd.exe /c` without `call` would replace itself with the
// shim's first command instead of running the shim and returning.
const WINDOWS_BATCH_EXTENSIONS = new Set(['.cmd', '.bat']);

// npm publishes the CLI as a JavaScript entry (cli.js). Running it needs a
// Node interpreter this module does not own, so v1 refuses the path here and
// the caller reports the configured value as unsupported.
const JAVASCRIPT_EXTENSION = '.js';

const trimPath = (value) => String(value ?? '').trim();

// Names probed on PATH, best candidate first: the native installer ships
// `claude.exe`, a global npm install is a `claude.cmd` shim, and a bare
// extensionless `claude` is the last PATH candidate.
const claudeSearchNames = (platform) => (platform === 'win32'
  ? ['claude.exe', 'claude.cmd', 'claude']
  : ['claude']);

// Install locations a PATH-less process (packaged Electron, a service) still
// has to find: the per-user local install, npm's global shim directory on
// Windows, and the native install location.
const claudeFallbackPaths = (env, platform) => {
  const home = trimPath(env?.HOME) || trimPath(env?.USERPROFILE);
  const fallbacks = [];
  if (home) {
    fallbacks.push(path.join(home, '.claude', 'local', 'claude'));
  }
  if (platform === 'win32') {
    const appData = trimPath(env?.APPDATA);
    if (appData) {
      fallbacks.push(path.join(appData, 'npm', 'claude.cmd'));
    }
  }
  if (home) {
    fallbacks.push(path.join(home, '.local', 'bin', 'claude'));
  }
  return fallbacks;
};

// Default PATH probe used when the caller injects none. Tests replace it with
// a recording fake, so the real filesystem is only ever touched in production.
const createPathSearch = (env, exists) => (name) => {
  const rawPath = env?.PATH ?? env?.Path ?? '';
  for (const dir of String(rawPath).split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return null;
};

/**
 * Resolve the absolute path of the user's `claude` CLI, or null when none is
 * found.
 *
 * Order: the `settings.claudeBinary` override, then `CLAUDE_BINARY`, then a
 * PATH search, then the known install locations. Every candidate must exist;
 * a stale override falls through to the next source instead of being returned.
 * All IO is injected so tests never touch the real filesystem: `exists(path)`
 * answers whether a candidate is real, and `searchPath(name)` probes PATH and
 * returns an absolute path or null.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   settings?: { claudeBinary?: string },
 *   platform?: string,
 *   exists?: (path: string) => boolean,
 *   searchPath?: (name: string) => string | null,
 * }} [options]
 * @returns {string | null} The CLI path, or null when nothing exists.
 */
export function resolveClaudeCliPath({
  env = process.env,
  settings = {},
  platform = process.platform,
  exists = fs.existsSync,
  searchPath,
} = {}) {
  const explicit = [settings?.claudeBinary, env?.CLAUDE_BINARY].map(trimPath).filter(Boolean);
  for (const candidate of explicit) {
    if (exists(candidate)) return candidate;
  }

  const probePath = searchPath ?? createPathSearch(env, exists);
  for (const name of claudeSearchNames(platform)) {
    const found = probePath(name);
    if (found) return found;
  }

  for (const candidate of claudeFallbackPaths(env, platform)) {
    if (exists(candidate)) return candidate;
  }

  return null;
}

/**
 * Build the spawn spec for a resolved CLI path, or null when v1 cannot run it.
 *
 * On Windows a `.cmd`/`.bat` shim goes through the command interpreter
 * (`comSpec`, defaulting to `%ComSpec%` when the caller does not supply one),
 * while `.exe` and extensionless executables run as-is. A bare `.js` entry is
 * refused: it needs a Node interpreter this module does not own, and the
 * caller reports the configured path as unsupported.
 *
 * @param {string} cliPath Absolute path returned by resolveClaudeCliPath.
 * @param {{ platform?: string, comSpec?: string }} [options]
 * @returns {{ command: string, args: string[] } | null} The spawn spec, or null.
 */
export function buildClaudeLaunchSpec(cliPath, { platform = process.platform, comSpec } = {}) {
  const command = trimPath(cliPath);
  if (!command) return null;

  const extension = path.extname(command).toLowerCase();
  if (extension === JAVASCRIPT_EXTENSION) return null;

  if (platform !== 'win32') {
    return { command, args: [] };
  }

  if (WINDOWS_BATCH_EXTENSIONS.has(extension)) {
    return {
      command: comSpec || process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'call', command],
    };
  }

  return { command, args: [] };
}

// A CLI that answers `--version` within five seconds is available; a longer
// wait (a hang, an interactive prompt) is not something a startup probe should
// hold onto, so the child is killed at this deadline.
const PROBE_TIMEOUT_MS = 5000;
// A zero-exit probe that printed nothing still answers "it runs"; only the
// version is unknown.
const UNKNOWN_VERSION = 'unknown';

/** The first non-empty trimmed line of `text`, or null when there is none. */
const firstNonEmptyLine = (text) => {
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return null;
};

/**
 * Run the resolved CLI once (`--version` appended to the spec's args) to
 * report whether it actually runs.
 *
 * The spawn is injected, and the call never throws or rejects: a null launch
 * spec (the `.js` refusal), a spawn that fails or throws, a non-zero exit, and
 * a child that outlives `timeoutMs` (it is killed, then reported) all resolve
 * as `{ ok: false, error }`. A zero exit resolves `{ ok: true, version }`,
 * where the version is the first non-empty trimmed line of the collected
 * stdout/stderr — `'unknown'` when the CLI printed nothing.
 *
 * @param {{
 *   launchSpec: { command: string, args: string[] } | null,
 *   spawnImpl?: (command: string, args: string[], options: { windowsHide: boolean, stdio: string[] }) => import('node:child_process').ChildProcess,
 *   timeoutMs?: number,
 * }} [options]
 * @returns {Promise<{ ok: true, version: string } | { ok: false, error: string }>}
 */
export function probeClaudeCli({ launchSpec, spawnImpl = spawn, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  if (!launchSpec || !trimPath(launchSpec.command)) {
    return Promise.resolve({ ok: false, error: 'unsupported executable' });
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(launchSpec.command, [...launchSpec.args, '--version'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ ok: false, error: `${error?.message ?? error}` });
      return;
    }

    const stdout = [];
    const stderr = [];
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // The process may already be gone.
      }
      settle({ ok: false, error: 'timed out' });
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on('data', (chunk) => stdout.push(String(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
    // A spawn that fails (a missing or unreadable executable) reports through
    // 'error' and never closes; without this the probe would sit until its
    // timeout for a child that never ran.
    child.on('error', (error) => settle({ ok: false, error: `${error?.message ?? error}` }));
    child.on('close', (code) => {
      if (code === 0) {
        settle({ ok: true, version: firstNonEmptyLine([...stdout, ...stderr].join('')) ?? UNKNOWN_VERSION });
        return;
      }
      const reported = String(stderr.join('')).trim();
      settle({ ok: false, error: reported || `exit code ${code}` });
    });
  });
}
