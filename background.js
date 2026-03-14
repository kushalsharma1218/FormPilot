// background.js — Service Worker (v2.2 with Cloud Sync)

importScripts('lib/auth-store.js');
importScripts('lib/ai-utils.js');
importScripts('lib/firestore-utils.js');
importScripts('ai-service.js');
importScripts('cloud-sync.js');

const STORAGE_KEY = 'autofill_data';
const GLOBAL_STORAGE_KEY = 'global_profile_data';
const SESSION_KEY = 'autofill_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ── Storage Helpers (Account Aware) ────────────────────────────
const AuthStore = (globalThis.JobAutofill && JobAutofill.AuthStore) || {
  getUserKey: async (baseKey) => baseKey,
  getAuthState: async () => null,
};

async function getData() {
  try {
    const key = await AuthStore.getUserKey(STORAGE_KEY);
    const result = await chrome.storage.local.get(key);
    const data = result[key] || {};
    // Ensure structure exists
    if (!data.sites) data.sites = {};
    if (!data.hostnameMappings) data.hostnameMappings = {};
    // Normalize site entries
    Object.values(data.sites).forEach(site => {
      if (!site.fields) site.fields = {};
      if (!Array.isArray(site.mappings)) site.mappings = [];
      if (site.enabled === undefined) site.enabled = !site.disabled;
    });
    return data;
  } catch (err) {
    console.error('[Background] getData error:', err);
    return { sites: {}, hostnameMappings: {} };
  }
}

async function saveData(data) {
  const key = await AuthStore.getUserKey(STORAGE_KEY);
  await chrome.storage.local.set({ [key]: data });
}

async function getGlobalProfile() {
  try {
    const key = await AuthStore.getUserKey(GLOBAL_STORAGE_KEY);
    const result = await chrome.storage.local.get(key);
    return result[key] || {};
  } catch (err) {
    console.error('[Background] getGlobalProfile error:', err);
    return {};
  }
}

