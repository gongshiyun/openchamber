import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildClaudeLaunchSpec, resolveClaudeCliPath } from './cli-resolution.js';

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
