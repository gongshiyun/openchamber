// Claude Code transcript: per-session message records built from wire events,
// paged the way `message.list` pages, and persisted as JSONL. The wire shapes
// consumed here are the ones translator.js emits and the UI's projection.ts
// reads; transcript.contract.test.js pins that against the real projection.

import { describe, expect, test } from 'bun:test';

import { createTranscript } from './transcript.js';

const SESSION_ID = 'ses_claude_transcript';
const DIRECTORY = 'D:\\work\\claude';
const FILE_PATH = 'D:\\work\\claude\\sessions\\ses_claude_transcript.jsonl';

const createMemoryFs = () => {
  const files = new Map();
  const directories = [];
  return {
    files,
    directories,
    fsImpl: {
      appendFile: async (filePath, data) => {
        files.set(filePath, (files.get(filePath) ?? '') + data);
      },
      readFile: async (filePath) => {
        if (!files.has(filePath)) {
          const error = new Error(`ENOENT: no such file, open '${filePath}'`);
          error.code = 'ENOENT';
          throw error;
        }
        return files.get(filePath);
      },
      mkdir: async (directory) => {
        directories.push(directory);
      },
    },
  };
};

const createTestTranscript = () => {
  const memory = createMemoryFs();
  const transcript = createTranscript({
    sessionID: SESSION_ID,
    directory: DIRECTORY,
    filePath: FILE_PATH,
    fsImpl: memory.fsImpl,
  });
  return { transcript, memory };
};

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

const ASSISTANT_MODEL = { providerID: 'claude-code', id: 'sonnet' };
const TOOL_INPUT = '{"command":"ls"}';

// One whole assistant turn: step start, a text block, one successful tool
// call, step end. Returns the step events so tests can assert their times.
const driveTurn = (transcript, { userID, userText, assistantID, text, toolID = 'toolu_1', toolName = 'Bash' }) => {
  transcript.beginUserMessage({ text: userText, messageID: userID });
  const started = wire('session.step.started', {
    assistantMessageID: assistantID,
    agent: 'claude',
    model: ASSISTANT_MODEL,
  });
  transcript.applyWireEvent(started);
  transcript.applyWireEvent(wire('session.text.started', { assistantMessageID: assistantID, ordinal: 0 }));
  transcript.applyWireEvent(
    wire('session.text.delta', { assistantMessageID: assistantID, ordinal: 0, delta: text.slice(0, 5) }),
  );
  transcript.applyWireEvent(
    wire('session.text.delta', { assistantMessageID: assistantID, ordinal: 0, delta: text.slice(5) }),
  );
  transcript.applyWireEvent(wire('session.text.ended', { assistantMessageID: assistantID, ordinal: 0, text }));
  transcript.applyWireEvent(
    wire('session.tool.input.started', { assistantMessageID: assistantID, id: toolID, name: toolName }),
  );
  transcript.applyWireEvent(
    wire('session.tool.input.delta', { assistantMessageID: assistantID, id: toolID, delta: TOOL_INPUT.slice(0, 6) }),
  );
  transcript.applyWireEvent(
    wire('session.tool.input.delta', { assistantMessageID: assistantID, id: toolID, delta: TOOL_INPUT.slice(6) }),
  );
  transcript.applyWireEvent(wire('session.tool.input.ended', { assistantMessageID: assistantID, id: toolID, text: TOOL_INPUT }));
  transcript.applyWireEvent(
    wire('session.tool.success', {
      assistantMessageID: assistantID,
      id: toolID,
      content: [{ type: 'text', text: 'a.txt' }],
      executed: true,
    }),
  );
  const ended = wire('session.step.ended', {
    assistantMessageID: assistantID,
    finish: 'stop',
    cost: 0.01,
    tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
  });
  transcript.applyWireEvent(ended);
  return { started, ended };
};

