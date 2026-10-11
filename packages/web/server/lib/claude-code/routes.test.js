import express from 'express';
import request from 'supertest';
import { describe, expect, test } from 'bun:test';
import { OpenCode } from '@opencode/client';

import { createClaudeRoutes } from './routes.js';

/**
 * A fake registry with the same surface the server bootstrap injects (Task 7).
 * Every call is recorded as `[method, ...args]`; answers are the shapes the
 * real registry promises (a session record, a message page, a settled reply).
 */
const createRegistry = (overrides = {}) => {
  const calls = [];
  const record = (name, answer) => (...args) => {
    calls.push([name, ...args]);
    return answer instanceof Function ? answer(...args) : answer;
  };
  const registry = {
    isClaudeSession: (sessionID) => String(sessionID).startsWith('ses_claude'),
    createSession: record('createSession', ({ id, title, metadata, directory }) => {
      const session = { id: id ?? 'ses_claude_new', title, metadata };
      if (directory) session.location = { directory };
      return session;
    }),
    getSession: record('getSession', (sessionID) => ({ id: sessionID, location: { directory: '/repo/app' } })),
    renameSession: record('renameSession', undefined),
    removeSession: record('removeSession', undefined),
    moveSession: record('moveSession', undefined),
    sendPrompt: record('sendPrompt', { id: 'msg_1' }),
    generate: record('generate', { text: 'Generated text' }),
    synthetic: record('synthetic', { id: 'msg_synth_1', type: 'synthetic', text: 'Context' }),
    interrupt: record('interrupt', { interrupted: true }),
    switchModel: record('switchModel', undefined),
    switchAgent: record('switchAgent', undefined),
    setPermissionMode: record('setPermissionMode', (sessionID, mode) => mode),
    setEffort: record('setEffort', (sessionID, effort) => effort),
    getMessages: record('getMessages', { data: [{ id: 'msg_1' }], cursor: { next: 'cur_2' } }),
    replyPermission: record('replyPermission', true),
    ...overrides,
  };
  return { registry, calls };
};

/** The router under `/api`, with a terminal handler standing in for the proxy. */
const createApp = (overrides = {}) => {
  const { registry, calls } = createRegistry(overrides);
  const terminal = [];
  const app = express();
  app.use(express.json());
  app.use('/api', createClaudeRoutes({ registry }));
  app.use((req, res) => {
    terminal.push(`${req.method} ${req.originalUrl}`);
    res.status(418).json({ handledBy: 'proxy' });
  });
  return { app, calls, terminal };
};

