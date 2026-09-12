// Loads every script the MV3 service worker pulls in, in importScripts order,
// inside one shared global — the same way Chrome does.
//
// This exists because a duplicate top-level `const` in two of those scripts is a
// SyntaxError that kills the worker before a single line runs. Nothing else in the
// suite catches it: each file parses fine on its own, and the only user-visible
// symptom is the popup reporting "Background not responding".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { makeWorkerContext, workerScripts, ROOT } = require('./helpers/worker-harness.js');

test('every service worker script loads into one shared global', () => {
  const { context } = makeWorkerContext();
  for (const file of workerScripts()) {
    assert.doesNotThrow(
      () => vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file }),
      `${file} failed to load into the service worker scope`
    );
  }
});

test('no top-level lexical name is declared by two worker scripts', () => {
  const seen = new Map();
  const collisions = [];
  for (const file of workerScripts()) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const line of src.split('\n')) {
      const m = /^(const|let|class)\s+([A-Za-z_$][\w$]*)/.exec(line);
      if (!m) continue;
      const name = m[2];
      if (seen.has(name)) collisions.push(`${name} (${seen.get(name)} and ${file})`);
      else seen.set(name, file);
    }
  }
  assert.deepEqual(collisions, [], `duplicate top-level declarations kill the worker: ${collisions.join(', ')}`);
});

test('the worker answers the messages the popup sends on open', async () => {
  const { context, listeners } = makeWorkerContext();
  for (const file of workerScripts()) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
  }
  assert.equal(listeners.length, 1, 'expected exactly one onMessage listener');

  for (const type of ['CLOUD_GET_STATUS', 'GET_EXT_SETTINGS', 'GET_ALL_DATA', 'GET_GLOBAL_PROFILE']) {
    const reply = await new Promise((resolve) => {
      const keepAlive = listeners[0]({ type }, {}, resolve);
      assert.equal(keepAlive, true, `${type} must return true to keep the channel open`);
    });
    assert.ok(reply && typeof reply === 'object', `${type} returned no response`);
  }
});


test('sign-in replies before the initial cloud sync finishes', async () => {
  // The initial sync is ~14 Firestore round trips. The popup gives up after 20s,
  // and previously awaited all of it — so a successful login reported a timeout.
  let releaseSync;
  const syncBlocked = new Promise((resolve) => { releaseSync = resolve; });
  let firestoreCalls = 0;

  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes('identitytoolkit')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          localId: 'uid-1', email: 'user@example.com', displayName: 'Test User',
          idToken: 'id-token', refreshToken: 'refresh-token', expiresIn: '3600',
        }),
      };
    }
    // Any Firestore traffic is part of the background sync — hold it open.
    firestoreCalls += 1;
    await syncBlocked;
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const { context, listeners } = makeWorkerContext(fetchImpl);
  for (const file of workerScripts()) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
  }

  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CLOUD_SIGN_IN did not reply while the sync was pending')), 3000);
    listeners[0]({ type: 'CLOUD_SIGN_IN', email: 'user@example.com', password: 'pw' }, {}, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
  });

  assert.equal(reply.ok, true, 'sign-in should succeed');
  assert.equal(reply.user.email, 'user@example.com');

  // Let the detached sync get as far as its first network call.
  await new Promise((r) => setTimeout(r, 50));

  const state = await new Promise((resolve) => {
    listeners[0]({ type: 'CLOUD_GET_SYNC_STATE' }, {}, resolve);
  });
  assert.equal(state.syncing, true, 'the sync should still be running after sign-in returns');
  assert.ok(firestoreCalls > 0, 'the background sync should have started hitting Firestore');

  releaseSync();
});
