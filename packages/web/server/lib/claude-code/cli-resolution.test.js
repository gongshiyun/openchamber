import { EventEmitter } from 'node:events';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildClaudeLaunchSpec, probeClaudeCli, resolveBundledClaudeCliPath, resolveClaudeCliPath } from './cli-resolution.js';

// searchPath is the resolver's only PATH IO, so a recording fake both answers
// the lookup and proves which candidate names were asked for, and in which
// order. The real filesystem is never touched.
const recordingSearchPath = (hits = {}) => {
  const calls = [];
  const searchPath = (name) => {
    calls.push(name);
    return hits[name] ?? null;
  };
  return { calls, searchPath };
};

const missSearchPath = () => null;

/**
 * A fake `spawnImpl` answering one canned run. The child is an EventEmitter
 * with `stdout`/`stderr` emitters and a `kill` that records the call; with
 * `close: false` it never closes (the timeout path), and an `error` is
 * emitted instead of any output. Output and exit are emitted after the probe
 * has attached its listeners, like a real child.
 */
const createFakeSpawn = ({ stdout = '', stderr = '', code = 0, close = true, error = null } = {}) => {
  const calls = [];
  const children = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killCalls = 0;
    child.kill = () => {
      child.killCalls += 1;
    };
    calls.push({ command, args, options });
    children.push(child);
    if (error) {
      queueMicrotask(() => child.emit('error', error));
    } else if (close) {
      queueMicrotask(() => {
        if (stdout) child.stdout.emit('data', stdout);
        if (stderr) child.stderr.emit('data', stderr);
        child.emit('close', code);
      });
    }
    return child;
  };
  return { calls, children, spawnImpl };
};

