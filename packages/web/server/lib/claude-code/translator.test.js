// Unit tests for the Claude Agent SDK -> OpenCode wire event translator.
//
// The SDK messages below are hand-built plain objects mirroring the assumed
// input contract documented at the top of translator.js; the SDK package is
// not imported here.

import { describe, expect, test } from 'bun:test';

import { createTranslator } from './translator.js';

const SESSION_ID = 'ses_claude_unit';
const DIRECTORY = 'C:\\work\\claude';
const CLOCK = 1_700_000_000_000;

const createTestTranslator = (options = {}) => {
  let idCounter = 0;
  return createTranslator({
    sessionID: SESSION_ID,
    directory: DIRECTORY,
    newMessageId: () => {
      idCounter += 1;
      return `evt_${String(idCounter).padStart(3, '0')}`;
    },
    now: () => CLOCK,
    ...options,
  });
};

const streamEvent = (event) => ({
  type: 'stream_event',
  event,
  session_id: 'claude_session_1',
  uuid: 'uuid-1',
  parent_tool_use_id: null,
});

const blockStart = (index, contentBlock) =>
  streamEvent({ type: 'content_block_start', index, content_block: contentBlock });
const blockDelta = (index, delta) => streamEvent({ type: 'content_block_delta', index, delta });
const blockStop = (index) => streamEvent({ type: 'content_block_stop', index });

const userToolResults = (results) => ({
  type: 'user',
  message: { role: 'user', content: results },
  session_id: 'claude_session_1',
  uuid: 'uuid-2',
});

const successResult = (overrides = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Done.',
  total_cost_usd: 0.0123,
  usage: {
    input_tokens: 120,
    output_tokens: 34,
    cache_read_input_tokens: 5000,
    cache_creation_input_tokens: 20,
  },
  session_id: 'claude_session_1',
  ...overrides,
});

const errorResult = (overrides = {}) => ({
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  total_cost_usd: 0.004,
  usage: { input_tokens: 8, output_tokens: 1 },
  session_id: 'claude_session_1',
  ...overrides,
});

const assistantMessageIDOf = (events) => {
  const started = events.find((event) => event.type === 'session.step.started');
  return started?.data.assistantMessageID;
};

describe('beginTurn', () => {
  test('emits session.execution.started inside the wire envelope', () => {
    const translator = createTestTranslator();

    const events = translator.beginTurn();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'session.execution.started',
      created: CLOCK,
      data: { sessionID: SESSION_ID },
      location: { directory: DIRECTORY },
    });
    expect(events[0].id).toBeTypeOf('string');
  });
});

describe('text blocks', () => {
  test('maps a text block to session.text.started, .delta and .ended with accumulated text', () => {
    const translator = createTestTranslator();
    translator.beginTurn();

    const started = translator.translate(blockStart(0, { type: 'text' }));
    expect(started.map((event) => event.type)).toEqual(['session.step.started', 'session.text.started']);
    const assistantMessageID = started[0].data.assistantMessageID;
    expect(started[0].data).toEqual({
      sessionID: SESSION_ID,
      assistantMessageID,
      agent: 'claude',
      model: { providerID: 'claude-code', id: 'default' },
      started: CLOCK,
    });
    expect(started[1].data).toEqual({ sessionID: SESSION_ID, assistantMessageID, ordinal: 0 });

    const firstDelta = translator.translate(blockDelta(0, { type: 'text_delta', text: 'Hello ' }));
    expect(firstDelta.map((event) => event.type)).toEqual(['session.text.delta']);
    expect(firstDelta[0].data).toEqual({ sessionID: SESSION_ID, assistantMessageID, ordinal: 0, delta: 'Hello ' });

    translator.translate(blockDelta(0, { type: 'text_delta', text: 'world' }));

    const ended = translator.translate(blockStop(0));
    expect(ended.map((event) => event.type)).toEqual(['session.text.ended']);
    expect(ended[0].data).toEqual({ sessionID: SESSION_ID, assistantMessageID, ordinal: 0, text: 'Hello world' });
  });

  test('setModel changes the alias reported on the next step', () => {
    const translator = createTestTranslator();
    translator.setModel('opus');
    translator.beginTurn();

    const events = translator.translate(blockStart(0, { type: 'text' }));

    expect(events[0].data.model).toEqual({ providerID: 'claude-code', id: 'opus' });
  });
});

