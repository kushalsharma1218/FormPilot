// background.js — Service Worker (v2.2 with Cloud Sync)

importScripts('lib/auth-store.js');
importScripts('lib/ai-utils.js');
importScripts('lib/firestore-utils.js');
importScripts('ai-service.js');
try {
  importScripts('config.private.js');
} catch (_) {
  // Optional private Firebase config (not committed)
}
importScripts('lib/sync-queue.js');
importScripts('lib/crypto-utils.js');
importScripts('cloud-sync.js');

const AuthStore = JobAutofill.AuthStore;
const CryptoUtils = JobAutofill.CryptoUtils;
const SyncQueue = JobAutofill.SyncQueue;

// ── In-Memory Security State ───────────────────────────────────
// Must live on globalThis: cloud-sync.js reads globalThis.currentSyncKey, and a
// top-level `let` is a lexical binding, not a property of the worker global.
globalThis.currentSyncKey = null; // AES CryptoKey, never persisted to local storage
globalThis.syncKeySalt = null;    // Uint8Array salt for the current user

const STORAGE_KEY = 'autofill_data';
const GLOBAL_STORAGE_KEY = 'global_profile_data';
const RESUMES_KEY = 'resumes_data';
const METRICS_KEY = 'usage_metrics';
const SESSION_KEY = 'autofill_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CLOUD_PREFS_KEY = 'cloud_sync_prefs';
// Deliberately not user-scoped: content.js reads this before it knows who (if anyone)
// is signed in, so it cannot live behind AuthStore.getUserKey().
const EXT_SETTINGS_KEY = 'extension_settings';
const EXCLUDED_SITES_KEY = 'excluded_sites';
const METRIC_TIME_PER_FIELD_SEC = 8;
const DEBUG_LOG_KEY = 'fp_debug_logs';
const DEBUG_LOG_MAX = 500;
const GLOBAL_ALIAS_PROMOTE_MAX = 20;

// ── Frame Registry (for iframe-aware messaging) ────────────────
const FRAME_REGISTRY = new Map(); // tabId -> Set(frameId)
let debugLogBuffer = [];
let debugFlushTimer = null;

function registerFrame(sender) {
  const tabId = sender?.tab?.id;
  const frameId = sender?.frameId;
  if (tabId === undefined || frameId === undefined) return;
  let set = FRAME_REGISTRY.get(tabId);
  if (!set) {
    set = new Set();
    FRAME_REGISTRY.set(tabId, set);
  }
  set.add(frameId);
}

async function broadcastToTabFrames(tabId, payload) {
  if (tabId === undefined || tabId === null) return { ok: false, error: 'Missing tabId' };
  const frames = FRAME_REGISTRY.get(tabId);
  const frameIds = new Set([0, ...(frames ? Array.from(frames) : [])]);
  const results = await Promise.allSettled(
    Array.from(frameIds).map(frameId =>
      chrome.tabs.sendMessage(tabId, payload, { frameId }).catch(() => null)
    )
  );
  // Return the answering frame's payload, not just a boolean: callers need the
  // data (extracted page text, saved-field count), and collapsing it to { ok }
  // is why those popup features reported undefined.
  const answered = results.find(r => r.status === 'fulfilled' && r.value && r.value.ok);
  if (answered) return { ...answered.value, ok: true };
  return { ok: false };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  FRAME_REGISTRY.delete(tabId);
});

// The first sync after sign-in is ~14 Firestore round trips. The popup times its
// sign-in request out after 6s, so awaiting the sync made a perfectly successful
// login report "Background not responding". Auth is already persisted by
// cloudSignIn/cloudSignUp, so reply immediately and sync in the background.
let initialSyncState = { syncing: false, lastError: null, lastSyncAt: null };

async function finishSignIn(mode) {
  try {
    await saveCloudPrefs({ enabled: true });
  } catch (err) {
    console.warn('[Cloud] Could not enable sync prefs:', err);
  }
  await broadcastAuthState(true);

  initialSyncState = { syncing: true, lastError: null, lastSyncAt: null };
  broadcastSyncState();

  // Deliberately not awaited.
  (async () => {
    try {
      const { prefs } = await getCloudPrefs();
      if (mode === 'pull-then-push') await pullAllFromCloud(prefs);
      if (prefs.enabled) await pushAllToCloud(prefs);
      initialSyncState = { syncing: false, lastError: null, lastSyncAt: new Date().toISOString() };
    } catch (err) {
      console.warn('[Cloud] Initial sync failed:', err);
      initialSyncState = { syncing: false, lastError: err?.message || 'Sync failed', lastSyncAt: null };
    }
    broadcastSyncState();
    await broadcastAuthState(true); // let tabs pick up freshly pulled data
  })();
}

function broadcastSyncState() {
  const payload = { type: 'CLOUD_SYNC_STATE_CHANGED', ...initialSyncState };
  chrome.runtime.sendMessage(payload).catch(() => { }); // popup/dashboard, if open
}

// content.js gates init() on sign-in state, so every auth transition must reach
// already-open tabs — otherwise they stay suppressed until the user reloads.
// Exposed on globalThis so cloud-sync.js can reach it — it is loaded first, and a
// bare function declaration here is not visible to it by name at call time.
globalThis.broadcastAuthState = broadcastAuthState;
async function broadcastAuthState(loggedIn) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (err) {
    console.warn('[Auth] Could not enumerate tabs:', err);
    return;
  }
  await Promise.allSettled(
    tabs.map(tab => broadcastToTabFrames(tab.id, { type: 'AUTH_STATE_CHANGED', loggedIn }))
  );
}

async function flushDebugLogs() {
  if (debugLogBuffer.length === 0) return;
  const buffer = debugLogBuffer.splice(0, debugLogBuffer.length);
  if (debugFlushTimer) {
    clearTimeout(debugFlushTimer);
    debugFlushTimer = null;
  }
  try {
    const key = await AuthStore.getUserKey(DEBUG_LOG_KEY);
    const result = await chrome.storage.local.get(key);
    let logs = Array.isArray(result[key]) ? result[key] : [];
    logs = logs.concat(buffer);
    if (logs.length > DEBUG_LOG_MAX) logs = logs.slice(-DEBUG_LOG_MAX);
    await chrome.storage.local.set({ [key]: logs });
  } catch (err) {
    console.warn('[Background] Debug log flush failed:', err?.message || err);
  }
}

function queueDebugLog(entry) {
  if (!entry) return;
  const sanitized = { ...entry };
  if (sanitized.value) delete sanitized.value;
  debugLogBuffer.push(sanitized);
  if (debugLogBuffer.length >= 80) {
    flushDebugLogs();
  } else if (!debugFlushTimer) {
    debugFlushTimer = setTimeout(flushDebugLogs, 1500);
  }
}

async function clearGoogleIdentityTokenCache() {
  if (!chrome.identity?.getAuthToken || !chrome.identity?.removeCachedAuthToken) {
    return false;
  }
  return new Promise((resolve) => {
    try {
      chrome.identity.getAuthToken({ interactive: false }, (token) => {
        if (chrome.runtime.lastError || !token) {
          resolve(false);
          return;
        }
        chrome.identity.removeCachedAuthToken({ token }, () => resolve(true));
      });
    } catch (_) {
      resolve(false);
    }
  });
}

// ── Storage Helpers (Account Aware) ────────────────────────────
// (AuthStore is aliased at the top of this file; cloud-sync.js owns CloudAuthStore.)

// Reads a user-scoped key, adopting pre-sign-in ("anonymous") data exactly once.
//
// The anonymous copy is REMOVED after adoption. Leaving it behind meant the next
// account to sign in on the same device inherited the previous user's data — a
// cross-account leak that needed no race and no failure to trigger. It also
// covers the three stores that had no migration at all, so a user who worked
// signed out (the default) no longer loses resumes, applications and tasks the
// moment they sign up.
async function readUserScoped(baseKey, fallback, isEmpty) {
  const key = await AuthStore.getUserKey(baseKey);
  const result = await chrome.storage.local.get([key, baseKey]);
  let value = result[key];

  if (key !== baseKey && isEmpty(value) && !isEmpty(result[baseKey])) {
    value = result[baseKey];
    await chrome.storage.local.set({ [key]: value });
    await chrome.storage.local.remove(baseKey);
    console.log(`[Background] Adopted anonymous "${baseKey}" into ${key}`);
  }

  return { key, value: isEmpty(value) ? fallback : value };
}

const isEmptyList = (v) => !Array.isArray(v) || v.length === 0;

// Serialises read-modify-write cycles on the shared storage blobs. content.js is
// injected with all_frames:true, so two frames of one page routinely save at the
// same moment and the last writer used to win outright.
let storageWriteChain = Promise.resolve();
function withStorageLock(fn) {
  const run = storageWriteChain.then(fn, fn);
  storageWriteChain = run.then(() => { }, () => { });
  return run;
}

