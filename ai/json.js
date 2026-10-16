// Provider output is one bounded JSON value. JSON.parse alone hides duplicate keys.
export const MAX_DRAFT_BYTES = 256 * 1024;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);

export function parseDraftJSON(input) {
  if (typeof input !== 'string') {
    // Accept editor-owned objects as well, but never execute getters or toJSON hooks.
    const seen = new Set();
    let nodes = 0;
    function copy(value, depth) {
      if (depth > 32 || ++nodes > 40000) throw new Error('Draft JSON is too complex.');
      if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (!value || typeof value !== 'object') throw new Error('Draft must contain only finite JSON values.');
      if (seen.has(value)) throw new Error('Draft JSON cannot contain cycles.');
      const array = Array.isArray(value);
      if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Draft must contain plain JSON objects.');
      if (Reflect.ownKeys(value).some(key => typeof key !== 'string')) throw new Error('Draft JSON cannot contain symbol keys.');
      seen.add(value);
      const result = array ? [] : {};
      for (const key of Object.getOwnPropertyNames(value)) {
        if (array && key === 'length') continue;
        if (RESERVED.has(key)) throw new Error('Draft JSON contains a reserved property.');
        if (array && !/^(0|[1-9][0-9]*)$/.test(key)) throw new Error('Draft arrays cannot contain named properties.');
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('Draft must contain plain JSON properties.');
        result[key] = copy(descriptor.value, depth + 1);
      }
      if (array && (value.length > 40000 || Object.keys(value).length !== value.length)) throw new Error('Draft arrays cannot contain holes.');
      seen.delete(value);
      return result;
    }
    input = JSON.stringify(copy(input, 0));
  }
  if (new TextEncoder().encode(input).length > MAX_DRAFT_BYTES) throw new Error('Draft exceeds the 256 KiB response limit.');
  let offset = 0, nodes = 0;
  const fail = () => { throw new Error('Draft must be one complete valid JSON value.'); };
  const space = () => { while (/[\x20\t\n\r]/.test(input[offset] || '\0')) offset++; };
  function string() {
    const start = offset++;
    while (offset < input.length) {
      const char = input[offset++];
      if (char === '"') {
        try { return JSON.parse(input.slice(start, offset)); } catch { fail(); }
      }
      if (char === '\\') offset++;
    }
    fail();
  }
  function value(depth) {
    if (depth > 32 || ++nodes > 40000) throw new Error('Draft JSON is too complex.');
    space();
    const char = input[offset];
    if (char === '"') return string();
    if (char === '{') {
      offset++; space();
      const object = {}, keys = new Set();
      if (input[offset] === '}') { offset++; return object; }
      while (offset < input.length) {
        if (input[offset] !== '"') fail();
        const key = string();
        if (keys.has(key)) throw new Error('Draft JSON contains a duplicate property.');
        if (RESERVED.has(key)) throw new Error('Draft JSON contains a reserved property.');
        keys.add(key); space();
        if (input[offset++] !== ':') fail();
        object[key] = value(depth + 1); space();
        if (input[offset] === '}') { offset++; return object; }
        if (input[offset++] !== ',') fail();
        space();
      }
      fail();
    }
    if (char === '[') {
      offset++; space();
      const array = [];
      if (input[offset] === ']') { offset++; return array; }
      while (offset < input.length) {
        array.push(value(depth + 1)); space();
        if (input[offset] === ']') { offset++; return array; }
        if (input[offset++] !== ',') fail();
      }
      fail();
    }
    for (const [token, result] of [['true', true], ['false', false], ['null', null]]) {
      if (input.startsWith(token, offset)) { offset += token.length; return result; }
    }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(input.slice(offset));
    if (!match) fail();
    offset += match[0].length;
    const number = Number(match[0]);
    if (!Number.isFinite(number)) throw new Error('Draft JSON numbers must be finite.');
    return number;
  }
  const result = value(0); space();
  if (offset !== input.length) fail();
  return result;
}
