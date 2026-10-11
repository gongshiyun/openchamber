// Claude Agent SDK stream messages -> OpenCode v2 wire events.
//
// The Claude backend feeds the same durable event log shape OpenCode v2
// publishes, so the UI's `translateWireEvent` (packages/ui/src/lib/opencode/
// events.ts) and the sync stores consume it unchanged. This module is a pure
// state machine over the message stream: no IO, no SDK import, and an unknown
// or malformed message maps to no events instead of throwing.
//
// One turn: `beginTurn()` -> content/step events -> an SDK `result` message
// (or `abort()`). The assistant message id is minted lazily when the first
// content arrives, and its `session.step.started` is always emitted before
// anything that addresses the message. A result or abort settles the turn;
// later SDK messages map to nothing until the next `beginTurn()`.
//
// Tool calls stream as `session.tool.input.started` -> `.delta` -> `.ended`,
// and the block's stop also publishes the call itself as `session.tool.called`
// with the accumulated input JSON parsed into an object (`{}` when empty or
// malformed), which is what the UI's running tool card reads.
// `session.tool.progress` is not emitted.
//
// ---------------------------------------------------------------------------
// SDK message shapes
// ---------------------------------------------------------------------------
//
// The Claude Agent SDK package is not a dependency yet, so the input contract
// is plain objects documented here and read defensively below; when the real
// SDK lands (Task 10/12) a shape drift is a local fix in this block.
//
//   stream_event / content_block_start:
//     { type: 'stream_event',
//       event: { type: 'content_block_start', index, content_block: { type: 'text' | 'thinking' | 'tool_use', id?, name? } } }
//   stream_event / content_block_delta:
//     { type: 'stream_event',
//       event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text }
//                                                          | { type: 'thinking_delta', thinking }
//                                                          | { type: 'input_json_delta', partial_json } } }
//   stream_event / content_block_stop:
//     { type: 'stream_event', event: { type: 'content_block_stop', index } }
//   user (tool results):
//     { type: 'user',
//       message: { role: 'user', content: [ { type: 'tool_result', tool_use_id, content: string | block[], is_error? } ] } }
//   result:
//     { type: 'result', subtype: 'success' | 'error_*', result?, is_error?, total_cost_usd?, usage? }
//   system / assistant echoes / unknown types: ignored.
//
// The runner enables `includePartialMessages`, so the content_block stream is
// authoritative for text, reasoning and tool input; full `assistant` echoes
// are ignored to avoid duplicating content.

import { asNonEmptyString, isPlainObject, isString } from '../shared/guards.js';
import { createMessageId } from './ids.js';

const PROVIDER_ID = 'claude-code';
// Used until the session selects a Claude model; the runner calls setModel
// with the session's alias (opus/sonnet/haiku/fable) before a turn starts.
const DEFAULT_MODEL = 'default';

// `Number.isFinite` rejects every non-number, so it carries the whole check.
const numberOrZero = (value) => (Number.isFinite(value) ? value : 0);

// SDK result usage -> TokenUsageInfo ({ input, output, reasoning, cache: { read, write } }).
// `reasoning` stays 0: the SDK reports thinking tokens inside output_tokens.
// The exact mapping is finalized when the real SDK lands (Tasks 10/12).
const tokenUsage = (usage) => ({
  input: numberOrZero(usage?.input_tokens),
  output: numberOrZero(usage?.output_tokens),
  reasoning: 0,
  cache: {
    read: numberOrZero(usage?.cache_read_input_tokens),
    write: numberOrZero(usage?.cache_creation_input_tokens),
  },
});

// A tool_result block's content as displayable text (string content, or the
// text blocks of an array); used for error messages.
const contentText = (content) => {
  if (isString(content)) return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && isString(block.text))
    .map((block) => block.text)
    .join('\n');
};

// Claude tool_result content -> the OpenCode tool content array the UI reads
// (`toolOutputText` / `toolAttachments` in packages/ui projection.ts). Only
// text is carried in v1; image blocks are dropped until the attachment path
// exists. The wire tuple expects at least one entry, so empty output becomes
// one empty text block.
const toolContent = (content) => {
  const items = [];
  if (isString(content) && content.length > 0) {
    items.push({ type: 'text', text: content });
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block && block.type === 'text' && isString(block.text)) {
        items.push({ type: 'text', text: block.text });
      }
    }
  }
  return items.length > 0 ? items : [{ type: 'text', text: '' }];
};

