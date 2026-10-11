/**
 * Claude Code per-session transcript: wire message records plus JSONL persistence.
 *
 * The Claude backend feeds the same durable event log shape OpenCode v2
 * publishes, so a Claude session's history must answer `message.list` with the
 * wire records the UI projects (`projectMessages` in packages/ui/src/lib/
 * opencode/projection.ts). This module owns that history: it turns the wire
 * events translator.js emits into wire message records (`info`) with their
 * ordered content items (`parts`), pages them the way the OpenCode v2 store
 * does, and appends every change to one JSONL file so a restart can rebuild
 * the session without the claude process.
 *
 * Wire fidelity (the shapes are pinned by transcript.contract.test.js):
 *   user      { id, type: 'user', time: { created }, text }
 *   synthetic { id, type: 'synthetic', time: { created }, text, description?,
 *               metadata? }
 *   assistant { id, type: 'assistant', time: { created, completed? }, agent,
 *               model: { providerID, id, variant? }, content: [items] }
 *   text      { type: 'text', text }
 *   reasoning { type: 'reasoning', text, time? }
 *   tool      { type: 'tool', id, name, executed?, state, time }
 *   tool state.status: 'streaming' | 'running' | 'completed' | 'error'
 * `parts` is the same ordered content list as `info.content`; both address
 * text/reasoning items by `(messageID, ordinal)` and tools by their call id,
 * mirroring `partIds` in packages/ui/src/lib/opencode/model.ts. A tool that
 * settles directly from streaming (the Claude SDK reports results without a
 * separate called event) carries its accumulated JSON input parsed into the
 * settled state, which is what `projectToolPart` reads.
 *
 * Pagination mirrors OpenCode v2's `SessionStore.messages`: records stay in
 * creation order; `order: 'desc'` (default) is newest first; `cursor` is a
 * message id and the page starts strictly AFTER it, so `next` is the last
 * record of the page when more records remain in the walk direction and
 * undefined otherwise. A cursor naming no record yields an empty page, like
 * upstream. A page with no `next` holds the last record in that direction,
 * which is the client's `complete` signal.
 *
 * Persistence is append-only JSONL, one op per line:
 *   { kind: 'user',      op: 'create', messageID, created, text }
 *   { kind: 'synthetic', op: 'create', messageID, created, text, description?, metadata? }
 *   { kind: 'assistant', op: 'create', messageID, created, agent?, model }
 *   { kind: 'assistant', op: 'patch',  messageID, patch: { time, finish, ... } }
 *   { kind: 'assistant', op: 'part',   messageID, partID, part }
 *   { kind: 'assistant', op: 'delta',  messageID, partID, field, delta }
 * `load()` replaces the in-memory records with a replay of the lines (same
 * code path as the live state), so it belongs before any event is applied. A
 * malformed line that is the last line is treated as a torn append from a
 * crash and ignored; a malformed line before it throws an Error with
 * `malformed` set to the 1-based line number. `close()` stops accepting new
 * records; `flush()` still drains what is already queued.
 *
 * Unknown or irrelevant wire events, foreign sessions, and events for parts
 * that were never started are tolerated: missing parts are created lazily, and
 * nothing else changes the records.
 */

import fsPromisesDefault from 'node:fs/promises';
import pathDefault from 'node:path';

import { isPlainObject, isRecord, isString } from '../shared/guards.js';

// Mirrors `partIds` in packages/ui/src/lib/opencode/model.ts: text and
// reasoning items are addressed by (messageID, ordinal), tools by call id.
const textPartId = (messageID, ordinal) => `${messageID}:text:${ordinal}`;
const reasoningPartId = (messageID, ordinal) => `${messageID}:reasoning:${ordinal}`;

// A record created from a late-joined stream has no step.started to copy from;
// this mirrors translator.js's provider id and default model alias so the
// record still projects.
const FALLBACK_MODEL = { providerID: 'claude-code', id: 'default' };

const DEFAULT_LIMIT = 50;

const isFinalToolStatus = (status) => status === 'completed' || status === 'error';

