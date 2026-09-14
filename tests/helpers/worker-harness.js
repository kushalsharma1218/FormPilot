// Shared MV3 service-worker harness: loads every importScripts'd file into one
// vm context with a stubbed `chrome` (including a real in-memory storage backend)
// and lets a test dispatch messages at the background's onMessage listener.
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

function makeWorkerContext(fetchImpl) {
  const noop = () => {};
  const listeners = [];
  const store = {};
  const chrome = {
    runtime: {
      id: 'test', lastError: null, getURL: (p) => `chrome-extension://test/${p}`,
      onMessage: { addListener: (f) => listeners.push(f) },
      onInstalled: { addListener: noop }, onStartup: { addListener: noop },
      onConnect: { addListener: noop }, sendMessage: async () => ({}),
    },
    storage: {
      // A real in-memory store, so saveAuthState -> getAuthState round-trips and
      // the post-sign-in sync actually runs instead of bailing with "Not logged in".
      local: {
        get: async (keys) => {
          if (keys == null) return { ...store };
          const wanted = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of wanted) if (k in store) out[k] = store[k];
          return out;
        },
        set: async (obj) => { Object.assign(store, obj); },
        remove: async (keys) => {
          for (const k of (Array.isArray(keys) ? keys : [keys])) delete store[k];
        },
      },
      onChanged: { addListener: noop },
    },
    tabs: {
      query: async () => [], sendMessage: async () => ({}), create: async () => ({}),
      onRemoved: { addListener: noop }, onUpdated: { addListener: noop }, onActivated: { addListener: noop },
    },
    action: { onClicked: { addListener: noop }, setBadgeText: noop, setBadgeBackgroundColor: noop, setTitle: noop },
    webNavigation: { onCommitted: { addListener: noop }, onHistoryStateUpdated: { addListener: noop } },
    // These take callbacks; a no-op never invokes them and the caller hangs forever.
    identity: {
      getAuthToken: (_opts, cb) => { if (typeof cb === 'function') cb(null); },
      removeCachedAuthToken: (_opts, cb) => { if (typeof cb === 'function') cb(); },
      launchWebAuthFlow: (_opts, cb) => { if (typeof cb === 'function') cb(null); },
      getRedirectURL: () => '',
    },
    alarms: { create: noop, onAlarm: { addListener: noop }, clear: noop },
    sidePanel: { setPanelBehavior: async () => {} },
    contextMenus: { create: noop, onClicked: { addListener: noop } },
    commands: { onCommand: { addListener: noop } },
    scripting: { executeScript: async () => [] },
  };

  const sandbox = {
    chrome, console, setTimeout, clearTimeout, setInterval, clearInterval,
    TextEncoder, TextDecoder, btoa, atob, URL, URLSearchParams,
    crypto: require('node:crypto').webcrypto,
    fetch: fetchImpl || (async () => ({ ok: true, status: 200, json: async () => ({}) })),
    Headers: class {}, importScripts: noop,
  };
  // Supplied explicitly so the suite does not depend on config.private.js, which
  // is gitignored and therefore absent from a fresh clone. Every network call is
  // stubbed, so these values are never used for anything real.
  sandbox.PRIVATE_FIREBASE_CONFIG = {
    apiKey: 'test-api-key',
    projectId: 'test-project',
    authDomain: 'test-project.firebaseapp.com',
  };
  // A real service-worker global has these; the sandbox needs them so that
  // anything installing error handlers at load time behaves as it would in Chrome.
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  return { context: vm.createContext(sandbox), listeners, store };
}

function workerScripts() {
  const src = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const imported = [...src.matchAll(/importScripts\('([^']+)'\)/g)].map((m) => m[1]);
  return [...imported, 'background.js'].filter((f) => fs.existsSync(path.join(ROOT, f)));
}

function loadWorker(fetchImpl) {
  const ctx = makeWorkerContext(fetchImpl);
  for (const file of workerScripts()) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx.context, { filename: file });
  }
  ctx.send = (msg) => new Promise((resolve) => { ctx.listeners[0](msg, {}, resolve); });
  return ctx;
}

module.exports = { makeWorkerContext, workerScripts, loadWorker, ROOT };
