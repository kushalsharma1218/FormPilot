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
importScripts('cloud-sync.js');

const STORAGE_KEY = 'autofill_data';
const GLOBAL_STORAGE_KEY = 'global_profile_data';
const RESUMES_KEY = 'resumes_data';
const METRICS_KEY = 'usage_metrics';
const SESSION_KEY = 'autofill_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CLOUD_PREFS_KEY = 'cloud_sync_prefs';
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
  const ok = results.some(r => r.status === 'fulfilled' && r.value && r.value.ok);
  return { ok };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  FRAME_REGISTRY.delete(tabId);
});

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

// ── Storage Helpers (Account Aware) ────────────────────────────
const AuthStore = (globalThis.JobAutofill && JobAutofill.AuthStore) || {
  getUserKey: async (baseKey) => baseKey,
  getAuthState: async () => null,
};

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
  if (auth) {
    prefs.enabled = true;
    prefs.syncProfile = true;
    prefs.syncAutofill = true;
    prefs.syncApplications = true;
    prefs.syncTasks = true;
    prefs.syncAiSettings = true;
    prefs.syncResumes = true;
    prefs.syncMetrics = true;
  }
  return { key, prefs };
}

async function saveCloudPrefs(next) {
  const { key, prefs } = await getCloudPrefs();
  const merged = { ...prefs, ...(next || {}) };
  if (merged.enabled) {
    merged.syncProfile = true;
    merged.syncAutofill = true;
    merged.syncApplications = true;
    merged.syncTasks = true;
    merged.syncAiSettings = true;
    merged.syncResumes = true;
    merged.syncMetrics = true;
  }
  await chrome.storage.local.set({ [key]: merged });
  return merged;
}

// ── Resume Vault (Local + Cloud Sync) ──────────────────────────
async function getResumesStore() {
  const key = await AuthStore.getUserKey(RESUMES_KEY);
  const result = await chrome.storage.local.get(key);
  const data = result[key] || { items: [], defaultId: null };
  if (!Array.isArray(data.items)) data.items = [];
  return { key, data };
}

async function saveResumesStore(key, data) {
  await chrome.storage.local.set({ [key]: data });
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
      const data = await getData();
      const siteKey = resolveSiteKey(data, msg.hostname);
      if (isSiteDisabled(data, siteKey)) return { ok: false, error: 'Site disabled' };
      if (!data.sites[siteKey]) data.sites[siteKey] = { enabled: true, fields: {}, flags: {}, metrics: {}, sandbox: {} };
      data.sites[siteKey].fields = Object.assign({}, data.sites[siteKey].fields, msg.fields || {});
      await saveData(data);
      queueCloudSync();
      return { ok: true };
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
      queueCloudSync();
      return { ok: true };
    }

    // ── Excluded Sites (Not a Job Portal) ──────────────────────────
    case 'EXCLUDE_SITE': {
      const data = await getData();
      const host = (msg.hostname || '').toLowerCase().replace(/^www\./, '');
      if (!host) return { ok: false, error: 'No hostname provided' };
      if (!data.excludedSites.includes(host)) {
        data.excludedSites.push(host);
      }
      // Also disable the site
      const siteKey = resolveSiteKey(data, host);
      if (!data.sites[siteKey]) data.sites[siteKey] = { enabled: false, fields: {}, flags: {}, metrics: {}, sandbox: {} };
      data.sites[siteKey].disabled = true;
      data.sites[siteKey].enabled = false;
      await saveData(data);
      queueCloudSync();
      // Broadcast to content scripts in the current tab
      if (sender?.tab?.id !== undefined) {
        broadcastToTabFrames(sender.tab.id, { type: 'SITE_EXCLUDED_UPDATE', excluded: true }).catch(() => { });
      }
      return { ok: true };
    }

    case 'UNEXCLUDE_SITE': {
      const data = await getData();
      const host = (msg.hostname || '').toLowerCase().replace(/^www\./, '');
      if (!host) return { ok: false, error: 'No hostname provided' };
      data.excludedSites = data.excludedSites.filter(h => h !== host);
      // Re-enable the site
      const siteKey = resolveSiteKey(data, host);
      if (data.sites[siteKey]) {
        data.sites[siteKey].disabled = false;
        data.sites[siteKey].enabled = true;
      }
      await saveData(data);
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
      return { excluded: data.excludedSites.includes(host) };
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
      return { ok: true, newKey };
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
      const keys = ['autofill', 'profile', 'ai_settings', 'applications', 'metrics', 'resumes'];
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
      console.log('[Cloud] Sign up attempt:', msg.email);
      const auth = await cloudSignUp(msg.email, msg.password, msg.displayName || '');
      // Auto-push local data to cloud on signup
      try {
        await saveCloudPrefs({ enabled: true });
        const { prefs } = await getCloudPrefs();
        if (prefs.enabled) await pushAllToCloud(prefs);
      } catch (e) { console.warn('[Cloud] Post-signup push failed:', e); }
      return { ok: true, user: { email: auth.email, displayName: auth.displayName } };
    }

    case 'CLOUD_SIGN_IN': {
      if (!msg.email || !msg.password) return { ok: false, error: 'Email and password are required' };
      console.log('[Cloud] Sign in attempt:', msg.email);
      const auth = await cloudSignIn(msg.email, msg.password);
      // Auto-pull cloud data on login
      try {
        await saveCloudPrefs({ enabled: true });
        const { prefs } = await getCloudPrefs();
        await pullAllFromCloud(prefs);
        await pushAllToCloud(prefs);
      } catch (e) { console.warn('[Cloud] Post-login sync failed:', e); }
      return { ok: true, user: { email: auth.email, displayName: auth.displayName } };
    }

    case 'CLOUD_SIGN_IN_GOOGLE': {
      if (!msg.accessToken) return { ok: false, error: 'Google Access Token is required' };
      const auth = await cloudSignInWithGoogle(msg.accessToken);
      // Auto-pull cloud data on login
      try {
        await saveCloudPrefs({ enabled: true });
        const { prefs } = await getCloudPrefs();
        await pullAllFromCloud(prefs);
        await pushAllToCloud(prefs);
      } catch (e) { console.warn('[Cloud] Post-login sync failed:', e); }
      return { ok: true, user: { email: auth.email, displayName: auth.displayName } };
    }

    case 'CLOUD_SIGN_OUT': {
      await cloudSignOut();
      return { ok: true };
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
        await pushAllToCloud(prefs);
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
  chrome.alarms.create(CLOUD_PULL_ALARM, { periodInMinutes: 3 });
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