const modelFrom = (model) => {
  const result = {
    providerID: isString(model?.providerID) ? model.providerID : FALLBACK_MODEL.providerID,
    id: isString(model?.id) ? model.id : FALLBACK_MODEL.id,
  };
  if (isString(model?.variant)) result.variant = model.variant;
  return result;
};

/** Drops undefined fields so a persisted patch carries only what changed. */
const compactPatch = (patch) => {
  const result = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
};

/** The accumulated streaming JSON input of a tool part, parsed for the settled state. */
const parseToolInput = (part) => {
  const raw = isString(part?.state?.input) ? part.state.input : '';
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

export const createTranscript = ({ sessionID, directory, filePath, fsImpl = fsPromisesDefault }) => {
  /** Creation-ordered records: `{ info, parts }`, assistant `parts === info.content`. */
  const records = [];
  const recordByID = new Map();
  /** messageID -> Map(partID -> wire part item), the addressable parts of each message. */
  const partsByID = new Map();

  let closed = false;

  // -------------------------------------------------------------------------
  // JSONL persistence
  // -------------------------------------------------------------------------

  let pendingLines = [];
  let drainPromise = null;
  let lastWriteError = null;
  let directoryReady = null;

  const ensureDirectory = () => {
    if (!directoryReady) directoryReady = fsImpl.mkdir(pathDefault.dirname(filePath), { recursive: true });
    return directoryReady;
  };

  const writePending = async () => {
    try {
      await ensureDirectory();
    } catch (error) {
      // Do not memoize a failed mkdir: the next flush retries it.
      directoryReady = null;
      lastWriteError = error;
      return;
    }
    while (pendingLines.length > 0) {
      const batch = pendingLines;
      pendingLines = [];
      try {
        await fsImpl.appendFile(filePath, batch.join(''));
      } catch (error) {
        pendingLines = [...batch, ...pendingLines];
        lastWriteError = error;
        return;
      }
    }
    lastWriteError = null;
  };

  const scheduleDrain = () => {
    if (drainPromise || lastWriteError) return;
    drainPromise = writePending().finally(() => {
      drainPromise = null;
      if (pendingLines.length > 0 && !lastWriteError) scheduleDrain();
    });
  };

  const enqueue = (op) => {
    pendingLines.push(`${JSON.stringify(op)}\n`);
    scheduleDrain();
  };

  const flush = async () => {
    // An explicit flush is also the retry after a failed append.
    lastWriteError = null;
    while (pendingLines.length > 0 || drainPromise) {
      if (!drainPromise) scheduleDrain();
      await drainPromise;
      if (lastWriteError) {
        const error = lastWriteError;
        lastWriteError = null;
        throw error;
      }
    }
  };

  // -------------------------------------------------------------------------
  // Record state
  // -------------------------------------------------------------------------

  const findPart = (messageID, partID) => partsByID.get(messageID)?.get(partID);

  const registerPart = (record, partID, part) => {
    record.parts.push(part);
    let index = partsByID.get(record.info.id);
    if (!index) {
      index = new Map();
      partsByID.set(record.info.id, index);
    }
    index.set(partID, part);
  };

  const applyCreate = (op) => {
    if (!isString(op.messageID) || recordByID.has(op.messageID)) return;
    const created = Number.isFinite(op.created) ? op.created : Date.now();
    if (op.kind === 'user') {
      const text = isString(op.text) ? op.text : '';
      const info = { id: op.messageID, type: 'user', time: { created }, text };
      records.push({ info, parts: [{ type: 'text', text }] });
    } else if (op.kind === 'synthetic') {
      // The UI projects this record as a context block of its own; it carries
      // no parts and never changes after creation.
      const info = { id: op.messageID, type: 'synthetic', time: { created }, text: isString(op.text) ? op.text : '' };
      if (isString(op.description)) info.description = op.description;
      if (isPlainObject(op.metadata)) info.metadata = op.metadata;
      records.push({ info, parts: [] });
    } else {
      const info = {
        id: op.messageID,
        type: 'assistant',
        time: { created },
        model: modelFrom(op.model),
        content: [],
      };
      if (isString(op.agent)) info.agent = op.agent;
      records.push({ info, parts: info.content });
    }
    recordByID.set(op.messageID, records[records.length - 1]);
  };

  const applyPatch = (op) => {
    const record = recordByID.get(op.messageID);
    if (!record) return;
    const { info } = record;
    if (op.patch.time) info.time = { ...info.time, ...op.patch.time };
    if (op.patch.finish !== undefined) info.finish = op.patch.finish;
    if (op.patch.cost !== undefined) info.cost = op.patch.cost;
    if (op.patch.tokens !== undefined) info.tokens = op.patch.tokens;
    if (op.patch.error !== undefined) info.error = op.patch.error;
    if (op.patch.snapshot !== undefined) info.snapshot = op.patch.snapshot;
  };

  const applyPart = (op) => {
    const record = recordByID.get(op.messageID);
    if (!record || record.info.type !== 'assistant') return;
    const existing = findPart(op.messageID, op.partID);
    if (existing) {
      Object.assign(existing, op.part);
      return;
    }
    registerPart(record, op.partID, op.part);
  };

  const applyDelta = (op) => {
    const part = findPart(op.messageID, op.partID);
    if (!part) return;
    // `field` names the kind the delta belongs to: text/reasoning parts carry
    // `text`, tool parts carry `state.input`, so the branch alone decides.
    if (op.field === 'text') part.text += op.delta;
    if (op.field === 'input') part.state.input += op.delta;
  };

  const applyOp = (op) => {
    if (!isRecord(op)) return;
    switch (op.op) {
      case 'create':
        applyCreate(op);
        break;
      case 'patch':
        applyPatch(op);
        break;
      case 'part':
        applyPart(op);
        break;
      case 'delta':
        applyDelta(op);
        break;
      default:
        // An op from a newer format: unknown, not fatal.
        break;
    }
  };

  // -------------------------------------------------------------------------
  // Wire events -> ops
  // -------------------------------------------------------------------------

  const eventCreated = (event) => (Number.isFinite(event?.created) ? event.created : Date.now());

  const assistantCreateOp = (messageID, created, data) => {
    const op = {
      kind: 'assistant',
      op: 'create',
      messageID,
      created,
      model: data?.model,
    };
    if (isString(data?.agent)) op.agent = data.agent;
    return op;
  };

  const partOp = (messageID, partID, part) => ({ kind: 'assistant', op: 'part', messageID, partID, part });
  const deltaOp = (messageID, partID, field, delta) => ({
    kind: 'assistant',
    op: 'delta',
    messageID,
    partID,
    field,
    delta,
  });

  /**
   * Ops that rebuild this event's change, or [] for anything irrelevant. A
   * content event for a message the transcript has not seen yet carries its
   * own assistant create op first, so replay always has the record.
   */
  const wireOps = (event) => {
    const type = event?.type;
    const data = event?.data ?? {};
    // Every wire event names its session; anything else is not this one's.
    if (data.sessionID !== sessionID) return [];
    const created = eventCreated(event);
    const messageID = data.assistantMessageID;
    const createIfMissing = () => (recordByID.has(messageID) ? [] : [assistantCreateOp(messageID, created, data)]);

    switch (type) {
      case 'session.step.started': {
        if (!isString(messageID) || recordByID.has(messageID)) return [];
        return [assistantCreateOp(messageID, created, data)];
      }
      case 'session.step.ended':
        if (!isString(messageID)) return [];
        return [
          {
            kind: 'assistant',
            op: 'patch',
            messageID,
            patch: compactPatch({
              time: { completed: created },
              finish: data.finish,
              cost: data.cost,
              tokens: data.tokens,
            }),
          },
        ];
      case 'session.step.failed':
        if (!isString(messageID)) return [];
        return [
          {
            kind: 'assistant',
            op: 'patch',
            messageID,
            patch: compactPatch({
              time: { completed: created },
              finish: data.finish ?? 'error',
              error: data.error,
              cost: data.cost,
              tokens: data.tokens,
            }),
          },
        ];

      case 'session.text.started':
      case 'session.reasoning.started': {
        const ordinal = data.ordinal;
        if (!isString(messageID) || !Number.isInteger(ordinal) || ordinal < 0) return [];
        const reasoning = type === 'session.reasoning.started';
        const partID = reasoning ? reasoningPartId(messageID, ordinal) : textPartId(messageID, ordinal);
        const ops = createIfMissing();
        if (!findPart(messageID, partID)) {
          ops.push(
            partOp(
              messageID,
              partID,
              reasoning ? { type: 'reasoning', text: '', time: { created } } : { type: 'text', text: '' },
            ),
          );
        }
        return ops;
      }

      case 'session.text.delta':
      case 'session.reasoning.delta': {
        const ordinal = data.ordinal;
        if (!isString(messageID) || !Number.isInteger(ordinal) || !isString(data.delta)) return [];
        const reasoning = type === 'session.reasoning.delta';
        const partID = reasoning ? reasoningPartId(messageID, ordinal) : textPartId(messageID, ordinal);
        const ops = createIfMissing();
        if (!findPart(messageID, partID)) {
          ops.push(
            partOp(
              messageID,
              partID,
              reasoning ? { type: 'reasoning', text: '', time: { created } } : { type: 'text', text: '' },
            ),
          );
        }
        ops.push(deltaOp(messageID, partID, 'text', data.delta));
        return ops;
      }

      case 'session.text.ended':
      case 'session.reasoning.ended': {
        const ordinal = data.ordinal;
        if (!isString(messageID) || !Number.isInteger(ordinal) || !isString(data.text)) return [];
        const reasoning = type === 'session.reasoning.ended';
        const partID = reasoning ? reasoningPartId(messageID, ordinal) : textPartId(messageID, ordinal);
        const ops = createIfMissing();
        const existing = findPart(messageID, partID);
        ops.push(
          partOp(
            messageID,
            partID,
            reasoning
              ? { type: 'reasoning', text: data.text, time: { created: existing?.time?.created ?? created, completed: created } }
              : { type: 'text', text: data.text },
          ),
        );
        return ops;
      }

      case 'session.tool.input.started': {
        if (!isString(messageID) || !isString(data.id)) return [];
        const ops = createIfMissing();
        if (!findPart(messageID, data.id)) {
          ops.push(
            partOp(messageID, data.id, {
              type: 'tool',
              id: data.id,
              name: isString(data.name) ? data.name : '',
              state: { status: 'streaming', input: '' },
              time: { created },
            }),
          );
        }
        return ops;
      }

      case 'session.tool.input.delta': {
        if (!isString(messageID) || !isString(data.id) || !isString(data.delta)) return [];
        const existing = findPart(messageID, data.id);
        if (existing && isFinalToolStatus(existing.state?.status)) return [];
        const ops = createIfMissing();
        if (!existing) {
          ops.push(
            partOp(messageID, data.id, {
              type: 'tool',
              id: data.id,
              name: '',
              state: { status: 'streaming', input: '' },
              time: { created },
            }),
          );
        }
        ops.push(deltaOp(messageID, data.id, 'input', data.delta));
        return ops;
      }

      case 'session.tool.input.ended': {
        if (!isString(messageID) || !isString(data.id)) return [];
        const existing = findPart(messageID, data.id);
        if (existing && isFinalToolStatus(existing.state?.status)) return [];
        const ops = createIfMissing();
        const accumulated = existing?.state?.input ?? '';
        ops.push(
          partOp(messageID, data.id, {
            type: 'tool',
            id: data.id,
            name: existing?.name ?? '',
            state: { status: 'streaming', input: data.text ?? accumulated },
            time: { ...(existing?.time ?? { created }) },
          }),
        );
        return ops;
      }

      case 'session.tool.success':
      case 'session.tool.failed': {
        if (!isString(messageID) || !isString(data.id)) return [];
        const existing = findPart(messageID, data.id);
        if (existing && isFinalToolStatus(existing.state?.status)) return [];
        const ops = createIfMissing();
        const input = parseToolInput(existing);
        const baseTime = existing?.time ?? { created };
        const state =
          type === 'session.tool.success'
            ? compactPatch({ status: 'completed', input, content: data.content, metadata: data.metadata })
            : compactPatch({
                status: 'error',
                input,
                error: data.error ?? { type: 'error', message: '' },
                content: data.content,
                metadata: data.metadata,
              });
        const part = {
          type: 'tool',
          id: data.id,
          name: existing?.name ?? '',
          state,
          time: { ...baseTime, completed: created },
        };
        if (data.executed !== undefined) part.executed = data.executed;
        ops.push(partOp(messageID, data.id, part));
        return ops;
      }

      default:
        return [];
    }
  };

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  const beginUserMessage = ({ text, messageID } = {}) => {
    if (closed || !isString(messageID) || recordByID.has(messageID)) return;
    const op = {
      kind: 'user',
      op: 'create',
      messageID,
      created: Date.now(),
      text: isString(text) ? text : '',
    };
    applyOp(op);
    enqueue(op);
  };

  /**
   * One synthetic context message: the wire record the UI renders as a context
   * block ahead of the turn that carries it. Like a user message it never
   * changes after creation; unlike one it has no parts.
   */
  const beginSyntheticMessage = ({ text, messageID, description, metadata } = {}) => {
    if (closed || !isString(messageID) || recordByID.has(messageID)) return;
    const op = {
      kind: 'synthetic',
      op: 'create',
      messageID,
      created: Date.now(),
      text: isString(text) ? text : '',
    };
    if (isString(description)) op.description = description;
    if (isPlainObject(metadata)) op.metadata = metadata;
    applyOp(op);
    enqueue(op);
  };

  const applyWireEvent = (event) => {
    if (closed) return;
    for (const op of wireOps(event)) {
      applyOp(op);
      enqueue(op);
    }
  };

  /**
   * One page of records. `cursor` is a message id the page starts strictly
   * after, in the direction `order` walks; `next` is the cursor for the next
   * page and is undefined once the oldest (or newest) record is on the page.
   */
  const listRecords = ({ limit, cursor, order } = {}) => {
    const size = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
    const hasCursor = isString(cursor) && cursor.length > 0;
    const cursorIndex = hasCursor ? records.findIndex((record) => record.info.id === cursor) : -1;
    if (hasCursor && cursorIndex < 0) return { items: [], next: undefined };
    if (order === 'asc') {
      const candidates = records.slice(hasCursor ? cursorIndex + 1 : 0);
      const items = candidates.slice(0, size);
      return { items, next: candidates.length > size ? items[items.length - 1].info.id : undefined };
    }
    const candidates = records.slice(0, hasCursor ? cursorIndex : records.length);
    const items = candidates.slice(-size).reverse();
    return { items, next: candidates.length > size ? items[items.length - 1].info.id : undefined };
  };

  const getRecord = (messageID) => recordByID.get(messageID) ?? null;

  const load = async () => {
    let content = '';
    try {
      content = await fsImpl.readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const ops = [];
    const lines = content.split('\n');
    let lastNonEmpty = -1;
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].trim().length > 0) lastNonEmpty = index;
    }
    for (let index = 0; index <= lastNonEmpty; index += 1) {
      const line = lines[index];
      if (line.trim().length === 0) continue;
      try {
        ops.push(JSON.parse(line));
      } catch {
        // A torn final line is a crash mid-append, not corruption.
        if (index === lastNonEmpty) break;
        const error = new Error(
          `Claude transcript for session ${sessionID} (${directory}): malformed JSONL at ${filePath} line ${index + 1}`,
        );
        error.malformed = index + 1;
        throw error;
      }
    }
    records.length = 0;
    recordByID.clear();
    partsByID.clear();
    for (const op of ops) applyOp(op);
  };

  const close = () => {
    closed = true;
  };

  return { beginUserMessage, beginSyntheticMessage, applyWireEvent, listRecords, getRecord, flush, load, close };
};
