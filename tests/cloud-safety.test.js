// Regression tests for the data-loss and cross-account defects found in audit.
// Each asserts the CORRECT behaviour; each fails if the corresponding fix is reverted.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadWorker } = require('./helpers/worker-harness.js');

// A Firestore/Identity stub backed by a plain object, so documents persist
// across "devices" the way the real backend does.
function makeCloud(docs = {}) {
  return {
    docs,
    fetchImpl: async (url, options = {}) => {
      const href = String(url);
      if (href.includes('identitytoolkit') || href.includes('securetoken')) {
        return {
          ok: true, status: 200,
          json: async () => ({
            localId: 'uid-1', email: 'user@example.com', displayName: 'Test User',
            idToken: 'id-token', refreshToken: 'refresh-token', expiresIn: '3600',
            id_token: 'id-token', refresh_token: 'refresh-token', expires_in: '3600',
          }),
        };
      }
      const m = /documents\/(.+?)(?:\?|$)/.exec(href);
      const key = m ? m[1] : href;
      if ((options.method || 'GET') === 'GET') {
        if (!(key in docs)) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => docs[key] };
      }
      docs[key] = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => docs[key] };
    },
  };
}

const signIn = (w) => w.send({ type: 'CLOUD_SIGN_IN', email: 'user@example.com', password: 'pw' });

test('the E2EE salt is recoverable after sign-out (it lives with the account)', async () => {
  const cloud = makeCloud();

  const first = loadWorker(cloud.fetchImpl);
  await signIn(first);
  const set = await first.send({ type: 'SET_SYNC_PASSPHRASE', passphrase: 'correct horse' });
  assert.equal(set.ok, true);
  assert.equal(set.firstTime, true, 'first activation should create the verifier');

  // A second worker with a WIPED local store — i.e. after sign-out, or a second
  // device. The salt must come back from the account, not be regenerated.
  const second = loadWorker(cloud.fetchImpl);
  await signIn(second);
  const again = await second.send({ type: 'SET_SYNC_PASSPHRASE', passphrase: 'correct horse' });
  assert.equal(again.ok, true, 'the same passphrase must still be accepted');
  assert.equal(again.firstTime, false, 'it must recognise the existing verifier, not mint a new one');
});

test('a wrong passphrase is rejected rather than silently deriving a bad key', async () => {
  const cloud = makeCloud();
  const w = loadWorker(cloud.fetchImpl);
  await signIn(w);
  await w.send({ type: 'SET_SYNC_PASSPHRASE', passphrase: 'right one' });

  const other = loadWorker(cloud.fetchImpl);
  await signIn(other);
  const bad = await other.send({ type: 'SET_SYNC_PASSPHRASE', passphrase: 'wrong one' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /incorrect passphrase/i);
});

test('a push without the in-memory key refuses rather than writing plaintext', async () => {
  const cloud = makeCloud();

  const first = loadWorker(cloud.fetchImpl);
  await signIn(first);
  await first.send({ type: 'SET_SYNC_PASSPHRASE', passphrase: 'correct horse' });
  await first.send({ type: 'SAVE_GLOBAL_PROFILE', profile: { firstName: 'Ada', phone: '555' } });
  await first.send({ type: 'CLOUD_PUSH' });

  // Worker restart: E2EE is still on for the account, but the key is gone.
  const restarted = loadWorker(cloud.fetchImpl);
  await signIn(restarted);
  await restarted.send({ type: 'SAVE_GLOBAL_PROFILE', profile: { firstName: 'Ada', phone: '555' } });
  await restarted.send({ type: 'CLOUD_PUSH' });

  const profileDoc = JSON.stringify(cloud.docs['users/uid-1/profile/data'] || {});
  assert.ok(!profileDoc.includes('Ada'), 'profile must not have been rewritten in the clear');
});

test('anonymous data is not inherited by the next account to sign in', async () => {
  const cloud = makeCloud();
  const w = loadWorker(cloud.fetchImpl);

  // Someone uses the extension signed out.
  await w.send({ type: 'SAVE_GLOBAL_PROFILE', profile: { firstName: 'Alice', phone: '555-0001' } });
  await signIn(w);
  const adopted = await w.send({ type: 'GET_GLOBAL_PROFILE' });
  assert.equal(adopted.profile.firstName, 'Alice', 'the signing-in user should adopt their own prior work');

  // The anonymous copy must be gone, so nobody else can pick it up.
  const leftBehind = await new Promise((r) => w.context.chrome.storage.local.get('global_profile_data').then(r));
  assert.deepEqual(leftBehind, {}, 'the anonymous copy must be cleared after adoption');
});

test('a sync queue left by another account is discarded, not uploaded', async () => {
  const cloud = makeCloud();
  const w = loadWorker(cloud.fetchImpl);
  await signIn(w);

  // Hand-plant a queue item owned by a different user.
  await w.context.chrome.storage.local.set({
    cloud_sync_queue: [{
      id: 'x1', action: 'patch', key: 'profile',
      payload: { firstName: 'SomeoneElse' }, userId: 'uid-OTHER', attempts: 0,
    }],
  });
  await w.send({ type: 'CLOUD_SYNC' });

  const doc = JSON.stringify(cloud.docs['users/uid-1/profile/data'] || {});
  assert.ok(!doc.includes('SomeoneElse'), "another account's queued data must never be uploaded here");
});

test('a per-category sync opt-out actually persists', async () => {
  const cloud = makeCloud();
  const w = loadWorker(cloud.fetchImpl);
  await signIn(w);

  const saved = await w.send({ type: 'CLOUD_SAVE_PREFS', prefs: { syncApplications: false } });
  const prefs = saved.prefs || (await w.send({ type: 'CLOUD_GET_PREFS' })).prefs;
  assert.equal(prefs.syncApplications, false, 'the opt-out must survive the round trip');
});

test('sign-out will not silently delete data the cloud never received', async () => {
  const cloud = makeCloud();
  const w = loadWorker(cloud.fetchImpl);
  await signIn(w);
  await w.send({ type: 'CLOUD_SAVE_PREFS', prefs: { enabled: false } });
  await w.send({ type: 'SAVE_GLOBAL_PROFILE', profile: { firstName: 'Ada' } });

  const out = await w.send({ type: 'CLOUD_SIGN_OUT' });
  assert.equal(out.ok, false);
  assert.equal(out.needsConfirm, true, 'it must ask before destroying un-backed-up data');
});