async function getData() {
  try {
    const key = await AuthStore.getUserKey(STORAGE_KEY);
    const result = await chrome.storage.local.get([key, STORAGE_KEY]);
    let data = result[key] || {};

    // ── MIGRATION: Copy anonymous site data to logged-in user if empty ──
    if (key !== STORAGE_KEY && Object.keys(data.sites || {}).length === 0) {
      const anonData = result[STORAGE_KEY];
      if (anonData && Object.keys(anonData.sites || {}).length > 0) {
        console.log(`[Background] Migrating ${Object.keys(anonData.sites).length} sites from anonymous storage to user ${key}`);
        data = anonData;
        await chrome.storage.local.set({ [key]: data });
        await chrome.storage.local.remove(STORAGE_KEY);
      }
    }
    // Ensure structure exists
    if (!data.sites) data.sites = {};
    if (!data.hostnameMappings) data.hostnameMappings = {};
    if (!data.globalAliases || typeof data.globalAliases !== 'object') data.globalAliases = {};
    if (!Array.isArray(data.excludedSites)) data.excludedSites = [];
    // Normalize site entries
    Object.values(data.sites).forEach(site => {
      if (!site.fields) site.fields = {};
      if (!Array.isArray(site.mappings)) site.mappings = [];
      if (!site.flags) site.flags = {};
      if (!site.metrics) site.metrics = {};
      if (!site.sandbox) site.sandbox = {};
      if (site.enabled === undefined) site.enabled = !site.disabled;
    });
    return data;
  } catch (err) {
    console.error('[Background] getData error:', err);
    return { sites: {}, hostnameMappings: {}, globalAliases: {}, excludedSites: [] };
  }
}

async function saveData(data) {
  const key = await AuthStore.getUserKey(STORAGE_KEY);
  await chrome.storage.local.set({ [key]: data });
  if (globalThis.JobAutofill?.SyncQueue) {
    await globalThis.JobAutofill.SyncQueue.enqueue('patch', 'autofill', data);
  }
}

async function getGlobalProfile() {
  try {
    const key = await AuthStore.getUserKey(GLOBAL_STORAGE_KEY);
    const result = await chrome.storage.local.get([key, GLOBAL_STORAGE_KEY]);
    let profile = result[key] || {};

    // ── MIGRATION: Copy anonymous profile to logged-in user if empty ──
    if (key !== GLOBAL_STORAGE_KEY && Object.keys(profile).length === 0) {
      const anonProfile = result[GLOBAL_STORAGE_KEY];
      if (anonProfile && Object.keys(anonProfile).length > 0) {
        console.log(`[Background] Migrating global profile from anonymous storage to user ${key}`);
        profile = anonProfile;
        await chrome.storage.local.set({ [key]: profile });
        await chrome.storage.local.remove(GLOBAL_STORAGE_KEY);
      }
    }
    return profile;
  } catch (err) {
    console.error('[Background] getGlobalProfile error:', err);
    return {};
  }
}

async function saveGlobalProfile(profile) {
  const key = await AuthStore.getUserKey(GLOBAL_STORAGE_KEY);
  await chrome.storage.local.set({ [key]: profile });
  if (globalThis.JobAutofill?.SyncQueue) {
    await globalThis.JobAutofill.SyncQueue.enqueue('patch', 'profile', profile);
  }
}

function defaultUsageMetrics() {
  return {
    totalRuns: 0,
    totalFieldsDetected: 0,
    totalFieldsMatched: 0,
    totalFieldsFilled: 0,
    totalTimeSavedSec: 0,
    lastRunAt: null,
    daily: {},
    perSite: {},
  };
}

async function getUsageMetrics() {
  const key = await AuthStore.getUserKey(METRICS_KEY);
  const result = await chrome.storage.local.get([key, METRICS_KEY]);
  let metrics = result[key] || {};
  if (key !== METRICS_KEY && (!metrics || Object.keys(metrics).length === 0)) {
    const anonMetrics = result[METRICS_KEY];
    if (anonMetrics && Object.keys(anonMetrics).length > 0) {
      metrics = anonMetrics;
      await chrome.storage.local.set({ [key]: metrics });
    }
  }
  return metrics && Object.keys(metrics).length > 0 ? metrics : defaultUsageMetrics();
}

async function saveUsageMetrics(metrics) {
  const key = await AuthStore.getUserKey(METRICS_KEY);
  await chrome.storage.local.set({ [key]: metrics });
  if (globalThis.JobAutofill?.SyncQueue) {
    await globalThis.JobAutofill.SyncQueue.enqueue('patch', 'metrics', metrics);
  }
}

