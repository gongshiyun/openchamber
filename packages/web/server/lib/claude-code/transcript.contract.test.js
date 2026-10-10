// Shape contract: every record the transcript stores must survive the UI's own
// wire -> domain projection (`projectMessages`), the exact function the
// OpenChamber client runs on every `message.list` response
// (packages/ui/src/lib/opencode/client.ts). A drifted message or part shape
// makes a Claude session's chat throw or render empty; this test fails here,
// in the server package, instead.
//
// `listRecords` returns `{ info, parts }` records - the record shape
// `client.ts` produces - so the projection consumes the wire message inside
// each record (`record.info`); `record.parts` is the same content list in wire
// form. The UI module is TypeScript and runs directly under vitest, following
// the relay cross-compat precedent
// (packages/web/server/lib/relay/cross-compat.test.js).

import { describe, expect, test } from 'bun:test';

import { projectMessages } from '../../../../ui/src/lib/opencode/projection.ts';
import { createTranscript } from './transcript.js';

const SESSION_ID = 'ses_claude_contract';
const DIRECTORY = 'D:\\work\\claude';
const FILE_PATH = 'D:\\work\\claude\\sessions\\ses_claude_contract.jsonl';

const createTestTranscript = () =>
  createTranscript({
    sessionID: SESSION_ID,
    directory: DIRECTORY,
    filePath: FILE_PATH,
    fsImpl: {
      appendFile: async () => {},
      readFile: async () => {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      },
      mkdir: async () => {},
    },
  });

let clock = 1_700_000_000_000;
const tick = () => {
  clock += 1;
  return clock;
};

const wire = (type, data) => ({
  id: `evt_${type}`,
  type,
  created: tick(),
  data: { sessionID: SESSION_ID, ...data },
  location: { directory: DIRECTORY },
});

const ASSISTANT_ID = 'msg_assistant_contract';
const ASSISTANT_MODEL = { providerID: 'claude-code', id: 'sonnet' };

const projectRecords = (transcript) =>
  projectMessages(
    transcript.listRecords({ limit: 10 }).items.map((record) => record.info),
    SESSION_ID,
  );

describe('Claude transcript -> UI message projection contract', () => {
  test('a whole turn projects to domain messages with text and tool parts', () => {
    const transcript = createTestTranscript();

    transcript.beginUserMessage({ text: 'List the files.', messageID: 'msg_user_contract' });
    transcript.applyWireEvent(
      wire('session.step.started', { assistantMessageID: ASSISTANT_ID, agent: 'claude', model: ASSISTANT_MODEL }),
    );
    transcript.applyWireEvent(wire('session.text.started', { assistantMessageID: ASSISTANT_ID, ordinal: 0 }));
    transcript.applyWireEvent(
      wire('session.text.delta', { assistantMessageID: ASSISTANT_ID, ordinal: 0, delta: 'Let me ' }),
    );
    transcript.applyWireEvent(
      wire('session.text.delta', { assistantMessageID: ASSISTANT_ID, ordinal: 0, delta: 'look.' }),
    );
    transcript.applyWireEvent(
      wire('session.text.ended', { assistantMessageID: ASSISTANT_ID, ordinal: 0, text: 'Let me look.' }),
    );
    transcript.applyWireEvent(
      wire('session.tool.input.started', { assistantMessageID: ASSISTANT_ID, id: 'toolu_contract', name: 'Bash' }),
    );
    transcript.applyWireEvent(
      wire('session.tool.input.delta', {
        assistantMessageID: ASSISTANT_ID,
        id: 'toolu_contract',
        delta: '{"command":"ls"}',
      }),
    );
    transcript.applyWireEvent(
      wire('session.tool.input.ended', {
        assistantMessageID: ASSISTANT_ID,
        id: 'toolu_contract',
        text: '{"command":"ls"}',
      }),
    );
    transcript.applyWireEvent(
      wire('session.tool.success', {
        assistantMessageID: ASSISTANT_ID,
        id: 'toolu_contract',
        content: [{ type: 'text', text: 'a.txt' }],
        executed: true,
      }),
    );
    const ended = wire('session.step.ended', {
      assistantMessageID: ASSISTANT_ID,
      finish: 'stop',
      cost: 0.02,
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    transcript.applyWireEvent(ended);

    const records = transcript.listRecords({ limit: 10 }).items;
    const projected = projectRecords(transcript);

    expect(projected).toHaveLength(records.length);

    const user = projected.find(({ message }) => message.role === 'user');
    expect(user.parts.map((part) => part.type)).toEqual(['text']);
    expect(user.parts[0].text).toBe('List the files.');

    const assistant = projected.find(({ message }) => message.role === 'assistant');
    expect(assistant.message.providerID).toBe('claude-code');
    expect(assistant.message.modelID).toBe('sonnet');
    expect(assistant.message.time.completed).toBe(ended.created);
    expect(assistant.parts.map((part) => part.type)).toEqual(['text', 'tool']);
    expect(assistant.parts[0].text).toBe('Let me look.');

    const toolPart = assistant.parts[1];
    expect(toolPart.callID).toBe('toolu_contract');
    expect(toolPart.tool).toBe('Bash');
    expect(toolPart.state.status).toBe('completed');
    expect(toolPart.state.input).toEqual({ command: 'ls' });
    expect(toolPart.state.output).toBe('a.txt');
  });

  test('a streaming tool part projects to the pending domain state with raw input', () => {
    const transcript = createTestTranscript();

    transcript.applyWireEvent(
      wire('session.step.started', { assistantMessageID: ASSISTANT_ID, agent: 'claude', model: ASSISTANT_MODEL }),
    );
    transcript.applyWireEvent(
      wire('session.tool.input.started', { assistantMessageID: ASSISTANT_ID, id: 'toolu_stream', name: 'Bash' }),
    );
    transcript.applyWireEvent(
      wire('session.tool.input.delta', {
        assistantMessageID: ASSISTANT_ID,
        id: 'toolu_stream',
        delta: '{"command":"ls"}',
      }),
    );
    transcript.applyWireEvent(
      wire('session.tool.input.ended', {
        assistantMessageID: ASSISTANT_ID,
        id: 'toolu_stream',
        text: '{"command":"ls"}',
      }),
    );

    const assistant = projectRecords(transcript).find(({ message }) => message.role === 'assistant');
    const toolPart = assistant.parts.find((part) => part.type === 'tool');
    expect(toolPart.state.status).toBe('pending');
    expect(toolPart.state.raw).toBe('{"command":"ls"}');
  });

  test('a failed tool projects to the error domain state', () => {
    const transcript = createTestTranscript();

    transcript.applyWireEvent(
      wire('session.step.started', { assistantMessageID: ASSISTANT_ID, agent: 'claude', model: ASSISTANT_MODEL }),
    );
    transcript.applyWireEvent(
      wire('session.tool.input.started', { assistantMessageID: ASSISTANT_ID, id: 'toolu_error', name: 'Read' }),
    );
    transcript.applyWireEvent(
      wire('session.tool.failed', {
        assistantMessageID: ASSISTANT_ID,
        id: 'toolu_error',
        content: [{ type: 'text', text: 'ENOENT' }],
        executed: true,
        error: { type: 'error', message: 'ENOENT: no such file' },
      }),
    );

    const assistant = projectRecords(transcript).find(({ message }) => message.role === 'assistant');
    const toolPart = assistant.parts.find((part) => part.type === 'tool');
    expect(toolPart.state.status).toBe('error');
    expect(toolPart.state.error).toBe('ENOENT: no such file');
    expect(toolPart.state.output).toBe('ENOENT');
  });
});
