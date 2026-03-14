const test = require('node:test');
const assert = require('node:assert/strict');

const { extractJSON } = require('../lib/ai-utils');

test('extractJSON parses JSON object embedded in text', () => {
  const input = 'Here is the result:\n{"ok":true,"count":3}\nThanks!';
  const parsed = extractJSON(input);
  assert.deepEqual(parsed, { ok: true, count: 3 });
});

test('extractJSON parses JSON array embedded in text', () => {
  const input = 'List: [1, 2, {"a":"b"}]';
  const parsed = extractJSON(input);
  assert.deepEqual(parsed, [1, 2, { a: 'b' }]);
});

test('extractJSON throws on missing JSON', () => {
  assert.throws(() => extractJSON('no json here'), /did not contain valid JSON/i);
});

test('extractJSON throws on malformed JSON', () => {
  assert.throws(() => extractJSON('prefix {bad json] suffix'), /malformed JSON/i);
});
