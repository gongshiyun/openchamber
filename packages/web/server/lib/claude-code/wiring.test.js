// Wiring tests for the Claude Code backend on the OpenChamber server: the
// route subset mounted ahead of the OpenCode readiness gate, the session list
// merge, the global event stream multiplex, and the metadata route branch.
//
// The proxy runs end to end against a fake OpenCode upstream, the way
// opencode-proxy.test.js does it. The Claude runtime is the real one; its
// runner factory and CLI lookup are the same test seams index.test.js uses.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';

import { createClaudeCodeRuntime } from './index.js';
import { registerOpenCodeProxy } from '../opencode/proxy.js';
import { createOpenChamberSessionService, registerOpenChamberSessionRoutes } from '../openchamber-sessions/routes.js';

const listen = (app, host = '127.0.0.1') => new Promise((resolve, reject) => {
  const server = app.listen(0, host, () => resolve(server));
  server.once('error', reject);
});

const closeServer = (server) => new Promise((resolve, reject) => {
  if (!server) {
    resolve();
    return;
  }
  server.close((error) => (error ? reject(error) : resolve()));
});

/** The server's global hub, recording injected events and fanning them out. */
const createFakeHub = () => {
  const events = [];
  const subscribers = new Set();
  return {
    events,
    subscribers,
    injectEvent(input) {
      events.push(input);
    },
    subscribeEvent(subscriber, options) {
      const entry = { subscriber, options };
      subscribers.add(entry);
      return () => subscribers.delete(entry);
    },
    /** Fans one event out the way the hub's own commit step does. */
    emit(payload) {
      const directory = payload?.location?.directory ?? 'global';
      for (const { subscriber } of [...subscribers]) {
        subscriber({ payload, directory, spaceId: null });
      }
    },
    ofType(type) {
      return events.filter((entry) => entry.payload?.type === type).map((entry) => entry.payload);
    },
  };
};

/** A runner stand-in: records sends and answers what the test sets. */
const createFakeRunners = () => {
  const sessions = [];
  const runners = [];
  const factory = {
    createRunner(session) {
      const runner = {
        sends: [],
        busy: false,
        isBusy() {
          return runner.busy === true;
        },
        async send(input) {
          runner.sends.push(input);
          // The real runner records the user message before the turn starts.
          session.transcript.beginUserMessage({ text: input.text, messageID: input.messageID });
        },
        async interrupt() {},
        async setModel() {},
        resolvePermission() {
          return true;
        },
        async dispose() {},
      };
      sessions.push(session);
      runners.push(runner);
      return runner;
    },
  };
  return { factory, sessions, runners };
};

const createRuntime = ({ dataDir, hub, runners = createFakeRunners() }) => {
  const runtime = createClaudeCodeRuntime({
    dataDir,
    eventHub: hub,
    getSettings: () => ({}),
    createRunnerFactoryImpl: () => runners.factory,
    resolveCliPath: async () => 'C:\\fake\\claude.exe',
    // Title generation must never reach the real SDK in tests: the fake
    // answers an empty result, which derives no title and applies nothing.
    spawnQueryImpl: async () => (async function* () {
      yield { type: 'result', subtype: 'success', result: '' };
    })(),
  });
  return { runtime, runners };
};

const READY_RUNTIME = (upstreamPort) => ({
  openCodePort: upstreamPort,
  openCodeBaseUrl: null,
  isOpenCodeReady: true,
  openCodeNotReadySince: 0,
  isRestartingOpenCode: false,
});

