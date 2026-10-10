import { describe, expect, test } from 'vitest';
import { createMessageId, createSessionId } from './ids.js';

// The server mints claude-code session and message ids itself. They have to
// look exactly like OpenCode's: the UI special-cases the `ses_` prefix, and
// OpenCode sorts ids by the 6-byte big-endian time/counter prefix, so a wrong
// shape here breaks ordering instead of failing loudly.
const ID_PATTERN = /^(ses|msg)_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

const timePrefix = (id) => Number.parseInt(id.slice(4, 16), 16);

describe('claude-code ids', () => {
  test('session ids carry the ses_ prefix in OpenCode format', () => {
    const id = createSessionId();

    expect(id).toMatch(ID_PATTERN);
    expect(id.startsWith('ses_')).toBe(true);
  });

  test('message ids carry the msg_ prefix in the same format', () => {
    const id = createMessageId();

    expect(id).toMatch(ID_PATTERN);
    expect(id.startsWith('msg_')).toBe(true);
  });

  test('200 generated session ids are unique', () => {
    const ids = new Set();
    for (let index = 0; index < 200; index += 1) ids.add(createSessionId());

    expect(ids.size).toBe(200);
  });

  test('the 12-hex time prefix is non-decreasing across consecutive calls', () => {
    let previous = 0;
    for (let index = 0; index < 200; index += 1) {
      const current = timePrefix(createSessionId());

      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });
});