function getLocalDateKey(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function mergeMetricBucket(a = {}, b = {}) {
  return {
    runs: Math.max(Number(a.runs || 0), Number(b.runs || 0)),
    fieldsDetected: Math.max(Number(a.fieldsDetected || 0), Number(b.fieldsDetected || 0)),
    fieldsMatched: Math.max(Number(a.fieldsMatched || 0), Number(b.fieldsMatched || 0)),
    fieldsFilled: Math.max(Number(a.fieldsFilled || 0), Number(b.fieldsFilled || 0)),
    timeSavedSec: Math.max(Number(a.timeSavedSec || 0), Number(b.timeSavedSec || 0)),
    lastAt: a.lastAt && b.lastAt ? (a.lastAt > b.lastAt ? a.lastAt : b.lastAt) : (a.lastAt || b.lastAt || null),
  };
}

function mergeUsageMetrics(local, remote) {
  const merged = defaultUsageMetrics();
  const l = local || {};
  const r = remote || {};
  merged.totalRuns = Math.max(Number(l.totalRuns || 0), Number(r.totalRuns || 0));
  merged.totalFieldsDetected = Math.max(Number(l.totalFieldsDetected || 0), Number(r.totalFieldsDetected || 0));
  merged.totalFieldsMatched = Math.max(Number(l.totalFieldsMatched || 0), Number(r.totalFieldsMatched || 0));
  merged.totalFieldsFilled = Math.max(Number(l.totalFieldsFilled || 0), Number(r.totalFieldsFilled || 0));
  merged.totalTimeSavedSec = Math.max(Number(l.totalTimeSavedSec || 0), Number(r.totalTimeSavedSec || 0));
  merged.lastRunAt = l.lastRunAt && r.lastRunAt ? (l.lastRunAt > r.lastRunAt ? l.lastRunAt : r.lastRunAt) : (l.lastRunAt || r.lastRunAt || null);

  const daily = { ...(l.daily || {}) };
  Object.entries(r.daily || {}).forEach(([key, bucket]) => {
    daily[key] = mergeMetricBucket(daily[key], bucket);
  });
  merged.daily = daily;

  const perSite = { ...(l.perSite || {}) };
  Object.entries(r.perSite || {}).forEach(([key, bucket]) => {
    perSite[key] = mergeMetricBucket(perSite[key], bucket);
  });
  merged.perSite = perSite;
  return merged;
}

function normalizeAliasLabel(label) {
  return (label || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ')
    .replace(/[^\w\s]/g, '')
    .trim();
}

async function recordUsageMetrics(hostname, stats = {}) {
  const detected = Number(stats.detected || 0);
  const matched = Number(stats.matched || 0);
  const filled = Number(stats.filled || 0);
  if (detected <= 0 && filled <= 0) return null;

  const metrics = await getUsageMetrics();
  const now = new Date();
  const dateKey = getLocalDateKey(now);
  const timeSavedSec = filled * METRIC_TIME_PER_FIELD_SEC;

  metrics.totalRuns = Number(metrics.totalRuns || 0) + 1;
  metrics.totalFieldsDetected = Number(metrics.totalFieldsDetected || 0) + detected;
  metrics.totalFieldsMatched = Number(metrics.totalFieldsMatched || 0) + matched;
  metrics.totalFieldsFilled = Number(metrics.totalFieldsFilled || 0) + filled;
  metrics.totalTimeSavedSec = Number(metrics.totalTimeSavedSec || 0) + timeSavedSec;
  metrics.lastRunAt = now.toISOString();

  metrics.daily = metrics.daily || {};
  const day = metrics.daily[dateKey] || {};
  metrics.daily[dateKey] = {
    runs: Number(day.runs || 0) + 1,
    fieldsDetected: Number(day.fieldsDetected || 0) + detected,
    fieldsMatched: Number(day.fieldsMatched || 0) + matched,
    fieldsFilled: Number(day.fieldsFilled || 0) + filled,
    timeSavedSec: Number(day.timeSavedSec || 0) + timeSavedSec,
    lastAt: metrics.lastRunAt,
  };

  if (hostname) {
    metrics.perSite = metrics.perSite || {};
    const site = metrics.perSite[hostname] || {};
    metrics.perSite[hostname] = {
      runs: Number(site.runs || 0) + 1,
      fieldsDetected: Number(site.fieldsDetected || 0) + detected,
      fieldsMatched: Number(site.fieldsMatched || 0) + matched,
      fieldsFilled: Number(site.fieldsFilled || 0) + filled,
      timeSavedSec: Number(site.timeSavedSec || 0) + timeSavedSec,
      lastAt: metrics.lastRunAt,
    };
  }

  await saveUsageMetrics(metrics);
  return metrics;
}
function clampScore(value) {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function computeQualityScore(stats) {
  const detected = Math.max(0, Number(stats?.detected || 0));
  const matched = Math.max(0, Number(stats?.matched || 0));
  const filled = Math.max(0, Number(stats?.filled || 0));
  if (!detected) return 0;
  const matchRatio = matched / detected;
  const fillRatio = matched ? filled / matched : 0;
  const score = Math.round(100 * (0.7 * matchRatio + 0.3 * fillRatio));
  return clampScore(score);
}

function isSiteDisabled(data, siteKey) {
  const site = data?.sites?.[siteKey];
  return !!(site?.disabled || site?.enabled === false);
}

// ── Cloud Sync Preferences ─────────────────────────────────────
// ── Sync key derivation state ──────────────────────────────────
const SYNC_SALT_KEY = 'sync_salt';
const SYNC_VERIFIER_KEY = 'sync_verifier';
const SYNC_VERIFIER_PROBE = 'formpilot-sync-verifier-v1';

// The salt and the passphrase verifier belong to the ACCOUNT, not the device.
//
// A PBKDF2 salt is not a secret — it exists to make precomputed tables useless,
// not to stay hidden — and the verifier is a probe that only the right key can
// decrypt. Keeping either only in local storage meant the sign-out sweep
// (`user_<id>_*`) destroyed them, which made every encrypted document in the
// cloud permanently unreadable, and meant a second device could never derive the
// same key. Both are therefore mirrored to users/<uid>/sync_meta/data.
const SYNC_META_DOC = 'sync_meta';

async function loadSyncMeta() {
  const saltKey = await AuthStore.getUserKey(SYNC_SALT_KEY);
  const verifierKey = await AuthStore.getUserKey(SYNC_VERIFIER_KEY);
  const local = await chrome.storage.local.get([saltKey, verifierKey, SYNC_SALT_KEY]);

  let salt = local[saltKey] || null;
  let verifier = local[verifierKey] || null;

  // Authoritative copy lives with the account; local storage is only a cache.
  if (!salt || !verifier) {
    try {
      const remote = await globalThis.CloudSync?.pullRawFromCloud?.(SYNC_META_DOC);
      if (remote?.salt) {
        salt = salt || remote.salt;
        verifier = verifier || (remote.verifierIv && remote.verifierCiphertext
          ? { iv: remote.verifierIv, ciphertext: remote.verifierCiphertext }
          : null);
      }
    } catch (err) {
      console.warn('[Security] Could not read sync_meta from cloud:', err?.message || err);
    }
  }

  // Pre-per-user salt, kept so data encrypted before this change still decrypts.
  if (!salt && local[SYNC_SALT_KEY]) salt = local[SYNC_SALT_KEY];

  return { salt, verifier, saltKey, verifierKey };
}

async function saveSyncMeta({ salt, verifier, saltKey, verifierKey }) {
  const writes = {};
  if (salt) writes[saltKey] = salt;
  if (verifier) writes[verifierKey] = verifier;
  if (Object.keys(writes).length) await chrome.storage.local.set(writes);

  try {
    await globalThis.CloudSync?.pushRawToCloud?.(SYNC_META_DOC, {
      salt,
      verifierIv: verifier?.iv || '',
      verifierCiphertext: verifier?.ciphertext || '',
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    // Non-fatal, but the user is now one sign-out away from losing access.
    console.warn('[Security] Could not mirror sync_meta to cloud:', err?.message || err);
  }
}

// true = passphrase matches, false = wrong passphrase, null = no verifier yet.
async function verifySyncKey(key, verifier) {
  if (!verifier?.iv || !verifier?.ciphertext) return null;
  try {
    return (await CryptoUtils.decrypt(verifier.ciphertext, verifier.iv, key)) === SYNC_VERIFIER_PROBE;
  } catch (_) {
    return false;
  }
}

// Does this account use E2EE? Consulted before any push, so that a worker restart
// (which drops the in-memory key) cannot silently downgrade the cloud to plaintext.
async function accountUsesE2ee() {
  try {
    const { verifier } = await loadSyncMeta();
    return !!(verifier?.iv && verifier?.ciphertext);
  } catch (_) {
    return false;
  }
}

const DEFAULT_EXT_SETTINGS = {
  // false = local-only mode: autofill works signed out, sign-in only adds cloud sync.
  // true  = autofill stays disabled until the user signs in.
  requireSignIn: false,
};

async function getExtSettings() {
  try {
    const result = await chrome.storage.local.get(EXT_SETTINGS_KEY);
    return { ...DEFAULT_EXT_SETTINGS, ...(result[EXT_SETTINGS_KEY] || {}) };
  } catch (err) {
    console.warn('[Settings] Falling back to defaults:', err);
    return { ...DEFAULT_EXT_SETTINGS };
  }
}

async function saveExtSettings(patch) {
  const next = { ...(await getExtSettings()), ...(patch || {}) };
  await chrome.storage.local.set({ [EXT_SETTINGS_KEY]: next });
  return next;
}

async function getCloudPrefs() {
  const key = await AuthStore.getUserKey(CLOUD_PREFS_KEY);
  const result = await chrome.storage.local.get(key);
  const stored = result[key] || {};
  const prefs = {
    enabled: false,
    syncProfile: true, // always on when enabled
    syncAutofill: true,
    syncApplications: true,
    syncTasks: true,
    syncAiSettings: true,
    syncResumes: true,
    syncMetrics: true,
    ...stored,
  };
  const auth = await AuthStore.getAuthState();
  if (auth && stored.enabled === undefined) {
    // Signing in turns sync on by default, but never overrides a stored choice —
    // forcing every category true made the per-category opt-outs unsaveable.
    prefs.enabled = true;
  }
  if (!auth) {
    prefs.enabled = false;
  }
  return { key, prefs };
}

async function saveCloudPrefs(next) {
  const { key, prefs } = await getCloudPrefs();
  const merged = { ...prefs, ...(next || {}) };
  if (merged.enabled) {
    // Profile is the one category that is genuinely not optional — it is what
    // makes an account useful on a second device. The rest are the user's call.
    merged.syncProfile = true;
  }
  await chrome.storage.local.set({ [key]: merged });
  return merged;
}

// ── Resume Vault (Local + Cloud Sync) ──────────────────────────
async function getResumesStore() {
  const { key, value } = await readUserScoped(
    RESUMES_KEY,
    { items: [], defaultId: null },
    (v) => !v || isEmptyList(v.items)
  );
  const data = value;
  if (!Array.isArray(data.items)) data.items = [];
  return { key, data };
}

async function saveResumesStore(key, data) {
  await chrome.storage.local.set({ [key]: data });
  if (globalThis.JobAutofill?.SyncQueue) {
    await globalThis.JobAutofill.SyncQueue.enqueue('patch', 'resumes', data);
  }
}

function sanitizeResumeMeta(item) {
  return {
    id: item.id,
    name: item.name,
    label: item.label || '',
    mime: item.mime || '',
    size: item.size || 0,
    updatedAt: item.updatedAt || item.createdAt || new Date().toISOString(),
  };
}

async function listResumes() {
  const { data } = await getResumesStore();
  return { items: data.items.map(sanitizeResumeMeta), defaultId: data.defaultId || null };
}

async function getResumeById(id) {
  const { data } = await getResumesStore();
  return data.items.find(r => r.id === id) || null;
}

async function addOrUpdateResume(resume) {
  const { key, data } = await getResumesStore();
  const now = new Date().toISOString();
  const id = resume.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
  const idx = data.items.findIndex(r => r.id === id);
  if (idx >= 0) {
    const existing = data.items[idx];
    const entry = {
      ...existing,
      id,
      name: resume.name || existing.name || 'Resume',
      label: resume.label !== undefined ? resume.label : (existing.label || ''),
      mime: resume.mime || existing.mime || '',
      size: resume.size || existing.size || 0,
      dataUrl: resume.dataUrl || existing.dataUrl || '',
      createdAt: existing.createdAt || resume.createdAt || now,
      updatedAt: now,
    };
    data.items[idx] = entry;
  } else {
    const entry = {
      id,
      name: resume.name || 'Resume',
      label: resume.label || '',
      mime: resume.mime || '',
      size: resume.size || 0,
      dataUrl: resume.dataUrl || '',
      createdAt: resume.createdAt || now,
      updatedAt: now,
    };
    data.items.unshift(entry);
  }
  if (!data.defaultId) data.defaultId = id;
  await saveResumesStore(key, data);
  return data.items.find(r => r.id === id);
}

async function deleteResume(id) {
  const { key, data } = await getResumesStore();
  data.items = data.items.filter(r => r.id !== id);
  if (data.defaultId === id) data.defaultId = data.items[0]?.id || null;
  await saveResumesStore(key, data);
  return data;
}

async function setDefaultResume(id) {
  const { key, data } = await getResumesStore();
  if (data.items.find(r => r.id === id)) {
    data.defaultId = id;
    await saveResumesStore(key, data);
  }
  return data;
}

// Resolve the effective site key for a hostname (custom or plain hostname)
function resolveSiteKey(data, hostname) {
  if (!hostname) return hostname;
  return (data.hostnameMappings || {})[hostname] || hostname;
}

// ── Application Tracker ────────────────────────────────────────
async function getApplications() {
  const { value } = await readUserScoped(APPLICATIONS_KEY, [], isEmptyList);
  return value;
}

async function saveApplications(apps) {
  const key = await AuthStore.getUserKey(APPLICATIONS_KEY);
  await chrome.storage.local.set({ [key]: apps });
  if (globalThis.JobAutofill?.SyncQueue) {
    await globalThis.JobAutofill.SyncQueue.enqueue('patch', 'applications', { list: apps });
  }
}

async function addApplication(app) {
  const apps = await getApplications();
  const exists = apps.find(a => a.companyName === app.companyName && a.jobTitle === app.jobTitle);
  if (exists) {
    Object.assign(exists, app, { updatedAt: new Date().toISOString() });
  } else {
    apps.unshift({
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
      ...app,
      status: app.status || 'applied',
      appliedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      notes: '',
      jobDescription: app.jobDescription || '',
    });
  }
  await saveApplications(apps);
  return apps;
}

async function updateApplication(id, updates) {
  const apps = await getApplications();
  const app = apps.find(a => a.id === id);
  if (app) {
    Object.assign(app, updates, { updatedAt: new Date().toISOString() });
    await saveApplications(apps);
  }
  return apps;
}

async function deleteApplication(id) {
  let apps = await getApplications();
  apps = apps.filter(a => a.id !== id);
  await saveApplications(apps);
  return apps;
}

// ── Task Tracker ───────────────────────────────────────────────
// Tolerant of legacy/free-form statuses ("completed", "To Do", "in progress").
// TASK_STATUS_SET / TASK_STATUS_ALIASES come from ai-service.js (imported first).
function normalizeTaskStatus(status) {
  if (!status) return 'new';
  const raw = String(status).trim().toLowerCase();
  if (!raw) return 'new';
  const normalized = raw.replace(/[\s-]+/g, '_');
  if (TASK_STATUS_SET.has(normalized)) return normalized;
  if (TASK_STATUS_ALIASES[normalized]) return TASK_STATUS_ALIASES[normalized];
  return 'backlog';
}

function normalizeTaskList(list) {
  let changed = false;
  const next = list.map(task => {
    const normalized = normalizeTaskStatus(task?.status);
    if (normalized !== task?.status) {
      changed = true;
      return { ...task, status: normalized };
    }
    return task;
  });
  return { next, changed };
}

async function getTasks() {
  const { value: list } = await readUserScoped(TASKS_KEY, [], isEmptyList);
  const { next, changed } = normalizeTaskList(list);
  if (changed) await saveTasks(next);
  return next;
}

async function saveTasks(tasks) {
  const key = await AuthStore.getUserKey(TASKS_KEY);
  await chrome.storage.local.set({ [key]: tasks });
  if (globalThis.JobAutofill?.SyncQueue) {
    await globalThis.JobAutofill.SyncQueue.enqueue('patch', 'tasks', { list: tasks });
  }
}

function recomputeEpics(tasks) {
  const epics = tasks.filter(t => t.type === 'epic');
  for (const epic of epics) {
    const children = tasks.filter(t => t.parentId === epic.id && t.type !== 'epic');
    if (children.length === 0) continue;
    const allDone = children.every(c => c.status === 'done');
    const anyActive = children.some(c => c.status === 'in_progress' || c.status === 'blocked');
    const anyDone = children.some(c => c.status === 'done');
    const anyBacklog = children.some(c => c.status === 'backlog');
    const anyNew = children.some(c => c.status === 'new');
    let nextStatus = 'new';
    if (allDone) nextStatus = 'done';
    else if (anyActive || anyDone) nextStatus = 'in_progress';
    else if (anyBacklog) nextStatus = 'backlog';
    else if (anyNew) nextStatus = 'new';
    if (epic.status !== nextStatus) {
      epic.status = nextStatus;
      epic.updatedAt = new Date().toISOString();
    }
  }
  return tasks;
}

async function addTask(task) {
  const tasks = await getTasks();
  const now = new Date().toISOString();
  const isEpic = task.type === 'epic' || task.isEpic === true;
  const parentCandidate = isEpic ? '' : (task.parentId || '');
  const parentId = parentCandidate && parentCandidate !== task.id ? parentCandidate : '';
  const entryId = task.id && !tasks.some(t => t.id === task.id)
    ? task.id
    : (Date.now().toString(36) + Math.random().toString(36).substr(2, 5));
  const entry = {
    id: entryId,
    title: task.title || 'Untitled Task',
    description: task.description || '',
    status: normalizeTaskStatus(task.status || (isEpic ? 'new' : 'new')),
    priority: task.priority || 'medium',
    dueDate: task.dueDate || '',
    createdAt: now,
    updatedAt: now,
    tags: Array.isArray(task.tags) ? task.tags : [],
    type: isEpic ? 'epic' : 'task',
    parentId,
  };
  tasks.unshift(entry);
  const next = recomputeEpics(tasks);
  await saveTasks(next);
  return next;
}

async function updateTask(id, updates) {
  const tasks = await getTasks();
  const task = tasks.find(t => t.id === id);
  if (task) {
    const nextUpdates = { ...(updates || {}) };
    if (nextUpdates.status !== undefined) {
      nextUpdates.status = normalizeTaskStatus(nextUpdates.status);
    }
    if (nextUpdates.type === 'epic') {
      nextUpdates.parentId = '';
    }
    if (task.type === 'epic' && nextUpdates.parentId !== undefined) {
      delete nextUpdates.parentId;
    }
    if (nextUpdates.parentId && nextUpdates.parentId === id) {
      nextUpdates.parentId = '';
    }
    Object.assign(task, nextUpdates, { updatedAt: new Date().toISOString() });
    const next = recomputeEpics(tasks);
    await saveTasks(next);
    return next;
  }
  return tasks;
}

async function deleteTask(id) {
  let tasks = await getTasks();
  const removed = tasks.find(t => t.id === id);
  tasks = tasks.filter(t => t.id !== id);
  if (removed?.type === 'epic') {
    const now = new Date().toISOString();
    tasks.forEach(t => {
      if (t.parentId === id) {
        t.parentId = '';
        t.updatedAt = now;
      }
    });
  }
  const next = recomputeEpics(tasks);
  await saveTasks(next);
  return next;
}


async function resolveSiteKeyForHost(hostname) {
  const data = await getData();
  return resolveSiteKey(data, hostname) || hostname;
}

// ── Session Helpers (Multi-page forms) ────────────────────────
async function getSessionStore() {
  const key = await AuthStore.getUserKey(SESSION_KEY);
  const result = await chrome.storage.local.get(key);
  const store = result[key] || {};
  const now = Date.now();
  let changed = false;
  for (const [siteKey, entry] of Object.entries(store)) {
    const updatedAt = new Date(entry?.updatedAt || 0).getTime();
    if (!updatedAt || (now - updatedAt) > SESSION_TTL_MS) {
      delete store[siteKey];
      changed = true;
    }
  }
  if (changed) {
    await chrome.storage.local.set({ [key]: store });
  }
  return store;
}

async function saveSessionStore(store) {
  const key = await AuthStore.getUserKey(SESSION_KEY);
  await chrome.storage.local.set({ [key]: store });
}

async function getSessionEntry(hostname) {
  const siteKey = await resolveSiteKeyForHost(hostname);
  const store = await getSessionStore();
  const entry = store[siteKey] || { fields: {}, flags: {} };
  if (!entry.fields) entry.fields = {};
  if (!entry.flags) entry.flags = {};
  return { siteKey, entry, store };
}

async function getSessionFields(hostname) {
  const { entry } = await getSessionEntry(hostname);
  return entry.fields || {};
}

async function mergeSessionFields(hostname, fields) {
  const siteKey = await resolveSiteKeyForHost(hostname);
  const store = await getSessionStore();
  const entry = store[siteKey] || { fields: {}, flags: {} };
  entry.fields = { ...(entry.fields || {}), ...(fields || {}) };
  entry.updatedAt = new Date().toISOString();
  store[siteKey] = entry;
  await saveSessionStore(store);
  return entry.fields;
}

async function clearSessionFields(hostname) {
  const siteKey = await resolveSiteKeyForHost(hostname);
  const store = await getSessionStore();
  delete store[siteKey];
  await saveSessionStore(store);
}

async function setSessionFlags(hostname, flags) {
  const { siteKey, entry, store } = await getSessionEntry(hostname);
  entry.flags = { ...(entry.flags || {}), ...(flags || {}) };
  entry.updatedAt = new Date().toISOString();
  store[siteKey] = entry;
  await saveSessionStore(store);
  return entry.flags;
}

// ── Message Handler ────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) {
    sendResponse({ ok: false, error: 'Invalid message: missing type' });
    return false;
  }

  (async () => {
    try {
      const result = await handleMessage(msg, sender);
      sendResponse(result);
    } catch (err) {
      console.error(`[Background] Error handling ${msg.type}:`, err);
      sendResponse({ ok: false, error: err.message || 'Unknown background error' });
    }
  })();
  return true; // async response
});

async function handleMessage(msg, sender) {
  // ── Autofill / Site Data ─────────────────────────────────────
  switch (msg.type) {
    case 'FRAME_HELLO': {
      registerFrame(sender);
      return { ok: true };
    }

    case 'BROADCAST_TO_FRAMES': {
      const tabId = msg.tabId !== undefined ? msg.tabId : sender?.tab?.id;
      return await broadcastToTabFrames(tabId, msg.payload);
    }

    case 'LOG_EVENT': {
      registerFrame(sender);
      const now = new Date().toISOString();
      queueDebugLog({
        ts: now,
        tabId: sender?.tab?.id,
        frameId: sender?.frameId,
        ...msg.event
      });
      return { ok: true };
    }

    case 'LOG_GET': {
      await flushDebugLogs();
      const key = await AuthStore.getUserKey(DEBUG_LOG_KEY);
      const result = await chrome.storage.local.get(key);
      const logs = Array.isArray(result[key]) ? result[key] : [];
      return { ok: true, logs };
    }

    case 'LOG_CLEAR': {
      const key = await AuthStore.getUserKey(DEBUG_LOG_KEY);
      await chrome.storage.local.set({ [key]: [] });
      debugLogBuffer = [];
      if (debugFlushTimer) {
        clearTimeout(debugFlushTimer);
        debugFlushTimer = null;
      }
      return { ok: true };
    }

    case 'GET_SITE_KEY': {
      const data = await getData();
      return { siteKey: resolveSiteKey(data, msg.hostname) };
    }

    case 'GET_SITE_DATA': {
      const data = await getData();
      const siteKey = resolveSiteKey(data, msg.hostname);
      const site = data.sites[siteKey] || { enabled: true, fields: {}, mappings: [], flags: {}, metrics: {}, sandbox: {} };
      return { site, siteKey };
    }

    case 'GLOBAL_ALIAS_GET': {
      const data = await getData();
      return { ok: true, aliases: data.globalAliases || {} };
    }

    case 'GLOBAL_ALIAS_MERGE': {
      const label = normalizeAliasLabel(msg.label);
      const key = (msg.key || '').toString().trim();
      if (!label || !key) return { ok: false, error: 'Missing label or key' };
      const data = await getData();
      const aliases = { ...(data.globalAliases || {}) };
      const current = aliases[label];
      const nextCount = current?.key === key
        ? Math.min(Number(current.count || 0) + 1, GLOBAL_ALIAS_PROMOTE_MAX)
        : 1;
      aliases[label] = {
        key,
        count: nextCount,
        updatedAt: new Date().toISOString(),
      };
      data.globalAliases = aliases;
      await saveData(data);
      queueCloudSync();
      return { ok: true, aliases };
    }

    case 'SET_ENABLED': {
      const data = await getData();
      const siteKey = resolveSiteKey(data, msg.hostname);
      if (!data.sites[siteKey]) data.sites[siteKey] = { enabled: false, fields: {}, flags: {}, metrics: {}, sandbox: {} };
      data.sites[siteKey].enabled = !!msg.enabled;
      if (msg.clearDisabled) data.sites[siteKey].disabled = false;
      await saveData(data);
      queueCloudSync();
      if (sender?.tab?.id !== undefined) {
        broadcastToTabFrames(sender.tab.id, { type: 'SITE_SETTINGS_UPDATE', enabled: data.sites[siteKey].enabled }).catch(() => { });
      }
      return { ok: true };
    }

    case 'SAVE_FIELDS': {
      // Under the lock: all_frames means several frames of one page save at once.
      return withStorageLock(async () => {
        const data = await getData();
        const siteKey = resolveSiteKey(data, msg.hostname);
        if (isSiteDisabled(data, siteKey)) return { ok: false, error: 'Site disabled' };
        if (!data.sites[siteKey]) data.sites[siteKey] = { enabled: true, fields: {}, flags: {}, metrics: {}, sandbox: {} };
        data.sites[siteKey].fields = Object.assign({}, data.sites[siteKey].fields, msg.fields || {});
        await saveData(data);
        queueCloudSync();
        return { ok: true };
      });
    }

    case 'SANDBOX_MERGE': {
      const data = await getData();
      const siteKey = resolveSiteKey(data, msg.hostname);
      if (isSiteDisabled(data, siteKey)) return { ok: false, error: 'Site disabled' };
      if (!data.sites[siteKey]) data.sites[siteKey] = { enabled: true, fields: {}, mappings: [], flags: {}, metrics: {}, sandbox: {} };
      const sandbox = data.sites[siteKey].sandbox || {};
      const fields = msg.fields || {};
      const sessionId = msg.sessionId || 'default';
      const now = new Date().toISOString();
      let promoted = 0;

      Object.entries(fields).forEach(([key, value]) => {
        if (value === undefined || value === null || value === '') return;
        const existing = sandbox[key];
        if (!existing || existing.value !== value) {
          sandbox[key] = { value, count: 1, lastSessionId: sessionId, updatedAt: now };
          return;
        }
        if (existing.lastSessionId !== sessionId) {
          existing.count = (existing.count || 1) + 1;
          existing.lastSessionId = sessionId;
          existing.updatedAt = now;
        }
        if (existing.count >= 2) {
          data.sites[siteKey].fields[key] = value;
          delete sandbox[key];
          promoted += 1;
        }
      });

      data.sites[siteKey].sandbox = sandbox;
      await saveData(data);
      if (promoted > 0) queueCloudSync();
      return { ok: true, promoted };
    }

    case 'SITE_METRICS_UPDATE': {
      const stats = msg.stats || {};
      const detected = Number(stats.detected || 0);
      if (detected < 3) return { ok: false, skipped: true };
      const data = await getData();
      const siteKey = resolveSiteKey(data, msg.hostname);
      if (!data.sites[siteKey]) data.sites[siteKey] = { enabled: true, fields: {}, mappings: [], flags: {}, metrics: {}, sandbox: {} };
      const metrics = data.sites[siteKey].metrics || {};
      const score = computeQualityScore(stats);
      const samples = Number(metrics.samples || 0);
      const nextSamples = samples + 1;
      const prevAvg = Number(metrics.avgScore || score);
      const avgScore = Math.round(((prevAvg * samples) + score) / nextSamples);
      metrics.samples = nextSamples;
      metrics.avgScore = avgScore;
      metrics.last = {
        detected: Number(stats.detected || 0),
        matched: Number(stats.matched || 0),
        filled: Number(stats.filled || 0),
        score,
        ts: new Date().toISOString(),
      };
      data.sites[siteKey].metrics = metrics;
      await saveData(data);
      return { ok: true, metrics };
    }

    case 'USAGE_METRICS_UPDATE': {
      const stats = msg.stats || {};
      const metrics = await recordUsageMetrics(msg.hostname, stats);
      if (metrics) queueCloudSync();
      return { ok: true, metrics };
    }

    case 'GET_SITE_MAPPINGS': {
      const data = await getData();
      const siteKey = resolveSiteKey(data, msg.hostname);
      const site = data.sites[siteKey] || { enabled: true, fields: {}, mappings: [], flags: {}, metrics: {}, sandbox: {} };
      return { ok: true, mappings: site.mappings || [], siteKey };
    }

    case 'SAVE_SITE_MAPPING': {
      if (!msg.mapping || !msg.hostname) return { ok: false, error: 'Missing mapping/hostname' };
      const data = await getData();
      const siteKey = resolveSiteKey(data, msg.hostname);
      if (isSiteDisabled(data, siteKey)) return { ok: false, error: 'Site disabled' };
      if (!data.sites[siteKey]) data.sites[siteKey] = { enabled: true, fields: {}, mappings: [], flags: {}, metrics: {}, sandbox: {} };
      if (!Array.isArray(data.sites[siteKey].mappings)) data.sites[siteKey].mappings = [];
      const mappings = data.sites[siteKey].mappings;
      const idx = mappings.findIndex(m => m.signature === msg.mapping.signature);
      const normalized = {
        signature: msg.mapping.signature,
        mappedKey: msg.mapping.mappedKey,
        label: msg.mapping.label || '',
        type: msg.mapping.type || '',
        hints: msg.mapping.hints || {},
        updatedAt: new Date().toISOString(),
      };
      if (idx >= 0) {
        mappings[idx] = { ...mappings[idx], ...normalized, hints: normalized.hints || mappings[idx].hints || {} };
      } else {
        mappings.push(normalized);
      }
      data.sites[siteKey].mappings = mappings;
      await saveData(data);
      queueCloudSync();
      return { ok: true, mappings };
    }

    case 'SET_SITE_FLAGS': {
      const data = await getData();
      const siteKey = resolveSiteKey(data, msg.hostname);
      if (!data.sites[siteKey]) data.sites[siteKey] = { enabled: true, fields: {}, mappings: [], flags: {}, metrics: {}, sandbox: {} };
      data.sites[siteKey].flags = { ...(data.sites[siteKey].flags || {}), ...(msg.flags || {}) };
      await saveData(data);
      queueCloudSync();
      if (sender?.tab?.id !== undefined) {
        broadcastToTabFrames(sender.tab.id, { type: 'SITE_SETTINGS_UPDATE', flags: data.sites[siteKey].flags }).catch(() => { });
      }
      return { ok: true, flags: data.sites[siteKey].flags };
    }

    case 'SESSION_GET': {
      const { entry } = await getSessionEntry(msg.hostname);
      return { ok: true, fields: entry.fields || {}, flags: entry.flags || {} };
    }

    case 'SESSION_MERGE': {
      const data = await getData();
      const siteKey = resolveSiteKey(data, msg.hostname);
      if (isSiteDisabled(data, siteKey)) return { ok: false, error: 'Site disabled' };
      const fields = await mergeSessionFields(msg.hostname, msg.fields || {});
      return { ok: true, fields };
    }

    case 'SESSION_SET_FLAGS': {
      const data = await getData();
      const siteKey = resolveSiteKey(data, msg.hostname);
      if (isSiteDisabled(data, siteKey)) return { ok: false, error: 'Site disabled' };
      const flags = await setSessionFlags(msg.hostname, msg.flags || {});
      return { ok: true, flags };
    }

    case 'SESSION_CLEAR': {
      await clearSessionFields(msg.hostname);
      return { ok: true };
    }

    case 'TEACH_MODE_DONE': {
      return { ok: true };
    }

    case 'DISABLE_SITE': {
      const data = await getData();
      const siteKey = resolveSiteKey(data, msg.hostname);
      if (!data.sites[siteKey]) data.sites[siteKey] = { enabled: false, fields: {}, flags: {}, metrics: {}, sandbox: {} };
      data.sites[siteKey].disabled = true;
      data.sites[siteKey].enabled = false; // Also disable if specifically blocked
      await saveData(data);
      if (globalThis.JobAutofill?.SyncQueue) {
        await globalThis.JobAutofill.SyncQueue.enqueue('patch', 'autofill', data);
      }
      queueCloudSync();
      return { ok: true };
    }

    // ── Excluded Sites (Not a Job Portal) ──────────────────────────
    case 'EXCLUDE_SITE': {
      const data = await getData();
      const host = (msg.hostname || '').toLowerCase().replace(/^www\./, '');
      if (!host) return { ok: false, error: 'No hostname provided' };

      const isAlreadyCovered = data.excludedSites.some(h => host === h || host.endsWith('.' + h));
      if (!isAlreadyCovered) {
        // Remove any existing subdomains of this new broader exclusion
        data.excludedSites = data.excludedSites.filter(h => !h.endsWith('.' + host));
        data.excludedSites.push(host);
      }

      // Also disable the site
      const siteKey = resolveSiteKey(data, host);
      if (!data.sites[siteKey]) data.sites[siteKey] = { enabled: false, fields: {}, flags: {}, metrics: {}, sandbox: {} };
      data.sites[siteKey].disabled = true;
      data.sites[siteKey].enabled = false;
      await saveData(data);
      if (globalThis.JobAutofill?.SyncQueue) {
        await globalThis.JobAutofill.SyncQueue.enqueue('patch', 'autofill', data);
      }
      queueCloudSync();
      // Broadcast to content scripts in the current tab
      if (sender?.tab?.id !== undefined) {
        broadcastToTabFrames(sender.tab.id, { type: 'SITE_EXCLUDED_UPDATE', excluded: true }).catch(() => { });
        broadcastToTabFrames(sender.tab.id, { type: 'AUTH_STATE_CHANGED', loggedIn: false }).catch(() => { }); // Reset local state just in case
      }
      return { ok: true };
    }

    case 'UNEXCLUDE_SITE': {
      const data = await getData();
      const host = (msg.hostname || '').toLowerCase().replace(/^www\./, '');
      if (!host) return { ok: false, error: 'No hostname provided' };

      // Remove exact matches and parent matches
      data.excludedSites = data.excludedSites.filter(h => {
        return h !== host && !host.endsWith('.' + h) && !h.endsWith('.' + host);
      });

      // Re-enable the site
      const siteKey = resolveSiteKey(data, host);
      if (data.sites[siteKey]) {
        data.sites[siteKey].disabled = false;
        data.sites[siteKey].enabled = true;
      }
      await saveData(data);
      if (globalThis.JobAutofill?.SyncQueue) {
        await globalThis.JobAutofill.SyncQueue.enqueue('patch', 'autofill', data);
      }
      queueCloudSync();
      if (sender?.tab?.id !== undefined) {
        broadcastToTabFrames(sender.tab.id, { type: 'SITE_EXCLUDED_UPDATE', excluded: false }).catch(() => { });
        broadcastToTabFrames(sender.tab.id, { type: 'SITE_SETTINGS_UPDATE', enabled: true }).catch(() => { });
      }
      return { ok: true };
    }

    case 'IS_SITE_EXCLUDED': {
      const data = await getData();
      const host = (msg.hostname || '').toLowerCase().replace(/^www\./, '');
      const isExcluded = data.excludedSites.some(h => host === h || host.endsWith('.' + h));
      return { excluded: isExcluded };
    }

    case 'GET_EXCLUDED_SITES': {
      const data = await getData();
      return { ok: true, excludedSites: data.excludedSites || [] };
    }

    case 'CLEAR_SITE': {
      const data = await getData();
      const siteKey = resolveSiteKey(data, msg.hostname);
      if (data.sites[siteKey]) {
        data.sites[siteKey].fields = {};
        if (data.sites[siteKey].flags) {
          delete data.sites[siteKey].flags.neverPrompt;
        }
        data.sites[siteKey].metrics = {};
        data.sites[siteKey].sandbox = {};
      }
      await saveData(data);
      if (globalThis.JobAutofill?.SyncQueue) {
        await globalThis.JobAutofill.SyncQueue.enqueue('patch', 'autofill', data);
      }
      return { ok: true };
    }

    case 'RENAME_SITE': {
      const data = await getData();
      const oldKey = resolveSiteKey(data, msg.hostname);
      const newKey = (msg.newKey || '').trim();
      if (!newKey || newKey === oldKey) return { ok: false, error: 'Invalid or duplicate key' };
      if (data.sites[oldKey]) {
        data.sites[newKey] = data.sites[oldKey];
        delete data.sites[oldKey];
      }
      data.hostnameMappings[msg.hostname] = newKey;
      await saveData(data);
      if (globalThis.JobAutofill?.SyncQueue) {
        await globalThis.JobAutofill.SyncQueue.enqueue('patch', 'autofill', data);
      }
      return { ok: true, newKey };
    }

    case 'IMPORT_SITE_DATA': {
      // The dashboard used to write chrome.storage.local.autofill_data directly,
      // but every reader goes through AuthStore.getUserKey() — so imported sites
      // silently vanished for any signed-in user.
      if (!msg.data || typeof msg.data !== 'object') {
        return { ok: false, error: 'No data supplied' };
      }
      const existing = await getData();
      const merged = {
        ...existing,
        sites: { ...(existing.sites || {}), ...(msg.data.sites || {}) },
        hostnameMappings: { ...(existing.hostnameMappings || {}), ...(msg.data.hostnameMappings || {}) },
      };
      await saveData(merged);
      return { ok: true, siteCount: Object.keys(merged.sites || {}).length };
    }

    case 'GET_ALL_DATA': {
      const data = await getData();
      return { data };
    }

    case 'GET_USAGE_METRICS': {
      const metrics = await getUsageMetrics();
      return { ok: true, metrics };
    }

    case 'GET_GLOBAL_PROFILE': {
      const profile = await getGlobalProfile();
      return { profile };
    }

    case 'SAVE_GLOBAL_PROFILE': {
      if (!msg.profile || typeof msg.profile !== 'object') {
        return { ok: false, error: 'Invalid profile data' };
      }
      await saveGlobalProfile(msg.profile);
      queueCloudSync();
      return { ok: true };
    }

    // ── AI Settings ──────────────────────────────────────────────
    case 'AI_GET_SETTINGS': {
      const settings = await getAiSettings();
      return { settings };
    }

    // Content scripts only ever need the boolean. AI_GET_SETTINGS returns the
    // user's plaintext API key, and a content script runs in every frame of every
    // page — there is no reason for the key to be there.
    case 'AI_IS_ENABLED': {
      const settings = await getAiSettings();
      return { ok: true, enabled: !!(settings?.enabled && settings?.apiKey) };
    }

    case 'AI_SAVE_SETTINGS': {
      if (!msg.settings) return { ok: false, error: 'Missing settings' };
      await saveAiSettings(msg.settings);
      queueCloudSync();
      return { ok: true };
    }

    case 'AI_CHECK_BUILTIN': {
      return await checkBuiltInAI();
    }

    case 'AI_GET_PROVIDERS': {
      return { providers: AI_PROVIDERS };
    }

    case 'AI_TEST_CONNECTION': {
      const settings = await getAiSettings();

      if (settings.provider === 'built-in') {
        const check = await checkBuiltInAI();
        if (!check.available) return { ok: false, error: check.reason };
      } else if (!settings.apiKey) {
        return { ok: false, error: 'No API key set' };
      }

      const tempSettings = { ...settings, enabled: true };
      await saveAiSettings(tempSettings);
      try {
        await callAI('Reply with exactly: OK', { temperature: 0, maxTokens: 10 });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      } finally {
        await saveAiSettings(settings); // restore original
      }
    }

    // ── AI Features ──────────────────────────────────────────────
    case 'AI_PARSE_RESUME': {
      if (!msg.text) return { ok: false, error: 'No resume text provided' };
      const parsed = await parseResume(msg.text);
      return { ok: true, parsed };
    }

    case 'AI_SCORE_MATCH': {
      if (!msg.jobDescription) return { ok: false, error: 'No job description provided' };
      const profile = await getGlobalProfile();
      const score = await scoreJobMatch(msg.jobDescription, profile);
      return { ok: true, score };
    }

    case 'AI_TAILOR_RESUME': {
      if (!msg.jobDescription) return { ok: false, error: 'No job description provided' };
      const profile = await getGlobalProfile();
      const tailored = await tailorResume(msg.jobDescription, profile);
      return { ok: true, tailored };
    }

    case 'AI_GENERATE_ANSWER': {
      if (!msg.question) return { ok: false, error: 'No question provided' };
      const profile = await getGlobalProfile();
      const answer = await generateAnswer(msg.question, msg.jobContext || '', profile);
      return { ok: true, answer };
    }

    case 'AI_MATCH_FIELDS': {
      const profile = await getGlobalProfile();
      const profileFields = Object.keys(profile);
      const mapping = await matchFields(msg.fieldLabels || [], profileFields);
      return { ok: true, mapping };
    }

    case 'AI_EXTRACT_JOB': {
      if (!msg.pageContent) return { ok: false, error: 'No page content provided' };
      const info = await extractJobInfo(msg.pageContent);
      return { ok: true, info };
    }

    case 'AI_INTERVIEW_PREP': {
      if (!msg.jobDescription) return { ok: false, error: 'No job description provided' };
      const profile = await getGlobalProfile();
      const prep = await generateInterviewQuestions(msg.jobDescription, profile);
      return { ok: true, prep };
    }

    case 'AI_FOLLOW_UP': {
      if (!msg.application) return { ok: false, error: 'No application provided' };
      const profile = await getGlobalProfile();
      const email = await generateFollowUp(msg.application, profile);
      return { ok: true, email };
    }

    // ── Application Tracker ──────────────────────────────────────
    case 'APP_GET_ALL': {
      const apps = await getApplications();
      return { apps };
    }

    case 'APP_ADD': {
      if (!msg.application?.companyName) return { ok: false, error: 'Company name is required' };
      const apps = await addApplication(msg.application);
      queueCloudSync();
      return { ok: true, apps };
    }

    case 'APP_UPDATE': {
      if (!msg.id) return { ok: false, error: 'Application ID is required' };
      const apps = await updateApplication(msg.id, msg.updates || {});
      queueCloudSync();
      return { ok: true, apps };
    }

    case 'APP_DELETE': {
      if (!msg.id) return { ok: false, error: 'Application ID is required' };
      const apps = await deleteApplication(msg.id);
      queueCloudSync();
      return { ok: true, apps };
    }

    // ── Task Tracker ────────────────────────────────────────────
    case 'TASK_GET_ALL': {
      const tasks = await getTasks();
      return { tasks };
    }

    case 'TASK_ADD': {
      if (!msg.task?.title) return { ok: false, error: 'Task title is required' };
      const tasks = await addTask(msg.task);
      queueCloudSync();
      return { ok: true, tasks };
    }

    case 'TASK_UPDATE': {
      if (!msg.id) return { ok: false, error: 'Task ID is required' };
      const tasks = await updateTask(msg.id, msg.updates || {});
      queueCloudSync();
      return { ok: true, tasks };
    }

    case 'TASK_DELETE': {
      if (!msg.id) return { ok: false, error: 'Task ID is required' };
      const tasks = await deleteTask(msg.id);
      queueCloudSync();
      return { ok: true, tasks };
    }

    // ── Resume Vault (Local Only) ─────────────────────────────────
    case 'RESUME_LIST': {
      const data = await listResumes();
      return { ok: true, ...data };
    }

    case 'RESUME_GET': {
      if (!msg.id) return { ok: false, error: 'Resume ID required' };
      const resume = await getResumeById(msg.id);
      if (!resume) return { ok: false, error: 'Resume not found' };
      return { ok: true, resume };
    }

    case 'RESUME_ADD': {
      if (!msg.resume) return { ok: false, error: 'Missing resume data' };
      if (!msg.resume.dataUrl && !msg.resume.id) {
        return { ok: false, error: 'Missing resume file' };
      }
      const entry = await addOrUpdateResume(msg.resume);
      queueCloudSync();
      return { ok: true, resume: sanitizeResumeMeta(entry) };
    }

    case 'RESUME_DELETE': {
      if (!msg.id) return { ok: false, error: 'Resume ID required' };
      const data = await deleteResume(msg.id);
      queueCloudSync();
      return { ok: true, items: data.items.map(sanitizeResumeMeta), defaultId: data.defaultId || null };
    }

    case 'RESUME_SET_DEFAULT': {
      if (!msg.id) return { ok: false, error: 'Resume ID required' };
      const data = await setDefaultResume(msg.id);
      queueCloudSync();
      return { ok: true, items: data.items.map(sanitizeResumeMeta), defaultId: data.defaultId || null };
    }

    // ── Cloud Sync ────────────────────────────────────────────────
    case 'GET_EXT_SETTINGS': {
      return { ok: true, settings: await getExtSettings() };
    }

    case 'SAVE_EXT_SETTINGS': {
      const settings = await saveExtSettings(msg.settings || {});
      // Open tabs gate on this, so re-evaluate them immediately.
      const auth = await AuthStore.getAuthState();
      await broadcastAuthState(!!auth);
      return { ok: true, settings };
    }

    case 'CLOUD_GET_PREFS': {
      const { prefs } = await getCloudPrefs();
      return { ok: true, prefs };
    }

    case 'CLOUD_SAVE_PREFS': {
      const prefs = await saveCloudPrefs(msg.prefs || {});
      return { ok: true, prefs };
    }

    case 'CLOUD_DELETE_REMOTE': {
      const { prefs } = await getCloudPrefs();
      if (!prefs.enabled) return { ok: false, error: 'Cloud sync is disabled' };
      const keys = ['autofill', 'profile', 'ai_settings', 'applications', 'tasks', 'metrics', 'resumes', 'sync_meta'];
      if (typeof deleteCloudData === 'function') {
        await deleteCloudData(keys);
        return { ok: true };
      }
      return { ok: false, error: 'Delete not supported' };
    }

    case 'CLOUD_GET_STATUS': {
      if (typeof ensureFirebaseConfigLoaded === 'function') {
        await ensureFirebaseConfigLoaded();
      }
      const auth = await AuthStore.getAuthState();
      const meta = await getSyncMeta();
      return {
        configured: isCloudConfigured(),
        loggedIn: !!auth,
        user: auth ? { email: auth.email, displayName: auth.displayName } : null,
        lastSync: meta,
      };
    }

    case 'CLOUD_GET_CONFIG': {
      if (typeof getCloudConfig === 'function') {
        const config = await getCloudConfig();
        return { ok: true, config };
      }
      return { ok: false, error: 'Cloud config not available' };
    }

    case 'CLOUD_SAVE_CONFIG': {
      if (!msg.config) return { ok: false, error: 'Missing config' };
      if (typeof saveCloudConfig === 'function') {
        const config = await saveCloudConfig(msg.config);
        return { ok: true, config };
      }
      return { ok: false, error: 'Cloud config not available' };
    }

    case 'CLOUD_SIGN_UP': {
      if (!msg.email || !msg.password) return { ok: false, error: 'Email and password are required' };
      console.log('[Cloud] Sign up attempt');
      const auth = await cloudSignUp(msg.email, msg.password, msg.displayName || '');
      await finishSignIn('push');
      return { ok: true, user: { email: auth.email, displayName: auth.displayName } };
    }

    case 'CLOUD_SIGN_IN': {
      if (!msg.email || !msg.password) return { ok: false, error: 'Email and password are required' };
      console.log('[Cloud] Sign in attempt');
      const auth = await cloudSignIn(msg.email, msg.password);
      await finishSignIn('pull-then-push');
      return { ok: true, user: { email: auth.email, displayName: auth.displayName } };
    }

    case 'CLOUD_SIGN_IN_GOOGLE': {
      if (!msg.accessToken) return { ok: false, error: 'Google Access Token is required' };
      const auth = await cloudSignInWithGoogle(msg.accessToken);
      await finishSignIn('pull-then-push');
      return { ok: true, user: { email: auth.email, displayName: auth.displayName } };
    }

    case 'CLOUD_GET_SYNC_STATE': {
      return { ok: true, ...initialSyncState };
    }

    case 'CLOUD_SIGN_OUT': {
      try {
        const auth = await AuthStore.getAuthState();
        const userId = auth?.userId;

        // 1. Clear Google identity cache
        try { await clearGoogleIdentityTokenCache(); } catch (_) { }

        // 2. Official sign out (clears Firebase token)
        await cloudSignOut();

        // 3. Try to get local work to the cloud BEFORE deleting it. Signing out
        //    while offline used to destroy the only copy of anything that had not
        //    synced yet. If the push fails, keep the data and say so — the caller
        //    can re-issue with force:true once the user has accepted the loss.
        if (userId && !msg.force) {
          let pushed = false;
          try {
            const { prefs } = await getCloudPrefs();
            if (prefs.enabled) {
              await pushAllToCloud(prefs);
              pushed = true;
            }
          } catch (err) {
            console.warn('[Cloud] Final push before sign-out failed:', err);
          }
          if (!pushed) {
            // Sync off, or the push failed — either way the cloud does not have
            // this data, and the sweep below is the only copy's last moment.
            return {
              ok: false,
              needsConfirm: true,
              error: 'Your data has not been backed up to the cloud. Sign out anyway and delete it from this device?',
            };
          }
        }

        // 4. Clear ALL user-scoped storage keys if we have a userId
        if (userId) {
          const userPrefix = 'user_' + userId + '_';
          const allLocal = await chrome.storage.local.get(null);
          const userKeys = Object.keys(allLocal).filter(k => k.startsWith(userPrefix));
          if (userKeys.length > 0) {
            await chrome.storage.local.remove(userKeys);
          }
        }

        // 4. Clear AuthStore and general local caches
        await AuthStore.clearAuthState();
        await chrome.storage.local.remove(['cloud_sync_meta', 'cloud_config', 'session_store']);

        // 5. Reset in-memory state — the derived sync key must never survive into
        //    the next account's session.
        globalThis.currentSyncKey = null;
        globalThis.syncKeySalt = null;
        await chrome.storage.local.remove([SYNC_SALT_KEY]); // legacy non-user-scoped salt
        // Not user-scoped, so the prefix sweep misses it. Anything still queued
        // belongs to the account signing out.
        try { await SyncQueue.clearQueue(); } catch (_) { }
        debugLogBuffer = [];
        if (debugFlushTimer) { clearTimeout(debugFlushTimer); debugFlushTimer = null; }
        if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }

        // 6. Notify all tabs to reset their state
        await broadcastAuthState(false);

        console.log('[Cloud] Comprehensive logout complete.');
        return { ok: true };
      } catch (err) {
        console.error('[Cloud] Logout failure:', err);
        return { ok: false, error: err.message };
      }
    }

    case 'CLOUD_RESET_PASSWORD': {
      if (!msg.email) return { ok: false, error: 'Email is required' };
      await cloudResetPassword(msg.email);
      return { ok: true };
    }

    case 'CLOUD_PUSH': {
      const { prefs } = await getCloudPrefs();
      await pushAllToCloud(prefs);
      return { ok: true };
    }

    case 'CLOUD_PULL': {
      const { prefs } = await getCloudPrefs();
      await pullAllFromCloud(prefs);
      return { ok: true };
    }

    case 'CLOUD_SYNC': {
      // Pull first (get latest), then push (upload merged)
      const { prefs } = await getCloudPrefs();
      await pullAllFromCloud(prefs);
      await pushAllToCloud(prefs);
      return { ok: true };
    }

    case 'SET_SYNC_PASSPHRASE': {
      if (!msg.passphrase) return { ok: false, error: 'Passphrase required' };
      try {
        const auth = await AuthStore.getAuthState();
        if (!auth) return { ok: false, error: 'User must be logged in' };

        const meta = await loadSyncMeta();
        const saltB64 = meta.salt || CryptoUtils.b64Encode(CryptoUtils.generateSalt());
        const salt = CryptoUtils.b64Decode(saltB64);
        const key = await CryptoUtils.deriveKey(msg.passphrase, salt);

        // Verify against the stored probe so a typo is reported as a wrong
        // passphrase instead of silently deriving a key that fails against real
        // data later.
        const verified = await verifySyncKey(key, meta.verifier);
        if (verified === false) {
          return { ok: false, error: 'Incorrect passphrase for this account' };
        }

        const probe = verified === null ? await CryptoUtils.encrypt(SYNC_VERIFIER_PROBE, key) : null;
        await saveSyncMeta({
          salt: saltB64,
          verifier: probe ? { iv: probe.iv, ciphertext: probe.ciphertext } : meta.verifier,
          saltKey: meta.saltKey,
          verifierKey: meta.verifierKey,
        });

        globalThis.syncKeySalt = salt;
        globalThis.currentSyncKey = key;
        console.log('[Security] Sync key successfully derived.');
        return { ok: true, firstTime: verified === null };
      } catch (err) {
        console.error('[Security] Failed to set sync passphrase:', err);
        return { ok: false, error: 'Failed to derive security key' };
      }
    }

    case 'GET_SYNC_STATUS': {
      const hasSyncKey = !!globalThis.currentSyncKey;
      return {
        ok: true,
        hasSyncKey,
        hasKey: hasSyncKey, // alias kept for older callers
        isEncrypted: hasSyncKey
      };
    }

    case 'OPEN_DASHBOARD': {
      try {
        const hash = typeof msg.hash === 'string' ? msg.hash : '';
        const url = chrome.runtime.getURL('dashboard/dashboard.html') + hash;
        await chrome.tabs.create({ url });
        return { ok: true };
      } catch (err) {
        console.warn('[Background] OPEN_DASHBOARD failed:', err);
        return { ok: false, error: err?.message || 'Failed to open dashboard' };
      }
    }

    default:
      return { ok: false, error: `Unknown message type: ${msg.type}` };
  }
}

// ── Auto Cloud Sync (debounced) ────────────────────────────────
let syncTimer = null;
function queueCloudSync() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    try {
      const auth = await AuthStore.getAuthState();
      const { prefs } = await getCloudPrefs();
      if (typeof ensureFirebaseConfigLoaded === 'function') {
        await ensureFirebaseConfigLoaded();
      }
      if (auth && isCloudConfigured() && prefs.enabled) {
        console.log('[Cloud] Auto-syncing...');
        // Pull latest first to keep local in sync, then push merged updates
        await pullAllFromCloud(prefs);
        if (globalThis.CloudSync?.drainSyncQueue) {
          await globalThis.CloudSync.drainSyncQueue();
        } else {
          await pushAllToCloud(prefs);
        }
        console.log('[Cloud] Auto-sync complete.');
      }
    } catch (err) {
      console.warn('[Cloud] Auto-sync failed:', err.message);
    }
  }, 5000); // 5 second debounce
}