describe('claude session routes', () => {
  describe('session ownership', () => {
    test('falls through when the registry does not own the session', async () => {
      const { app, calls, terminal } = createApp();

      const response = await request(app)
        .post('/api/session/ses_opencode_1/prompt')
        .send({ text: 'hello' })
        .expect(418);

      expect(response.body).toEqual({ handledBy: 'proxy' });
      expect(terminal).toEqual(['POST /api/session/ses_opencode_1/prompt']);
      expect(calls).toEqual([]);
    });

    test('falls through on every session-scoped route', async () => {
      const { app, calls, terminal } = createApp();
      const session = 'ses_opencode_1';

      await request(app).get(`/api/session/${session}`).expect(418);
      await request(app).patch(`/api/session/${session}`).send({ title: 'Renamed' }).expect(418);
      await request(app).delete(`/api/session/${session}`).expect(418);
      await request(app).post(`/api/session/${session}/move`).send({ directory: '/repo/other' }).expect(418);
      await request(app).post(`/api/session/${session}/model`).send({ model: { id: 'opus', providerID: 'claude-code' } }).expect(418);
      await request(app).post(`/api/session/${session}/agent`).send({ agent: 'build' }).expect(418);
      await request(app).post(`/api/session/${session}/permission-mode`).send({ mode: 'acceptEdits' }).expect(418);
      await request(app).post(`/api/session/${session}/effort`).send({ effort: 'high' }).expect(418);
      await request(app).post(`/api/session/${session}/generate`).send({ prompt: 'Hi' }).expect(418);
      await request(app).post(`/api/session/${session}/synthetic`).send({ text: 'context' }).expect(418);
      await request(app).post(`/api/session/${session}/interrupt`).expect(418);
      await request(app).get(`/api/session/${session}/message`).expect(418);
      await request(app).post(`/api/session/${session}/permission/perm_1/reply`).send({ decision: 'once' }).expect(418);

      expect(terminal).toHaveLength(13);
      expect(calls).toEqual([]);
    });

    test('leaves the session list to the proxy', async () => {
      const { app, calls, terminal } = createApp();

      await request(app).get('/api/session?limit=50').expect(418);

      expect(terminal).toEqual(['GET /api/session?limit=50']);
      expect(calls).toEqual([]);
    });
  });

  describe('POST /api/session', () => {
    test('falls through without the Claude backend header', async () => {
      const { app, calls, terminal } = createApp();

      const response = await request(app).post('/api/session').send({ title: 'Plain OpenCode session' }).expect(418);

      expect(response.body).toEqual({ handledBy: 'proxy' });
      expect(terminal).toEqual(['POST /api/session']);
      expect(calls).toEqual([]);
    });

    test('creates a Claude session when the backend header says so', async () => {
      const { app, calls } = createApp();
      const metadata = { openchamber: { backend: 'claude' } };

      const response = await request(app)
        .post('/api/session')
        .set('X-OpenChamber-Backend', 'claude')
        .send({ title: 'Claude task', metadata })
        .expect(200);

      expect(response.body).toEqual({
        data: { id: 'ses_claude_new', title: 'Claude task', metadata },
      });
      expect(calls).toEqual([['createSession', { title: 'Claude task', metadata }]]);
    });

    test('passes the directory the create names to the registry', async () => {
      const { app, calls } = createApp();

      await request(app)
        .post('/api/session')
        .set('x-openchamber-backend', 'claude')
        .send({ title: 'Claude task', location: { directory: '/repo/app' } })
        .expect(200);

      expect(calls).toEqual([
        ['createSession', { title: 'Claude task', metadata: undefined, directory: '/repo/app' }],
      ]);
    });

    test('forwards the client-minted id, agent, and model from the create body', async () => {
      const { app, calls } = createApp();
      const metadata = { openchamber: { backend: 'claude' } };
      const model = { providerID: 'claude-code', id: 'sonnet' };

      const response = await request(app)
        .post('/api/session')
        .set('x-openchamber-backend', 'claude')
        .send({
          id: 'ses_client_1',
          title: 'Claude task',
          agent: 'build',
          model,
          metadata,
          location: { directory: '/repo/app' },
        })
        .expect(200);

      expect(calls).toEqual([
        ['createSession', {
          id: 'ses_client_1',
          title: 'Claude task',
          agent: 'build',
          model,
          metadata,
          directory: '/repo/app',
        }],
      ]);
      expect(response.body.data.id).toBe('ses_client_1');
    });
  });

  describe('prompt and interrupt', () => {
    test('forwards a prompt with its text and answers the data envelope', async () => {
      const { app, calls } = createApp();

      const response = await request(app)
        .post('/api/session/ses_claude_1/prompt')
        .send({ id: 'msg_1', text: 'Fix the failing test' })
        .expect(200);

      expect(calls).toEqual([['sendPrompt', 'ses_claude_1', { text: 'Fix the failing test', id: 'msg_1' }]]);
      expect(response.body).toEqual({ data: { id: 'msg_1' } });
    });

    test('forwards the client-minted message id and files alongside the text', async () => {
      const { app, calls } = createApp();
      const files = [{ uri: 'data:text/plain;base64,aGVsbG8=', name: 'note.txt' }];

      await request(app)
        .post('/api/session/ses_claude_1/prompt')
        .send({ id: 'msg_client_1', text: 'See the attachment', files })
        .expect(200);

      expect(calls).toEqual([
        ['sendPrompt', 'ses_claude_1', { text: 'See the attachment', id: 'msg_client_1', files }],
      ]);
    });

    test('drops malformed attachments and keeps the valid ones', async () => {
      const { app, calls } = createApp();

      await request(app)
        .post('/api/session/ses_claude_1/prompt')
        .send({
          id: 'msg_files_1',
          text: 'Look',
          files: [
            { uri: 'data:text/plain;base64,aGVsbG8=', name: 'note.txt' },
            { name: 'missing-uri.txt' },
            { uri: 42, name: 'bad.txt' },
            null,
            { uri: 'data:image/png;base64,iVBORw0KGgo=' },
          ],
        })
        .expect(200);

      expect(calls).toEqual([
        ['sendPrompt', 'ses_claude_1', {
          text: 'Look',
          id: 'msg_files_1',
          files: [
            { uri: 'data:text/plain;base64,aGVsbG8=', name: 'note.txt' },
            { uri: 'data:image/png;base64,iVBORw0KGgo=' },
          ],
        }],
      ]);

      // A non-array, or an array with nothing valid, forwards no files at all.
      await request(app)
        .post('/api/session/ses_claude_1/prompt')
        .send({ id: 'msg_files_2', text: 'No files', files: 'nonsense' })
        .expect(200);
      await request(app)
        .post('/api/session/ses_claude_1/prompt')
        .send({ id: 'msg_files_3', text: 'Still none', files: [{ uri: '' }] })
        .expect(200);

      expect(calls.slice(1)).toEqual([
        ['sendPrompt', 'ses_claude_1', { text: 'No files', id: 'msg_files_2' }],
        ['sendPrompt', 'ses_claude_1', { text: 'Still none', id: 'msg_files_3' }],
      ]);
    });

    test('rejects a prompt without text', async () => {
      const { app, calls } = createApp();

      const response = await request(app)
        .post('/api/session/ses_claude_1/prompt')
        .send({ id: 'msg_1' })
        .expect(400);

      expect(response.body).toMatchObject({ _tag: 'InvalidRequestError' });
      expect(calls).toEqual([]);
    });

    test('forwards an interrupt and answers the raw wire shape', async () => {
      const { app, calls } = createApp();

      const response = await request(app).post('/api/session/ses_claude_1/interrupt').expect(200);

      expect(calls).toEqual([['interrupt', 'ses_claude_1']]);
      expect(response.body).toEqual({ interrupted: true });
    });

    test('reports an interrupt that found nothing as not interrupted', async () => {
      const { app } = createApp({ interrupt: async () => undefined });

      const response = await request(app).post('/api/session/ses_claude_1/interrupt').expect(200);

      expect(response.body).toEqual({ interrupted: false });
    });
  });

  describe('generate', () => {
    test('forwards the prompt and answers the data envelope', async () => {
      const { app, calls } = createApp();

      const response = await request(app)
        .post('/api/session/ses_claude_1/generate')
        .send({ prompt: 'Draft a commit message' })
        .expect(200);

      expect(calls).toEqual([['generate', 'ses_claude_1', 'Draft a commit message']]);
      expect(response.body).toEqual({ data: { text: 'Generated text' } });
    });

    test('rejects a missing or blank prompt', async () => {
      const { app, calls } = createApp();

      const missing = await request(app)
        .post('/api/session/ses_claude_1/generate')
        .send({})
        .expect(400);
      const blank = await request(app)
        .post('/api/session/ses_claude_1/generate')
        .send({ prompt: '   ' })
        .expect(400);

      expect(missing.body).toMatchObject({ _tag: 'InvalidRequestError' });
      expect(blank.body).toMatchObject({ _tag: 'InvalidRequestError' });
      expect(calls).toEqual([]);
    });

    test('maps a generation failure to the declared tagged 503', async () => {
      const { app } = createApp({
        generate: async () => {
          throw new Error('Claude Code generate failed: process exited');
        },
      });

      const response = await request(app)
        .post('/api/session/ses_claude_1/generate')
        .send({ prompt: 'Hi' })
        .expect(503);

      expect(response.body).toMatchObject({
        _tag: 'ServiceUnavailableError',
        message: 'Claude Code generate failed: process exited',
      });
    });
  });

  describe('synthetic context', () => {
    test('forwards a synthetic message with its text, description and metadata', async () => {
      const { app, calls } = createApp();
      const metadata = { kind: 'selection' };

      const response = await request(app)
        .post('/api/session/ses_claude_1/synthetic')
        .send({
          id: 'msg_ctx_1',
          text: 'The failing test',
          description: 'Quoted selection',
          metadata,
          delivery: 'queue',
          resume: false,
        })
        .expect(200);

      expect(calls).toEqual([
        ['synthetic', 'ses_claude_1', {
          id: 'msg_ctx_1',
          text: 'The failing test',
          description: 'Quoted selection',
          metadata,
        }],
      ]);
      expect(response.body).toEqual({ data: { id: 'msg_synth_1', type: 'synthetic', text: 'Context' } });
    });

    test('rejects a synthetic message without text', async () => {
      const { app, calls } = createApp();

      const missing = await request(app)
        .post('/api/session/ses_claude_1/synthetic')
        .send({ id: 'msg_ctx_1' })
        .expect(400);
      const empty = await request(app)
        .post('/api/session/ses_claude_1/synthetic')
        .send({ text: '' })
        .expect(400);

      expect(missing.body).toMatchObject({ _tag: 'InvalidRequestError' });
      expect(empty.body).toMatchObject({ _tag: 'InvalidRequestError' });
      expect(calls).toEqual([]);
    });
  });

  describe('model and agent switches', () => {
    test('switches through the SDK paths for model and agent', async () => {
      const { app, calls } = createApp();

      await request(app)
        .post('/api/session/ses_claude_1/model')
        .send({ model: { id: 'opus', providerID: 'claude-code' } })
        .expect(204);
      await request(app)
        .post('/api/session/ses_claude_1/agent')
        .send({ agent: 'build' })
        .expect(204);

      expect(calls).toEqual([
        ['switchModel', 'ses_claude_1', { id: 'opus', providerID: 'claude-code' }],
        ['switchAgent', 'ses_claude_1', 'build'],
      ]);
    });
  });

  describe('permission mode and effort', () => {
    test('sets a permission mode and answers the mode envelope', async () => {
      const { app, calls } = createApp();

      const response = await request(app)
        .post('/api/session/ses_claude_1/permission-mode')
        .send({ mode: 'acceptEdits' })
        .expect(200);

      expect(calls).toEqual([['setPermissionMode', 'ses_claude_1', 'acceptEdits']]);
      expect(response.body).toEqual({ data: { mode: 'acceptEdits' } });
    });

    test('rejects a mode outside the v1 set', async () => {
      const { app, calls } = createApp();

      for (const mode of ['plan', 'dontAsk', 'auto', 'yolo', '', null, 7]) {
        const response = await request(app)
          .post('/api/session/ses_claude_1/permission-mode')
          .send({ mode })
          .expect(400);
        expect(response.body).toMatchObject({ _tag: 'InvalidRequestError' });
      }
      expect(calls).toEqual([]);
    });

    test('sets and clears the effort level', async () => {
      const { app, calls } = createApp();

      const set = await request(app)
        .post('/api/session/ses_claude_1/effort')
        .send({ effort: 'max' })
        .expect(200);
      const cleared = await request(app)
        .post('/api/session/ses_claude_1/effort')
        .send({ effort: null })
        .expect(200);

      expect(set.body).toEqual({ data: { effort: 'max' } });
      expect(cleared.body).toEqual({ data: { effort: null } });
      expect(calls).toEqual([
        ['setEffort', 'ses_claude_1', 'max'],
        ['setEffort', 'ses_claude_1', null],
      ]);
    });

    test('rejects an effort level outside the SDK set', async () => {
      const { app, calls } = createApp();

      for (const effort of ['gigantic', 'HIGH', 42]) {
        const response = await request(app)
          .post('/api/session/ses_claude_1/effort')
          .send({ effort })
          .expect(400);
        expect(response.body).toMatchObject({ _tag: 'InvalidRequestError' });
      }
      expect(calls).toEqual([]);
    });
  });

  describe('message list', () => {
    test('passes pagination through and answers the page envelope', async () => {
      const { app, calls } = createApp();

      const response = await request(app)
        .get('/api/session/ses_claude_1/message?limit=15&cursor=cur_1&order=asc')
        .expect(200);

      expect(calls).toEqual([
        ['getMessages', 'ses_claude_1', { limit: 15, cursor: 'cur_1', order: 'asc' }],
      ]);
      expect(response.body).toEqual({ data: [{ id: 'msg_1' }], cursor: { next: 'cur_2' } });
    });

    test('omits pagination it was not given', async () => {
      const { app, calls } = createApp();

      await request(app).get('/api/session/ses_claude_1/message').expect(200);

      expect(calls).toEqual([
        ['getMessages', 'ses_claude_1', { limit: undefined, cursor: undefined, order: undefined }],
      ]);
    });
  });

  describe('permission reply', () => {
    test('replies with the decision from the body', async () => {
      const { app, calls } = createApp();

      await request(app)
        .post('/api/session/ses_claude_1/permission/perm_1/reply')
        .send({ decision: 'always' })
        .expect(204);

      expect(calls).toEqual([['replyPermission', 'ses_claude_1', 'perm_1', 'always']]);
    });

    test('rejects a decision outside once/always/reject', async () => {
      const { app, calls } = createApp();

      const response = await request(app)
        .post('/api/session/ses_claude_1/permission/perm_1/reply')
        .send({ decision: 'sometimes' })
        .expect(400);

      expect(response.body).toMatchObject({ _tag: 'InvalidRequestError' });
      expect(calls).toEqual([]);
    });

    test('answers 404 when the registry does not know the request', async () => {
      const { app } = createApp({ replyPermission: async () => false });

      const response = await request(app)
        .post('/api/session/ses_claude_1/permission/perm_unknown/reply')
        .send({ decision: 'once' })
        .expect(404);

      expect(response.body).toMatchObject({ _tag: 'PermissionNotFoundError' });
    });

    test('answers 404 when the registry throws a not-found', async () => {
      const { app } = createApp({
        replyPermission: async () => {
          throw Object.assign(new Error('no such permission'), { status: 404 });
        },
      });

      const response = await request(app)
        .post('/api/session/ses_claude_1/permission/perm_unknown/reply')
        .send({ decision: 'once' })
        .expect(404);

      expect(response.body).toMatchObject({ _tag: 'PermissionNotFoundError' });
    });
  });

  describe('session record routes', () => {
    test('reads one session as the SDK envelope', async () => {
      const { app, calls } = createApp();

      const response = await request(app).get('/api/session/ses_claude_1').expect(200);

      expect(calls).toEqual([['getSession', 'ses_claude_1']]);
      expect(response.body).toEqual({ data: { id: 'ses_claude_1', location: { directory: '/repo/app' } } });
    });

    test('answers 404 when the registry lost the session', async () => {
      const { app } = createApp({ getSession: async () => null });

      const response = await request(app).get('/api/session/ses_claude_1').expect(404);

      expect(response.body).toMatchObject({ _tag: 'SessionNotFoundError' });
    });

    test('renames, removes, and moves with an empty body', async () => {
      const { app, calls } = createApp();

      await request(app).patch('/api/session/ses_claude_1').send({ title: 'Renamed' }).expect(204);
      await request(app).delete('/api/session/ses_claude_1').expect(204);
      await request(app).post('/api/session/ses_claude_1/move').send({ directory: '/repo/other' }).expect(204);

      expect(calls).toEqual([
        ['renameSession', 'ses_claude_1', 'Renamed'],
        ['removeSession', 'ses_claude_1'],
        ['moveSession', 'ses_claude_1', '/repo/other'],
      ]);
    });

    test('rejects a rename without a title and a move without a directory', async () => {
      const { app, calls } = createApp();

      const rename = await request(app).patch('/api/session/ses_claude_1').send({ metadata: {} }).expect(400);
      const move = await request(app).post('/api/session/ses_claude_1/move').send({}).expect(400);

      expect(rename.body).toMatchObject({ _tag: 'InvalidRequestError' });
      expect(move.body).toMatchObject({ _tag: 'InvalidRequestError' });
      expect(calls).toEqual([]);
    });
  });

  test('drives a real @opencode/client against the router end to end', async () => {
    const { app, calls } = createApp();
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise((resolve) => server.once('listening', resolve));
      const client = OpenCode.make({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        headers: { 'x-openchamber-backend': 'claude' },
      });

      const session = await client.session.create({
        id: 'ses_claude_client',
        title: 'Claude task',
        agent: 'build',
        model: { providerID: 'claude-code', id: 'sonnet' },
        location: { directory: '/repo/app' },
      });
      expect(session).toEqual({
        id: 'ses_claude_client',
        title: 'Claude task',
        location: { directory: '/repo/app' },
      });

      const prompted = await client.session.prompt({
        sessionID: 'ses_claude_client',
        id: 'msg_client_1',
        text: 'Fix it',
      });
      expect(prompted).toEqual({ id: 'msg_1' });

      const admitted = await client.session.synthetic({
        sessionID: 'ses_claude_client',
        id: 'msg_ctx_1',
        text: 'Context',
        description: 'Selection',
        resume: false,
      });
      expect(admitted).toEqual({ id: 'msg_synth_1', type: 'synthetic', text: 'Context' });

      const generated = await client.session.generate({ sessionID: 'ses_claude_client', prompt: 'Draft it' });
      expect(generated).toEqual({ text: 'Generated text' });

      const interrupted = await client.session.interrupt({ sessionID: 'ses_claude_client' });
      expect(interrupted).toEqual({ interrupted: true });

      const page = await client.message.list({ sessionID: 'ses_claude_client', limit: 10 });
      expect(page).toEqual({ data: [{ id: 'msg_1' }], cursor: { next: 'cur_2' } });

      await client.permission.reply({ sessionID: 'ses_claude_client', requestID: 'perm_1', decision: 'always' });

      expect(calls).toEqual([
        ['createSession', {
          id: 'ses_claude_client',
          title: 'Claude task',
          agent: 'build',
          model: { providerID: 'claude-code', id: 'sonnet' },
          metadata: undefined,
          directory: '/repo/app',
        }],
        ['sendPrompt', 'ses_claude_client', { text: 'Fix it', id: 'msg_client_1' }],
        ['synthetic', 'ses_claude_client', {
          id: 'msg_ctx_1',
          text: 'Context',
          description: 'Selection',
          metadata: undefined,
        }],
        ['generate', 'ses_claude_client', 'Draft it'],
        ['interrupt', 'ses_claude_client'],
        ['getMessages', 'ses_claude_client', { limit: 10, cursor: undefined, order: undefined }],
        ['replyPermission', 'ses_claude_client', 'perm_1', 'always'],
      ]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
