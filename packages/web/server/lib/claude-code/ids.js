// Server-side claude-code id minting in OpenCode's own format.
// JS mirror of packages/ui/src/lib/opencode/ids.ts — the web server is plain
// JS and cannot import from packages/ui (same precedent as relay/e2ee.js), so
// the algorithm is reimplemented here and MUST stay compatible: the UI
// special-cases the `ses_` prefix, and OpenCode sorts ids by the 6-byte
// big-endian time/counter prefix.

const ID_RANDOM_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ID_RANDOM_LENGTH = 14;
const ID_TIME_BYTES = 6;
// The low 12 bits after the millisecond timestamp act as a per-millisecond
// counter, so ids minted within the same millisecond still sort in
// creation order.
const ID_COUNTER_SCALE = 0x1000n;

let lastIdTimestamp = 0;
let idCounter = 0;

const randomBase62 = (length) => {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);

  let result = '';
  for (let index = 0; index < length; index += 1) {
    result += ID_RANDOM_CHARS[bytes[index] % ID_RANDOM_CHARS.length];
  }
  return result;
};

const ascendingId = (prefix) => {
  const timestamp = Date.now();
  if (timestamp !== lastIdTimestamp) {
    lastIdTimestamp = timestamp;
    idCounter = 0;
  }
  idCounter += 1;

  const sortable = BigInt(timestamp) * ID_COUNTER_SCALE + BigInt(idCounter);
  const timeBytes = new Uint8Array(ID_TIME_BYTES);
  for (let index = 0; index < ID_TIME_BYTES; index += 1) {
    timeBytes[index] = Number((sortable >> BigInt(8 * (ID_TIME_BYTES - 1 - index))) & 0xffn);
  }
  const hex = Array.from(timeBytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${hex}${randomBase62(ID_RANDOM_LENGTH)}`;
};

/** Time-sortable session id (`ses_` + 12 time/counter hex + 14 random base62). */
export const createSessionId = () => ascendingId('ses');

/** Time-sortable message id (`msg_` + 12 time/counter hex + 14 random base62). */
export const createMessageId = () => ascendingId('msg');