describe('resolveClaudeCliPath', () => {
  it('prefers settings.claudeBinary over CLAUDE_BINARY and PATH', () => {
    const settingsPath = 'C:\\settings\\claude.exe';
    const { calls, searchPath } = recordingSearchPath({ 'claude.exe': 'C:\\path\\claude.exe' });

    const resolved = resolveClaudeCliPath({
      env: { CLAUDE_BINARY: 'C:\\env\\claude.exe' },
      settings: { claudeBinary: settingsPath },
      platform: 'win32',
      exists: (candidate) => candidate === settingsPath,
      searchPath,
    });

    expect(resolved).toBe(settingsPath);
    expect(calls).toEqual([]);
  });

  it('uses CLAUDE_BINARY when settings has no override', () => {
    const envPath = 'C:\\env\\claude.cmd';
    const { calls, searchPath } = recordingSearchPath({ 'claude.exe': 'C:\\path\\claude.exe' });

    const resolved = resolveClaudeCliPath({
      env: { CLAUDE_BINARY: envPath },
      settings: {},
      platform: 'win32',
      exists: (candidate) => candidate === envPath,
      searchPath,
    });

    expect(resolved).toBe(envPath);
    expect(calls).toEqual([]);
  });

  it('trims surrounding whitespace from configured paths', () => {
    const settingsPath = 'C:\\settings\\claude.exe';

    const resolved = resolveClaudeCliPath({
      env: {},
      settings: { claudeBinary: `  ${settingsPath}  ` },
      platform: 'win32',
      exists: (candidate) => candidate === settingsPath,
      searchPath: missSearchPath,
    });

    expect(resolved).toBe(settingsPath);
  });

  it('skips configured paths that do not exist on disk', () => {
    const resolved = resolveClaudeCliPath({
      env: { CLAUDE_BINARY: 'C:\\missing\\claude.exe' },
      settings: { claudeBinary: 'C:\\gone\\claude.exe' },
      platform: 'win32',
      exists: () => false,
      searchPath: missSearchPath,
    });

    expect(resolved).toBeNull();
  });

  it('finds claude on PATH when nothing is configured', () => {
    const pathHit = 'C:\\nodejs\\claude.exe';
    const { searchPath } = recordingSearchPath({ 'claude.exe': pathHit });

    const resolved = resolveClaudeCliPath({
      env: {},
      platform: 'win32',
      exists: () => false,
      searchPath,
    });

    expect(resolved).toBe(pathHit);
  });

  it('on win32 probes claude.exe, then claude.cmd, then bare claude', () => {
    const { calls, searchPath } = recordingSearchPath({ 'claude.cmd': 'C:\\nodejs\\claude.cmd' });

    const resolved = resolveClaudeCliPath({
      env: {},
      settings: {},
      platform: 'win32',
      exists: () => false,
      searchPath,
    });

    expect(calls).toEqual(['claude.exe', 'claude.cmd']);
    expect(resolved).toBe('C:\\nodejs\\claude.cmd');

    const miss = recordingSearchPath({});
    const unresolved = resolveClaudeCliPath({
      env: {},
      settings: {},
      platform: 'win32',
      exists: () => false,
      searchPath: miss.searchPath,
    });

    expect(miss.calls).toEqual(['claude.exe', 'claude.cmd', 'claude']);
    expect(unresolved).toBeNull();
  });

  it('on non-win32 probes only the bare claude name', () => {
    const { calls, searchPath } = recordingSearchPath({ claude: '/usr/local/bin/claude' });

    const resolved = resolveClaudeCliPath({
      env: {},
      settings: {},
      platform: 'linux',
      exists: () => false,
      searchPath,
    });

    expect(calls).toEqual(['claude']);
    expect(resolved).toBe('/usr/local/bin/claude');
  });

  it('walks env.PATH with the default prober when no searchPath is injected', () => {
    const nodejsDir = 'C:\\nodejs';
    const hit = path.join(nodejsDir, 'claude.exe');

    const resolved = resolveClaudeCliPath({
      env: { PATH: ['C:\\Windows', nodejsDir].join(path.delimiter) },
      settings: {},
      platform: 'win32',
      exists: (candidate) => candidate === hit,
    });

    expect(resolved).toBe(hit);
  });

  it('falls back to known install locations when PATH misses', () => {
    const home = 'C:\\Users\\tester';
    const appData = 'C:\\Users\\tester\\AppData\\Roaming';
    const documented = [
      path.join(home, '.claude', 'local', 'claude'),
      path.join(appData, 'npm', 'claude.cmd'),
      path.join(home, '.local', 'bin', 'claude'),
    ];

    for (const target of documented) {
      const resolved = resolveClaudeCliPath({
        env: { USERPROFILE: home, APPDATA: appData },
        settings: {},
        platform: 'win32',
        exists: (candidate) => candidate === target,
        searchPath: missSearchPath,
      });

      expect(resolved).toBe(target);
    }
  });

  it('uses HOME for the local install on non-Windows platforms', () => {
    const home = '/home/tester';
    const target = path.join(home, '.local', 'bin', 'claude');

    const resolved = resolveClaudeCliPath({
      env: { HOME: home },
      settings: {},
      platform: 'linux',
      exists: (candidate) => candidate === target,
      searchPath: missSearchPath,
    });

    expect(resolved).toBe(target);
  });

  it('returns null when nothing is found', () => {
    const resolved = resolveClaudeCliPath({
      env: { USERPROFILE: 'C:\\Users\\tester', APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' },
      settings: {},
      platform: 'win32',
      exists: () => false,
      searchPath: missSearchPath,
    });

    expect(resolved).toBeNull();
  });
});

describe('buildClaudeLaunchSpec', () => {
  it('wraps .cmd and .bat shims through cmd.exe with call', () => {
    expect(buildClaudeLaunchSpec('C:\\Program Files\\nodejs\\claude.cmd', {
      platform: 'win32',
      comSpec: 'C:\\Windows\\System32\\cmd.exe',
    })).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'call', 'C:\\Program Files\\nodejs\\claude.cmd'],
    });

    expect(buildClaudeLaunchSpec('C:\\npm\\claude.BAT', {
      platform: 'win32',
      comSpec: 'cmd.exe',
    })).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'call', 'C:\\npm\\claude.BAT'],
    });
  });

  it('runs a .exe directly on win32', () => {
    const exePath = 'C:\\Users\\tester\\.local\\bin\\claude.exe';

    expect(buildClaudeLaunchSpec(exePath, { platform: 'win32' })).toEqual({
      command: exePath,
      args: [],
    });
  });

  it('runs an extensionless executable directly on win32', () => {
    const barePath = 'C:\\Users\\tester\\.claude\\local\\claude';

    expect(buildClaudeLaunchSpec(barePath, { platform: 'win32' })).toEqual({
      command: barePath,
      args: [],
    });
  });

  it('refuses a bare .js entry that would need a Node interpreter', () => {
    const jsPath = 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';

    expect(buildClaudeLaunchSpec(jsPath, { platform: 'win32' })).toBeNull();
  });

  it('runs a non-Windows executable directly', () => {
    expect(buildClaudeLaunchSpec('/usr/local/bin/claude', { platform: 'linux' })).toEqual({
      command: '/usr/local/bin/claude',
      args: [],
    });
  });

  it('defaults comSpec to the host command interpreter', () => {
    const expected = process.env.ComSpec || 'cmd.exe';

    expect(buildClaudeLaunchSpec('C:\\npm\\claude.cmd', { platform: 'win32' })).toEqual({
      command: expected,
      args: ['/d', '/s', '/c', 'call', 'C:\\npm\\claude.cmd'],
    });
  });

  it('returns null for an empty or missing path', () => {
    expect(buildClaudeLaunchSpec('', { platform: 'win32' })).toBeNull();
    expect(buildClaudeLaunchSpec(null, { platform: 'win32' })).toBeNull();
  });
});