describe('thinking blocks', () => {
  test('maps a thinking block under the reasoning vocabulary with its own ordinal', () => {
    const translator = createTestTranslator();
    translator.beginTurn();

    const started = translator.translate(blockStart(1, { type: 'thinking' }));
    expect(started.map((event) => event.type)).toEqual(['session.step.started', 'session.reasoning.started']);
    const assistantMessageID = assistantMessageIDOf(started);
    expect(started[1].data).toEqual({ sessionID: SESSION_ID, assistantMessageID, ordinal: 0 });

    const delta = translator.translate(blockDelta(1, { type: 'thinking_delta', thinking: 'Weighing options' }));
    expect(delta.map((event) => event.type)).toEqual(['session.reasoning.delta']);
    expect(delta[0].data).toEqual({
      sessionID: SESSION_ID,
      assistantMessageID,
      ordinal: 0,
      delta: 'Weighing options',
    });

    // A signature delta carries no displayable content.
    expect(translator.translate(blockDelta(1, { type: 'signature_delta', signature: 'sig' }))).toEqual([]);

    const ended = translator.translate(blockStop(1));
    expect(ended.map((event) => event.type)).toEqual(['session.reasoning.ended']);
    expect(ended[0].data).toEqual({
      sessionID: SESSION_ID,
      assistantMessageID,
      ordinal: 0,
      text: 'Weighing options',
    });
  });
});

