// Tests for the Claude Code runtime: the session registry, its on-disk index,
// the runner lifecycle, and the route subset it serves.
//
// The filesystem is real (a fresh temp dir per test), so persistence is
// observed the way production writes it. The runner factory and the event hub
// are fakes: the registry's job is wiring a session to a runner and publishing
// wire events, while runner.test.js owns the SDK protocol.
//
// The UI contract tests import the UI's own modules (projectSession,
// createProjectIdFromPath) the same way the transcript and translator contract
// tests do, so a drifted record shape fails here, in the server package.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import request from 'supertest';
import { OpenCode } from '@opencode/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';

import { messageIdFromEvent } from '../../../../ui/src/lib/opencode/events.ts';
import { projectMessages, projectSession } from '../../../../ui/src/lib/opencode/projection.ts';
import { createProjectIdFromPath as uiProjectIdFromPath } from '../../../../ui/src/lib/projectId.ts';
import { createClaudeCodeRuntime } from './index.js';

const ZERO_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
const CLOCK = 1_700_000_000_000;

let tempRoot;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-code-runtime-'));
  // `start()` probes the CLI and logs one line per outcome; the tests that
  // assert that line install their own spy, and every other test stays quiet.
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tempRoot, { recursive: true, force: true });
});

const indexPath = () => path.join(tempRoot, 'claude-code', 'sessions.json');
const transcriptPath = (sessionID) => path.join(tempRoot, 'claude-code', 'sessions', `${sessionID}.jsonl`);

const readIndex = async () => JSON.parse(await fs.readFile(indexPath(), 'utf8'));

const fileExists = (filePath) => fs.access(filePath).then(() => true, () => false);

