const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const CryptoUtils = require(path.join(__dirname, '..', 'lib', 'crypto-utils.js'));

test('encrypt/decrypt round-trips an object', async () => {
  const salt = CryptoUtils.generateSalt();
  const key = await CryptoUtils.deriveKey('correct horse battery staple', salt);
  const payload = { firstName: 'Kushal', skills: ['js', 'ts'], years: 6 };

  const { iv, ciphertext } = await CryptoUtils.encrypt(payload, key);
  assert.deepEqual(await CryptoUtils.decrypt(ciphertext, iv, key), payload);
});

test('encrypt/decrypt round-trips a plain string', async () => {
  const salt = CryptoUtils.generateSalt();
  const key = await CryptoUtils.deriveKey('pw', salt);
  const { iv, ciphertext } = await CryptoUtils.encrypt('not json', key);
  assert.equal(await CryptoUtils.decrypt(ciphertext, iv, key), 'not json');
});

test('a wrong passphrase fails to decrypt', async () => {
  const salt = CryptoUtils.generateSalt();
  const good = await CryptoUtils.deriveKey('right', salt);
  const bad = await CryptoUtils.deriveKey('wrong', salt);

  const { iv, ciphertext } = await CryptoUtils.encrypt({ a: 1 }, good);
  await assert.rejects(() => CryptoUtils.decrypt(ciphertext, iv, bad));
});

test('the same passphrase under a different salt yields a different key', async () => {
  const a = await CryptoUtils.deriveKey('same', CryptoUtils.generateSalt());
  const b = await CryptoUtils.deriveKey('same', CryptoUtils.generateSalt());

  const { iv, ciphertext } = await CryptoUtils.encrypt({ a: 1 }, a);
  await assert.rejects(() => CryptoUtils.decrypt(ciphertext, iv, b));
});

test('each encryption uses a fresh IV', async () => {
  const key = await CryptoUtils.deriveKey('pw', CryptoUtils.generateSalt());
  const one = await CryptoUtils.encrypt({ a: 1 }, key);
  const two = await CryptoUtils.encrypt({ a: 1 }, key);
  assert.notEqual(one.iv, two.iv);
  assert.notEqual(one.ciphertext, two.ciphertext);
});