describe('tool blocks', () => {
  test('streams tool input and settles the call from the tool_result', () => {
    const translator = createTestTranslator();
    translator.beginTurn();

    const started = translator.translate(blockStart(2, { type: 'tool_use', id: 'toolu_1', name: 'Bash' }));
    expect(started.map((event) => event.type)).toEqual(['session.step.started', 'session.tool.input.started']);
    const assistantMessageID = assistantMessageIDOf(started);
    expect(started[1].data).toEqual({ sessionID: SESSION_ID, assistantMessageID, id: 'toolu_1', name: 'Bash' });

    const delta = translator.translate(blockDelta(2, { type: 'input_json_delta', partial_json: '{"command":' }));
    expect(delta.map((event) => event.type)).toEqual(['session.tool.input.delta']);
    expect(delta[0].data).toEqual({
      sessionID: SESSION_ID,
      assistantMessageID,
      id: 'toolu_1',
      delta: '{"command":',
    });

    translator.translate(blockDelta(2, { type: 'input_json_delta', partial_json: '"ls -la"}' }));

    const ended = translator.translate(blockStop(2));
    expect(ended.map((event) => event.type)).toEqual(['session.tool.input.ended', 'session.tool.called']);
    expect(ended[0].data).toEqual({
      sessionID: SESSION_ID,
      assistantMessageID,
      id: 'toolu_1',
      text: '{"command":"ls -la"}',
    });
    expect(ended[1].created).toBe(CLOCK);
    expect(ended[1].data).toEqual({
      sessionID: SESSION_ID,
      assistantMessageID,
      id: 'toolu_1',
      input: { command: 'ls -la' },
      executed: true,
    });

    const settled = translator.translate(
      userToolResults([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file-a.txt\nfile-b.txt' }]),
    );
    expect(settled.map((event) => event.type)).toEqual(['session.tool.success']);
    expect(settled[0].data).toEqual({
      sessionID: SESSION_ID,
      assistantMessageID,
      id: 'toolu_1',
      content: [{ type: 'text', text: 'file-a.txt\nfile-b.txt' }],
      executed: true,
    });
  });

  test('emits called with an empty input object when the input stream is empty', () => {
    const translator = createTestTranslator();
    translator.beginTurn();
    const started = translator.translate(blockStart(0, { type: 'tool_use', id: 'toolu_4', name: 'Bash' }));
    const assistantMessageID = assistantMessageIDOf(started);

    const ended = translator.translate(blockStop(0));

    expect(ended.map((event) => event.type)).toEqual(['session.tool.input.ended', 'session.tool.called']);
    expect(ended[0].data.text).toBe('');
    expect(ended[1].data).toEqual({
      sessionID: SESSION_ID,
      assistantMessageID,
      id: 'toolu_4',
      input: {},
      executed: true,
    });
  });

  test('emits called with an empty input object when the input stream is malformed', () => {
    const translator = createTestTranslator();
    translator.beginTurn();
    const started = translator.translate(blockStart(0, { type: 'tool_use', id: 'toolu_5', name: 'Bash' }));
    const assistantMessageID = assistantMessageIDOf(started);
    translator.translate(blockDelta(0, { type: 'input_json_delta', partial_json: '{"command":' }));

    const ended = translator.translate(blockStop(0));

    // The raw stream still reaches input.ended unchanged.
    expect(ended[0].data.text).toBe('{"command":');
    expect(ended[1].data).toEqual({
      sessionID: SESSION_ID,
      assistantMessageID,
      id: 'toolu_5',
      input: {},
      executed: true,
    });
  });

  test('emits called with an empty input object when the input stream is not an object', () => {
    const translator = createTestTranslator();
    translator.beginTurn();
    translator.translate(blockStart(0, { type: 'tool_use', id: 'toolu_6', name: 'Bash' }));
    translator.translate(blockDelta(0, { type: 'input_json_delta', partial_json: '"ls -la"' }));

    const ended = translator.translate(blockStop(0));

    expect(ended[1].data.input).toEqual({});
  });

  test('maps a failed tool_result to session.tool.failed with the extracted message', () => {
    const translator = createTestTranslator();
    translator.beginTurn();
    const started = translator.translate(blockStart(0, { type: 'tool_use', id: 'toolu_2', name: 'Read' }));
    const assistantMessageID = assistantMessageIDOf(started);

    const failed = translator.translate(
      userToolResults([
        {
          type: 'tool_result',
          tool_use_id: 'toolu_2',
          content: [{ type: 'text', text: 'ENOENT: no such file' }],
          is_error: true,
        },
      ]),
    );

    expect(failed.map((event) => event.type)).toEqual(['session.tool.failed']);
    expect(failed[0].data).toEqual({
      sessionID: SESSION_ID,
      assistantMessageID,
      id: 'toolu_2',
      content: [{ type: 'text', text: 'ENOENT: no such file' }],
      error: { type: 'error', message: 'ENOENT: no such file' },
      executed: true,
    });
  });

  test('translates every tool_result block of one user message', () => {
    const translator = createTestTranslator();
    translator.beginTurn();
    translator.translate(blockStart(0, { type: 'tool_use', id: 'toolu_a', name: 'Bash' }));
    translator.translate(blockStart(1, { type: 'tool_use', id: 'toolu_b', name: 'Read' }));

    const settled = translator.translate(
      userToolResults([
        { type: 'tool_result', tool_use_id: 'toolu_a', content: [{ type: 'text', text: 'ok' }] },
        { type: 'tool_result', tool_use_id: 'toolu_b', content: [{ type: 'text', text: 'missing' }], is_error: true },
      ]),
    );

    expect(settled.map((event) => event.type)).toEqual(['session.tool.success', 'session.tool.failed']);
    expect(settled[0].data.id).toBe('toolu_a');
    expect(settled[1].data.id).toBe('toolu_b');
  });

  test('normalizes empty tool_result content to one empty text block', () => {
    const translator = createTestTranslator();
    translator.beginTurn();
    translator.translate(blockStart(0, { type: 'tool_use', id: 'toolu_3', name: 'Bash' }));

    const settled = translator.translate(
      userToolResults([{ type: 'tool_result', tool_use_id: 'toolu_3', content: '' }]),
    );

    expect(settled[0].data.content).toEqual([{ type: 'text', text: '' }]);
  });
});

describe('result messages', () => {
  test('a successful result ends the step and the execution', () => {
    const translator = createTestTranslator();
    translator.beginTurn();
    const started = translator.translate(blockStart(0, { type: 'text' }));
    const assistantMessageID = assistantMessageIDOf(started);
    translator.translate(blockStop(0));

    const events = translator.translate(successResult());

    expect(events.map((event) => event.type)).toEqual(['session.step.ended', 'session.execution.succeeded']);
    expect(events[0].data).toEqual({
      sessionID: SESSION_ID,
      assistantMessageID,
      finish: 'stop',
      cost: 0.0123,
      tokens: { input: 120, output: 34, reasoning: 0, cache: { read: 5000, write: 20 } },
    });
    expect(events[1].data).toEqual({ sessionID: SESSION_ID });
  });

  test('mints the assistant message when a result arrives with no content', () => {
    const translator = createTestTranslator();
    translator.beginTurn();

    const events = translator.translate(successResult());

    expect(events.map((event) => event.type)).toEqual([
      'session.step.started',
      'session.step.ended',
      'session.execution.succeeded',
    ]);
    expect(assistantMessageIDOf(events)).toBe(events[1].data.assistantMessageID);
  });

  test('tolerates a missing usage record with zero tokens and cost', () => {
    const translator = createTestTranslator();
    translator.beginTurn();
    translator.translate(blockStart(0, { type: 'text' }));

    const events = translator.translate(successResult({ usage: undefined, total_cost_usd: undefined }));

    expect(events[0].data.tokens).toEqual({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
    expect(events[0].data.cost).toBe(0);
  });

  test('an error result fails the step and the execution', () => {
    const translator = createTestTranslator();
    translator.beginTurn();
    const started = translator.translate(blockStart(0, { type: 'text' }));
    const assistantMessageID = assistantMessageIDOf(started);

    const events = translator.translate(errorResult());

    expect(events.map((event) => event.type)).toEqual(['session.step.failed', 'session.execution.failed']);
    expect(events[0].data).toEqual({
      sessionID: SESSION_ID,
      assistantMessageID,
      error: { type: 'error_during_execution', message: 'Claude Code run failed: error_during_execution' },
      cost: 0.004,
      tokens: { input: 8, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    expect(events[1].data).toEqual({
      sessionID: SESSION_ID,
      error: { type: 'error_during_execution', message: 'Claude Code run failed: error_during_execution' },
    });
  });

  test('uses the SDK result text as the error message when present', () => {
    const translator = createTestTranslator();
    translator.beginTurn();
    translator.translate(blockStart(0, { type: 'text' }));

    const events = translator.translate(errorResult({ result: 'Credit balance is too low' }));

    expect(events[0].data.error.message).toBe('Credit balance is too low');
  });

  test('is_error with a success subtype still fails the turn', () => {
    const translator = createTestTranslator();
    translator.beginTurn();
    translator.translate(blockStart(0, { type: 'text' }));

    const events = translator.translate(successResult({ is_error: true, result: undefined }));

    expect(events.map((event) => event.type)).toEqual(['session.step.failed', 'session.execution.failed']);
    expect(events[0].data.error.message).toBe('Claude Code run failed');
  });
});

describe('ordering and ordinals', () => {
  test('step.started precedes the first content event and text ordinals increment per block', () => {
    const translator = createTestTranslator();
    translator.beginTurn();

    const events = [
      ...translator.translate(blockStart(0, { type: 'text' })),
      ...translator.translate(blockStop(0)),
      ...translator.translate(blockStart(1, { type: 'text' })),
      ...translator.translate(blockDelta(1, { type: 'text_delta', text: 'second' })),
      ...translator.translate(blockStop(1)),
    ];

    const types = events.map((event) => event.type);
    expect(types.indexOf('session.step.started')).toBeLessThan(types.indexOf('session.text.started'));
    const textStarted = events.filter((event) => event.type === 'session.text.started');
    expect(textStarted.map((event) => event.data.ordinal)).toEqual([0, 1]);
    expect(events.filter((event) => event.type === 'session.step.started')).toHaveLength(1);
  });

  test('text and reasoning ordinals count independently', () => {
    const translator = createTestTranslator();
    translator.beginTurn();

    const text0 = translator.translate(blockStart(0, { type: 'text' }));
    const reasoning0 = translator.translate(blockStart(1, { type: 'thinking' }));
    const text1 = translator.translate(blockStart(2, { type: 'text' }));
    const reasoning1 = translator.translate(blockStart(3, { type: 'thinking' }));

    expect(text0.find((event) => event.type === 'session.text.started').data.ordinal).toBe(0);
    expect(reasoning0.find((event) => event.type === 'session.reasoning.started').data.ordinal).toBe(0);
    expect(text1.find((event) => event.type === 'session.text.started').data.ordinal).toBe(1);
    expect(reasoning1.find((event) => event.type === 'session.reasoning.started').data.ordinal).toBe(1);
  });

  test('a second turn mints a new assistant message and resets ordinals', () => {
    const translator = createTestTranslator();
    translator.beginTurn();
    const first = translator.translate(blockStart(0, { type: 'text' }));
    const firstMessageID = assistantMessageIDOf(first);
    translator.translate(successResult());

    const secondBegin = translator.beginTurn();
    expect(secondBegin.map((event) => event.type)).toEqual(['session.execution.started']);

    const second = translator.translate(blockStart(0, { type: 'text' }));
    const secondMessageID = assistantMessageIDOf(second);
    expect(secondMessageID).not.toBe(firstMessageID);
    expect(second.find((event) => event.type === 'session.text.started').data.ordinal).toBe(0);
  });
});

describe('abort', () => {
  test('fails the open step and interrupts execution', () => {
    const translator = createTestTranslator();
    translator.beginTurn();
    const started = translator.translate(blockStart(0, { type: 'text' }));
    const assistantMessageID = assistantMessageIDOf(started);

    const events = translator.abort();

    expect(events.map((event) => event.type)).toEqual(['session.step.failed', 'session.execution.interrupted']);
    expect(events[0].data).toMatchObject({
      sessionID: SESSION_ID,
      assistantMessageID,
      error: { message: 'Interrupted by user' },
    });
    expect(events[1].data).toEqual({ sessionID: SESSION_ID, reason: 'user' });

    // The turn is closed: a late SDK result or delta must not settle it again.
    expect(translator.translate(successResult())).toEqual([]);
    expect(translator.translate(blockDelta(0, { type: 'text_delta', text: 'late' }))).toEqual([]);
  });

  test('emits only the interruption once the turn ended', () => {
    const translator = createTestTranslator();
    translator.beginTurn();
    translator.translate(blockStart(0, { type: 'text' }));
    translator.translate(successResult());

    const events = translator.abort({ reason: 'shutdown' });

    expect(events.map((event) => event.type)).toEqual(['session.execution.interrupted']);
    expect(events[0].data).toEqual({ sessionID: SESSION_ID, reason: 'shutdown' });
  });
});

describe('fail', () => {
  test('fails the open step and the execution with the given error', () => {
    const translator = createTestTranslator();
    translator.beginTurn();
    const started = translator.translate(blockStart(0, { type: 'text' }));
    const assistantMessageID = assistantMessageIDOf(started);

    const events = translator.fail({ error: { type: 'error', message: 'transport closed' } });

    expect(events.map((event) => event.type)).toEqual(['session.step.failed', 'session.execution.failed']);
    expect(events[0].data).toEqual({
      sessionID: SESSION_ID,
      assistantMessageID,
      error: { type: 'error', message: 'transport closed' },
    });
    expect(events[1].data).toEqual({
      sessionID: SESSION_ID,
      error: { type: 'error', message: 'transport closed' },
    });

    // The turn is closed: a late result or delta must not settle it again.
    expect(translator.translate(successResult())).toEqual([]);
    expect(translator.translate(blockDelta(0, { type: 'text_delta', text: 'late' }))).toEqual([]);
  });

  test('fails the execution without a step when no content arrived', () => {
    const translator = createTestTranslator();
    translator.beginTurn();

    const events = translator.fail({ error: { type: 'error', message: 'spawn failed' } });

    expect(events.map((event) => event.type)).toEqual(['session.execution.failed']);
    expect(events[0].data).toEqual({
      sessionID: SESSION_ID,
      error: { type: 'error', message: 'spawn failed' },
    });
  });
});

describe('unknown and malformed SDK messages', () => {
  test('system init, assistant echoes and unknown types map to nothing', () => {
    const translator = createTestTranslator();
    translator.beginTurn();

    expect(translator.translate({ type: 'system', subtype: 'init', session_id: 'claude_session_1' })).toEqual([]);
    expect(
      translator.translate({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'echo' }] },
      }),
    ).toEqual([]);
    expect(translator.translate({ type: 'future.thing' })).toEqual([]);
  });

  test('malformed messages never throw and map to nothing', () => {
    const translator = createTestTranslator();
    translator.beginTurn();

    const malformed = [
      undefined,
      null,
      42,
      'text',
      {},
      { type: 'stream_event' },
      { type: 'stream_event', event: {} },
      { type: 'stream_event', event: { type: 'content_block_start' } },
      { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } },
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: {} } },
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 9, delta: { type: 'text_delta', text: 'x' } } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 9 } },
      { type: 'stream_event', event: { type: 'message_start', message: {} } },
      { type: 'user', message: {} },
      { type: 'user', message: { content: 'not-an-array' } },
      { type: 'user', message: { content: [{ type: 'tool_result' }] } },
      { type: 'result' },
    ];

    for (const message of malformed) {
      expect(translator.translate(message)).toEqual([]);
    }
  });

  test('content outside a turn still mints the assistant message; a settled turn stays closed', () => {
    const translator = createTestTranslator();

    const events = translator.translate(blockStart(0, { type: 'text' }));
    expect(events.map((event) => event.type)).toEqual(['session.step.started', 'session.text.started']);

    // The result settles the turn; later content is a late SDK message.
    translator.translate(successResult());
    expect(translator.translate(blockStart(1, { type: 'text' }))).toEqual([]);
  });
});