// A tool call's accumulated `input_json_delta` stream as the input object the
// UI reads. The stream is empty for a tool that takes no input and can be
// partial when the block is cut off, so anything that does not parse to a
// plain object degrades to `{}` instead of failing the call.
const parseToolInput = (json) => {
  if (json.length === 0) return {};
  try {
    const parsed = JSON.parse(json);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

// SDK result -> SessionStructuredError ({ type, message }). The SDK puts a
// human-readable note in `result` when it has one; otherwise the error
// subtype (error_during_execution, error_max_turns, ...) names the failure.
const resultError = (message) => {
  const text = asNonEmptyString(message?.result);
  if (text) return { type: 'error', message: text };
  const subtype =
    isString(message?.subtype) && message.subtype !== 'success' ? message.subtype : null;
  return {
    type: subtype ?? 'error',
    message: subtype ? `Claude Code run failed: ${subtype}` : 'Claude Code run failed',
  };
};

export const createTranslator = ({
  sessionID,
  directory,
  agent = 'claude',
  newMessageId = createMessageId,
  now = Date.now,
}) => {
  let model = DEFAULT_MODEL;
  // Set by the terminal events (a result or abort); later content and results
  // are late SDK messages and map to nothing until the next beginTurn. Starts
  // false so translate() also maps a lone message outside a turn, which is
  // what the lazy assistant-message minting relies on.
  let turnSettled = false;
  let stepOpen = false;
  let assistantMessageID = null;
  let textOrdinal = 0;
  let reasoningOrdinal = 0;
  const blocks = new Map();

  const wire = (type, data) => ({
    id: newMessageId(),
    type,
    created: now(),
    data: { sessionID, ...data },
    location: { directory },
  });

  // Mints the turn's assistant message on first use and returns its
  // `session.step.started`, so no event ever addresses a message the UI has
  // not seen. Empty for every later call in the same turn.
  const ensureStep = () => {
    if (stepOpen) return [];
    assistantMessageID = newMessageId();
    stepOpen = true;
    return [
      wire('session.step.started', {
        assistantMessageID,
        agent,
        model: { providerID: PROVIDER_ID, id: model },
        started: now(),
      }),
    ];
  };

  const translateBlockStart = (event) => {
    const index = event?.index;
    const block = event?.content_block;
    // A block with no string `type` matches none of the branches below, so the
    // index and the block's presence are the only preconditions left.
    if (!Number.isFinite(index) || !block) return [];

    if (block.type === 'text') {
      const events = ensureStep();
      const ordinal = textOrdinal;
      textOrdinal += 1;
      blocks.set(index, { kind: 'text', ordinal, text: '' });
      events.push(wire('session.text.started', { assistantMessageID, ordinal }));
      return events;
    }

    if (block.type === 'thinking') {
      const events = ensureStep();
      const ordinal = reasoningOrdinal;
      reasoningOrdinal += 1;
      blocks.set(index, { kind: 'reasoning', ordinal, text: '' });
      events.push(wire('session.reasoning.started', { assistantMessageID, ordinal }));
      return events;
    }

    if (block.type === 'tool_use' && isString(block.id)) {
      const events = ensureStep();
      const name = isString(block.name) ? block.name : '';
      blocks.set(index, { kind: 'tool_use', id: block.id, name, json: '' });
      events.push(wire('session.tool.input.started', { assistantMessageID, id: block.id, name }));
      return events;
    }

    return [];
  };

  const translateBlockDelta = (event) => {
    const block = blocks.get(event?.index);
    const delta = event?.delta;
    // The exact `delta.type` comparisons below reject a missing or non-string
    // type on their own.
    if (!block || !delta) return [];

    if (delta.type === 'text_delta' && block.kind === 'text' && isString(delta.text)) {
      block.text += delta.text;
      return [wire('session.text.delta', { assistantMessageID, ordinal: block.ordinal, delta: delta.text })];
    }

    if (delta.type === 'thinking_delta' && block.kind === 'reasoning' && isString(delta.thinking)) {
      block.text += delta.thinking;
      return [wire('session.reasoning.delta', { assistantMessageID, ordinal: block.ordinal, delta: delta.thinking })];
    }

    if (delta.type === 'input_json_delta' && block.kind === 'tool_use' && isString(delta.partial_json)) {
      block.json += delta.partial_json;
      return [wire('session.tool.input.delta', { assistantMessageID, id: block.id, delta: delta.partial_json })];
    }

    return [];
  };

  const translateBlockStop = (event) => {
    const block = blocks.get(event?.index);
    if (!block) return [];
    blocks.delete(event.index);

    if (block.kind === 'text') {
      return [wire('session.text.ended', { assistantMessageID, ordinal: block.ordinal, text: block.text })];
    }
    if (block.kind === 'reasoning') {
      return [wire('session.reasoning.ended', { assistantMessageID, ordinal: block.ordinal, text: block.text })];
    }
    // The call follows its input: `input.ended` carries the raw accumulated
    // JSON for the stream, `called` the parsed input for the running card.
    return [
      wire('session.tool.input.ended', { assistantMessageID, id: block.id, text: block.json }),
      wire('session.tool.called', {
        assistantMessageID,
        id: block.id,
        input: parseToolInput(block.json),
        executed: true,
      }),
    ];
  };

  const translateStreamEvent = (message) => {
    if (turnSettled) return [];
    const event = message?.event;
    // Only the three content-block event types below are translated; any other
    // `type` (including a non-string one) takes the default branch.
    if (!event) return [];

    switch (event.type) {
      case 'content_block_start':
        return translateBlockStart(event);
      case 'content_block_delta':
        return translateBlockDelta(event);
      case 'content_block_stop':
        return translateBlockStop(event);
      default:
        return [];
    }
  };

  // The SDK reports tool results as user messages. A tool_result whose tool
  // part was never streamed settles nothing in the UI; includePartialMessages
  // makes the stream authoritative, so that ordering is assumed here.
  const translateToolResults = (message) => {
    if (turnSettled) return [];
    const content = message?.message?.content;
    if (!Array.isArray(content)) return [];

    const events = [];
    for (const block of content) {
      if (!block || block.type !== 'tool_result' || !isString(block.tool_use_id)) continue;
      events.push(...ensureStep());
      const data = {
        assistantMessageID,
        id: block.tool_use_id,
        content: toolContent(block.content),
        executed: true,
      };
      if (block.is_error === true) {
        events.push(
          wire('session.tool.failed', {
            ...data,
            error: { type: 'error', message: contentText(block.content) || 'Tool call failed' },
          }),
        );
      } else {
        events.push(wire('session.tool.success', data));
      }
    }
    return events;
  };

  const translateResult = (message) => {
    if (turnSettled) return [];
    const subtype = isString(message?.subtype) ? message.subtype : null;
    const isSuccess = subtype === 'success' && message?.is_error !== true;
    const isError = message?.is_error === true || (subtype !== null && subtype.startsWith('error'));
    if (!isSuccess && !isError) return [];

    const events = ensureStep();
    const cost = numberOrZero(message?.total_cost_usd);
    const tokens = tokenUsage(message?.usage);

    if (isSuccess) {
      events.push(
        wire('session.step.ended', { assistantMessageID, finish: 'stop', cost, tokens }),
        wire('session.execution.succeeded', {}),
      );
    } else {
      const error = resultError(message);
      events.push(
        wire('session.step.failed', { assistantMessageID, error, cost, tokens }),
        wire('session.execution.failed', { error }),
      );
    }

    turnSettled = true;
    stepOpen = false;
    return events;
  };

  const translate = (message) => {
    // An absent, non-object, or unknown message matches no case below.
    switch (message?.type) {
      case 'stream_event':
        return translateStreamEvent(message);
      case 'user':
        return translateToolResults(message);
      case 'result':
        return translateResult(message);
      default:
        return [];
    }
  };

  const beginTurn = () => {
    turnSettled = false;
    stepOpen = false;
    assistantMessageID = null;
    textOrdinal = 0;
    reasoningOrdinal = 0;
    blocks.clear();
    return [wire('session.execution.started', {})];
  };

  const abort = ({ reason = 'user' } = {}) => {
    const events = [];
    if (stepOpen) {
      stepOpen = false;
      events.push(
        wire('session.step.failed', {
          assistantMessageID,
          error: {
            type: 'aborted',
            message: reason === 'user' ? 'Interrupted by user' : `Interrupted: ${reason}`,
          },
        }),
      );
    }
    turnSettled = true;
    events.push(wire('session.execution.interrupted', { reason }));
    return events;
  };

  // Settles the turn as failed from outside the SDK stream: a transport
  // failure or a generator throw the runner observes. Mirrors translateResult's
  // error path without cost and tokens, which no result message carries here.
  const fail = ({ error }) => {
    if (turnSettled) return [];
    const events = [];
    if (stepOpen) {
      stepOpen = false;
      events.push(wire('session.step.failed', { assistantMessageID, error }));
    }
    turnSettled = true;
    events.push(wire('session.execution.failed', { error }));
    return events;
  };

  const setModel = (modelId) => {
    if (isString(modelId) && modelId.length > 0) model = modelId;
  };

  return { setModel, beginTurn, translate, abort, fail };
};