async function saveGlobalProfile(profile) {
  const key = await AuthStore.getUserKey(GLOBAL_STORAGE_KEY);
  await chrome.storage.local.set({ [key]: profile });
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

async function getSessionFields(hostname) {
  const siteKey = await resolveSiteKeyForHost(hostname);
  const store = await getSessionStore();
  return store[siteKey]?.fields || {};
}

async function mergeSessionFields(hostname, fields) {
  const siteKey = await resolveSiteKeyForHost(hostname);
  const store = await getSessionStore();
  const entry = store[siteKey] || { fields: {} };
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
    case 'GET_SITE_KEY': {
      const data = await getData();
      return { siteKey: resolveSiteKey(data, msg.hostname) };
    }

    case 'GET_SITE_DATA': {
      const data = await getData();
      const siteKey = resolveSiteKey(data, msg.hostname);
      const site = data.sites[siteKey] || { enabled: true, fields: {}, mappings: [] };
      return { site, siteKey };
    }

    case 'SET_ENABLED': {
      const data = await getData();
      const siteKey = resolveSiteKey(data, msg.hostname);
      if (!data.sites[siteKey]) data.sites[siteKey] = { enabled: false, fields: {} };
      data.sites[siteKey].enabled = !!msg.enabled;
      if (msg.clearDisabled) data.sites[siteKey].disabled = false;
      await saveData(data);
      queueCloudSync();
      return { ok: true };
    }

    case 'SAVE_FIELDS': {
      const data = await getData();
      const siteKey = resolveSiteKey(data, msg.hostname);
      if (!data.sites[siteKey]) data.sites[siteKey] = { enabled: true, fields: {} };
      data.sites[siteKey].fields = Object.assign({}, data.sites[siteKey].fields, msg.fields || {});
      await saveData(data);
      queueCloudSync();
      return { ok: true };
    }

    case 'GET_SITE_MAPPINGS': {
      const data = await getData();
      const siteKey = resolveSiteKey(data, msg.hostname);
      const site = data.sites[siteKey] || { enabled: true, fields: {}, mappings: [] };
      return { ok: true, mappings: site.mappings || [], siteKey };
    }

    case 'SAVE_SITE_MAPPING': {
      if (!msg.mapping || !msg.hostname) return { ok: false, error: 'Missing mapping/hostname' };
      const data = await getData();
      const siteKey = resolveSiteKey(data, msg.hostname);
      if (!data.sites[siteKey]) data.sites[siteKey] = { enabled: true, fields: {}, mappings: [] };
      if (!Array.isArray(data.sites[siteKey].mappings)) data.sites[siteKey].mappings = [];
      const mappings = data.sites[siteKey].mappings;
      const idx = mappings.findIndex(m => m.signature === msg.mapping.signature);
      const normalized = {
        signature: msg.mapping.signature,
        mappedKey: msg.mapping.mappedKey,
        label: msg.mapping.label || '',
        type: msg.mapping.type || '',
        updatedAt: new Date().toISOString(),
      };
      if (idx >= 0) {
        mappings[idx] = { ...mappings[idx], ...normalized };
      } else {
        mappings.push(normalized);
      }
      data.sites[siteKey].mappings = mappings;
      await saveData(data);
      return { ok: true, mappings };
    }

    case 'SESSION_GET': {
      const fields = await getSessionFields(msg.hostname);
      return { ok: true, fields };
    }

    case 'SESSION_MERGE': {
      const fields = await mergeSessionFields(msg.hostname, msg.fields || {});
      return { ok: true, fields };
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
      if (!data.sites[siteKey]) data.sites[siteKey] = { enabled: false, fields: {} };
      data.sites[siteKey].disabled = true;
      data.sites[siteKey].enabled = false; // Also disable if specifically blocked
      await saveData(data);
      queueCloudSync();
      return { ok: true };
    }

    case 'CLEAR_SITE': {
      const data = await getData();
      const siteKey = resolveSiteKey(data, msg.hostname);
      if (data.sites[siteKey]) data.sites[siteKey].fields = {};
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
      return { ok: true, apps };
    }

    case 'APP_UPDATE': {
      if (!msg.id) return { ok: false, error: 'Application ID is required' };
      const apps = await updateApplication(msg.id, msg.updates || {});
      return { ok: true, apps };
    }

    case 'APP_DELETE': {
      if (!msg.id) return { ok: false, error: 'Application ID is required' };
      const apps = await deleteApplication(msg.id);
      queueCloudSync();
      return { ok: true, apps };
    }

    // ── Cloud Sync ────────────────────────────────────────────────
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
      try { await pushAllToCloud(); } catch (e) { console.warn('[Cloud] Post-signup push failed:', e); }
      return { ok: true, user: { email: auth.email, displayName: auth.displayName } };
    }

    case 'CLOUD_SIGN_IN': {
      if (!msg.email || !msg.password) return { ok: false, error: 'Email and password are required' };
      console.log('[Cloud] Sign in attempt:', msg.email);
      const auth = await cloudSignIn(msg.email, msg.password);
      // Auto-pull cloud data on login
      try { await pullAllFromCloud(); } catch (e) { console.warn('[Cloud] Post-login pull failed:', e); }
      return { ok: true, user: { email: auth.email, displayName: auth.displayName } };
    }

    case 'CLOUD_SIGN_IN_GOOGLE': {
      if (!msg.accessToken) return { ok: false, error: 'Google Access Token is required' };
      const auth = await cloudSignInWithGoogle(msg.accessToken);
      // Auto-pull cloud data on login
      try { await pullAllFromCloud(); } catch (e) { console.warn('[Cloud] Post-login pull failed:', e); }
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
      await pushAllToCloud();
      return { ok: true };
    }

    case 'CLOUD_PULL': {
      await pullAllFromCloud();
      return { ok: true };
    }

    case 'CLOUD_SYNC': {
      // Pull first (get latest), then push (upload merged)
      await pullAllFromCloud();
      await pushAllToCloud();
      return { ok: true };
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
      if (typeof ensureFirebaseConfigLoaded === 'function') {
        await ensureFirebaseConfigLoaded();
      }
      if (auth && isCloudConfigured()) {
        console.log('[Cloud] Auto-syncing...');
        await pushAllToCloud();
        console.log('[Cloud] Auto-sync complete.');
      }
    } catch (err) {
      console.warn('[Cloud] Auto-sync failed:', err.message);
    }
  }, 5000); // 5 second debounce
}