describe('claude-code transcript records', () => {
  test('beginUserMessage creates one user record with a single text part', () => {
    const { transcript } = createTestTranscript();

    transcript.beginUserMessage({ text: 'Hello Claude', messageID: 'msg_user_1' });

    const page = transcript.listRecords({ limit: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.next).toBeUndefined();
    const [record] = page.items;
    expect(record.info.type).toBe('user');
    expect(record.info.id).toBe('msg_user_1');
    expect(record.info.text).toBe('Hello Claude');
    expect(Number.isFinite(record.info.time.created)).toBe(true);
    expect(record.parts).toEqual([{ type: 'text', text: 'Hello Claude' }]);
  });

  test('a full assistant turn builds one record with text and tool parts', () => {
    const { transcript } = createTestTranscript();

    const { ended } = driveTurn(transcript, {
      userID: 'msg_user_1',
      userText: 'List the files.',
      assistantID: 'msg_assistant_1',
      text: 'Let me look.',
    });

    const page = transcript.listRecords({ limit: 10 });
    expect(page.items.map((record) => record.info.id)).toEqual(['msg_assistant_1', 'msg_user_1']);

    const record = page.items[0];
    expect(record.info.type).toBe('assistant');
    expect(record.info.id).toBe('msg_assistant_1');
    expect(record.info.agent).toBe('claude');
    expect(record.info.model).toEqual(ASSISTANT_MODEL);
    expect(Number.isFinite(record.info.time.created)).toBe(true);
    expect(record.info.time.completed).toBe(ended.created);
    expect(record.info.finish).toBe('stop');
    expect(record.info.cost).toBe(0.01);
    expect(record.info.tokens).toEqual({ input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } });

    expect(record.parts).toHaveLength(2);
    expect(record.parts[0]).toEqual({ type: 'text', text: 'Let me look.' });
    const toolPart = record.parts[1];
    expect(toolPart.type).toBe('tool');
    expect(toolPart.id).toBe('toolu_1');
    expect(toolPart.name).toBe('Bash');
    expect(toolPart.executed).toBe(true);
    expect(toolPart.state.status).toBe('completed');
    expect(toolPart.state.input).toEqual({ command: 'ls' });
    expect(toolPart.state.content).toEqual([{ type: 'text', text: 'a.txt' }]);
    expect(Number.isFinite(toolPart.time.created)).toBe(true);
    expect(Number.isFinite(toolPart.time.completed)).toBe(true);
  });

  test('a failed tool and a failed step map to the error wire states', () => {
    const { transcript } = createTestTranscript();

    transcript.beginUserMessage({ text: 'Read it', messageID: 'msg_user_1' });
    transcript.applyWireEvent(
      wire('session.step.started', { assistantMessageID: 'msg_assistant_1', agent: 'claude', model: ASSISTANT_MODEL }),
    );
    transcript.applyWireEvent(
      wire('session.tool.input.started', { assistantMessageID: 'msg_assistant_1', id: 'toolu_b', name: 'Read' }),
    );
    transcript.applyWireEvent(
      wire('session.tool.input.delta', { assistantMessageID: 'msg_assistant_1', id: 'toolu_b', delta: '{"file":"a"}' }),
    );
    transcript.applyWireEvent(
      wire('session.tool.input.ended', { assistantMessageID: 'msg_assistant_1', id: 'toolu_b', text: '{"file":"a"}' }),
    );
    transcript.applyWireEvent(
      wire('session.tool.failed', {
        assistantMessageID: 'msg_assistant_1',
        id: 'toolu_b',
        content: [{ type: 'text', text: 'ENOENT' }],
        executed: true,
        error: { type: 'error', message: 'ENOENT' },
      }),
    );
    const failed = wire('session.step.failed', {
      assistantMessageID: 'msg_assistant_1',
      error: { type: 'error', message: 'Claude Code run failed' },
    });
    transcript.applyWireEvent(failed);

    const [record] = transcript.listRecords({ limit: 10 }).items;
    expect(record.info.finish).toBe('error');
    expect(record.info.error).toEqual({ type: 'error', message: 'Claude Code run failed' });
    expect(record.info.time.completed).toBe(failed.created);
    const toolPart = record.parts.find((part) => part.type === 'tool');
    expect(toolPart.state.status).toBe('error');
    expect(toolPart.state.input).toEqual({ file: 'a' });
    expect(toolPart.state.error).toEqual({ type: 'error', message: 'ENOENT' });
    expect(toolPart.state.content).toEqual([{ type: 'text', text: 'ENOENT' }]);
  });

  test('reasoning and text parts stay separate kinds in stream order', () => {
    const { transcript } = createTestTranscript();

    transcript.applyWireEvent(
      wire('session.step.started', { assistantMessageID: 'msg_assistant_1', agent: 'claude', model: ASSISTANT_MODEL }),
    );
    transcript.applyWireEvent(wire('session.reasoning.started', { assistantMessageID: 'msg_assistant_1', ordinal: 0 }));
    transcript.applyWireEvent(
      wire('session.reasoning.delta', { assistantMessageID: 'msg_assistant_1', ordinal: 0, delta: 'Hmm' }),
    );
    const reasoningEnded = wire('session.reasoning.ended', {
      assistantMessageID: 'msg_assistant_1',
      ordinal: 0,
      text: 'Hmm, let me think.',
    });
    transcript.applyWireEvent(reasoningEnded);
    transcript.applyWireEvent(wire('session.text.started', { assistantMessageID: 'msg_assistant_1', ordinal: 0 }));
    transcript.applyWireEvent(
      wire('session.text.delta', { assistantMessageID: 'msg_assistant_1', ordinal: 0, delta: 'Answer.' }),
    );
    transcript.applyWireEvent(
      wire('session.text.ended', { assistantMessageID: 'msg_assistant_1', ordinal: 0, text: 'Answer.' }),
    );

    const [record] = transcript.listRecords({ limit: 10 }).items;
    expect(record.parts.map((part) => part.type)).toEqual(['reasoning', 'text']);
    expect(record.parts[0].text).toBe('Hmm, let me think.');
    expect(record.parts[0].time.completed).toBe(reasoningEnded.created);
    expect(record.parts[1]).toEqual({ type: 'text', text: 'Answer.' });
  });

  test('events for unknown parts create them lazily and irrelevant events are ignored', () => {
    const { transcript } = createTestTranscript();

    // A late-joined stream: no step.started, no text.started.
    transcript.applyWireEvent(
      wire('session.text.delta', { assistantMessageID: 'msg_assistant_9', ordinal: 0, delta: 'late text' }),
    );
    // Irrelevant event types and foreign sessions must not change the records.
    transcript.applyWireEvent(wire('session.execution.started', {}));
    transcript.applyWireEvent(wire('session.retry.scheduled', { assistantMessageID: 'msg_assistant_9', attempt: 1 }));
    transcript.applyWireEvent({
      id: 'evt_foreign',
      type: 'session.text.delta',
      created: tick(),
      data: { sessionID: 'ses_other', assistantMessageID: 'msg_assistant_9', ordinal: 0, delta: 'foreign' },
      location: { directory: DIRECTORY },
    });

    const page = transcript.listRecords({ limit: 10 });
    expect(page.items).toHaveLength(1);
    const [record] = page.items;
    expect(record.info.type).toBe('assistant');
    expect(record.info.id).toBe('msg_assistant_9');
    expect(record.info.model).toEqual({ providerID: 'claude-code', id: 'default' });
    expect(record.parts).toEqual([{ type: 'text', text: 'late text' }]);
  });

  test('listRecords pages newest first, walks every record exactly once, and drops next on the oldest page', () => {
    const { transcript } = createTestTranscript();
    driveTurn(transcript, { userID: 'msg_user_1', userText: 'first', assistantID: 'msg_assistant_1', text: 'One.' });
    driveTurn(transcript, { userID: 'msg_user_2', userText: 'second', assistantID: 'msg_assistant_2', text: 'Two.' });

    const expected = ['msg_assistant_2', 'msg_user_2', 'msg_assistant_1', 'msg_user_1'];
    const first = transcript.listRecords({ limit: 1 });
    expect(first.items.map((record) => record.info.id)).toEqual(['msg_assistant_2']);
    // `next` names the last record of the page; the next page starts strictly
    // after it, the exclusive cursor of the OpenCode v2 message store.
    expect(first.next).toBe('msg_assistant_2');

    const walked = [];
    let cursor;
    for (let page = 0; page < expected.length; page += 1) {
      const result = transcript.listRecords({ limit: 1, cursor });
      walked.push(...result.items.map((record) => record.info.id));
      cursor = result.next;
    }

    expect(walked).toEqual(expected);
    // The last page is the oldest record; the walk stops there.
    expect(cursor).toBeUndefined();

    // A page that reaches the oldest record carries no next cursor.
    const all = transcript.listRecords({ limit: 10 });
    expect(all.items.map((record) => record.info.id)).toEqual(expected);
    expect(all.next).toBeUndefined();
  });

  test('listRecords supports ascending pages and an unknown cursor yields an empty page', () => {
    const { transcript } = createTestTranscript();
    driveTurn(transcript, { userID: 'msg_user_1', userText: 'first', assistantID: 'msg_assistant_1', text: 'One.' });
    driveTurn(transcript, { userID: 'msg_user_2', userText: 'second', assistantID: 'msg_assistant_2', text: 'Two.' });

    const first = transcript.listRecords({ limit: 2, order: 'asc' });
    expect(first.items.map((record) => record.info.id)).toEqual(['msg_user_1', 'msg_assistant_1']);
    expect(first.next).toBe('msg_assistant_1');

    const second = transcript.listRecords({ limit: 2, cursor: first.next, order: 'asc' });
    expect(second.items.map((record) => record.info.id)).toEqual(['msg_user_2', 'msg_assistant_2']);
    expect(second.next).toBeUndefined();

    expect(transcript.listRecords({ limit: 2, cursor: 'msg_missing' })).toEqual({ items: [], next: undefined });
  });

  test('late tool events do not overwrite a settled tool part', () => {
    const { transcript } = createTestTranscript();

    transcript.applyWireEvent(
      wire('session.step.started', { assistantMessageID: 'msg_assistant_1', agent: 'claude', model: ASSISTANT_MODEL }),
    );
    transcript.applyWireEvent(
      wire('session.tool.input.started', { assistantMessageID: 'msg_assistant_1', id: 'toolu_1', name: 'Bash' }),
    );
    transcript.applyWireEvent(
      wire('session.tool.success', {
        assistantMessageID: 'msg_assistant_1',
        id: 'toolu_1',
        content: [{ type: 'text', text: 'a.txt' }],
        executed: true,
      }),
    );
    // A duplicate or late result must not reopen the settled call.
    transcript.applyWireEvent(
      wire('session.tool.input.delta', { assistantMessageID: 'msg_assistant_1', id: 'toolu_1', delta: 'more' }),
    );
    transcript.applyWireEvent(
      wire('session.tool.failed', {
        assistantMessageID: 'msg_assistant_1',
        id: 'toolu_1',
        executed: true,
        error: { type: 'error', message: 'late' },
      }),
    );

    const [record] = transcript.listRecords({ limit: 10 }).items;
    const toolPart = record.parts[0];
    expect(toolPart.state.status).toBe('completed');
    expect(toolPart.state.content).toEqual([{ type: 'text', text: 'a.txt' }]);
  });

  test('getRecord returns one record by message id and null for unknown ids', () => {
    const { transcript } = createTestTranscript();
    driveTurn(transcript, { userID: 'msg_user_1', userText: 'first', assistantID: 'msg_assistant_1', text: 'One.' });

    const record = transcript.getRecord('msg_assistant_1');
    expect(record.info.id).toBe('msg_assistant_1');
    expect(record.parts).toHaveLength(2);
    expect(transcript.getRecord('msg_unknown')).toBeNull();
  });

  test('flush and load rebuild an identical transcript from the JSONL', async () => {
    const { transcript, memory } = createTestTranscript();
    driveTurn(transcript, { userID: 'msg_user_1', userText: 'first', assistantID: 'msg_assistant_1', text: 'One.' });
    driveTurn(transcript, { userID: 'msg_user_2', userText: 'second', assistantID: 'msg_assistant_2', text: 'Two.' });
    await transcript.flush();

    const reloaded = createTranscript({
      sessionID: SESSION_ID,
      directory: DIRECTORY,
      filePath: FILE_PATH,
      fsImpl: memory.fsImpl,
    });
    await reloaded.load();

    expect(reloaded.listRecords({ limit: 10 })).toEqual(transcript.listRecords({ limit: 10 }));
    expect(reloaded.getRecord('msg_assistant_2')).toEqual(transcript.getRecord('msg_assistant_2'));
  });

  test('load tolerates a torn final line', async () => {
    const { transcript, memory } = createTestTranscript();
    driveTurn(transcript, { userID: 'msg_user_1', userText: 'first', assistantID: 'msg_assistant_1', text: 'One.' });
    await transcript.flush();

    // A crash mid-append leaves a partial line without a trailing newline.
    memory.files.set(FILE_PATH, `${memory.files.get(FILE_PATH)}{"kind":"assistant","op":"pa`);

    const reloaded = createTranscript({
      sessionID: SESSION_ID,
      directory: DIRECTORY,
      filePath: FILE_PATH,
      fsImpl: memory.fsImpl,
    });
    await reloaded.load();
    expect(reloaded.listRecords({ limit: 10 })).toEqual(transcript.listRecords({ limit: 10 }));
  });

  test('load throws a malformed error for a corrupt line before the end', async () => {
    const { transcript, memory } = createTestTranscript();
    driveTurn(transcript, { userID: 'msg_user_1', userText: 'first', assistantID: 'msg_assistant_1', text: 'One.' });
    await transcript.flush();

    const lines = memory.files.get(FILE_PATH).split('\n');
    lines.splice(1, 0, 'not json');
    memory.files.set(FILE_PATH, lines.join('\n'));

    const reloaded = createTranscript({
      sessionID: SESSION_ID,
      directory: DIRECTORY,
      filePath: FILE_PATH,
      fsImpl: memory.fsImpl,
    });
    let caught = null;
    try {
      await reloaded.load();
    } catch (error) {
      caught = error;
    }
    expect(caught?.malformed).toBe(2);
  });

  test('load on a missing file starts empty', async () => {
    const { transcript } = createTestTranscript();
    await transcript.load();
    expect(transcript.listRecords({ limit: 10 })).toEqual({ items: [], next: undefined });
  });
});
