// Unit tests for the Claude Code session runner.
//
// The Agent SDK package is not a dependency yet, so `spawnQuery` is a fake
// that behaves like the real `query()`: an async generator over hand-built
// SDK messages plus the control methods the runner calls. The transcript and
// translator are the real committed modules, with the transcript's filesystem
// injected, so the tests observe the same records production writes.

import { describe, expect, test, vi } from 'bun:test';

import { createRunnerFactory } from './runner.js';
import { createTranscript } from './transcript.js';
import { createTranslator } from './translator.js';

const SESSION_ID = 'ses_claude_runner';
const DIRECTORY = 'C:\\work\\claude-runner';
const TRANSCRIPT_PATH = 'C:\\cache\\sessions\\ses_claude_runner.jsonl';
const CLOCK = 1_700_000_000_000;
const CLAUDE_SESSION = 'claude_session_1';

// ---------------------------------------------------------------------------
// Fake query and fixtures
// ---------------------------------------------------------------------------

/** An in-memory fsPromises surface for the transcript. */
const createMemoryFs = () => {
  const files = new Map();
  return {
    files,
    mkdir: async () => undefined,
    appendFile: async (filePath, data) => {
      files.set(filePath, `${files.get(filePath) ?? ''}${data}`);
    },
    readFile: async (filePath) => {
      if (!files.has(filePath)) {
        const error = new Error(`ENOENT: ${filePath}`);
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(filePath);
    },
  };
};

/** A controllable stand-in for the SDK's `Query` async generator. */
const createFakeQuery = () => {
  const messages = [];
  const calls = { interrupts: 0, models: [], permissionModes: [], closes: 0 };
  let waiting = null;
  let finished = false;
  let failure = null;

  const wake = () => {
    if (!waiting) return;
    const resume = waiting;
    waiting = null;
    resume();
  };

  const take = () => {
    if (messages.length > 0) {
      return { value: messages.shift(), done: false };
    }
    if (failure) {
      const error = failure;
      failure = null;
      return Promise.reject(error);
    }
    return null;
  };

  const query = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        const immediate = take();
        if (immediate) return Promise.resolve(immediate);
        if (finished) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          waiting = resolve;
        }).then(() => take() ?? { value: undefined, done: true });
      },
    }),
    interrupt: async () => {
      calls.interrupts += 1;
    },
    setModel: async (model) => {
      calls.models.push(model);
    },
    setPermissionMode: async (mode) => {
      calls.permissionModes.push(mode);
    },
    close: () => {
      calls.closes += 1;
      finished = true;
      wake();
    },
  };

  return {
    query,
    calls,
    push(message) {
      messages.push(message);
      wake();
    },
    fail(error) {
      failure = error;
      wake();
    },
    finish() {
      finished = true;
      wake();
    },
  };
};

const initMessage = (sessionId = CLAUDE_SESSION) => ({
  type: 'system',
  subtype: 'init',
  session_id: sessionId,
});

const streamEvent = (event, sessionId = CLAUDE_SESSION) => ({
  type: 'stream_event',
  event,
  session_id: sessionId,
  parent_tool_use_id: null,
});

const blockStart = (index, contentBlock, sessionId) =>
  streamEvent({ type: 'content_block_start', index, content_block: contentBlock }, sessionId);
const blockDelta = (index, delta, sessionId) =>
  streamEvent({ type: 'content_block_delta', index, delta }, sessionId);
const blockStop = (index, sessionId) => streamEvent({ type: 'content_block_stop', index }, sessionId);

const successResult = (overrides = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Done.',
  total_cost_usd: 0.01,
  usage: { input_tokens: 10, output_tokens: 4 },
  session_id: CLAUDE_SESSION,
  ...overrides,
});

const eventsOfType = (emitted, type) => emitted.filter((event) => event.type === type);