describe('probeClaudeCli', () => {
  const launchSpec = {
    command: 'C:\\npm\\claude.cmd',
    args: ['/d', '/s', '/c', 'call', 'C:\\npm\\claude.cmd'],
  };

  it('runs the spec with --version and reports the first non-empty output line', async () => {
    const { calls, spawnImpl } = createFakeSpawn({ stdout: '\n  2.1.0 (Claude Code)  \n', stderr: 'later line\n' });

    const result = await probeClaudeCli({ launchSpec, spawnImpl });

    expect(result).toEqual({ ok: true, version: '2.1.0 (Claude Code)' });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('C:\\npm\\claude.cmd');
    expect(calls[0].args).toEqual(['/d', '/s', '/c', 'call', 'C:\\npm\\claude.cmd', '--version']);
    expect(calls[0].options).toMatchObject({ windowsHide: true });
  });

  it('falls back to stderr for the version line', async () => {
    const { spawnImpl } = createFakeSpawn({ stderr: '1.0.0\n' });

    expect(await probeClaudeCli({ launchSpec, spawnImpl })).toEqual({ ok: true, version: '1.0.0' });
  });

  it('reports an unknown version when a zero-exit run printed nothing', async () => {
    const { spawnImpl } = createFakeSpawn({});

    expect(await probeClaudeCli({ launchSpec, spawnImpl })).toEqual({ ok: true, version: 'unknown' });
  });

  it('reports stderr as the failure on a non-zero exit, or the exit code when stderr is empty', async () => {
    const reported = createFakeSpawn({ stderr: '  authentication required  \n', code: 1 });
    expect(await probeClaudeCli({ launchSpec, spawnImpl: reported.spawnImpl })).toEqual({
      ok: false,
      error: 'authentication required',
    });

    const silent = createFakeSpawn({ code: 3 });
    expect(await probeClaudeCli({ launchSpec, spawnImpl: silent.spawnImpl })).toEqual({
      ok: false,
      error: 'exit code 3',
    });
  });

  it('kills a child that outlives the timeout and reports it', async () => {
    const { children, spawnImpl } = createFakeSpawn({ close: false });

    const result = await probeClaudeCli({ launchSpec, spawnImpl, timeoutMs: 20 });

    expect(result).toEqual({ ok: false, error: 'timed out' });
    expect(children[0].killCalls).toBe(1);
  });

  it('refuses a null or empty launch spec without spawning', async () => {
    const { calls, spawnImpl } = createFakeSpawn({});

    expect(await probeClaudeCli({ launchSpec: null, spawnImpl })).toEqual({
      ok: false,
      error: 'unsupported executable',
    });
    expect(await probeClaudeCli({ launchSpec: { command: '  ', args: [] }, spawnImpl })).toEqual({
      ok: false,
      error: 'unsupported executable',
    });
    expect(calls).toEqual([]);
  });

  it('reports a spawn error instead of waiting out the timeout', async () => {
    const { spawnImpl } = createFakeSpawn({ error: new Error('spawn C:\\missing\\claude.exe ENOENT') });

    expect(await probeClaudeCli({ launchSpec, spawnImpl })).toEqual({
      ok: false,
      error: 'spawn C:\\missing\\claude.exe ENOENT',
    });
  });

  it('resolves a spawn that throws synchronously', async () => {
    const spawnImpl = () => {
      throw new Error('EINVAL: invalid spawn options');
    };

    expect(await probeClaudeCli({ launchSpec, spawnImpl })).toEqual({
      ok: false,
      error: 'EINVAL: invalid spawn options',
    });
  });
});

