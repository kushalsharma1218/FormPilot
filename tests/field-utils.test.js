const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isUnstableId,
  cleanLabelText,
  selectFieldKey,
  isSensitiveKey,
} = require('../lib/field-utils');

test('isUnstableId detects UUIDs, numeric, and long hashes', () => {
  assert.equal(isUnstableId('6f1b2c3d-4e5f-6789-abcd-ef0123456789'), true);
  assert.equal(isUnstableId('123456'), true);
  assert.equal(isUnstableId('a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6'), true);
  assert.equal(isUnstableId('email'), false);
});

test('cleanLabelText trims and removes asterisks', () => {
  assert.equal(cleanLabelText(' First Name * '), 'First Name');
});

test('selectFieldKey prefers labels over attributes', () => {
  const key = selectFieldKey({
    labelledByText: 'First Name',
    name: 'first_name',
  });
  assert.equal(key, 'First Name');
});

test('selectFieldKey ignores unstable attribute ids', () => {
  const key = selectFieldKey({
    labelledByText: '',
    name: '',
    id: '123456',
    ariaLabel: 'Email',
  });
  assert.equal(key, 'Email');
});

test('isSensitiveKey flags sensitive labels/keys', () => {
  assert.equal(isSensitiveKey({ key: 'ssn' }), true);
  assert.equal(isSensitiveKey({ label: 'Social Security Number' }), true);
  assert.equal(isSensitiveKey({ key: 'email' }), false);
});