const waitFor = async (predicate, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** The server's global hub, recording every injected event. */
const createHub = () => {
  const events = [];
  return {
    events,
    injectEvent(input) {
      events.push(input);
    },
    ofType(type) {
      return events.filter((entry) => entry.payload?.type === type).map((entry) => entry.payload);
    },
  };
};

/** A runner stand-in: records every call, answers what the test sets. */
const createFakeRunners = () => {
  const sessions = [];
  const runners = [];
  const factory = {
    createRunner(session) {
      const runner = {
        sends: [],
        models: [],
        permissionModes: [],
        permissions: [],
        permissionRequests: [],
        interrupts: 0,
        disposed: 0,
        permissionResult: true,
        busy: false,
        isBusy() {
          return runner.busy === true;
        },
        async send(input) {
          runner.sends.push(input);
          // The real runner records the user message before the turn starts.
          session.transcript.beginUserMessage({ text: input.text, messageID: input.messageID });
        },
        async interrupt() {
          runner.interrupts += 1;
        },
        async setModel(modelId) {
          runner.models.push(modelId);
        },
        async setPermissionMode(mode) {
          runner.permissionModes.push(mode);
        },
        resolvePermission(requestID, decision) {
          runner.permissions.push([requestID, decision]);
          return runner.permissionResult;
        },
        pendingPermissionRequests() {
          return runner.permissionRequests;
        },
        async dispose() {
          runner.disposed += 1;
        },
      };
      sessions.push(session);
      runners.push(runner);
      return runner;
    },
  };
  return { factory, sessions, runners };
};

/**
 * The one-shot `spawnQueryImpl` a test runtime defaults to: an empty result,
 * which derives no generated title and leaves existing behavior untouched.
 * Tests that exercise `session.generate` or generated titles inject their own.
 */
const createSilentSpawnQuery = () => async () => (async function* () {
  yield { type: 'result', subtype: 'success', result: '' };
})();

/**
 * A one-shot `spawnQueryImpl` yielding the given SDK messages, recording every
 * spawn. The result is delivered when the test calls `release()`, so a test
 * can change the title (or the record) before the generation completes; `done`
 * resolves once the query has been consumed.
 */
const createManualOneShot = ({ result = 'Model title', error = null } = {}) => {
  const calls = [];
  let release = null;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let markDone = null;
  const done = new Promise((resolve) => {
    markDone = resolve;
  });
  return {
    calls,
    release,
    done,
    spawn: async (params) => {
      calls.push(params);
      return (async function* () {
        try {
          await gate;
          if (error) throw error;
          yield { type: 'result', subtype: 'success', result };
        } finally {
          markDone();
        }
      })();
    },
  };
};

/** A one-shot `spawnQueryImpl` that yields the given messages as they are. */
const createOneShot = (...messages) => {
  const calls = [];
  return {
    calls,
    spawn: async (params) => {
      calls.push(params);
      return (async function* () {
        for (const message of messages) yield message;
      })();
    },
  };
};

const createRuntime = ({ runners = createFakeRunners(), hub = createHub(), deps = {} } = {}) => {
  const clock = {
    value: CLOCK,
    advance(ms = 1000) {
      this.value += ms;
      return this.value;
    },
  };
  const runtime = createClaudeCodeRuntime({
    dataDir: tempRoot,
    eventHub: hub,
    getSettings: () => ({}),
    createRunnerFactoryImpl: () => runners.factory,
    resolveCliPath: async () => 'C:\\fake\\claude.exe',
    // The startup probe is injected like every other seam: the real one would
    // spawn a process, and cli-resolution.test.js owns its behavior.
    probeCliImpl: async () => ({ ok: true, version: 'test-cli 1.0.0' }),
    // Title generation must never reach the real SDK in tests; the default
    // fake answers an empty result, which applies nothing.
    spawnQueryImpl: createSilentSpawnQuery(),
    now: () => clock.value,
    ...deps,
  });
  return { runtime, hub, runners, clock };
};

/** The router under `/api`, with a terminal handler standing in for the proxy. */
const createApp = (runtime) => {
  const app = express();
  app.use(express.json());
  app.use('/api', runtime.router);
  app.use((req, res) => {
    res.status(418).json({ handledBy: 'proxy' });
  });
  return app;
};

const createSession = (app, body) =>
  request(app).post('/api/session').set('x-openchamber-backend', 'claude').send(body);

/** Creates one session and prompts it once, so its runner is live. */
const createAndPrompt = async (app, body) => {
  await createSession(app, body).expect(200);
  await request(app)
    .post(`/api/session/${body.id}/prompt`)
    .send({ id: `msg_${body.id}`, text: 'Hello' })
    .expect(200);
};

describe('claude code runtime', () => {
  describe('session registry', () => {
    test('creates a record the UI projects: every non-optional Session field is present', async () => {
      const { runtime, hub } = createRuntime();
      await runtime.start();
      const app = createApp(runtime);

      const response = await createSession(app, {
        id: 'ses_claude_1',
        title: 'Fix the tests',
        metadata: { pinned: true },
        location: { directory: 'C:\\work\\app' },
      }).expect(200);

      const info = response.body.data;
      expect(info.location).toEqual({ directory: 'C:/work/app' });
      // The wire record goes through the UI's own projection, exactly as the
      // client does on `session.create` / `session.get`.
      const session = projectSession(info);
      expect(session.id).toBe('ses_claude_1');
      expect(session.projectID).toBe(uiProjectIdFromPath('C:\\work\\app'));
      expect(session.directory).toBe('C:/work/app');
      expect(session.title).toBe('Fix the tests');
      expect(session.cost).toBe(0);
      expect(session.tokens).toEqual(ZERO_TOKENS);
      expect(session.time).toEqual({ created: CLOCK, updated: CLOCK });
      expect(session.model).toEqual({ providerID: 'claude-code', id: 'opus' });
      expect(session.metadata).toEqual({ pinned: true, openchamber: { backend: 'claude' } });

      // The same record reaches every client as `session.created`.
      const created = hub.ofType('session.created');
      expect(created).toHaveLength(1);
      expect(created[0].id).toMatch(/^msg_/);
      expect(created[0].created).toBe(CLOCK);
      expect(created[0].location).toEqual({ directory: 'C:/work/app' });
      expect(created[0].data).toEqual({
        sessionID: 'ses_claude_1',
        projectID: uiProjectIdFromPath('C:\\work\\app'),
        location: { directory: 'C:/work/app' },
        title: 'Fix the tests',
        model: { providerID: 'claude-code', id: 'opus' },
        metadata: { pinned: true, openchamber: { backend: 'claude' } },
      });
      expect(hub.events).toEqual([
        { payload: created[0], directory: 'C:/work/app', spaceId: null },
      ]);

      // The registry owns the session from the moment it exists.
      expect(runtime.isClaudeSession('ses_claude_1')).toBe(true);
      expect(runtime.isClaudeSession('ses_opencode_1')).toBe(false);
      expect(await fileExists(indexPath())).toBe(true);
      expect((await readIndex()).ses_claude_1).toMatchObject({
        directory: 'C:/work/app',
        projectID: uiProjectIdFromPath('C:\\work\\app'),
        title: 'Fix the tests',
        createdAt: CLOCK,
        updatedAt: CLOCK,
        model: { providerID: 'claude-code', id: 'opus' },
        claudeSessionUuid: null,
        metadata: { pinned: true, openchamber: { backend: 'claude' } },
      });
    });

    test('defaults the title, mints an id, and derives projectID like the UI', async () => {
      const { runtime } = createRuntime();
      await runtime.start();
      const app = createApp(runtime);

      const minted = await createSession(app, {}).expect(200);
      expect(minted.body.data.id).toMatch(/^ses_/);
      expect(minted.body.data.title).toBe('');
      expect(minted.body.data.projectID).toBe(uiProjectIdFromPath(''));

      const paths = [
        'C:\\work\\app',
        'C:\\work\\app\\',
        '/Users/me/project',
        '/Users/me/project///',
        'D:\\\u9879\u76ee\\app',
      ];
      for (const [index, directory] of paths.entries()) {
        const response = await createSession(app, {
          id: `ses_path_${index}`,
          location: { directory },
        }).expect(200);
        expect(response.body.data.projectID).toBe(uiProjectIdFromPath(directory));
      }
    });

    test('reloads records from disk on a new runtime, Claude session uuid included', async () => {
      const first = createRuntime();
      await first.runtime.start();
      const app = createApp(first.runtime);
      await createSession(app, {
        id: 'ses_keep_1',
        title: 'Kept',
        agent: 'build',
        model: { providerID: 'claude-code', id: 'sonnet' },
        metadata: { openchamber: { pinned: true } },
        location: { directory: 'C:\\work\\keep' },
      }).expect(200);
      await request(app)
        .post('/api/session/ses_keep_1/prompt')
        .send({ id: 'msg_keep_1', text: 'Hello' })
        .expect(200);

      // The SDK reports the Claude session id on the first message; the
      // registry persists it so a restart can resume the session.
      first.runners.sessions[0].onSessionId('claude-uuid-1');
      await waitFor(async () => (await readIndex()).ses_keep_1.claudeSessionUuid === 'claude-uuid-1');
      expect((await readIndex()).ses_keep_1).toEqual({
        directory: 'C:/work/keep',
        projectID: uiProjectIdFromPath('C:\\work\\keep'),
        title: 'Kept',
        createdAt: CLOCK,
        updatedAt: CLOCK,
        cost: 0,
        tokens: ZERO_TOKENS,
        model: { providerID: 'claude-code', id: 'sonnet' },
        claudeSessionUuid: 'claude-uuid-1',
        metadata: { openchamber: { pinned: true, backend: 'claude' } },
        agent: 'build',
      });

      await first.runtime.stop();
      expect(first.runners.runners[0].disposed).toBe(1);

      const second = createRuntime();
      await second.runtime.start();
      const secondApp = createApp(second.runtime);
      const info = (await request(secondApp).get('/api/session/ses_keep_1').expect(200)).body.data;
      expect(projectSession(info)).toMatchObject({
        id: 'ses_keep_1',
        projectID: uiProjectIdFromPath('C:\\work\\keep'),
        directory: 'C:/work/keep',
        title: 'Kept',
        agent: 'build',
        model: { providerID: 'claude-code', id: 'sonnet' },
        metadata: { openchamber: { pinned: true, backend: 'claude' } },
        time: { created: CLOCK, updated: CLOCK },
      });

      // The resumed runner gets the persisted uuid.
      await request(secondApp)
        .post('/api/session/ses_keep_1/prompt')
        .send({ id: 'msg_keep_2', text: 'Again' })
        .expect(200);
      expect(second.runners.sessions[0].claudeSessionUuid).toBe('claude-uuid-1');
    });

    test('refuses an unreadable index instead of starting as an empty registry', async () => {
      await fs.mkdir(path.dirname(indexPath()), { recursive: true });
      await fs.writeFile(indexPath(), '{ not json', 'utf8');
      const { runtime } = createRuntime();

      await expect(runtime.start()).rejects.toThrow(/unreadable/);
      expect(runtime.isClaudeSession('ses_any')).toBe(false);
    });

    test('ignores index entries and client ids that could escape the sessions directory', async () => {
      await fs.mkdir(path.dirname(indexPath()), { recursive: true });
      await fs.writeFile(indexPath(), JSON.stringify({
        ses_ok_1: {
          directory: 'C:\\work\\ok',
          title: 'ok',
          createdAt: 1,
          updatedAt: 1,
          model: { providerID: 'claude-code', id: 'opus' },
          metadata: {},
        },
        '../escape': { directory: 'C:\\evil' },
      }), 'utf8');
      const { runtime } = createRuntime();
      await runtime.start();

      expect(runtime.isClaudeSession('ses_ok_1')).toBe(true);
      expect(runtime.isClaudeSession('../escape')).toBe(false);
      expect(runtime.listSessionsForProxy({}).map((record) => record.id)).toEqual(['ses_ok_1']);

      const app = createApp(runtime);
      await createSession(app, { id: '../../escape' }).expect(500);
      expect(runtime.listSessionsForProxy({}).map((record) => record.id)).toEqual(['ses_ok_1']);
    });

    test('renames, moves and removes with the wire events the UI translates', async () => {
      const { runtime, hub, runners, clock } = createRuntime();
      await runtime.start();
      const app = createApp(runtime);
      await createAndPrompt(app, { id: 'ses_move_1', title: 'Original', location: { directory: 'C:\\work\\one' } });

      clock.advance();
      await request(app).patch('/api/session/ses_move_1').send({ title: 'Renamed' }).expect(204);
      expect(hub.ofType('session.renamed')).toEqual([
        expect.objectContaining({
          created: CLOCK + 1000,
          data: { sessionID: 'ses_move_1', title: 'Renamed' },
          location: { directory: 'C:/work/one' },
        }),
      ]);
      expect((await readIndex()).ses_move_1).toMatchObject({ title: 'Renamed', updatedAt: CLOCK + 1000 });

      clock.advance();
      await request(app).post('/api/session/ses_move_1/move').send({ directory: 'C:\\work\\two' }).expect(204);
      const moved = hub.ofType('session.moved');
      expect(moved).toHaveLength(1);
      expect(moved[0].data).toEqual({
        sessionID: 'ses_move_1',
        location: { directory: 'C:/work/two' },
        projectID: uiProjectIdFromPath('C:\\work\\two'),
      });
      const after = (await request(app).get('/api/session/ses_move_1').expect(200)).body.data;
      expect(after.location).toEqual({ directory: 'C:/work/two' });
      expect(after.projectID).toBe(uiProjectIdFromPath('C:\\work\\two'));
      expect(after.time.updated).toBe(CLOCK + 2000);
      expect((await readIndex()).ses_move_1).toMatchObject({
        directory: 'C:/work/two',
        projectID: uiProjectIdFromPath('C:\\work\\two'),
      });

      // The transcript file exists while the session does.
      await runners.sessions[0].transcript.flush();
      expect(await fileExists(transcriptPath('ses_move_1'))).toBe(true);
      await request(app).delete('/api/session/ses_move_1').expect(204);
      expect(runners.runners[0].disposed).toBe(1);
      expect(hub.ofType('session.deleted').at(-1).data).toEqual({ sessionID: 'ses_move_1' });
      expect(runtime.isClaudeSession('ses_move_1')).toBe(false);
      // The session now falls through to the OpenCode proxy.
      await request(app).get('/api/session/ses_move_1').expect(418);
      expect(await fileExists(transcriptPath('ses_move_1'))).toBe(false);
      expect((await readIndex()).ses_move_1).toBeUndefined();
    });

    test('lists a directory newest first, filtered by title and limited', async () => {
      const { runtime, clock } = createRuntime();
      await runtime.start();
      const app = createApp(runtime);
      const create = async (id, title, directory) => {
        clock.advance();
        await createSession(app, { id, title, location: { directory } }).expect(200);
      };
      await create('ses_l_1', 'Fix the parser', 'C:\\work\\a');
      await create('ses_l_2', 'Add tests', 'C:\\work\\a');
      await create('ses_l_3', 'fix docs', 'C:\\work\\b');

      const listed = runtime.listSessionsForProxy({ directory: 'C:\\work\\a' });
      expect(listed.map((record) => record.id)).toEqual(['ses_l_2', 'ses_l_1']);
      expect(listed[0].location).toEqual({ directory: 'C:/work/a' });
      expect(runtime.listSessionsForProxy({ directory: 'C:\\work\\a', search: 'FIX' }).map((record) => record.id))
        .toEqual(['ses_l_1']);
      expect(runtime.listSessionsForProxy({ directory: 'C:\\work\\a', limit: 1 }).map((record) => record.id))
        .toEqual(['ses_l_2']);
      expect(runtime.listSessionsForProxy({}).map((record) => record.id))
        .toEqual(['ses_l_3', 'ses_l_2', 'ses_l_1']);
      expect(runtime.listSessionsForProxy({ directory: 'C:\\work\\missing' })).toEqual([]);
    });

    test('stores the canonical directory form and matches either separator spelling', async () => {
      const { runtime, hub } = createRuntime();
      await runtime.start();
      const app = createApp(runtime);

      const response = await createSession(app, {
        id: 'ses_dir_1',
        location: { directory: 'D:\\X\\Y\\' },
      }).expect(200);

      expect(response.body.data.location).toEqual({ directory: 'D:/X/Y' });
      const created = hub.ofType('session.created')[0];
      expect(created.location).toEqual({ directory: 'D:/X/Y' });
      expect(created.data.location).toEqual({ directory: 'D:/X/Y' });
      expect((await readIndex()).ses_dir_1.directory).toBe('D:/X/Y');

      // The proxy canonicalizes the query directory with a realpath, which on
      // Windows yields backslashes; the record must match either spelling.
      expect(runtime.listSessionsForProxy({ directory: 'D:/X/Y' }).map((record) => record.id)).toEqual(['ses_dir_1']);
      expect(runtime.listSessionsForProxy({ directory: 'D:\\X\\Y' }).map((record) => record.id)).toEqual(['ses_dir_1']);
      expect(runtime.listSessionsForProxy({ directory: 'd:\\X\\Y\\' }).map((record) => record.id)).toEqual(['ses_dir_1']);
      expect(runtime.listSessionsForProxy({ directory: 'D:/X/Z' })).toEqual([]);
    });

    test('heals a legacy backslash directory in the stored index on load and persists it', async () => {
      await fs.mkdir(path.dirname(indexPath()), { recursive: true });
      await fs.writeFile(indexPath(), JSON.stringify({
        ses_dir_legacy: {
          directory: 'D:\\X\\Y',
          title: 'Legacy',
          createdAt: 1,
          updatedAt: 1,
          model: { providerID: 'claude-code', id: 'opus' },
          claudeSessionUuid: null,
          metadata: {},
        },
      }), 'utf8');

      const { runtime } = createRuntime();
      await runtime.start();

      // The healed directory is on disk, so the next boot starts canonical.
      expect((await readIndex()).ses_dir_legacy.directory).toBe('D:/X/Y');
      expect(runtime.listSessionsForProxy({ directory: 'D:\\X\\Y' }).map((record) => record.id))
        .toEqual(['ses_dir_legacy']);
    });

    test('falls back to the default alias when a create names a foreign model', async () => {
      const { runtime } = createRuntime();
      await runtime.start();
      const app = createApp(runtime);

      const foreign = await createSession(app, {
        id: 'ses_model_foreign',
        model: { providerID: 'zen', id: 'big-pickle' },
        location: { directory: 'C:\\work\\model' },
      }).expect(200);
      expect(foreign.body.data.model).toEqual({ providerID: 'claude-code', id: 'opus' });
      expect((await readIndex()).ses_model_foreign.model).toEqual({ providerID: 'claude-code', id: 'opus' });

      // A known alias keeps its variant; the provider alone is not enough.
      const aliased = await createSession(app, {
        id: 'ses_model_alias',
        model: { providerID: 'claude-code', id: 'haiku', variant: 'fast' },
        location: { directory: 'C:\\work\\model' },
      }).expect(200);
      expect(aliased.body.data.model).toEqual({ providerID: 'claude-code', id: 'haiku', variant: 'fast' });

      const unknown = await createSession(app, {
        id: 'ses_model_unknown',
        model: { providerID: 'claude-code', id: 'big-pickle' },
        location: { directory: 'C:\\work\\model' },
      }).expect(200);
      expect(unknown.body.data.model).toEqual({ providerID: 'claude-code', id: 'opus' });
    });

    test('heals a stored foreign model on load and gives the runner the healed alias', async () => {
      await fs.mkdir(path.dirname(indexPath()), { recursive: true });
      await fs.writeFile(indexPath(), JSON.stringify({
        ses_model_legacy: {
          directory: 'C:\\work\\legacy',
          title: 'Legacy',
          createdAt: 1,
          updatedAt: 1,
          model: { providerID: 'claude-code', id: 'big-pickle' },
          claudeSessionUuid: null,
          metadata: {},
        },
      }), 'utf8');

      const { runtime, runners } = createRuntime();
      await runtime.start();

      // The healed model is on disk, so the next boot starts canonical.
      expect((await readIndex()).ses_model_legacy.model).toEqual({ providerID: 'claude-code', id: 'opus' });

      const app = createApp(runtime);
      await request(app)
        .post('/api/session/ses_model_legacy/prompt')
        .send({ id: 'msg_legacy_1', text: 'Hello' })
        .expect(200);
      expect(runners.sessions[0].model).toBe('opus');
    });

    test('records an agent switch and emits it only when it changes', async () => {
      const { runtime, hub } = createRuntime();
      await runtime.start();
      const app = createApp(runtime);
      await createSession(app, { id: 'ses_agent_1', agent: 'build', location: { directory: 'C:\\work\\agent' } }).expect(200);

      await request(app).post('/api/session/ses_agent_1/agent').send({ agent: 'plan' }).expect(204);
      expect(hub.ofType('session.agent.selected')).toEqual([
        expect.objectContaining({ data: { sessionID: 'ses_agent_1', agent: 'plan', previous: 'build' } }),
      ]);
      expect((await request(app).get('/api/session/ses_agent_1').expect(200)).body.data.agent).toBe('plan');

      await request(app).post('/api/session/ses_agent_1/agent').send({ agent: 'plan' }).expect(204);
      expect(hub.ofType('session.agent.selected')).toHaveLength(1);
    });
  });

  describe('active sessions', () => {
    test('reports only sessions with a live busy runner', async () => {
      const { runtime, runners } = createRuntime();
      await runtime.start();
      const app = createApp(runtime);

      // A created session has no runner until its first prompt, and a live
      // runner between turns is not busy.
      await createSession(app, { id: 'ses_active_no_runner', location: { directory: 'C:\\work\\active' } }).expect(200);
      expect(runtime.activeSessions()).toEqual({});

      await createAndPrompt(app, { id: 'ses_active_idle', location: { directory: 'C:\\work\\active' } });
      expect(runtime.activeSessions()).toEqual({});

      runners.runners[0].busy = true;
      expect(runtime.activeSessions()).toEqual({ ses_active_idle: { type: 'running' } });

      runners.runners[0].busy = false;
      expect(runtime.activeSessions()).toEqual({});
    });
  });

  describe('pending permissions', () => {
    test('lists the parked requests of live runners in the matching directory only', async () => {
      const { runtime, runners } = createRuntime();
      await runtime.start();
      const app = createApp(runtime);

      await createAndPrompt(app, { id: 'ses_perm_repo', location: { directory: 'D:\\X\\Y' } });
      await createAndPrompt(app, { id: 'ses_perm_other', location: { directory: 'D:\\X\\Z' } });
      // A created session without a runner is never asked.
      await createSession(app, { id: 'ses_perm_none', location: { directory: 'D:\\X\\Y' } }).expect(200);

      const parked = {
        sessionID: 'ses_perm_repo',
        id: 'per_1',
        action: 'Bash',
        resources: ['bun test'],
      };
      runners.runners[0].permissionRequests.push(parked);

      // Both spellings of the same directory match; another directory does not.
      expect(runtime.pendingPermissionsForDirectory('D:\\X\\Y')).toEqual([parked]);
      expect(runtime.pendingPermissionsForDirectory('D:/X/Y/')).toEqual([parked]);
      expect(runtime.pendingPermissionsForDirectory('D:\\X\\Z')).toEqual([]);

      // A value that names no directory matches nothing.
      expect(runtime.pendingPermissionsForDirectory(undefined)).toEqual([]);
      expect(runtime.pendingPermissionsForDirectory('')).toEqual([]);
    });
  });

  describe('messages', () => {
    test('answers message.list with the SDK page envelope from the transcript', async () => {
      const { runtime, runners } = createRuntime();
      await runtime.start();
      const app = createApp(runtime);
      await createSession(app, { id: 'ses_msg_1', location: { directory: 'C:\\work\\msg' } }).expect(200);
      await request(app)
        .post('/api/session/ses_msg_1/prompt')
        .send({ id: 'msg_user_1', text: 'Fix it' })
        .expect(200);

      // The user record comes from the fake runner's send; the turn below is
      // written through the same transcript the runner owns.
      const { transcript, sessionID, directory } = runners.sessions[0];
      transcript.applyWireEvent({
        id: 'evt_1',
        type: 'session.step.started',
        created: 10,
        data: {
          sessionID,
          assistantMessageID: 'msg_assistant_1',
          agent: 'claude',
          model: { providerID: 'claude-code', id: 'opus' },
          started: 10,
        },
        location: { directory },
      });
      transcript.applyWireEvent({
        id: 'evt_2',
        type: 'session.text.ended',
        created: 11,
        data: { sessionID, assistantMessageID: 'msg_assistant_1', ordinal: 0, text: 'Done' },
        location: { directory },
      });
      transcript.applyWireEvent({
        id: 'evt_3',
        type: 'session.step.ended',
        created: 12,
        data: { sessionID, assistantMessageID: 'msg_assistant_1', finish: 'stop', cost: 0.01, tokens: ZERO_TOKENS },
        location: { directory },
      });
      await transcript.flush();

      const page = await request(app).get('/api/session/ses_msg_1/message').expect(200);
      // The default order is newest first, like OpenCode's store.
      expect(page.body.data.map((message) => message.id)).toEqual(['msg_assistant_1', 'msg_user_1']);
      expect(page.body.data[0]).toMatchObject({ id: 'msg_assistant_1', type: 'assistant', finish: 'stop' });
      expect(page.body.data[0].content).toEqual([{ type: 'text', text: 'Done' }]);
      expect(page.body.data[1]).toMatchObject({ id: 'msg_user_1', type: 'user', text: 'Fix it' });
      // The last record of the direction means the page is complete.
      expect(page.body.cursor).toEqual({});

      const newestFirst = await request(app).get('/api/session/ses_msg_1/message?limit=1').expect(200);
      expect(newestFirst.body.data.map((message) => message.id)).toEqual(['msg_assistant_1']);
      expect(newestFirst.body.cursor).toEqual({ next: 'msg_assistant_1' });
      const oldestFirst = await request(app).get('/api/session/ses_msg_1/message?limit=1&order=asc').expect(200);
      expect(oldestFirst.body.data.map((message) => message.id)).toEqual(['msg_user_1']);
      expect(oldestFirst.body.cursor).toEqual({ next: 'msg_user_1' });
      expect(await fileExists(transcriptPath('ses_msg_1'))).toBe(true);
    });
  });

  describe('synthetic context', () => {
    test('records and emits a synthetic message, then carries it into the next prompt only', async () => {
      const { runtime, hub, runners } = createRuntime();
      await runtime.start();
      const app = createApp(runtime);
      await createSession(app, { id: 'ses_ctx_1', location: { directory: 'C:\\work\\ctx' } }).expect(200);

      const metadata = { kind: 'quote' };
      const admitted = await request(app)
        .post('/api/session/ses_ctx_1/synthetic')
        .send({ id: 'msg_ctx_1', text: 'The failing test', description: 'Quoted selection', metadata })
        .expect(200);
      expect(admitted.body.data).toMatchObject({ id: 'msg_ctx_1', type: 'synthetic', text: 'The failing test' });

      // The transcript is the source of message.list, and the record survives
      // the UI's own projection.
      const page = await request(app).get('/api/session/ses_ctx_1/message').expect(200);
      expect(page.body.data).toEqual([
        expect.objectContaining({
          id: 'msg_ctx_1',
          type: 'synthetic',
          text: 'The failing test',
          description: 'Quoted selection',
          metadata,
        }),
      ]);
      const [projected] = projectMessages(page.body.data, 'ses_ctx_1');
      expect(projected.message).toMatchObject({
        id: 'msg_ctx_1',
        sessionID: 'ses_ctx_1',
        role: 'synthetic',
        text: 'The failing test',
        description: 'Quoted selection',
        metadata,
      });

      // The wire event carries the client's message id in the event id space,
      // which is exactly what the UI reads back (`messageIdFromEvent`).
      const emitted = hub.ofType('session.synthetic');
      expect(emitted).toEqual([
        expect.objectContaining({
          id: 'evt_ctx_1',
          created: CLOCK,
          data: { sessionID: 'ses_ctx_1', text: 'The failing test', description: 'Quoted selection', metadata },
          location: { directory: 'C:/work/ctx' },
        }),
      ]);
      expect(messageIdFromEvent(emitted[0].id)).toBe('msg_ctx_1');

      // The next prompt carries the context; the one after it does not.
      await request(app).post('/api/session/ses_ctx_1/prompt').send({ id: 'msg_p_1', text: 'Fix it' }).expect(200);
      await request(app).post('/api/session/ses_ctx_1/prompt').send({ id: 'msg_p_2', text: 'Again' }).expect(200);
      expect(runners.runners[0].sends).toEqual([
        { text: 'Fix it', messageID: 'msg_p_1', context: ['The failing test'] },
        { text: 'Again', messageID: 'msg_p_2' },
      ]);
    });

    test('mints the message id when the client sends none', async () => {
      const { runtime, hub } = createRuntime();
      await runtime.start();
      const app = createApp(runtime);
      await createSession(app, { id: 'ses_ctx_mint', location: { directory: 'C:\\work\\ctx' } }).expect(200);

      await request(app)
        .post('/api/session/ses_ctx_mint/synthetic')
        .send({ text: 'Auto id' })
        .expect(200);

      const [event] = hub.ofType('session.synthetic');
      expect(event.id).toMatch(/^evt_/);
      const page = await request(app).get('/api/session/ses_ctx_mint/message').expect(200);
      expect(page.body.data[0].id).toBe(messageIdFromEvent(event.id));
    });

    test('leaves an unknown session to the proxy', async () => {
      const { runtime, hub } = createRuntime();
      await runtime.start();
      const app = createApp(runtime);

      await request(app)
        .post('/api/session/ses_missing/synthetic')
        .send({ text: 'Context' })
        .expect(418);
      expect(hub.ofType('session.synthetic')).toEqual([]);
    });
  });

  describe('prompt, interrupt, permissions and switches', () => {
    test('sends the prompt to the session runner and answers its message id', async () => {
      const { runtime, runners } = createRuntime();
      await runtime.start();
      const app = createApp(runtime);
      await createSession(app, { id: 'ses_prompt_1', location: { directory: 'C:\\work\\prompt' } }).expect(200);

      const response = await request(app)
        .post('/api/session/ses_prompt_1/prompt')
        .send({ id: 'msg_client_1', text: 'Fix it', files: [{ name: 'ignored.txt' }] })
        .expect(200);

      expect(response.body).toEqual({ data: { id: 'msg_client_1' } });
      expect(runners.runners).toHaveLength(1);
      expect(runners.sessions[0]).toMatchObject({
        sessionID: 'ses_prompt_1',
        directory: 'C:/work/prompt',
        cwd: 'C:/work/prompt',
        model: 'opus',
        claudeSessionUuid: null,
        cliPath: 'C:\\fake\\claude.exe',
      });
      expect(runners.runners[0].sends).toEqual([{ text: 'Fix it', messageID: 'msg_client_1' }]);
    });

    test('interrupts the live runner and reports nothing when none is live', async () => {
      const { runtime, runners } = createRuntime();
      await runtime.start();
      const app = createApp(runtime);
      await createAndPrompt(app, { id: 'ses_int_1', location: { directory: 'C:\\work\\int' } });

      await request(app).post('/api/session/ses_int_1/interrupt').expect(200).expect({ interrupted: true });
      expect(runners.runners[0].interrupts).toBe(1);

      await createSession(app, { id: 'ses_int_2', location: { directory: 'C:\\work\\int' } }).expect(200);
      await request(app).post('/api/session/ses_int_2/interrupt').expect(200).expect({ interrupted: false });
    });

    test('passes a permission decision to the live runner', async () => {
      const { runtime, runners } = createRuntime();
      await runtime.start();
      const app = createApp(runtime);
      await createAndPrompt(app, { id: 'ses_perm_1', location: { directory: 'C:\\work\\perm' } });
      const runner = runners.runners[0];

      await request(app)
        .post('/api/session/ses_perm_1/permission/per_1/reply')
        .send({ decision: 'always' })
        .expect(204);
      expect(runner.permissions).toEqual([['per_1', 'always']]);

      runner.permissionResult = false;
      await request(app)
        .post('/api/session/ses_perm_1/permission/per_unknown/reply')
        .send({ decision: 'once' })
        .expect(404);

      // A session with no live runner has nothing to resolve either.
      await createSession(app, { id: 'ses_perm_2', location: { directory: 'C:\\work\\perm' } }).expect(200);
      await request(app)
        .post('/api/session/ses_perm_2/permission/per_2/reply')
        .send({ decision: 'reject' })
        .expect(404);
    });

    test('stores a model switch, calls the live runner and emits session.model.selected', async () => {
      const { runtime, hub, runners, clock } = createRuntime();
      await runtime.start();
      const app = createApp(runtime);
      await createAndPrompt(app, { id: 'ses_model_1', location: { directory: 'C:\\work\\model' } });
      const runner = runners.runners[0];

      clock.advance();
      await request(app)
        .post('/api/session/ses_model_1/model')
        .send({ model: { providerID: 'claude-code', id: 'sonnet' } })
        .expect(204);

      expect(runner.models).toEqual(['sonnet']);
      expect(hub.ofType('session.model.selected')).toEqual([
        expect.objectContaining({
          created: CLOCK + 1000,
          data: {
            sessionID: 'ses_model_1',
            model: { providerID: 'claude-code', id: 'sonnet' },
            previous: { providerID: 'claude-code', id: 'opus' },
          },
          location: { directory: 'C:/work/model' },
        }),
      ]);
      const info = (await request(app).get('/api/session/ses_model_1').expect(200)).body.data;
      expect(info.model).toEqual({ providerID: 'claude-code', id: 'sonnet' });
      expect(info.time.updated).toBe(CLOCK + 1000);
      expect((await readIndex()).ses_model_1.model).toEqual({ providerID: 'claude-code', id: 'sonnet' });

      // A selection from another provider, or an unknown alias, is ignored:
      // the record keeps the last valid alias, the live runner is not asked,
      // and nothing is emitted.
      clock.advance();
      await request(app)
        .post('/api/session/ses_model_1/model')
        .send({ model: { providerID: 'openchamber', id: 'auto' } })
        .expect(204);
      await request(app)
        .post('/api/session/ses_model_1/model')
        .send({ model: { providerID: 'claude-code', id: 'big-pickle' } })
        .expect(204);
      expect(runner.models).toEqual(['sonnet']);
      expect(hub.ofType('session.model.selected')).toHaveLength(1);
      expect((await request(app).get('/api/session/ses_model_1').expect(200)).body.data.model)
        .toEqual({ providerID: 'claude-code', id: 'sonnet' });
      expect((await readIndex()).ses_model_1.model).toEqual({ providerID: 'claude-code', id: 'sonnet' });
      expect((await readIndex()).ses_model_1.updatedAt).toBe(CLOCK + 1000);

      // A switch to another known alias still lands, runner included.
      clock.advance();
      await request(app)
        .post('/api/session/ses_model_1/model')
        .send({ model: { providerID: 'claude-code', id: 'haiku' } })
        .expect(204);
      expect(runner.models).toEqual(['sonnet', 'haiku']);
      expect(hub.ofType('session.model.selected')).toHaveLength(2);
      expect((await readIndex()).ses_model_1.model).toEqual({ providerID: 'claude-code', id: 'haiku' });
      expect((await readIndex()).ses_model_1.updatedAt).toBe(CLOCK + 3000);
    });

    test('derives the title from the first prompt text and emits session.renamed once', async () => {
      const { runtime, hub, clock } = createRuntime();
      await runtime.start();
      const app = createApp(runtime);
      await createSession(app, { id: 'ses_title_1', location: { directory: 'C:\\work\\title' } }).expect(200);

      clock.advance();
      await request(app)
        .post('/api/session/ses_title_1/prompt')
        .send({ id: 'msg_title_1', text: '  Fix   the parser\nsecond line is ignored  ' })
        .expect(200);

      // The first non-empty line, trimmed and collapsed, names the session.
      expect(hub.ofType('session.renamed')).toEqual([
        expect.objectContaining({
          created: CLOCK + 1000,
          data: { sessionID: 'ses_title_1', title: 'Fix the parser' },
          location: { directory: 'C:/work/title' },
        }),
      ]);
      expect((await readIndex()).ses_title_1).toMatchObject({ title: 'Fix the parser', updatedAt: CLOCK + 1000 });

      // A later prompt never renames a session that already has a title.
      clock.advance();
      await request(app)
        .post('/api/session/ses_title_1/prompt')
        .send({ id: 'msg_title_2', text: 'A completely different prompt' })
        .expect(200);
      expect(hub.ofType('session.renamed')).toHaveLength(1);
      expect((await readIndex()).ses_title_1.title).toBe('Fix the parser');
    });

    test('truncates a long derived title and leaves preset and blank titles alone', async () => {
      const { runtime, hub } = createRuntime();
      await runtime.start();
      const app = createApp(runtime);

      await createSession(app, { id: 'ses_title_long', location: { directory: 'C:\\work\\title' } }).expect(200);
      await request(app)
        .post('/api/session/ses_title_long/prompt')
        .send({ id: 'msg_long_1', text: 'x'.repeat(80) })
        .expect(200);
      expect(hub.ofType('session.renamed')).toEqual([
        expect.objectContaining({
          data: { sessionID: 'ses_title_long', title: `${'x'.repeat(60)}...` },
        }),
      ]);

      // A title the create already set is never overwritten.
      await createSession(app, {
        id: 'ses_title_kept',
        title: 'Kept title',
        location: { directory: 'C:\\work\\title' },
      }).expect(200);
      await request(app)
        .post('/api/session/ses_title_kept/prompt')
        .send({ id: 'msg_kept_1', text: 'This must not rename' })
        .expect(200);
      expect((await readIndex()).ses_title_kept.title).toBe('Kept title');

      // An all-blank prompt derives nothing: the title stays empty.
      await createSession(app, { id: 'ses_title_blank', location: { directory: 'C:\\work\\title' } }).expect(200);
      await request(app)
        .post('/api/session/ses_title_blank/prompt')
        .send({ id: 'msg_blank_1', text: '   \n\t  ' })
        .expect(200);
      expect((await readIndex()).ses_title_blank.title).toBe('');
      expect(hub.ofType('session.renamed')).toHaveLength(1);
    });
  });

  describe('session.generate', () => {
    test('answers one-shot text from the result, without a runner or transcript records', async () => {
      const oneShot = createOneShot(
        { type: 'system', subtype: 'init', session_id: 'claude-one-shot' },
        { type: 'result', subtype: 'success', result: 'Draft commit message' },
      );
      const { runtime, runners } = createRuntime({ deps: { spawnQueryImpl: oneShot.spawn } });
      await runtime.start();
      const app = createApp(runtime);
      await createSession(app, { id: 'ses_gen_1', location: { directory: 'C:\\work\\gen' } }).expect(200);

      const response = await request(app)
        .post('/api/session/ses_gen_1/generate')
        .send({ prompt: 'Draft a commit message' })
        .expect(200);

      expect(response.body).toEqual({ data: { text: 'Draft commit message' } });
      expect(oneShot.calls).toHaveLength(1);
      expect(oneShot.calls[0].prompt).toBe('Draft a commit message');
      expect(oneShot.calls[0].options).toMatchObject({
        cwd: 'C:/work/gen',
        maxTurns: 1,
        tools: [],
        pathToClaudeCodeExecutable: 'C:\\fake\\claude.exe',
      });
      expect(oneShot.calls[0].options.resume).toBeUndefined();

      // The one-shot never creates a runner and never enters history.
      expect(runners.runners).toEqual([]);
      const page = await request(app).get('/api/session/ses_gen_1/message').expect(200);
      expect(page.body.data).toEqual([]);
      expect(await fileExists(transcriptPath('ses_gen_1'))).toBe(false);
    });

    test("resumes the record's Claude session id when it has one", async () => {
      await fs.mkdir(path.dirname(indexPath()), { recursive: true });
      await fs.writeFile(indexPath(), JSON.stringify({
        ses_gen_resume: {
          directory: 'C:\\work\\gen',
          title: 'Resume',
          createdAt: 1,
          updatedAt: 1,
          cost: 0,
          tokens: ZERO_TOKENS,
          model: { providerID: 'claude-code', id: 'opus' },
          claudeSessionUuid: 'claude-uuid-9',
          metadata: {},
        },
      }), 'utf8');
      const oneShot = createOneShot({ type: 'result', subtype: 'success', result: 'Continued' });
      const { runtime } = createRuntime({ deps: { spawnQueryImpl: oneShot.spawn } });
      await runtime.start();
      const app = createApp(runtime);

      await request(app)
        .post('/api/session/ses_gen_resume/generate')
        .send({ prompt: 'Continue' })
        .expect(200);

      expect(oneShot.calls[0].options.resume).toBe('claude-uuid-9');
    });

    test('answers a tagged 503 when the one-shot query fails', async () => {
      const { runtime } = createRuntime({
        deps: {
          spawnQueryImpl: async () => {
            throw new Error('spawn failed');
          },
        },
      });
      await runtime.start();
      const app = createApp(runtime);
      await createSession(app, { id: 'ses_gen_fail', location: { directory: 'C:\\work\\gen' } }).expect(200);

      const response = await request(app)
        .post('/api/session/ses_gen_fail/generate')
        .send({ prompt: 'Hi' })
        .expect(503);

      expect(response.body).toMatchObject({ _tag: 'ServiceUnavailableError' });
      expect(response.body.message).toContain('spawn failed');
    });

    test('answers a tagged 503 when the stream ends without a result', async () => {
      const oneShot = createOneShot({ type: 'system', subtype: 'init' });
      const { runtime } = createRuntime({ deps: { spawnQueryImpl: oneShot.spawn } });
      await runtime.start();
      const app = createApp(runtime);
      await createSession(app, { id: 'ses_gen_empty', location: { directory: 'C:\\work\\gen' } }).expect(200);

      const response = await request(app)
        .post('/api/session/ses_gen_empty/generate')
        .send({ prompt: 'Hi' })
        .expect(503);

      expect(response.body).toMatchObject({ _tag: 'ServiceUnavailableError' });
      expect(response.body.message).toContain('ended before returning a result');
    });

    test('answers a tagged 503 when the result reports an error', async () => {
      // A success-subtype result with `is_error` carries the error text in
      // `result`; it must fail instead of being handed back as generated text.
      const oneShot = createOneShot({
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'API error: overloaded',
      });
      const { runtime } = createRuntime({ deps: { spawnQueryImpl: oneShot.spawn } });
      await runtime.start();
      const app = createApp(runtime);
      await createSession(app, { id: 'ses_gen_error', location: { directory: 'C:\\work\\gen' } }).expect(200);

      const response = await request(app)
        .post('/api/session/ses_gen_error/generate')
        .send({ prompt: 'Hi' })
        .expect(503);

      expect(response.body).toMatchObject({ _tag: 'ServiceUnavailableError' });
      expect(response.body.message).toContain('failed before returning text');
    });
  });

  describe('usage and cost', () => {
    test('onUsage replaces cost, accumulates tokens, emits session.usage.updated and survives a reload', async () => {
      const first = createRuntime();
      await first.runtime.start();
      const app = createApp(first.runtime);
      await createAndPrompt(app, { id: 'ses_usage_1', location: { directory: 'C:\\work\\usage' } });

      const onUsage = first.runners.sessions[0].onUsage;
      onUsage({ cost: 0.05, tokens: { input: 10, output: 4, reasoning: 1, cache: { read: 3, write: 2 } } });
      onUsage({ cost: 0.08, tokens: { input: 5, output: 6, reasoning: 0, cache: { read: 1, write: 0 } } });

      const totals = { input: 15, output: 10, reasoning: 1, cache: { read: 4, write: 2 } };
      await waitFor(async () => (await readIndex()).ses_usage_1.cost === 0.08);
      // The latest cumulative cost replaces the record's; token counts add up.
      expect((await readIndex()).ses_usage_1.tokens).toEqual(totals);

      const emitted = first.hub.ofType('session.usage.updated');
      expect(emitted).toHaveLength(2);
      expect(emitted[0]).toMatchObject({
        data: {
          sessionID: 'ses_usage_1',
          cost: 0.05,
          tokens: { input: 10, output: 4, reasoning: 1, cache: { read: 3, write: 2 } },
        },
        location: { directory: 'C:/work/usage' },
      });
      expect(emitted[1].data).toEqual({ sessionID: 'ses_usage_1', cost: 0.08, tokens: totals });

      // The wire record answers the same totals through the UI's projection.
      const info = (await request(app).get('/api/session/ses_usage_1').expect(200)).body.data;
      expect(info.cost).toBe(0.08);
      expect(info.tokens).toEqual(totals);
      expect(projectSession(info)).toMatchObject({ cost: 0.08, tokens: totals });

      // A new runtime reloads the persisted totals.
      await first.runtime.stop();
      const second = createRuntime();
      await second.runtime.start();
      expect(second.runtime.listSessionsForProxy({}).find((record) => record.id === 'ses_usage_1'))
        .toMatchObject({ cost: 0.08, tokens: totals });
      const reread = (await request(createApp(second.runtime)).get('/api/session/ses_usage_1').expect(200)).body.data;
      expect(reread.cost).toBe(0.08);
      expect(reread.tokens).toEqual(totals);
    });
  });

  describe('generated titles', () => {
    test('replaces the derived title with the model title and emits session.renamed', async () => {
      const oneShot = createManualOneShot({ result: '  Model-written title  \nignored line' });
      const { runtime, hub } = createRuntime({ deps: { spawnQueryImpl: oneShot.spawn } });
      await runtime.start();
      const app = createApp(runtime);
      await createSession(app, { id: 'ses_gentitle_1', location: { directory: 'C:\\work\\title' } }).expect(200);

      await request(app)
        .post('/api/session/ses_gentitle_1/prompt')
        .send({ id: 'msg_gt_1', text: 'Fix the parser' })
        .expect(200);
      expect(hub.ofType('session.renamed')).toEqual([
        expect.objectContaining({ data: { sessionID: 'ses_gentitle_1', title: 'Fix the parser' } }),
      ]);

      oneShot.release();
      await oneShot.done;
      await waitFor(async () => (await readIndex()).ses_gentitle_1.title === 'Model-written title');
      const renamed = hub.ofType('session.renamed');
      expect(renamed).toHaveLength(2);
      expect(renamed[1].data).toEqual({ sessionID: 'ses_gentitle_1', title: 'Model-written title' });

      // The one-shot carries the instructions and the user's text, on `haiku`,
      // with the resolved CLI so a packaged app does not fall back to the SDK's
      // bundled binary inside app.asar.
      expect(oneShot.calls).toHaveLength(1);
      expect(oneShot.calls[0].prompt).toBe(
        'Reply with a title only: max 6 words, no quotes, no punctuation at the end, same language as the text. Text: Fix the parser',
      );
      expect(oneShot.calls[0].options).toEqual({
        cwd: 'C:/work/title',
        maxTurns: 1,
        tools: [],
        model: 'haiku',
        pathToClaudeCodeExecutable: 'C:\\fake\\claude.exe',
      });
    });

    test('omits the CLI path when none resolves', async () => {
      const oneShot = createManualOneShot({ result: 'Model-written title' });
      const { runtime } = createRuntime({
        deps: { spawnQueryImpl: oneShot.spawn, resolveCliPath: async () => null },
      });
      await runtime.start();
      const app = createApp(runtime);
      await createSession(app, { id: 'ses_gentitle_7', location: { directory: 'C:\\work\\title' } }).expect(200);

      await request(app)
        .post('/api/session/ses_gentitle_7/prompt')
        .send({ id: 'msg_gt_7', text: 'Fix the parser' })
        .expect(200);
      oneShot.release();
      await oneShot.done;

      expect(oneShot.calls[0].options).toEqual({
        cwd: 'C:/work/title',
        maxTurns: 1,
        tools: [],
        model: 'haiku',
      });
    });

    test('a title changed before the generation completed is not clobbered', async () => {
      const oneShot = createManualOneShot({ result: 'Model-written title' });
      const { runtime, hub } = createRuntime({ deps: { spawnQueryImpl: oneShot.spawn } });
      await runtime.start();
      const app = createApp(runtime);
      await createSession(app, { id: 'ses_gentitle_2', location: { directory: 'C:\\work\\title' } }).expect(200);

      await request(app)
        .post('/api/session/ses_gentitle_2/prompt')
        .send({ id: 'msg_gt_2', text: 'Fix the parser' })
        .expect(200);
      await request(app).patch('/api/session/ses_gentitle_2').send({ title: 'Manual title' }).expect(204);

      oneShot.release();
      await oneShot.done;
      // Give the completed generation a beat to run its title check.
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect((await readIndex()).ses_gentitle_2.title).toBe('Manual title');
      // The derived rename and the manual one; the generation applied nothing.
      expect(hub.ofType('session.renamed')).toHaveLength(2);
    });

    test('leaves the derived title when generation fails', async () => {
      const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
      try {
        const oneShot = createManualOneShot({ error: new Error('haiku is unavailable') });
        const { runtime, hub } = createRuntime({ deps: { spawnQueryImpl: oneShot.spawn } });
        await runtime.start();
        const app = createApp(runtime);
        await createSession(app, { id: 'ses_gentitle_3', location: { directory: 'C:\\work\\title' } }).expect(200);

        await request(app)
          .post('/api/session/ses_gentitle_3/prompt')
          .send({ id: 'msg_gt_3', text: 'Fix the parser' })
          .expect(200);

        oneShot.release();
        await oneShot.done;
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect((await readIndex()).ses_gentitle_3.title).toBe('Fix the parser');
        expect(hub.ofType('session.renamed')).toHaveLength(1);
        // The failure is silent: one debug line, no thrown error, no rename.
        expect(debug).toHaveBeenCalledTimes(1);
      } finally {
        debug.mockRestore();
      }
    });

    test('only the first prompt with text triggers title generation', async () => {
      const oneShot = createManualOneShot({ result: 'Model title' });
      const { runtime, hub } = createRuntime({ deps: { spawnQueryImpl: oneShot.spawn } });
      await runtime.start();
      const app = createApp(runtime);
      await createSession(app, { id: 'ses_gentitle_4', location: { directory: 'C:\\work\\title' } }).expect(200);

      await request(app)
        .post('/api/session/ses_gentitle_4/prompt')
        .send({ id: 'msg_gt_4a', text: 'Fix the parser' })
        .expect(200);
      oneShot.release();
      await waitFor(async () => (await readIndex()).ses_gentitle_4.title === 'Model title');

      await request(app)
        .post('/api/session/ses_gentitle_4/prompt')
        .send({ id: 'msg_gt_4b', text: 'A later prompt' })
        .expect(200);
      expect(oneShot.calls).toHaveLength(1);
      expect((await readIndex()).ses_gentitle_4.title).toBe('Model title');
      expect(hub.ofType('session.renamed')).toHaveLength(2);

      // A title the create set never triggers generation either.
      await createSession(app, {
        id: 'ses_gentitle_5',
        title: 'Preset',
        location: { directory: 'C:\\work\\title' },
      }).expect(200);
      await request(app)
        .post('/api/session/ses_gentitle_5/prompt')
        .send({ id: 'msg_gt_5', text: 'Must not generate' })
        .expect(200);
      expect(oneShot.calls).toHaveLength(1);
    });

    test('cuts the title prompt to 500 characters and the generated title to 80', async () => {
      const longText = `Fix the parser ${'x'.repeat(600)}`;
      const oneShot = createManualOneShot({ result: 'y'.repeat(120) });
      const { runtime } = createRuntime({ deps: { spawnQueryImpl: oneShot.spawn } });
      await runtime.start();
      const app = createApp(runtime);
      await createSession(app, { id: 'ses_gentitle_6', location: { directory: 'C:\\work\\title' } }).expect(200);

      await request(app)
        .post('/api/session/ses_gentitle_6/prompt')
        .send({ id: 'msg_gt_6', text: longText })
        .expect(200);

      oneShot.release();
      await waitFor(async () => (await readIndex()).ses_gentitle_6.title === 'y'.repeat(80));
      expect(oneShot.calls[0].prompt).toBe(
        `Reply with a title only: max 6 words, no quotes, no punctuation at the end, same language as the text. Text: ${longText.slice(0, 500)}`,
      );
    });
  });

  describe('OpenChamber metadata', () => {
    test('merge-patches the stored record, returns the merged object and persists it', async () => {
      const { runtime, hub } = createRuntime();
      await runtime.start();
      const app = createApp(runtime);
      await createSession(app, {
        id: 'ses_meta_1',
        metadata: { openchamber: { goal: { state: 'active' } }, note: 'one' },
        location: { directory: 'C:\\work\\meta' },
      }).expect(200);

      expect(runtime.getSessionMetadata('ses_meta_1')).toEqual({
        openchamber: { goal: { state: 'active' }, backend: 'claude' },
        note: 'one',
      });
      expect(runtime.getSessionMetadata('ses_missing')).toBeNull();

      const merged = await runtime.mergeSessionMetadata(
        'ses_meta_1',
        { openchamber: { goal: { state: 'done' }, pinned: true }, note: null },
        { directory: 'C:\\work\\meta' },
      );
      expect(merged).toEqual({
        openchamber: { goal: { state: 'done' }, backend: 'claude', pinned: true },
      });
      expect(runtime.getSessionMetadata('ses_meta_1')).toEqual(merged);
      expect(hub.ofType('session.metadata.updated')).toEqual([
        expect.objectContaining({
          data: { sessionID: 'ses_meta_1', metadata: merged },
          location: { directory: 'C:/work/meta' },
        }),
      ]);
      expect((await readIndex()).ses_meta_1.metadata).toEqual(merged);
      expect((await request(app).get('/api/session/ses_meta_1').expect(200)).body.data.metadata).toEqual(merged);

      // A patch cannot unset the backend marker that makes this a Claude session.
      const markerKept = await runtime.mergeSessionMetadata('ses_meta_1', { openchamber: { backend: null } });
      expect(markerKept.openchamber.backend).toBe('claude');

      await expect(runtime.mergeSessionMetadata('ses_missing', { note: 'x' })).rejects.toThrow();
      await expect(runtime.mergeSessionMetadata('ses_meta_1', 'not an object')).rejects.toThrow();
    });
  });

  describe('permission mode and effort', () => {
    test('stores the permission mode, emits the metadata event and tells the live runner', async () => {
      const { runtime, hub, runners } = createRuntime();
      await runtime.start();
      const app = createApp(runtime);
      await createAndPrompt(app, { id: 'ses_mode_1', location: { directory: 'C:\\work\\mode' } });
      const runner = runners.runners[0];

      const response = await request(app)
        .post('/api/session/ses_mode_1/permission-mode')
        .send({ mode: 'acceptEdits' })
        .expect(200);

      expect(response.body).toEqual({ data: { mode: 'acceptEdits' } });
      expect(runner.permissionModes).toEqual(['acceptEdits']);
      expect(hub.ofType('session.metadata.updated')).toEqual([
        expect.objectContaining({
          data: {
            sessionID: 'ses_mode_1',
            metadata: { openchamber: { backend: 'claude', permissionMode: 'acceptEdits' } },
          },
          location: { directory: 'C:/work/mode' },
        }),
      ]);
      expect((await readIndex()).ses_mode_1.metadata.openchamber.permissionMode).toBe('acceptEdits');
      const info = (await request(app).get('/api/session/ses_mode_1').expect(200)).body.data;
      expect(info.metadata.openchamber.permissionMode).toBe('acceptEdits');

      // A session with no live runner stores the mode without one.
      await createSession(app, { id: 'ses_mode_2', location: { directory: 'C:\\work\\mode' } }).expect(200);
      await request(app)
        .post('/api/session/ses_mode_2/permission-mode')
        .send({ mode: 'bypassPermissions' })
        .expect(200);
      expect(runners.runners).toHaveLength(1);
      expect((await readIndex()).ses_mode_2.metadata.openchamber.permissionMode).toBe('bypassPermissions');
    });

    test('rejects a permission mode outside the v1 set', async () => {
      const { runtime, hub } = createRuntime();
      await runtime.start();
      const app = createApp(runtime);
      await createSession(app, { id: 'ses_mode_3', location: { directory: 'C:\\work\\mode' } }).expect(200);

      for (const mode of ['plan', 'dontAsk', 'auto', 'yolo', '', 42, null]) {
        const response = await request(app)
          .post('/api/session/ses_mode_3/permission-mode')
          .send({ mode })
          .expect(400);
        expect(response.body).toMatchObject({ _tag: 'InvalidRequestError' });
      }
      expect(hub.ofType('session.metadata.updated')).toEqual([]);
      // Nothing was stored: an absent mode reads as the default everywhere.
      expect(runtime.getSessionMetadata('ses_mode_3')).toEqual({ openchamber: { backend: 'claude' } });
    });

    test('heals an unknown stored permission mode and effort on load', async () => {
      await fs.mkdir(path.dirname(indexPath()), { recursive: true });
      await fs.writeFile(indexPath(), JSON.stringify({
        ses_mode_heal: {
          directory: 'C:\\work\\mode',
          title: 'Heal',
          createdAt: 1,
          updatedAt: 1,
          model: { providerID: 'claude-code', id: 'opus' },
          claudeSessionUuid: null,
          metadata: { openchamber: { permissionMode: 'yolo', effort: 'gigantic', pinned: true } },
        },
      }), 'utf8');

      const { runtime, runners } = createRuntime();
      await runtime.start();

      // The healed metadata is on disk, so the next boot starts canonical: the
      // unknown mode became the default, the unknown effort was dropped.
      const healed = { openchamber: { backend: 'claude', permissionMode: 'default', pinned: true } };
      expect((await readIndex()).ses_mode_heal.metadata).toEqual(healed);
      expect(runtime.getSessionMetadata('ses_mode_heal')).toEqual(healed);

      // The healed values reach the runner when the session is prompted.
      const app = createApp(runtime);
      await request(app)
        .post('/api/session/ses_mode_heal/prompt')
        .send({ id: 'msg_heal_1', text: 'Hello' })
        .expect(200);
      expect(runners.sessions[0].permissionMode).toBe('default');
      expect(runners.sessions[0].effort).toBeNull();
    });

    test('stores an effort level, clears it with null, and emits the metadata event', async () => {
      const { runtime, hub, runners } = createRuntime();
      await runtime.start();
      const app = createApp(runtime);
      await createSession(app, { id: 'ses_effort_1', location: { directory: 'C:\\work\\effort' } }).expect(200);

      const set = await request(app).post('/api/session/ses_effort_1/effort').send({ effort: 'xhigh' }).expect(200);
      expect(set.body).toEqual({ data: { effort: 'xhigh' } });
      expect((await readIndex()).ses_effort_1.metadata.openchamber.effort).toBe('xhigh');

      // Effort is read at runner creation, so the next runner carries it; a
      // change while a runner is live is not handed to it (the fake runner has
      // no setEffort, so a call would fail the request).
      await request(app).post('/api/session/ses_effort_1/prompt').send({ id: 'msg_eff_1', text: 'Hi' }).expect(200);
      expect(runners.sessions[0].effort).toBe('xhigh');
      await request(app).post('/api/session/ses_effort_1/effort').send({ effort: 'low' }).expect(200);
      expect(runners.runners[0].sends).toHaveLength(1);

      const cleared = await request(app).post('/api/session/ses_effort_1/effort').send({ effort: null }).expect(200);
      expect(cleared.body).toEqual({ data: { effort: null } });
      expect((await readIndex()).ses_effort_1.metadata.openchamber.effort).toBeUndefined();
      expect(runtime.getSessionMetadata('ses_effort_1').openchamber.effort).toBeUndefined();

      const emitted = hub.ofType('session.metadata.updated');
      expect(emitted).toHaveLength(3);
      expect(emitted[0].data.metadata.openchamber.effort).toBe('xhigh');
      expect(emitted[1].data.metadata.openchamber.effort).toBe('low');
      expect(emitted[2].data.metadata.openchamber.effort).toBeUndefined();
    });

    test('rejects an effort level outside the SDK set', async () => {
      const { runtime, hub } = createRuntime();
      await runtime.start();
      const app = createApp(runtime);
      await createSession(app, { id: 'ses_effort_2', location: { directory: 'C:\\work\\effort' } }).expect(200);

      for (const effort of ['gigantic', 'HIGH', 42]) {
        const response = await request(app)
          .post('/api/session/ses_effort_2/effort')
          .send({ effort })
          .expect(400);
        expect(response.body).toMatchObject({ _tag: 'InvalidRequestError' });
      }
      expect(hub.ofType('session.metadata.updated')).toEqual([]);
    });
  });

  describe('prompt attachments', () => {
    test('forwards validated attachments to the runner and drops malformed entries', async () => {
      const { runtime, runners } = createRuntime();
      await runtime.start();
      const app = createApp(runtime);
      await createSession(app, { id: 'ses_files_1', location: { directory: 'C:\\work\\files' } }).expect(200);

      await request(app)
        .post('/api/session/ses_files_1/prompt')
        .send({
          id: 'msg_files_1',
          text: 'See the attachment',
          files: [
            { uri: 'data:text/plain;base64,aGVsbG8=', name: 'note.txt' },
            { name: 'missing-uri.txt' },
            { uri: 42 },
            null,
          ],
        })
        .expect(200);

      expect(runners.runners[0].sends).toEqual([
        {
          text: 'See the attachment',
          messageID: 'msg_files_1',
          files: [{ uri: 'data:text/plain;base64,aGVsbG8=', name: 'note.txt' }],
        },
      ]);

      // A prompt with no usable attachment keeps the plain send shape.
      await request(app)
        .post('/api/session/ses_files_1/prompt')
        .send({ id: 'msg_files_2', text: 'No files', files: 'nonsense' })
        .expect(200);
      expect(runners.runners[0].sends[1]).toEqual({ text: 'No files', messageID: 'msg_files_2' });
    });
  });

  describe('CLI availability probe', () => {
    test('probes the resolved CLI at start and reports it through cliStatus', async () => {
      const probed = [];
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      const { runtime } = createRuntime({
        deps: {
          probeCliImpl: async ({ launchSpec }) => {
            probed.push(launchSpec);
            return { ok: true, version: '2.1.0 (Claude Code)' };
          },
        },
      });

      expect(runtime.cliStatus()).toEqual({ path: null, ok: false });

      await runtime.start();
      await waitFor(() => runtime.cliStatus().ok === true);

      // The runtime builds the spawn spec for the resolved path and hands it
      // to the probe; `--version` is the probe's own concern.
      expect(probed).toEqual([{ command: 'C:\\fake\\claude.exe', args: [] }]);
      expect(runtime.cliStatus()).toEqual({
        path: 'C:\\fake\\claude.exe',
        ok: true,
        version: '2.1.0 (Claude Code)',
      });
      expect(info).toHaveBeenCalledWith('[claude-code] claude CLI C:\\fake\\claude.exe (2.1.0 (Claude Code))');
    });

    test('records the failure and logs the fallback when the probe fails', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { runtime } = createRuntime({
        deps: { probeCliImpl: async () => ({ ok: false, error: 'exit code 1' }) },
      });

      await runtime.start();
      await waitFor(() => runtime.cliStatus().error === 'exit code 1');

      expect(runtime.cliStatus()).toEqual({ path: 'C:\\fake\\claude.exe', ok: false, error: 'exit code 1' });
      expect(warn).toHaveBeenCalledWith(
        "[claude-code] claude CLI C:\\fake\\claude.exe probe failed: exit code 1; sessions cannot start until it runs",
      );
    });

    test('reports the bundled executable when no CLI path resolves', async () => {
      const probed = [];
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      const { runtime } = createRuntime({
        deps: {
          resolveCliPath: async () => null,
          probeCliImpl: async (params) => {
            probed.push(params);
            return { ok: true, version: 'unused' };
          },
        },
      });

      await runtime.start();
      await waitFor(() => info.mock.calls.length > 0);

      expect(probed).toEqual([]);
      expect(runtime.cliStatus()).toEqual({ path: null, ok: false });
      expect(info).toHaveBeenCalledWith("[claude-code] no claude CLI found; the Agent SDK will resolve its own bundled executable");
    });

    test('a failing probe never rejects start()', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { runtime } = createRuntime({
        deps: {
          probeCliImpl: async () => {
            throw new Error('probe exploded');
          },
        },
      });

      await runtime.start();

      await waitFor(() => warn.mock.calls.length > 0);
      expect(warn).toHaveBeenCalledWith("[claude-code] claude CLI probe failed: probe exploded");
    });

    test('does not probe when the index cannot be loaded', async () => {
      await fs.mkdir(path.dirname(indexPath()), { recursive: true });
      await fs.writeFile(indexPath(), '{ not json', 'utf8');
      const probed = [];
      const { runtime } = createRuntime({
        deps: {
          probeCliImpl: async (params) => {
            probed.push(params);
            return { ok: true, version: 'unused' };
          },
        },
      });

      await expect(runtime.start()).rejects.toThrow(/unreadable/);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(probed).toEqual([]);
    });
  });

  describe('route level', () => {
    test('drives the real @opencode/client through create, prompt and permission reply', async () => {
      const { runtime, runners } = createRuntime();
      await runtime.start();
      const server = createApp(runtime).listen(0, '127.0.0.1');
      try {
        await new Promise((resolve) => server.once('listening', resolve));
        const client = OpenCode.make({
          baseUrl: `http://127.0.0.1:${server.address().port}`,
          headers: { 'x-openchamber-backend': 'claude' },
        });

        const session = await client.session.create({
          id: 'ses_e2e_1',
          title: 'End to end',
          location: { directory: 'C:\\work\\e2e' },
        });
        expect(projectSession(session)).toMatchObject({
          id: 'ses_e2e_1',
          projectID: uiProjectIdFromPath('C:\\work\\e2e'),
          directory: 'C:/work/e2e',
          title: 'End to end',
          cost: 0,
          tokens: ZERO_TOKENS,
        });

        const prompted = await client.session.prompt({ sessionID: 'ses_e2e_1', id: 'msg_e2e_1', text: 'Fix it' });
        expect(prompted).toEqual({ id: 'msg_e2e_1' });
        expect(runners.runners[0].sends).toEqual([{ text: 'Fix it', messageID: 'msg_e2e_1' }]);

        await client.permission.reply({ sessionID: 'ses_e2e_1', requestID: 'per_1', decision: 'once' });
        expect(runners.runners[0].permissions).toEqual([['per_1', 'once']]);

        const interrupted = await client.session.interrupt({ sessionID: 'ses_e2e_1' });
        expect(interrupted).toEqual({ interrupted: true });
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    test('accepts the runner factory as a plain object too', async () => {
      const runners = createFakeRunners();
      const { runtime } = createRuntime({ runners, deps: { createRunnerFactoryImpl: runners.factory } });
      await runtime.start();
      const app = createApp(runtime);
      await createAndPrompt(app, { id: 'ses_obj_1', location: { directory: 'C:\\work\\obj' } });
      expect(runners.runners[0].sends).toHaveLength(1);
    });
  });
});
