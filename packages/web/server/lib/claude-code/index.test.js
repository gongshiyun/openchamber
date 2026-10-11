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
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { messageIdFromEvent } from '../../../../ui/src/lib/opencode/events.ts';
import { projectMessages, projectSession } from '../../../../ui/src/lib/opencode/projection.ts';
import { createProjectIdFromPath as uiProjectIdFromPath } from '../../../../ui/src/lib/projectId.ts';
import { createClaudeCodeRuntime } from './index.js';

const ZERO_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
const CLOCK = 1_700_000_000_000;

let tempRoot;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-code-runtime-'));
});

afterEach(async () => {
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
        permissions: [],
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
        resolvePermission(requestID, decision) {
          runner.permissions.push([requestID, decision]);
          return runner.permissionResult;
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
