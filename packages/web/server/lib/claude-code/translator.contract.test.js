// Shape contract: every wire event the translator emits must be accepted by
// the UI's own wire -> sync translation. This is the guard against event
// vocabulary drift: a wrong event name (or a data field the UI no longer
// reads) fails here, in the server package, instead of surfacing as a chat
// that silently renders nothing.
//
// The UI module is TypeScript and runs directly under vitest/bun, following
// the relay cross-compat precedent (packages/web/server/lib/relay/cross-compat.test.js).

import { describe, expect, test } from 'bun:test';

import { translateWireEvent } from '../../../../ui/src/lib/opencode/events.ts';
import { createTranslator } from './translator.js';

const SESSION_ID = 'ses_claude_contract';
const DIRECTORY = 'D:\\work\\claude';
const CLOCK = 1_700_000_000_000;

const createTestTranslator = () => {
  let idCounter = 0;
  return createTranslator({
    sessionID: SESSION_ID,
    directory: DIRECTORY,
    newMessageId: () => {
      idCounter += 1;
      return `evt_${String(idCounter).padStart(3, '0')}`;
    },
    now: () => CLOCK,
  });
};

const streamEvent = (event) => ({
  type: 'stream_event',
  event,
  session_id: 'claude_session_contract',
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
  session_id: 'claude_session_contract',
  uuid: 'uuid-2',
});

const successResult = () => ({
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
  session_id: 'claude_session_contract',
});

// One whole turn exercising every event the translator can emit: text and
// thinking streams, two tool calls settled success and failed, then the result.
const driveSuccessfulTurn = (translator) => {
  const events = [...translator.beginTurn()];
  const push = (translated) => events.push(...translated);

  push(translator.translate(streamEvent({ type: 'message_start', message: { role: 'assistant' } })));
  push(translator.translate(blockStart(0, { type: 'text' })));
  push(translator.translate(blockDelta(0, { type: 'text_delta', text: 'Hi ' })));
  push(translator.translate(blockDelta(0, { type: 'text_delta', text: 'there' })));
  push(translator.translate(blockStop(0)));
  push(translator.translate(blockStart(1, { type: 'thinking' })));
  push(translator.translate(blockDelta(1, { type: 'thinking_delta', thinking: 'Hmm' })));
  push(translator.translate(blockStop(1)));
  push(translator.translate(blockStart(2, { type: 'tool_use', id: 'toolu_a', name: 'Bash' })));
  push(translator.translate(blockDelta(2, { type: 'input_json_delta', partial_json: '{"command":' })));
  push(translator.translate(blockDelta(2, { type: 'input_json_delta', partial_json: '"ls"}' })));
  push(translator.translate(blockStop(2)));
  push(translator.translate(userToolResults([{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'a.txt' }])));
  push(translator.translate(blockStart(3, { type: 'tool_use', id: 'toolu_b', name: 'Read' })));
  push(translator.translate(blockStop(3)));
  push(
    translator.translate(
      userToolResults([
        { type: 'tool_result', tool_use_id: 'toolu_b', content: [{ type: 'text', text: 'ENOENT' }], is_error: true },
      ]),
    ),
  );
  push(translator.translate(successResult()));

  return events;
};

const collectTranslationFailures = (events) => {
  const failures = [];
  for (const event of events) {
    const translated = translateWireEvent(event);
    if (!Array.isArray(translated) || translated.length === 0) {
      failures.push(event.type);
    }
  }
  return failures;
};

describe('Claude translator -> UI wire contract', () => {
  test('every event of a full successful turn translates to at least one sync event', () => {
    const translator = createTestTranslator();

    const events = driveSuccessfulTurn(translator);

    expect(events.length).toBeGreaterThan(0);
    expect(collectTranslationFailures(events)).toEqual([]);

    // The driver must cover the whole vocabulary; a new event added to the
    // translator without a matching UI case would otherwise slip through.
    const types = [...new Set(events.map((event) => event.type))].sort();
    expect(types).toEqual(
      [
        'session.execution.started',
        'session.execution.succeeded',
        'session.reasoning.delta',
        'session.reasoning.ended',
        'session.reasoning.started',
        'session.step.ended',
        'session.step.started',
        'session.text.delta',
        'session.text.ended',
        'session.text.started',
        'session.tool.failed',
        'session.tool.input.delta',
        'session.tool.input.ended',
        'session.tool.input.started',
        'session.tool.success',
      ].sort(),
    );
  });

  test('a failed turn and an aborted turn also stay inside the wire vocabulary', () => {
    const failing = createTestTranslator();
    const failedEvents = [
      ...failing.beginTurn(),
      ...failing.translate(blockStart(0, { type: 'text' })),
      ...failing.translate(blockStop(0)),
      ...failing.translate({
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        total_cost_usd: 0.02,
        usage: { input_tokens: 5, output_tokens: 2 },
        session_id: 'claude_session_contract',
      }),
    ];
    expect(failedEvents.map((event) => event.type)).toContain('session.step.failed');
    expect(failedEvents.map((event) => event.type)).toContain('session.execution.failed');
    expect(collectTranslationFailures(failedEvents)).toEqual([]);

    const aborted = createTestTranslator();
    const abortEvents = [
      ...aborted.beginTurn(),
      ...aborted.translate(blockStart(0, { type: 'text' })),
      ...aborted.translate(blockDelta(0, { type: 'text_delta', text: 'partial' })),
      ...aborted.abort(),
    ];
    expect(abortEvents.map((event) => event.type)).toContain('session.execution.interrupted');
    expect(collectTranslationFailures(abortEvents)).toEqual([]);
  });

  test('the guard would catch a wrong vocabulary: a sync-side event name translates to nothing', () => {
    const translated = translateWireEvent({
      type: 'message.updated',
      data: {},
      created: Date.now(),
      id: 'x',
      location: { directory: '/x' },
    });

    expect(translated).toEqual([]);
  });
});