// ── Periodic Cloud Pull (keeps local updated) ──────────────────
const CLOUD_PULL_ALARM = 'cloud_pull_alarm';
if (chrome.alarms) {
  chrome.alarms.create(CLOUD_PULL_ALARM, { periodInMinutes: 5 });
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm?.name !== CLOUD_PULL_ALARM) return;
    try {
      const auth = await AuthStore.getAuthState();
      const { prefs } = await getCloudPrefs();
      if (typeof ensureFirebaseConfigLoaded === 'function') {
        await ensureFirebaseConfigLoaded();
      }
      if (auth && isCloudConfigured() && prefs.enabled) {
        await pullAllFromCloud(prefs);
      }
    } catch (err) {
      console.warn('[Cloud] Periodic pull failed:', err.message);
    }
  });
}

// One-time pull on service worker start (if already logged in)
(async () => {
  try {
    const auth = await AuthStore.getAuthState();
    const { prefs } = await getCloudPrefs();
    if (typeof ensureFirebaseConfigLoaded === 'function') {
      await ensureFirebaseConfigLoaded();
    }
    if (auth && isCloudConfigured() && prefs.enabled) {
      await pullAllFromCloud(prefs);
    }
  } catch (err) {
    console.warn('[Cloud] Startup pull failed:', err.message);
  }
})();