/** The proxy app, wired exactly as server-utils-runtime wires it. */
const createProxyApp = ({ upstreamPort, runtime, hub, getRuntimeState = null, deps = {} }) => {
  const app = express();
  registerOpenCodeProxy(app, {
    fs: {},
    os: {},
    path,
    OPEN_CODE_READY_GRACE_MS: 0,
    getRuntime: getRuntimeState ?? (() => READY_RUNTIME(upstreamPort)),
    getOpenCodeAuthHeaders: () => ({}),
    buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:${upstreamPort}${requestPath}`,
    ensureOpenCodeApiPrefix: () => {},
    claudeRoutes: runtime.router,
    mergeClaudeSessionList: (options) => runtime.listSessionsForProxy(options),
    getClaudeActiveSessions: () => runtime.activeSessions(),
    claudeEventHub: hub,
    isClaudeSession: (sessionID) => runtime.isClaudeSession(sessionID),
    ...deps,
  });
  return app;
};

const postJson = (url, body, headers = {}) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

let tempRoot;
let upstreamServer;
let proxyServer;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-code-wiring-'));
});

afterEach(async () => {
  await closeServer(proxyServer);
  await closeServer(upstreamServer);
  proxyServer = undefined;
  upstreamServer = undefined;
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe('Claude Code server wiring', () => {
  it('routes a backend-header create to Claude and leaves a plain create to OpenCode', async () => {
    const hub = createFakeHub();
    const { runtime } = createRuntime({ dataDir: tempRoot, hub });
    await runtime.start();

    const upstream = express();
    const upstreamCreates = [];
    upstream.post('/api/session', express.json(), (req, res) => {
      upstreamCreates.push(req.body);
      res.status(200).json({ data: { id: 'ses_opencode', location: { directory: '/repo' } } });
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;

    proxyServer = await listen(createProxyApp({ upstreamPort, runtime, hub }));
    const base = `http://127.0.0.1:${proxyServer.address().port}`;

    const claude = await postJson(`${base}/api/session`, {
      id: 'ses_claude_1',
      title: 'Claude session',
      location: { directory: '/repo' },
    }, { 'x-openchamber-backend': 'claude' });

    expect(claude.status).toBe(200);
    const claudeBody = await claude.json();
    expect(claudeBody.data.id).toBe('ses_claude_1');
    expect(claudeBody.data.metadata).toEqual({ openchamber: { backend: 'claude' } });
    expect(upstreamCreates).toHaveLength(0);

    const plain = await postJson(`${base}/api/session`, { id: 'ses_plain' });

    expect(plain.status).toBe(200);
    expect(await plain.json()).toEqual({ data: { id: 'ses_opencode', location: { directory: '/repo' } } });
    expect(upstreamCreates).toEqual([{ id: 'ses_plain' }]);
  });

  it('answers Claude routes while OpenCode is restarting, where OpenCode routes are held and 503', async () => {
    const hub = createFakeHub();
    const { runtime, runners } = createRuntime({ dataDir: tempRoot, hub });
    await runtime.start();

    const upstream = express();
    let upstreamHits = 0;
    upstream.get('/api/config/providers', (_req, res) => {
      upstreamHits += 1;
      res.json({ ok: true });
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;

    const restartingState = {
      openCodePort: upstreamPort,
      openCodeBaseUrl: null,
      isOpenCodeReady: false,
      openCodeNotReadySince: Date.now(),
      isRestartingOpenCode: true,
    };
    proxyServer = await listen(createProxyApp({
      upstreamPort,
      runtime,
      hub,
      getRuntimeState: () => restartingState,
    }));
    const base = `http://127.0.0.1:${proxyServer.address().port}`;

    // An OpenCode route in the same state goes through the gate and 503s.
    const gated = await fetch(`${base}/api/config/providers`);
    expect(gated.status).toBe(503);
    expect(await gated.json()).toEqual({ error: 'OpenCode is restarting', restarting: true });
    expect(upstreamHits).toBe(0);

    // A Claude create and prompt never reach the gate.
    const created = await postJson(`${base}/api/session`, {
      id: 'ses_claude_gate',
      location: { directory: '/repo' },
    }, { 'x-openchamber-backend': 'claude' });
    expect(created.status).toBe(200);

    const prompted = await postJson(`${base}/api/session/ses_claude_gate/prompt`, {
      id: 'msg_1',
      text: 'Hello',
    });
    expect(prompted.status).toBe(200);
    expect((await prompted.json()).data.id).toBe('msg_1');
    expect(runners.runners[0].sends).toEqual([{ text: 'Hello', messageID: 'msg_1' }]);
    expect(upstreamHits).toBe(0);
  });

  it('merges Claude sessions into GET /api/session, scoped and paged like the host list', async () => {
    const hub = createFakeHub();
    const { runtime } = createRuntime({ dataDir: tempRoot, hub });
    await runtime.start();

    const upstream = express();
    upstream.get('/api/session', (req, res) => {
      res.json({
        data: [{ id: 'ses_host', location: { directory: '/repo' }, title: 'Host', time: { created: 1, updated: 2 }, metadata: {} }],
        cursor: req.query.cursor ? {} : { next: 'p2' },
      });
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;

    proxyServer = await listen(createProxyApp({ upstreamPort, runtime, hub }));
    const base = `http://127.0.0.1:${proxyServer.address().port}`;

    // No Claude session exists yet: the response is exactly the upstream's.
    const untouched = await (await fetch(`${base}/api/session?limit=50`)).json();
    expect(untouched).toEqual({
      data: [{ id: 'ses_host', location: { directory: '/repo' }, title: 'Host', time: { created: 1, updated: 2 }, metadata: {} }],
      cursor: { next: 'p2' },
    });

    await postJson(`${base}/api/session`, {
      id: 'ses_claude_repo',
      title: 'Claude in repo',
      location: { directory: '/repo' },
    }, { 'x-openchamber-backend': 'claude' }).then((res) => expect(res.status).toBe(200));
    await postJson(`${base}/api/session`, {
      id: 'ses_claude_other',
      title: 'Claude elsewhere',
      location: { directory: '/other' },
    }, { 'x-openchamber-backend': 'claude' }).then((res) => expect(res.status).toBe(200));

    const merged = await (await fetch(`${base}/api/session?limit=50`)).json();
    expect(merged.data.map((session) => session.id)).toEqual(['ses_host', 'ses_claude_repo', 'ses_claude_other']);
    const claude = merged.data.find((session) => session.id === 'ses_claude_repo');
    expect(claude.metadata).toEqual({ openchamber: { backend: 'claude' } });
    expect(claude.location).toEqual({ directory: '/repo' });
    expect(merged.cursor).toEqual({ next: 'p2' });

    // A scoped read carries only the Claude sessions of that directory.
    const scoped = await (await fetch(`${base}/api/session?directory=${encodeURIComponent('/repo')}`)).json();
    expect(scoped.data.map((session) => session.id)).toEqual(['ses_host', 'ses_claude_repo']);

    // A cursored read is the upstream's alone: no re-append of what the client has.
    const paged = await (await fetch(`${base}/api/session?limit=50&cursor=p2`)).json();
    expect(paged.data.map((session) => session.id)).toEqual(['ses_host']);
  });

  it('merges a busy Claude session into GET /api/session/active beside the host snapshot', async () => {
    const hub = createFakeHub();
    const { runtime, runners } = createRuntime({ dataDir: tempRoot, hub });
    await runtime.start();

    const upstream = express();
    upstream.get('/api/session/active', (_req, res) => {
      res.json({ data: { ses_host_active: { type: 'running' } } });
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;

    proxyServer = await listen(createProxyApp({ upstreamPort, runtime, hub }));
    const base = `http://127.0.0.1:${proxyServer.address().port}`;

    await postJson(`${base}/api/session`, {
      id: 'ses_claude_active',
      title: 'Active',
      location: { directory: '/repo' },
    }, { 'x-openchamber-backend': 'claude' }).then((res) => expect(res.status).toBe(200));
    await postJson(`${base}/api/session/ses_claude_active/prompt`, { id: 'msg_active_1', text: 'Hello' })
      .then((res) => expect(res.status).toBe(200));
    runners.runners[0].busy = true;

    const response = await fetch(`${base}/api/session/active`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        ses_host_active: { type: 'running' },
        ses_claude_active: { type: 'running' },
      },
    });
  });

  it('leaves GET /api/session/active as the host answered it without a busy Claude session', async () => {
    const hub = createFakeHub();
    const { runtime, runners } = createRuntime({ dataDir: tempRoot, hub });
    await runtime.start();

    const upstream = express();
    upstream.get('/api/session/active', (_req, res) => {
      res.json({ data: { ses_host_active: { type: 'running' } } });
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;

    proxyServer = await listen(createProxyApp({ upstreamPort, runtime, hub }));
    const base = `http://127.0.0.1:${proxyServer.address().port}`;

    // A live Claude session between turns is not busy: its runner is idle.
    await postJson(`${base}/api/session`, {
      id: 'ses_claude_idle',
      title: 'Idle',
      location: { directory: '/repo' },
    }, { 'x-openchamber-backend': 'claude' }).then((res) => expect(res.status).toBe(200));
    await postJson(`${base}/api/session/ses_claude_idle/prompt`, { id: 'msg_idle_1', text: 'Hello' })
      .then((res) => expect(res.status).toBe(200));
    runners.runners[0].busy = false;

    const response = await fetch(`${base}/api/session/active`);
    expect(response.status).toBe(200);
    // Byte-for-byte the host's answer, not a rebuilt one.
    expect(await response.text()).toBe('{"data":{"ses_host_active":{"type":"running"}}}');
  });

  it('keeps GET /api/session/active on the generic proxy when the Claude backend is absent', async () => {
    const hub = createFakeHub();
    const { runtime } = createRuntime({ dataDir: tempRoot, hub });
    await runtime.start();

    const upstream = express();
    let upstreamHits = 0;
    upstream.get('/api/session/active', (_req, res) => {
      upstreamHits += 1;
      res.json({ data: { ses_host_active: { type: 'running' } } });
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;

    proxyServer = await listen(createProxyApp({
      upstreamPort,
      runtime,
      hub,
      deps: { getClaudeActiveSessions: null },
    }));
    const base = `http://127.0.0.1:${proxyServer.address().port}`;

    const response = await fetch(`${base}/api/session/active`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { ses_host_active: { type: 'running' } } });
    expect(upstreamHits).toBe(1);
  });

  it('answers no partial active list when the host snapshot fails', async () => {
    const hub = createFakeHub();
    const { runtime, runners } = createRuntime({ dataDir: tempRoot, hub });
    await runtime.start();

    const upstream = express();
    upstream.get('/api/session/active', (_req, res) => {
      res.socket.destroy();
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;

    proxyServer = await listen(createProxyApp({ upstreamPort, runtime, hub }));
    const base = `http://127.0.0.1:${proxyServer.address().port}`;

    // A busy Claude session exists, but the host snapshot failed: the answer
    // must not be the Claude map alone, or the UI would read it as complete.
    await postJson(`${base}/api/session`, {
      id: 'ses_claude_fail',
      location: { directory: '/repo' },
    }, { 'x-openchamber-backend': 'claude' }).then((res) => expect(res.status).toBe(200));
    await postJson(`${base}/api/session/ses_claude_fail/prompt`, { id: 'msg_fail_1', text: 'Hello' })
      .then((res) => expect(res.status).toBe(200));
    runners.runners[0].busy = true;

    const response = await fetch(`${base}/api/session/active`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'OpenCode service unavailable' });
  });

  it('multiplexes Claude frames into /api/event and keeps upstream frames byte-identical', async () => {
    const hub = createFakeHub();
    const { runtime } = createRuntime({ dataDir: tempRoot, hub });
    await runtime.start();

    const upstream = express();
    let upstreamRes = null;
    upstream.get('/api/event', (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.flushHeaders();
      res.write('data: {"id":"h1","type":"host"}\n\n');
      upstreamRes = res;
      req.on('close', () => { upstreamRes = null; });
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;

    proxyServer = await listen(createProxyApp({ upstreamPort, runtime, hub }));
    const base = `http://127.0.0.1:${proxyServer.address().port}`;

    await postJson(`${base}/api/session`, {
      id: 'ses_claude_sse',
      location: { directory: '/repo' },
    }, { 'x-openchamber-backend': 'claude' }).then((res) => expect(res.status).toBe(200));

    const controller = new AbortController();
    const response = await fetch(`${base}/api/global/event`, {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readUntil = async (needle) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    };

    await readUntil('"h1"');
    expect(text).toBe('data: {"id":"h1","type":"host"}\n\n');
    expect(hub.subscribers.size).toBe(1);

    // A Claude session event is written as one frame; another session's is not.
    hub.emit({ id: 'c1', type: 'session.created', created: 1, data: { sessionID: 'ses_claude_sse' }, location: { directory: '/repo' } });
    hub.emit({ id: 'x1', type: 'session.created', created: 1, data: { sessionID: 'ses_opencode' } });
    await readUntil('"c1"');
    expect(text).toContain('data: {"id":"c1","type":"session.created","created":1,"data":{"sessionID":"ses_claude_sse"},"location":{"directory":"/repo"}}\n\n');
    expect(text).not.toContain('"x1"');

    // Half a block of the host's holds a Claude frame back until the block is whole.
    upstreamRes.write('data: {"id":"h2",');
    await readUntil('"h2"');
    hub.emit({ id: 'c2', type: 'session.updated', data: { sessionID: 'ses_claude_sse' } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(text).not.toContain('"c2"');
    upstreamRes.write('"type":"host"}\n\n');
    await readUntil('"c2"');
    expect(text.endsWith('data: {"id":"h2","type":"host"}\n\ndata: {"id":"c2","type":"session.updated","data":{"sessionID":"ses_claude_sse"}}\n\n')).toBe(true);

    // The subscription lives exactly as long as the response.
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hub.subscribers.size).toBe(0);
  });

  it('branches the metadata routes to the Claude runtime and keeps the OpenCode path for other sessions', async () => {
    const hub = createFakeHub();
    const { runtime } = createRuntime({ dataDir: tempRoot, hub });
    await runtime.start();

    const runtimeApp = express();
    runtimeApp.use(express.json());
    runtimeApp.use('/api', runtime.router);
    await request(runtimeApp)
      .post('/api/session')
      .set('x-openchamber-backend', 'claude')
      .send({ id: 'ses_claude_meta', title: 'Meta', metadata: { seed: true } })
      .expect(200);

    const sessionMetadataStore = {
      get: vi.fn(async () => ({})),
      setSessionMetadata: vi.fn(async () => ({ opencode: true })),
    };
    const broadcastGlobalUiEvent = vi.fn();
    const service = createOpenChamberSessionService({
      archiveStore: {},
      sessionMetadataStore,
      claudeSessionMetadata: {
        isClaudeSession: (sessionID) => runtime.isClaudeSession(sessionID),
        get: (sessionID) => runtime.getSessionMetadata(sessionID),
        merge: (sessionID, patch, options) => runtime.mergeSessionMetadata(sessionID, patch, options),
      },
      readSettingsFromDiskMigrated: async () => ({ projects: [] }),
      sanitizeProjects: (projects) => projects,
      validateDirectoryPath: async (directory) => ({ ok: true, directory }),
      buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
      getOpenCodeAuthHeaders: () => ({}),
      broadcastGlobalUiEvent,
    });
    const app = express();
    registerOpenChamberSessionRoutes(app, { sessionService: service });

    const read = await request(app).get('/api/openchamber/sessions/ses_claude_meta/metadata').expect(200);
    expect(read.body).toEqual({ metadata: { seed: true, openchamber: { backend: 'claude' } } });

    const written = await request(app)
      .post('/api/openchamber/sessions/ses_claude_meta/metadata')
      .send({ patch: { openchamber: { pinned: true } } })
      .expect(200);
    expect(written.body).toEqual({
      metadata: { seed: true, openchamber: { backend: 'claude', pinned: true } },
    });
    // The control-stream broadcast the route always sends, with the merged object.
    expect(broadcastGlobalUiEvent).toHaveBeenCalledWith({
      type: 'openchamber:session-metadata',
      properties: { sessionID: 'ses_claude_meta', metadata: written.body.metadata },
    });
    // The OpenCode store is not touched, and the runtime's own wire event is
    // not duplicated by the route.
    expect(sessionMetadataStore.setSessionMetadata).not.toHaveBeenCalled();
    expect(hub.ofType('session.metadata.updated')).toHaveLength(1);

    // A session the registry does not own takes the old path.
    const opencode = await request(app)
      .post('/api/openchamber/sessions/ses_opencode_meta/metadata')
      .send({ patch: { a: 1 } })
      .expect(200);
    expect(opencode.body).toEqual({ metadata: { opencode: true } });
    expect(sessionMetadataStore.setSessionMetadata).toHaveBeenCalledTimes(1);
    expect(hub.ofType('session.metadata.updated')).toHaveLength(1);
    await request(app).get('/api/openchamber/sessions/ses_opencode_meta/metadata').expect(200);
    expect(sessionMetadataStore.get).toHaveBeenCalledWith('ses_opencode_meta', { directory: '' });
  });
});