const waitFor = async (predicate, timeout = 3000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const createHarness = ({ session = {}, factory = {} } = {}) => {
  const emitted = [];
  const sessionIds = [];
  const idleCalls = [];
  const usageCalls = [];
  const spawns = [];
  const promptMessages = [];
  const fake = createFakeQuery();
  const fs = createMemoryFs();
  const transcript = createTranscript({
    sessionID: SESSION_ID,
    directory: DIRECTORY,
    filePath: TRANSCRIPT_PATH,
    fsImpl: fs,
  });
  let eventCounter = 0;
  const translator = createTranslator({
    sessionID: SESSION_ID,
    directory: DIRECTORY,
    newMessageId: () => {
      eventCounter += 1;
      return `evt_${eventCounter}`;
    },
    now: () => CLOCK,
  });
  const runnerFactory = createRunnerFactory({
    spawnQuery: async (params) => {
      spawns.push(params);
      // The real SDK pulls user messages off the prompt iterable as they are
      // pushed; consuming it here records what the runner actually sent.
      void (async () => {
        for await (const message of params.prompt) promptMessages.push(message);
      })();
      return fake.query;
    },
    now: () => CLOCK,
    ...factory,
  });
  const runner = runnerFactory.createRunner({
    sessionID: SESSION_ID,
    directory: DIRECTORY,
    cwd: DIRECTORY,
    model: 'sonnet',
    claudeSessionUuid: null,
    cliPath: null,
    transcript,
    translator,
    emit: (event) => emitted.push(event),
    onSessionId: (sessionId) => sessionIds.push(sessionId),
    onUsage: (usage) => usageCalls.push(usage),
    onIdle: (idleRunner) => idleCalls.push(idleRunner),
    ...session,
  });
  return { runner, fake, fs, transcript, spawns, promptMessages, emitted, sessionIds, idleCalls, usageCalls };
};

// ---------------------------------------------------------------------------
// Turn lifecycle
// ---------------------------------------------------------------------------

describe('turns', () => {
  test('send starts the query and the stream reaches emit and the transcript', async () => {
    const { runner, fake, spawns, promptMessages, emitted, transcript } = createHarness();

    await runner.send({ text: 'List the files', messageID: 'msg_user_1' });

    expect(spawns).toHaveLength(1);
    expect(spawns[0].options).toMatchObject({
      cwd: DIRECTORY,
      includePartialMessages: true,
      permissionMode: 'default',
      model: 'sonnet',
    });
    expect(emitted.map((event) => event.type)).toEqual(['session.execution.started']);
    expect(transcript.getRecord('msg_user_1').info).toMatchObject({
      id: 'msg_user_1',
      type: 'user',
      text: 'List the files',
    });

    await waitFor(() => promptMessages.length === 1);
    expect(promptMessages[0]).toEqual({
      type: 'user',
      message: { role: 'user', content: 'List the files' },
      parent_tool_use_id: null,
    });

    fake.push(initMessage());
    fake.push(blockStart(0, { type: 'text' }));
    fake.push(blockDelta(0, { type: 'text_delta', text: 'Hello ' }));
    fake.push(blockDelta(0, { type: 'text_delta', text: 'world' }));
    fake.push(blockStop(0));
    fake.push(successResult());

    await waitFor(() => eventsOfType(emitted, 'session.execution.succeeded').length === 1);

    const types = emitted.map((event) => event.type);
    expect(types.indexOf('session.step.started')).toBeGreaterThan(0);
    expect(types.indexOf('session.step.started')).toBeLessThan(types.indexOf('session.text.delta'));
    expect(types).toContain('session.text.ended');
    expect(types[types.length - 1]).toBe('session.execution.succeeded');

    const delta = eventsOfType(emitted, 'session.text.delta').find((event) => event.data.delta === 'world');
    expect(delta.data).toMatchObject({ sessionID: SESSION_ID, ordinal: 0, delta: 'world' });

    const assistantMessageID = eventsOfType(emitted, 'session.step.started')[0].data.assistantMessageID;
    const record = transcript.getRecord(assistantMessageID);
    expect(record.info).toMatchObject({
      id: assistantMessageID,
      type: 'assistant',
      model: { providerID: 'claude-code', id: 'sonnet' },
    });
    expect(record.info.content).toEqual([{ type: 'text', text: 'Hello world' }]);
    expect(runner.isBusy()).toBe(false);
  });

  test('a prompt with synthetic context prepends it to the SDK message content', async () => {
    const { runner, promptMessages, transcript } = createHarness();

    await runner.send({
      text: 'Fix the failing test',
      messageID: 'msg_ctx_turn',
      context: ['The test output:', 'ENOENT: no such file'],
    });

    await waitFor(() => promptMessages.length === 1);
    expect(promptMessages[0]).toEqual({
      type: 'user',
      message: { role: 'user', content: 'The test output:\n\nENOENT: no such file\n\nFix the failing test' },
      parent_tool_use_id: null,
    });
    // The transcript keeps the user's own text; the synthetic records carry
    // the context blocks.
    expect(transcript.getRecord('msg_ctx_turn').info.text).toBe('Fix the failing test');
  });

  test('two turns mint distinct assistant messages', async () => {
    const { runner, fake, emitted } = createHarness();

    await runner.send({ text: 'first', messageID: 'msg_1' });
    fake.push(blockStart(0, { type: 'text' }));
    fake.push(successResult());
    await waitFor(() => eventsOfType(emitted, 'session.execution.succeeded').length === 1);
    expect(runner.isBusy()).toBe(false);

    await runner.send({ text: 'second', messageID: 'msg_2' });
    fake.push(blockStart(0, { type: 'text' }));
    fake.push(successResult());
    await waitFor(() => eventsOfType(emitted, 'session.execution.succeeded').length === 2);

    expect(eventsOfType(emitted, 'session.execution.started')).toHaveLength(2);
    const started = eventsOfType(emitted, 'session.step.started');
    expect(started).toHaveLength(2);
    expect(started[0].data.assistantMessageID).not.toBe(started[1].data.assistantMessageID);
  });

  test('a prompt sent during a turn waits for the next turn', async () => {
    const { runner, fake, promptMessages, emitted, transcript } = createHarness();

    await runner.send({ text: 'first', messageID: 'msg_1' });
    await runner.send({ text: 'second', messageID: 'msg_2' });

    expect(eventsOfType(emitted, 'session.execution.started')).toHaveLength(1);
    expect(transcript.getRecord('msg_2').info.text).toBe('second');
    await waitFor(() => promptMessages.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(promptMessages).toHaveLength(1);

    fake.push(successResult());
    await waitFor(() => promptMessages.length === 2);
    expect(eventsOfType(emitted, 'session.execution.started')).toHaveLength(2);
    expect(promptMessages[1]).toEqual({
      type: 'user',
      message: { role: 'user', content: 'second' },
      parent_tool_use_id: null,
    });

    fake.push(successResult());
    await waitFor(() => eventsOfType(emitted, 'session.execution.succeeded').length === 2);
  });

  test('setModel updates the running query and the next step alias', async () => {
    const { runner, fake, emitted } = createHarness();

    await runner.send({ text: 'first', messageID: 'msg_1' });
    fake.push(successResult());
    await waitFor(() => eventsOfType(emitted, 'session.execution.succeeded').length === 1);

    await runner.setModel('opus');
    expect(fake.calls.models).toEqual(['opus']);

    await runner.send({ text: 'second', messageID: 'msg_2' });
    fake.push(blockStart(0, { type: 'text' }));
    fake.push(successResult());
    await waitFor(() => eventsOfType(emitted, 'session.execution.succeeded').length === 2);

    const started = eventsOfType(emitted, 'session.step.started');
    expect(started[started.length - 1].data.model).toEqual({ providerID: 'claude-code', id: 'opus' });
  });
});

// ---------------------------------------------------------------------------
// Permission modes and effort
// ---------------------------------------------------------------------------

describe('permission modes and effort', () => {
  test('buildOptions carries the session permission mode and the danger flag', async () => {
    const bypass = createHarness({ session: { permissionMode: 'bypassPermissions' } });
    await bypass.runner.send({ text: 'hi', messageID: 'msg_1' });
    expect(bypass.spawns[0].options).toMatchObject({
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    });

    const edits = createHarness({ session: { permissionMode: 'acceptEdits' } });
    await edits.runner.send({ text: 'hi', messageID: 'msg_2' });
    expect(edits.spawns[0].options.permissionMode).toBe('acceptEdits');
    expect(edits.spawns[0].options.allowDangerouslySkipPermissions).toBeUndefined();
  });

  test('a session without a mode spawns on the default without the danger flag', async () => {
    const { runner, spawns } = createHarness();

    await runner.send({ text: 'hi', messageID: 'msg_1' });

    expect(spawns[0].options.permissionMode).toBe('default');
    expect(spawns[0].options.allowDangerouslySkipPermissions).toBeUndefined();
  });

  test('setPermissionMode tells the live query and the next spawn', async () => {
    const { runner, fake, spawns, emitted } = createHarness();

    await runner.send({ text: 'first', messageID: 'msg_1' });
    await runner.setPermissionMode('acceptEdits');
    expect(fake.calls.permissionModes).toEqual(['acceptEdits']);

    // The respawn after a transport failure starts from the stored mode.
    fake.fail(new Error('process exited'));
    await waitFor(() => eventsOfType(emitted, 'session.execution.failed').length === 1);
    await runner.send({ text: 'second', messageID: 'msg_2' });
    expect(spawns).toHaveLength(2);
    expect(spawns[1].options.permissionMode).toBe('acceptEdits');
  });

  test('setPermissionMode stores the mode when no query is live yet', async () => {
    const { runner, spawns } = createHarness();

    await runner.setPermissionMode('bypassPermissions');
    await runner.send({ text: 'first', messageID: 'msg_1' });

    expect(spawns[0].options.permissionMode).toBe('bypassPermissions');
    expect(spawns[0].options.allowDangerouslySkipPermissions).toBe(true);
  });

  test('options carry the session effort level when one is set', async () => {
    const withEffort = createHarness({ session: { effort: 'high' } });
    await withEffort.runner.send({ text: 'hi', messageID: 'msg_1' });
    expect(withEffort.spawns[0].options.effort).toBe('high');

    const without = createHarness();
    await without.runner.send({ text: 'hi', messageID: 'msg_2' });
    expect(without.spawns[0].options.effort).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

describe('permissions', () => {
  const suggestions = [
    {
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'bun test:*' }],
      behavior: 'allow',
      destination: 'session',
    },
  ];

  test('an allow decision emits permission.asked and resolves the tool call', async () => {
    const { runner, fake, spawns, emitted } = createHarness();

    await runner.send({ text: 'run tests', messageID: 'msg_1' });
    fake.push(blockStart(0, { type: 'tool_use', id: 'toolu_1', name: 'Bash' }));
    await waitFor(() => eventsOfType(emitted, 'session.step.started').length === 1);
    const assistantMessageID = eventsOfType(emitted, 'session.step.started')[0].data.assistantMessageID;

    const canUseTool = spawns[0].options.canUseTool;
    const answer = canUseTool(
      'Bash',
      { command: 'bun test' },
      { signal: new AbortController().signal, suggestions, toolUseID: 'toolu_1' },
    );

    await waitFor(() => eventsOfType(emitted, 'permission.asked').length === 1);
    const request = eventsOfType(emitted, 'permission.asked')[0];
    expect(request.data).toEqual({
      sessionID: SESSION_ID,
      id: expect.stringMatching(/^per_[0-9A-Za-z]{22}$/),
      action: 'Bash',
      resources: ['bun test'],
      message: 'Claude wants to use Bash: bun test',
      metadata: { toolName: 'Bash', input: { command: 'bun test' } },
      source: { type: 'tool', messageID: assistantMessageID, id: 'toolu_1' },
    });
    expect(request.created).toBe(CLOCK);
    expect(request.location).toEqual({ directory: DIRECTORY });

    expect(runner.resolvePermission(request.data.id, 'once')).toBe(true);
    expect(await answer).toEqual({ behavior: 'allow' });
    const replied = eventsOfType(emitted, 'permission.replied');
    expect(replied).toHaveLength(1);
    expect(replied[0].data).toEqual({ sessionID: SESSION_ID, requestID: request.data.id, reply: 'once' });
  });

  test('pendingPermissionRequests lists parked wire requests and shrinks as they settle', async () => {
    const { runner, spawns, emitted } = createHarness();

    await runner.send({ text: 'run tests', messageID: 'msg_1' });
    const canUseTool = spawns[0].options.canUseTool;
    expect(runner.pendingPermissionRequests()).toEqual([]);

    const controller = new AbortController();
    const first = canUseTool('Bash', { command: 'bun test' }, { suggestions, toolUseID: 'toolu_1' });
    const second = canUseTool('Read', { file_path: 'C:\\work\\a.txt' }, { signal: controller.signal, toolUseID: 'toolu_2' });
    await waitFor(() => eventsOfType(emitted, 'permission.asked').length === 2);
    const [firstRequest, secondRequest] = eventsOfType(emitted, 'permission.asked');

    // The parked requests are the exact wire shapes the events carried.
    expect(runner.pendingPermissionRequests()).toEqual([firstRequest.data, secondRequest.data]);

    // An aborted request leaves the list; the answered one leaves with it.
    controller.abort();
    expect(await second).toEqual({ behavior: 'deny', message: 'Interrupted' });
    expect(runner.pendingPermissionRequests()).toEqual([firstRequest.data]);

    expect(runner.resolvePermission(firstRequest.data.id, 'once')).toBe(true);
    expect(await first).toEqual({ behavior: 'allow' });
    expect(runner.pendingPermissionRequests()).toEqual([]);

    // Dispose answers what is left parked and empties the list.
    const third = canUseTool('Glob', { pattern: '**/*.ts' }, { toolUseID: 'toolu_3' });
    await waitFor(() => eventsOfType(emitted, 'permission.asked').length === 3);
    const thirdRequest = eventsOfType(emitted, 'permission.asked')[2];
    expect(runner.pendingPermissionRequests()).toEqual([thirdRequest.data]);

    await runner.dispose();
    expect(await third).toEqual({ behavior: 'deny', message: 'Session closed' });
    expect(runner.pendingPermissionRequests()).toEqual([]);
  });

  test('a reject decision denies the tool call with the user message', async () => {
    const { runner, fake, spawns, emitted } = createHarness();

    await runner.send({ text: 'read a file', messageID: 'msg_1' });
    const canUseTool = spawns[0].options.canUseTool;
    const answer = canUseTool('Read', { file_path: 'C:\\work\\a.txt' }, { toolUseID: 'toolu_2' });

    await waitFor(() => eventsOfType(emitted, 'permission.asked').length === 1);
    const request = eventsOfType(emitted, 'permission.asked')[0];
    expect(request.data.resources).toEqual(['C:\\work\\a.txt']);
    expect(request.data.message).toBe('Claude wants to use Read: C:\\work\\a.txt');
    expect(request.data.source).toBeUndefined();

    expect(runner.resolvePermission(request.data.id, 'reject')).toBe(true);
    expect(await answer).toEqual({ behavior: 'deny', message: 'Rejected by the user' });
    expect(eventsOfType(emitted, 'permission.replied')[0].data.reply).toBe('reject');
  });

  test('an always decision is remembered and reused without prompting', async () => {
    const { runner, fake, spawns, emitted } = createHarness();

    await runner.send({ text: 'run tests', messageID: 'msg_1' });
    const canUseTool = spawns[0].options.canUseTool;
    const first = canUseTool('Bash', { command: 'bun test' }, { suggestions, toolUseID: 'toolu_1' });

    await waitFor(() => eventsOfType(emitted, 'permission.asked').length === 1);
    const request = eventsOfType(emitted, 'permission.asked')[0];
    expect(runner.resolvePermission(request.data.id, 'always')).toBe(true);
    expect(await first).toEqual({ behavior: 'allow', updatedPermissions: suggestions });

    const second = await canUseTool('Bash', { command: 'bun test --watch' }, { toolUseID: 'toolu_2' });
    expect(second).toEqual({ behavior: 'allow' });
    expect(eventsOfType(emitted, 'permission.asked')).toHaveLength(1);
  });

  test('resolvePermission with an unknown id returns false and emits nothing', () => {
    const { runner, emitted } = createHarness();

    expect(runner.resolvePermission('per_missing', 'once')).toBe(false);
    expect(emitted).toEqual([]);
  });

  test('dispose answers a pending prompt with a deny and stops emitting', async () => {
    const { runner, fake, spawns, emitted } = createHarness();

    await runner.send({ text: 'run tests', messageID: 'msg_1' });
    const canUseTool = spawns[0].options.canUseTool;
    const answer = canUseTool('Bash', { command: 'bun test' }, {});
    await waitFor(() => eventsOfType(emitted, 'permission.asked').length === 1);

    await runner.dispose();
    expect(await answer).toEqual({ behavior: 'deny', message: 'Session closed' });
    expect(eventsOfType(emitted, 'permission.replied')).toHaveLength(0);
  });

  test('a parked permission is denied and reported when it times out', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { runner, fake, spawns, emitted, idleCalls } = createHarness({
        factory: { permissionParkMaxMs: 30 },
      });

      await runner.send({ text: 'run tests', messageID: 'msg_1' });
      const canUseTool = spawns[0].options.canUseTool;
      const answer = canUseTool('Bash', { command: 'bun test' }, { toolUseID: 'toolu_1' });
      await waitFor(() => eventsOfType(emitted, 'permission.asked').length === 1);
      const request = eventsOfType(emitted, 'permission.asked')[0];

      expect(await answer).toEqual({ behavior: 'deny', message: 'Permission request timed out' });
      const replied = eventsOfType(emitted, 'permission.replied');
      expect(replied).toHaveLength(1);
      expect(replied[0].data).toEqual({ sessionID: SESSION_ID, requestID: request.data.id, reply: 'reject' });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(SESSION_ID);

      // The runner keeps running: the denied tool lets the turn settle from
      // the stream, and the timed-out request can no longer be answered.
      expect(runner.isBusy()).toBe(true);
      expect(fake.calls.closes).toBe(0);
      expect(idleCalls).toEqual([]);
      expect(runner.resolvePermission(request.data.id, 'once')).toBe(false);

      fake.push(successResult());
      await waitFor(() => eventsOfType(emitted, 'session.execution.succeeded').length === 1);
      expect(runner.isBusy()).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  test('an answer before the park deadline cancels the timeout', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { runner, spawns, emitted } = createHarness({ factory: { permissionParkMaxMs: 40 } });

      await runner.send({ text: 'run tests', messageID: 'msg_1' });
      const canUseTool = spawns[0].options.canUseTool;
      const answer = canUseTool('Bash', { command: 'bun test' }, { toolUseID: 'toolu_1' });
      await waitFor(() => eventsOfType(emitted, 'permission.asked').length === 1);
      const request = eventsOfType(emitted, 'permission.asked')[0];

      expect(runner.resolvePermission(request.data.id, 'once')).toBe(true);
      expect(await answer).toEqual({ behavior: 'allow' });

      // Past the park window: the answer stands and no timeout fired.
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(eventsOfType(emitted, 'permission.replied')).toHaveLength(1);
      expect(eventsOfType(emitted, 'permission.replied')[0].data.reply).toBe('once');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test('an abort before the park deadline cancels the timeout', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { runner, spawns, emitted } = createHarness({ factory: { permissionParkMaxMs: 40 } });

      await runner.send({ text: 'run tests', messageID: 'msg_1' });
      const controller = new AbortController();
      const canUseTool = spawns[0].options.canUseTool;
      const answer = canUseTool(
        'Bash',
        { command: 'bun test' },
        { signal: controller.signal, toolUseID: 'toolu_1' },
      );
      await waitFor(() => eventsOfType(emitted, 'permission.asked').length === 1);

      controller.abort();
      expect(await answer).toEqual({ behavior: 'deny', message: 'Interrupted' });

      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(eventsOfType(emitted, 'permission.replied')).toHaveLength(1);
      expect(eventsOfType(emitted, 'permission.replied')[0].data.reply).toBe('reject');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test('dispose before the park deadline cancels the timeout', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { runner, spawns, emitted } = createHarness({ factory: { permissionParkMaxMs: 40 } });

      await runner.send({ text: 'run tests', messageID: 'msg_1' });
      const canUseTool = spawns[0].options.canUseTool;
      const answer = canUseTool('Bash', { command: 'bun test' }, { toolUseID: 'toolu_1' });
      await waitFor(() => eventsOfType(emitted, 'permission.asked').length === 1);

      await runner.dispose();
      expect(await answer).toEqual({ behavior: 'deny', message: 'Session closed' });

      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(eventsOfType(emitted, 'permission.replied')).toHaveLength(0);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Prompt attachments
// ---------------------------------------------------------------------------

describe('prompt attachments', () => {
  const base64Of = (value) => Buffer.from(value, 'utf8').toString('base64');
  const attachmentBlocks = (message) => message.message.content;

  test('an image file follows the text block as a base64 image block', async () => {
    const { runner, promptMessages } = createHarness();
    const payload = base64Of('PNGDATA');

    await runner.send({
      text: 'What is this?',
      messageID: 'msg_1',
      context: ['A screenshot:'],
      files: [{ uri: `data:image/png;base64,${payload}`, name: 'shot.png' }],
    });

    await waitFor(() => promptMessages.length === 1);
    expect(attachmentBlocks(promptMessages[0])).toEqual([
      { type: 'text', text: 'A screenshot:\n\nWhat is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: payload } },
    ]);
  });

  test('a file-only prompt carries the attachment blocks without an empty text block', async () => {
    const { runner, promptMessages } = createHarness();
    const payload = base64Of('PNGDATA');

    await runner.send({
      text: '',
      messageID: 'msg_1',
      files: [{ uri: `data:image/png;base64,${payload}`, name: 'shot.png' }],
    });

    await waitFor(() => promptMessages.length === 1);
    expect(attachmentBlocks(promptMessages[0])).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: payload } },
    ]);
  });

  test('a text-like file is decoded behind a name header', async () => {
    const { runner, promptMessages } = createHarness();

    await runner.send({
      text: 'See the log',
      messageID: 'msg_1',
      files: [{ uri: `data:text/plain;base64,${base64Of('line one\nline two')}`, name: 'log.txt' }],
    });

    await waitFor(() => promptMessages.length === 1);
    expect(attachmentBlocks(promptMessages[0])).toEqual([
      { type: 'text', text: 'See the log' },
      { type: 'text', text: '[File: log.txt]\nline one\nline two' },
    ]);
  });

  test('a binary file is skipped with a note and a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { runner, promptMessages } = createHarness();

      await runner.send({
        text: 'Hi',
        messageID: 'msg_1',
        files: [{ uri: `data:application/octet-stream;base64,${base64Of('BIN')}`, name: 'blob.bin' }],
      });

      await waitFor(() => promptMessages.length === 1);
      expect(attachmentBlocks(promptMessages[0])).toEqual([
        { type: 'text', text: 'Hi' },
        { type: 'text', text: '[Attachment skipped: blob.bin (application/octet-stream)]' },
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test('an unparsable entry is skipped with an unknown-mime note', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { runner, promptMessages } = createHarness();

      await runner.send({
        text: 'Hi',
        messageID: 'msg_1',
        files: [
          { uri: 'not-a-data-uri', name: 'weird.txt' },
          null,
        ],
      });

      await waitFor(() => promptMessages.length === 1);
      expect(attachmentBlocks(promptMessages[0])).toEqual([
        { type: 'text', text: 'Hi' },
        { type: 'text', text: '[Attachment skipped: weird.txt (unknown)]' },
        { type: 'text', text: '[Attachment skipped: attachment 2 (unknown)]' },
      ]);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  test('a text file past the decoded cap is truncated with a marker', async () => {
    const { runner, promptMessages } = createHarness();
    const oversized = 'a'.repeat(256 * 1024 + 100);

    await runner.send({
      text: 'Read it',
      messageID: 'msg_1',
      files: [{ uri: `data:text/plain;base64,${base64Of(oversized)}`, name: 'big.txt' }],
    });

    await waitFor(() => promptMessages.length === 1);
    const block = attachmentBlocks(promptMessages[0])[1];
    expect(block.type).toBe('text');
    expect(block.text.startsWith('[File: big.txt]\na')).toBe(true);
    expect(block.text.endsWith('[Attachment truncated at 256 KB]')).toBe(true);
    expect(block.text.length).toBe(
      '[File: big.txt]\n'.length + 256 * 1024 + '\n[Attachment truncated at 256 KB]'.length,
    );
  });

  test('files past the total payload cap are skipped with the note', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { runner, promptMessages } = createHarness();
      const atCap = 'A'.repeat(5 * 1024 * 1024);

      await runner.send({
        text: 'Look',
        messageID: 'msg_1',
        files: [
          // Exactly at the cap: still carried.
          { uri: `data:image/png;base64,${atCap}`, name: 'huge.png' },
          // The next file pushes the total over it, and the one after stays skipped.
          { uri: `data:text/plain;base64,${base64Of('hello')}`, name: 'after.txt' },
          { uri: `data:text/plain;base64,${base64Of('later')}`, name: 'later.txt' },
        ],
      });

      await waitFor(() => promptMessages.length === 1);
      const blocks = attachmentBlocks(promptMessages[0]);
      expect(blocks).toHaveLength(4);
      expect(blocks[1]).toEqual({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: atCap },
      });
      expect(blocks[2]).toEqual({ type: 'text', text: '[Attachment skipped: after.txt (text/plain)]' });
      expect(blocks[3]).toEqual({ type: 'text', text: '[Attachment skipped: later.txt (text/plain)]' });
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Interrupt, failure, lifecycle
// ---------------------------------------------------------------------------

describe('interrupt and failure', () => {
  test('interrupt aborts the running turn when the stream settles', async () => {
    const { runner, fake, emitted } = createHarness();

    await runner.send({ text: 'long task', messageID: 'msg_1' });
    fake.push(blockStart(0, { type: 'text' }));
    fake.push(blockDelta(0, { type: 'text_delta', text: 'working' }));
    await waitFor(() => eventsOfType(emitted, 'session.text.delta').length === 1);
    expect(runner.isBusy()).toBe(true);

    const interrupted = runner.interrupt();
    expect(fake.calls.interrupts).toBe(1);
    // The SDK only settles the turn after the interrupt control request.
    fake.finish();
    await interrupted;

    await waitFor(() => eventsOfType(emitted, 'session.execution.interrupted').length === 1);
    const types = emitted.map((event) => event.type);
    expect(types).not.toContain('session.execution.succeeded');
    expect(types).not.toContain('session.execution.failed');
    expect(eventsOfType(emitted, 'session.step.failed')[0].data.error.message).toBe('Interrupted by user');
    expect(eventsOfType(emitted, 'session.execution.interrupted')[0].data).toEqual({
      sessionID: SESSION_ID,
      reason: 'user',
    });
    expect(runner.isBusy()).toBe(false);
  });

  test('interrupt denies a parked permission and clears it from the list', async () => {
    const { runner, fake, spawns, emitted } = createHarness();

    await runner.send({ text: 'long task', messageID: 'msg_1' });
    const canUseTool = spawns[0].options.canUseTool;
    const answer = canUseTool('Bash', { command: 'rm -rf build' }, { toolUseID: 'toolu_1' });
    await waitFor(() => eventsOfType(emitted, 'permission.asked').length === 1);
    const request = eventsOfType(emitted, 'permission.asked')[0];
    expect(runner.pendingPermissionRequests()).toEqual([request.data]);

    const interrupted = runner.interrupt();
    // The parked approval dies with the turn: denied, reported, out of the list.
    expect(await answer).toEqual({ behavior: 'deny', message: 'Interrupted' });
    expect(runner.pendingPermissionRequests()).toEqual([]);
    expect(eventsOfType(emitted, 'permission.replied')).toHaveLength(1);
    expect(eventsOfType(emitted, 'permission.replied')[0].data).toEqual({
      sessionID: SESSION_ID,
      requestID: request.data.id,
      reply: 'reject',
    });

    fake.finish();
    await interrupted;
    await waitFor(() => eventsOfType(emitted, 'session.execution.interrupted').length === 1);
    expect(runner.isBusy()).toBe(false);
  });

  test('interrupt settles from the next result instead of translating it', async () => {
    const { runner, fake, emitted } = createHarness();

    await runner.send({ text: 'long task', messageID: 'msg_1' });
    fake.push(blockStart(0, { type: 'text' }));
    await waitFor(() => eventsOfType(emitted, 'session.step.started').length === 1);

    await runner.interrupt();
    fake.push(successResult());

    await waitFor(() => eventsOfType(emitted, 'session.execution.interrupted').length === 1);
    const types = emitted.map((event) => event.type);
    expect(types).not.toContain('session.step.ended');
    expect(types).not.toContain('session.execution.succeeded');
    expect(runner.isBusy()).toBe(false);
  });

  test('interrupt outside a turn does nothing', async () => {
    const { runner, fake, emitted } = createHarness();

    await runner.interrupt();
    expect(fake.calls.interrupts).toBe(0);
    expect(emitted).toEqual([]);
  });

  test('a force-settled interrupt warns with the session it settled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const { runner, fake, emitted } = createHarness();

      await runner.send({ text: 'long task', messageID: 'msg_1' });
      fake.push(blockStart(0, { type: 'text' }));
      // The interrupt control request never settles and the stream stays open,
      // so only the force-settle path can end the turn.
      await runner.interrupt();
      expect(fake.calls.interrupts).toBe(1);
      expect(runner.isBusy()).toBe(true);

      await vi.advanceTimersByTimeAsync(10_000);

      expect(eventsOfType(emitted, 'session.execution.interrupted')).toHaveLength(1);
      expect(eventsOfType(emitted, 'session.execution.interrupted')[0].data.reason).toBe('user');
      expect(runner.isBusy()).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(SESSION_ID);
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  test('a generator throw fails the turn without crashing the runner', async () => {
    const { runner, fake, emitted } = createHarness();

    await runner.send({ text: 'do work', messageID: 'msg_1' });
    fake.push(blockStart(0, { type: 'text' }));
    await waitFor(() => eventsOfType(emitted, 'session.step.started').length === 1);

    fake.fail(new Error('process exited'));
    await waitFor(() => eventsOfType(emitted, 'session.execution.failed').length === 1);

    expect(eventsOfType(emitted, 'session.execution.failed')[0].data).toEqual({
      sessionID: SESSION_ID,
      error: { type: 'error', message: 'process exited' },
    });
    expect(eventsOfType(emitted, 'session.step.failed')).toHaveLength(1);
    expect(runner.isBusy()).toBe(false);
  });

  test('the next prompt after a failure resumes with the learned session id', async () => {
    const { runner, fake, spawns, emitted, sessionIds } = createHarness();

    await runner.send({ text: 'first', messageID: 'msg_1' });
    fake.push(initMessage('claude_session_9'));
    await waitFor(() => sessionIds.length === 1);
    fake.fail(new Error('transport died'));
    await waitFor(() => eventsOfType(emitted, 'session.execution.failed').length === 1);

    await runner.send({ text: 'second', messageID: 'msg_2' });
    expect(spawns).toHaveLength(2);
    expect(spawns[1].options.resume).toBe('claude_session_9');
  });

  test('the init session id is reported once for the session', async () => {
    const { runner, fake, emitted, sessionIds } = createHarness();

    await runner.send({ text: 'hi', messageID: 'msg_1' });
    fake.push(initMessage('claude_session_9'));
    fake.push(blockStart(0, { type: 'text' }));
    fake.push(successResult({ session_id: 'claude_session_9' }));
    await waitFor(() => eventsOfType(emitted, 'session.execution.succeeded').length === 1);

    expect(sessionIds).toEqual(['claude_session_9']);
  });

  test('options carry the resume uuid and the CLI path when the session has them', async () => {
    const { runner, spawns } = createHarness({
      session: { claudeSessionUuid: 'uuid-resume-1', cliPath: 'C:\\bin\\claude.cmd' },
    });

    await runner.send({ text: 'continue', messageID: 'msg_1' });
    expect(spawns[0].options).toMatchObject({
      resume: 'uuid-resume-1',
      pathToClaudeCodeExecutable: 'C:\\bin\\claude.cmd',
      model: 'sonnet',
    });
  });

  test('a session without a resume target omits resume and the CLI path', async () => {
    const { runner, spawns } = createHarness();

    await runner.send({ text: 'first', messageID: 'msg_1' });
    expect(spawns[0].options.resume).toBeUndefined();
    expect(spawns[0].options.pathToClaudeCodeExecutable).toBeUndefined();
  });

  test('the idle timer disposes the runner and reports it', async () => {
    const { runner, fake, fs, emitted, idleCalls } = createHarness({ factory: { idleMs: 30 } });

    await runner.send({ text: 'hi', messageID: 'msg_1' });
    fake.push(blockStart(0, { type: 'text' }));
    fake.push(successResult());
    await waitFor(() => eventsOfType(emitted, 'session.execution.succeeded').length === 1);

    await waitFor(() => idleCalls.length === 1);
    expect(idleCalls[0]).toBe(runner);
    expect(fake.calls.closes).toBe(1);
    expect(runner.isBusy()).toBe(false);
    expect(fs.files.get(TRANSCRIPT_PATH)).toContain('"kind":"assistant"');
    await expect(runner.send({ text: 'after idle', messageID: 'msg_2' })).rejects.toThrow();
  });

  test('a parked permission keeps the runner alive across idle windows and reaps after the reply', async () => {
    const { runner, fake, spawns, emitted, idleCalls } = createHarness({ factory: { idleMs: 30 } });

    await runner.send({ text: 'run tests', messageID: 'msg_1' });
    const canUseTool = spawns[0].options.canUseTool;
    const answer = canUseTool('Bash', { command: 'bun test' }, { toolUseID: 'toolu_1' });
    await waitFor(() => eventsOfType(emitted, 'permission.asked').length === 1);
    const request = eventsOfType(emitted, 'permission.asked')[0];

    // Two idle windows pass while the approval is parked: the runner must not
    // settle the turn, dispose, or report to onIdle.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(idleCalls).toEqual([]);
    expect(fake.calls.closes).toBe(0);
    expect(eventsOfType(emitted, 'session.execution.interrupted')).toEqual([]);
    expect(runner.isBusy()).toBe(true);

    // The reply is activity; the next idle window reaps as before.
    expect(runner.resolvePermission(request.data.id, 'once')).toBe(true);
    expect(await answer).toEqual({ behavior: 'allow' });
    await waitFor(() => idleCalls.length === 1);
    expect(idleCalls[0]).toBe(runner);
    expect(fake.calls.closes).toBe(1);
    expect(runner.isBusy()).toBe(false);
    expect(eventsOfType(emitted, 'session.execution.interrupted')[0].data.reason).toBe('idle');
  });

  test('a park left behind by a settled turn does not keep the runner alive', async () => {
    const { runner, fake, spawns, emitted, idleCalls } = createHarness({ factory: { idleMs: 30 } });

    await runner.send({ text: 'run tests', messageID: 'msg_1' });
    const canUseTool = spawns[0].options.canUseTool;
    const answer = canUseTool('Bash', { command: 'bun test' }, { toolUseID: 'toolu_1' });
    await waitFor(() => eventsOfType(emitted, 'permission.asked').length === 1);
    const request = eventsOfType(emitted, 'permission.asked')[0];

    // The turn settles (e.g. an interrupt racing the request) while the
    // approval is still parked.
    fake.push(successResult());
    await waitFor(() => runner.isBusy() === false);
    expect(runner.pendingPermissionRequests()).toEqual([request.data]);

    // The stale park must not keep the runner alive: the next idle window
    // rejects it (the interrupt path, so clients clear it) and then reaps.
    await waitFor(() => idleCalls.length === 1);
    expect(await answer).toEqual({ behavior: 'deny', message: 'Interrupted' });
    expect(runner.pendingPermissionRequests()).toEqual([]);
    expect(eventsOfType(emitted, 'permission.replied')).toHaveLength(1);
    expect(eventsOfType(emitted, 'permission.replied')[0].data).toEqual({
      sessionID: SESSION_ID,
      requestID: request.data.id,
      reply: 'reject',
    });
  });

  test('dispose is idempotent and closes the query once', async () => {
    const { runner, fake, emitted } = createHarness();

    await runner.send({ text: 'hi', messageID: 'msg_1' });
    fake.push(blockStart(0, { type: 'text' }));
    await waitFor(() => eventsOfType(emitted, 'session.step.started').length === 1);
    const emittedBefore = emitted.length;

    await runner.dispose();
    await runner.dispose();

    expect(fake.calls.closes).toBe(1);
    expect(runner.isBusy()).toBe(false);
    fake.push(blockDelta(0, { type: 'text_delta', text: 'late' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(emitted.length).toBe(emittedBefore);
  });
});

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

describe('usage', () => {
  const EXPECTED = {
    cost: 0.01,
    tokens: { input: 10, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
  };

  test('a successful result reports its cumulative cost and per-turn tokens', async () => {
    const { runner, fake, emitted, usageCalls } = createHarness();

    await runner.send({ text: 'hi', messageID: 'msg_1' });
    fake.push(blockStart(0, { type: 'text' }));
    fake.push(successResult());
    await waitFor(() => eventsOfType(emitted, 'session.execution.succeeded').length === 1);

    expect(usageCalls).toEqual([EXPECTED]);
  });

  test('a failed result reports its cost and tokens too', async () => {
    const { runner, fake, emitted, usageCalls } = createHarness();

    await runner.send({ text: 'hi', messageID: 'msg_1' });
    fake.push(successResult({ subtype: 'error_during_execution', is_error: true, result: 'boom' }));
    await waitFor(() => eventsOfType(emitted, 'session.execution.failed').length === 1);

    expect(eventsOfType(emitted, 'session.step.failed')).toHaveLength(1);
    expect(usageCalls).toEqual([EXPECTED]);
  });

  test('an interrupted turn and a transport failure report no usage', async () => {
    const interrupted = createHarness();
    await interrupted.runner.send({ text: 'long task', messageID: 'msg_1' });
    interrupted.fake.push(blockStart(0, { type: 'text' }));
    await waitFor(() => eventsOfType(interrupted.emitted, 'session.step.started').length === 1);
    await interrupted.runner.interrupt();
    // The next result settles the turn as aborted instead of translating it,
    // so its cost and tokens never reach onUsage.
    interrupted.fake.push(successResult());
    await waitFor(() => eventsOfType(interrupted.emitted, 'session.execution.interrupted').length === 1);
    expect(interrupted.usageCalls).toEqual([]);

    const failed = createHarness();
    await failed.runner.send({ text: 'do work', messageID: 'msg_2' });
    failed.fake.fail(new Error('process exited'));
    await waitFor(() => eventsOfType(failed.emitted, 'session.execution.failed').length === 1);
    expect(failed.usageCalls).toEqual([]);
  });
});
