const test = require('node:test');
const assert = require('node:assert/strict');

const {
  toFirestoreValue,
  fromFirestoreValue,
  toFirestoreDoc,
  fromFirestoreDoc,
} = require('../lib/firestore-utils');

test('toFirestoreValue/fromFirestoreValue round-trip primitives', () => {
  const values = [null, true, false, 123, 45.67, 'hello'];
  values.forEach((val) => {
    const encoded = toFirestoreValue(val);
    const decoded = fromFirestoreValue(encoded);
    assert.deepEqual(decoded, val);
  });
});

test('toFirestoreValue/fromFirestoreValue round-trip arrays and objects', () => {
  const input = {
    list: [1, 'two', { nested: true }],
    meta: { score: 9.5, tags: ['a', 'b'] },
  };
  const encoded = toFirestoreValue(input);
  const decoded = fromFirestoreValue(encoded);
  assert.deepEqual(decoded, input);
});

test('toFirestoreDoc/fromFirestoreDoc round-trip documents', () => {
  const doc = {
    name: 'Test',
    count: 3,
    flags: { ok: true },
    items: ['a', 'b'],
  };
  const encoded = toFirestoreDoc(doc);
  const decoded = fromFirestoreDoc(encoded);
  assert.deepEqual(decoded, doc);
});