describe('resolveBundledClaudeCliPath', () => {
  const archiveDir = 'C:\\app\\resources\\app.asar\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64';
  const unpackedDir = 'C:\\app\\resources\\app.asar.unpacked\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64';

  it('returns the unpacked copy when the resolved path sits inside app.asar', () => {
    const resolved = path.join(archiveDir, 'package.json');
    const executable = path.join(unpackedDir, 'claude.exe');

    const found = resolveBundledClaudeCliPath({
      platform: 'win32',
      arch: 'x64',
      resolveImpl: (request) => {
        expect(request).toBe('@anthropic-ai/claude-agent-sdk-win32-x64/package.json');
        return resolved;
      },
      exists: (candidate) => candidate === executable,
    });

    expect(found).toBe(executable);
  });

  it('keeps the resolved path when it is a real file outside an archive', () => {
    const dir = 'C:\\dev\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64';
    const executable = path.join(dir, 'claude.exe');

    expect(resolveBundledClaudeCliPath({
      platform: 'win32',
      resolveImpl: () => path.join(dir, 'package.json'),
      exists: (candidate) => candidate === executable,
    })).toBe(executable);
  });

  it('answers null when the platform package is not installed', () => {
    expect(resolveBundledClaudeCliPath({
      resolveImpl: () => {
        throw new Error('MODULE_NOT_FOUND');
      },
    })).toBeNull();
  });

  it('answers null when neither the archive entry nor the unpacked copy exists', () => {
    expect(resolveBundledClaudeCliPath({
      platform: 'win32',
      resolveImpl: () => path.join(archiveDir, 'package.json'),
      exists: () => false,
    })).toBeNull();
  });

  it('declines on a musl Linux host so the SDK picks the musl variant itself', () => {
    expect(resolveBundledClaudeCliPath({
      platform: 'linux',
      arch: 'x64',
      resolveImpl: () => {
        throw new Error('must not resolve');
      },
      exists: (candidate) => candidate === '/etc/alpine-release',
    })).toBeNull();
  });

  it('uses the extensionless name off Windows', () => {
    const dir = path.join('/opt/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64');
    const executable = path.join(dir, 'claude');

    expect(resolveBundledClaudeCliPath({
      platform: 'linux',
      arch: 'x64',
      resolveImpl: () => path.join(dir, 'package.json'),
      exists: (candidate) => candidate === executable,
    })).toBe(executable);
  });
});

describe('resolveClaudeCliPath with the bundled fallback', () => {
  it('prefers a real install over the bundled binary', () => {
    const { searchPath } = recordingSearchPath({ 'claude.exe': 'C:\\path\\claude.exe' });

    const resolved = resolveClaudeCliPath({
      env: { PATH: 'C:\\path' },
      platform: 'win32',
      exists: (candidate) => candidate === 'C:\\path\\claude.exe',
      searchPath,
      bundledCliPath: () => 'C:\\bundled\\claude.exe',
    });

    expect(resolved).toBe('C:\\path\\claude.exe');
  });

  it('falls back to the bundled binary when nothing else exists', () => {
    const resolved = resolveClaudeCliPath({
      env: {},
      platform: 'win32',
      exists: () => false,
      searchPath: missSearchPath,
      bundledCliPath: () => 'C:\\bundled\\claude.exe',
    });

    expect(resolved).toBe('C:\\bundled\\claude.exe');
  });

  it('answers null when neither an install nor a bundled binary exists', () => {
    const resolved = resolveClaudeCliPath({
      env: {},
      platform: 'win32',
      exists: () => false,
      searchPath: missSearchPath,
      bundledCliPath: () => null,
    });

    expect(resolved).toBeNull();
  });
});
