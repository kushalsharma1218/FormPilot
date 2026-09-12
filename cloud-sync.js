// cloud-sync.js — Firebase REST API Cloud Sync for Job Autofill
// Uses Firebase Auth REST API + Firestore REST API (no SDK needed)

// ── Firebase Config ────────────────────────────────────────────
// No default config is shipped. If cloud sync is enabled, config must be
// provisioned by the extension owner (not exposed in the UI).
const FIREBASE_CONFIG = {
  apiKey: '',
  projectId: '',
  authDomain: '',
};
const PRIVATE_CONFIG = (globalThis && globalThis.PRIVATE_FIREBASE_CONFIG) || null;
const HAS_PRIVATE_CONFIG = !!(PRIVATE_CONFIG && (PRIVATE_CONFIG.apiKey || PRIVATE_CONFIG.projectId));

function applyPrivateConfig() {
  if (!HAS_PRIVATE_CONFIG) return;
  FIREBASE_CONFIG.apiKey = (PRIVATE_CONFIG.apiKey || '').trim();
  FIREBASE_CONFIG.projectId = (PRIVATE_CONFIG.projectId || '').trim();
  const fallbackDomain = FIREBASE_CONFIG.projectId ? `${FIREBASE_CONFIG.projectId}.firebaseapp.com` : '';
  FIREBASE_CONFIG.authDomain = (PRIVATE_CONFIG.authDomain || fallbackDomain || '').trim();
}

const CloudAuthStore = (globalThis.JobAutofill && JobAutofill.AuthStore) || {};
const FirestoreUtils = (globalThis.JobAutofill && JobAutofill.FirestoreUtils) || null;
const getAuthState = CloudAuthStore.getAuthState || (async () => null);
const saveAuthState = CloudAuthStore.saveAuthState || (async () => { });
const clearAuthState = CloudAuthStore.clearAuthState || (async () => { });
const getUserKey = CloudAuthStore.getUserKey || (async (baseKey) => baseKey);
const toFirestoreValue = FirestoreUtils?.toFirestoreValue || function (val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    if (Number.isInteger(val)) return { integerValue: String(val) };
    return { doubleValue: val };
  }
  if (typeof val === 'string') return { stringValue: val };
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map(toFirestoreValue) } };
  }
  if (typeof val === 'object') {
    const fields = {};
    Object.entries(val).forEach(([k, v]) => {
      fields[k] = toFirestoreValue(v);
    });
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
};
const fromFirestoreValue = FirestoreUtils?.fromFirestoreValue || function (fv) {
  if (!fv) return null;
  if ('nullValue' in fv) return null;
  if ('booleanValue' in fv) return fv.booleanValue;
  if ('integerValue' in fv) return parseInt(fv.integerValue, 10);
  if ('doubleValue' in fv) return fv.doubleValue;
  if ('stringValue' in fv) return fv.stringValue;
  if ('arrayValue' in fv) {
    return (fv.arrayValue.values || []).map(fromFirestoreValue);
  }
  if ('mapValue' in fv) {
    const obj = {};
    Object.entries(fv.mapValue.fields || {}).forEach(([k, v]) => {
      obj[k] = fromFirestoreValue(v);
    });
    return obj;
  }
  return null;
};
const toFirestoreDoc = FirestoreUtils?.toFirestoreDoc || function (obj) {
  const fields = {};
  Object.entries(obj || {}).forEach(([k, v]) => {
    fields[k] = toFirestoreValue(v);
  });
  return { fields };
};
const fromFirestoreDoc = FirestoreUtils?.fromFirestoreDoc || function (doc) {
  if (!doc || !doc.fields) return {};
  const obj = {};
  Object.entries(doc.fields).forEach(([k, v]) => {
    obj[k] = fromFirestoreValue(v);
  });
  return obj;
};

const SYNC_META_KEY = 'cloud_sync_meta';
const CLOUD_CONFIG_KEY = 'cloud_config';
let configLoadPromise = null;

// mergeMetricBucket / mergeUsageMetrics are defined in background.js, which is
// loaded after this file and therefore owns both.

function mergeAliasMaps(local = {}, remote = {}) {
  const merged = { ...(local || {}) };
  Object.entries(remote || {}).forEach(([label, entry]) => {
    if (!entry?.key) return;
    const current = merged[label];
    if (!current) {
      merged[label] = entry;
      return;
    }
    if (current.key === entry.key) {
      merged[label] = {
        ...current,
        ...entry,
        count: Math.max(Number(current.count || 0), Number(entry.count || 0)),
        updatedAt: current.updatedAt && entry.updatedAt
          ? (current.updatedAt > entry.updatedAt ? current.updatedAt : entry.updatedAt)
          : (current.updatedAt || entry.updatedAt || null),
      };
      return;
    }
    const currentTs = current.updatedAt || '';
    const entryTs = entry.updatedAt || '';
    merged[label] = entryTs >= currentTs ? entry : current;
  });
  return merged;
}

function mergeSiteMappings(local = [], remote = []) {
  const merged = new Map();
  [...(local || []), ...(remote || [])].forEach((mapping) => {
    if (!mapping?.signature) return;
    const existing = merged.get(mapping.signature);
    if (!existing) {
      merged.set(mapping.signature, mapping);
      return;
    }
    const existingTs = existing.updatedAt || '';
    const mappingTs = mapping.updatedAt || '';
    merged.set(mapping.signature, mappingTs >= existingTs ? { ...existing, ...mapping } : { ...mapping, ...existing });
  });
  return Array.from(merged.values());
}

function setFirebaseConfig(config) {
  FIREBASE_CONFIG.apiKey = (config?.apiKey || '').trim();
  FIREBASE_CONFIG.projectId = (config?.projectId || '').trim();
  if (config?.authDomain) {
    FIREBASE_CONFIG.authDomain = (config?.authDomain || '').trim();
  }
}

async function ensureFirebaseConfigLoaded() {
  if (HAS_PRIVATE_CONFIG) {
    applyPrivateConfig();
    return { apiKey: FIREBASE_CONFIG.apiKey, projectId: FIREBASE_CONFIG.projectId, authDomain: FIREBASE_CONFIG.authDomain };
  }
  if (configLoadPromise) return configLoadPromise;
  configLoadPromise = chrome.storage.local.get(CLOUD_CONFIG_KEY)
    .then((result) => {
      const stored = result[CLOUD_CONFIG_KEY] || {};
      // If user saved empty values previously, keep them empty.
      const merged = {
        apiKey: (stored.apiKey || FIREBASE_CONFIG.apiKey || '').trim(),
        projectId: (stored.projectId || FIREBASE_CONFIG.projectId || '').trim(),
        authDomain: (stored.authDomain || FIREBASE_CONFIG.authDomain || '').trim(),
      };
      setFirebaseConfig(merged);
      return merged;
    })
    .catch(() => {
      // Keep defaults if storage read fails
      return { apiKey: FIREBASE_CONFIG.apiKey, projectId: FIREBASE_CONFIG.projectId, authDomain: FIREBASE_CONFIG.authDomain };
    });
  return configLoadPromise;
}

async function getCloudConfig() {
  await ensureFirebaseConfigLoaded();
  return { apiKey: FIREBASE_CONFIG.apiKey, projectId: FIREBASE_CONFIG.projectId, authDomain: FIREBASE_CONFIG.authDomain };
}

async function saveCloudConfig(config) {
  if (HAS_PRIVATE_CONFIG) {
    applyPrivateConfig();
    return { apiKey: FIREBASE_CONFIG.apiKey, projectId: FIREBASE_CONFIG.projectId, authDomain: FIREBASE_CONFIG.authDomain };
  }
  const normalized = {
    apiKey: (config?.apiKey || '').trim(),
    projectId: (config?.projectId || '').trim(),
    authDomain: (config?.authDomain || '').trim(),
  };
  await chrome.storage.local.set({ [CLOUD_CONFIG_KEY]: normalized });
  setFirebaseConfig(normalized);
  return normalized;
}

// ── Helpers ────────────────────────────────────────────────────
function firestoreUrl(path) {
  return `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/${path}`;
}

function authUrl(action) {
  return `https://identitytoolkit.googleapis.com/v1/accounts:${action}?key=${FIREBASE_CONFIG.apiKey}`;
}

function tokenRefreshUrl() {
  return `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_CONFIG.apiKey}`;
}

// ── Config Check ───────────────────────────────────────────────
function isCloudConfigured() {
  return !!(FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.projectId);
}

// ── Auth State ─────────────────────────────────────────────────

// ── Token Management ───────────────────────────────────────────
async function getValidToken() {
  const auth = await getAuthState();
  if (!auth) throw new Error('Not logged in');

  // Check if token is expired (tokens last 3600 seconds)
  const now = Date.now();
  const expiresAt = auth.tokenExpiresAt || 0;

  if (now < expiresAt - 60000) {
    // Token still valid (with 1 min buffer)
    return auth.idToken;
  }

  // Refresh the token
  try {
    const resp = await fetch(tokenRefreshUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: auth.refreshToken,
      }),
    });

    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.error?.message || 'Token refresh failed');
    }

    const data = await resp.json();
    const updatedAuth = {
      ...auth,
      idToken: data.id_token,
      refreshToken: data.refresh_token,
      tokenExpiresAt: Date.now() + (parseInt(data.expires_in) * 1000),
    };
    await saveAuthState(updatedAuth);
    return data.id_token;
  } catch (err) {
    // If refresh fails, clear auth state (user must re-login)
    // USER_NOT_FOUND / USER_DISABLED are just as terminal as an expired token: a
    // deleted or disabled account used to stay "signed in" forever while every
    // sync failed, with no way out but guessing that sign-out fixes it.
    const terminal = ['TOKEN_EXPIRED', 'INVALID_REFRESH_TOKEN', 'USER_NOT_FOUND', 'USER_DISABLED']
      .some(code => err.message?.includes(code));
    if (terminal) {
      await clearAuthState();
      // Tell the rest of the extension. Clearing auth silently meant getUserKey()
      // started returning un-scoped keys and everything written afterwards was
      // orphaned the moment the user signed back in.
      try { await globalThis.broadcastAuthState?.(false); } catch (_) { }
      try {
        chrome.runtime.sendMessage({
          type: 'CLOUD_SESSION_EXPIRED',
          reason: err.message || 'Session expired',
        }).catch(() => { });
      } catch (_) { }
    }
    throw err;
  }
}

// ── Authentication ─────────────────────────────────────────────
async function cloudSignUp(email, password, displayName) {
  await ensureFirebaseConfigLoaded();
  if (!isCloudConfigured()) throw new Error('Cloud sync not configured.');

  const resp = await fetch(authUrl('signUp'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      returnSecureToken: true,
    }),
  });

  const data = await resp.json();
  if (data.error) {
    throw new Error(friendlyAuthError(data.error.message));
  }

  // Update display name
  if (displayName) {
    await fetch(authUrl('update'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idToken: data.idToken,
        displayName,
        returnSecureToken: false,
      }),
    });
  }

  const authState = {
    userId: data.localId,
    email: data.email,
    displayName: displayName || data.email.split('@')[0],
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    tokenExpiresAt: Date.now() + (parseInt(data.expiresIn) * 1000),
  };
  await saveAuthState(authState);
  return authState;
}

async function cloudSignIn(email, password) {
  await ensureFirebaseConfigLoaded();
  if (!isCloudConfigured()) throw new Error('Cloud sync not configured.');

  const resp = await fetch(authUrl('signInWithPassword'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      returnSecureToken: true,
    }),
  });

  const data = await resp.json();
  if (data.error) {
    throw new Error(friendlyAuthError(data.error.message));
  }

  // Get display name
  let displayName = data.displayName || (data.email || '').split('@')[0] || 'Account';
  // Only pay for the extra lookup round trip when the name is actually missing —
  // sign-in latency is what the popup is waiting on.
  try {
    if (data.displayName) throw new Error('skip-lookup');
    const profileResp = await fetch(authUrl('lookup'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: data.idToken }),
    });
    const profileData = await profileResp.json();
    if (profileData.users?.[0]?.displayName) {
      displayName = profileData.users[0].displayName;
    }
  } catch { /* ignore */ }

  const authState = {
    userId: data.localId,
    email: data.email,
    displayName,
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    tokenExpiresAt: Date.now() + (parseInt(data.expiresIn) * 1000),
  };
  await saveAuthState(authState);
  return authState;
}

async function cloudSignInWithGoogle(googleAccessToken) {
  await ensureFirebaseConfigLoaded();
  if (!isCloudConfigured()) throw new Error('Cloud sync not configured.');

  const extensionId = chrome.runtime.id;
  const requestUri = `https://${extensionId}.chromiumapp.org/`;

  const resp = await fetch(authUrl('signInWithIdp'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      postBody: `access_token=${googleAccessToken}&providerId=google.com`,
      requestUri: requestUri,
      returnIdpCredential: true,
      returnSecureToken: true
    }),
  });

  const data = await resp.json();
  if (data.error) {
    console.error('[Cloud] Firebase Auth Error:', data.error);
    throw new Error(friendlyAuthError(data.error.message));
  }

  const authState = {
    userId: data.localId,
    email: data.email,
    displayName: data.displayName || (data.email || '').split('@')[0] || 'Account',
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    tokenExpiresAt: Date.now() + (parseInt(data.expiresIn) * 1000),
  };
  await saveAuthState(authState);
  return authState;
}

async function cloudSignOut() {
  await clearAuthState();
  await chrome.storage.local.remove(SYNC_META_KEY);
}

async function cloudResetPassword(email) {
  await ensureFirebaseConfigLoaded();
  if (!isCloudConfigured()) throw new Error('Cloud sync not configured.');

  const resp = await fetch(authUrl('sendOobCode'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestType: 'PASSWORD_RESET', email }),
  });

  const data = await resp.json();
  if (data.error) throw new Error(friendlyAuthError(data.error.message));
  return true;
}

function friendlyAuthError(code) {
  const map = {
    'EMAIL_EXISTS': 'An account with this email already exists.',
    'INVALID_EMAIL': 'Please enter a valid email address.',
    'WEAK_PASSWORD : Password should be at least 6 characters': 'Password must be at least 6 characters.',
    'EMAIL_NOT_FOUND': 'No account found with this email.',
    'INVALID_PASSWORD': 'Incorrect password.',
    'INVALID_LOGIN_CREDENTIALS': 'Invalid email or password.',
    'USER_DISABLED': 'This account has been disabled.',
    'TOO_MANY_ATTEMPTS_TRY_LATER': 'Too many attempts. Please try again later.',
    'OPERATION_NOT_ALLOWED': 'Email/password sign-in is not enabled for this project.',
  };
  return map[code] || code || 'Authentication failed.';
}

// ── Cloud Data Operations ──────────────────────────────────────

async function pushDataToCloud(dataKey, data) {
  await ensureFirebaseConfigLoaded();
  const auth = await getAuthState();
  if (!auth) throw new Error('Not logged in');
  const token = await getValidToken();

  const docPath = `users/${auth.userId}/${dataKey}/data`;
  const url = firestoreUrl(docPath);

  await assertNotDowngradingToPlaintext(dataKey);

  let payload = data;

  // E2EE: Encrypt if a sync key is present
  if (globalThis.currentSyncKey) {
    console.log(`[CloudSync] Encrypting ${dataKey} payload...`);
    const encrypted = await globalThis.JobAutofill.CryptoUtils.encrypt(data, globalThis.currentSyncKey);
    payload = {
      encrypted: true,
      iv: encrypted.iv,
      ciphertext: encrypted.ciphertext,
      updatedAt: new Date().toISOString()
    };
  }

  // Full-document PATCH (Firestore creates the doc if it does not exist).
  // Do NOT add an empty ?updateMask.fieldPaths= — that asks Firestore to update
  // zero fields, which silently writes nothing.
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(toFirestoreDoc(payload)),
  });

  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(err.error?.message || `Failed to push ${dataKey}`);
  }

  return true;
}

// ── Delta Sync (Offline Queue) ─────────────────────────────────

const MAX_QUEUE_ATTEMPTS = 5;

async function bumpQueueAttempts(items) {
  if (!globalThis.JobAutofill?.SyncQueue) return;
  const ids = new Set(items.map(i => i.id));
  const queue = await globalThis.JobAutofill.SyncQueue.getQueue();
  for (const entry of queue) {
    if (ids.has(entry.id)) entry.attempts = (entry.attempts || 0) + 1;
  }
  await chrome.storage.local.set({ cloud_sync_queue: queue });
}

async function drainSyncQueue() {
  if (!globalThis.JobAutofill?.SyncQueue) return;
  const queue = await globalThis.JobAutofill.SyncQueue.getQueue();
  if (!queue || queue.length === 0) return;

  await ensureFirebaseConfigLoaded();
  const auth = await getAuthState();
  if (!auth) return;
  const token = await getValidToken();

  console.log(`[CloudSync] Draining sync queue of ${queue.length} items`);

  // Group by document key to batch updates
  const updatesByKey = {};
  for (const item of queue) {
    if (!updatesByKey[item.key]) updatesByKey[item.key] = { items: [], id: item.key };
    updatesByKey[item.key].items.push(item);
  }

  const queueOwner = queue[0]?.userId;
  if (queueOwner && queueOwner !== auth.userId) {
    // Queued by a different account (e.g. someone signed out mid-outage).
    // Uploading it now would write their data into this account's documents.
    console.warn('[CloudSync] Dropping sync queue left behind by another account.');
    await globalThis.JobAutofill.SyncQueue.clearQueue();
    return;
  }

  const successIds = [];

  for (const [dataKey, group] of Object.entries(updatesByKey)) {
    const attempts = Math.max(...group.items.map(i => i.attempts || 0));
    try {
      // For now, if there are multiple patches for a single doc, we just take the latest payload
      const latestItem = group.items[group.items.length - 1];
      const docPath = `users/${auth.userId}/${dataKey}/data`;
      const url = firestoreUrl(docPath);

      await assertNotDowngradingToPlaintext(dataKey);

      // E2EE: Encrypt if a sync key is present
      let payload = latestItem.payload;
      if (globalThis.currentSyncKey) {
        const encrypted = await globalThis.JobAutofill.CryptoUtils.encrypt(payload, globalThis.currentSyncKey);
        payload = {
          encrypted: true,
          iv: encrypted.iv,
          ciphertext: encrypted.ciphertext,
          updatedAt: new Date().toISOString()
        };
      }

      const resp = await fetch(url, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(toFirestoreDoc(payload)),
      });

      if (!resp.ok) {
        if (resp.status === 404) {
          // Undeliverable. Firestore PATCH creates missing docs, so a repeated 404
          // means this item will never land — drop it rather than grow the queue forever.
          console.warn(`[CloudSync] Target doc ${dataKey} not found after ${attempts} attempts; dropping queued items.`);
          if (attempts >= MAX_QUEUE_ATTEMPTS) {
            successIds.push(...group.items.map(i => i.id));
          } else {
            await bumpQueueAttempts(group.items);
          }
        } else {
          const err = await resp.json();
          throw new Error(err.error?.message || `Failed to push ${dataKey}`);
        }
      } else {
        successIds.push(...group.items.map(i => i.id));
      }
    } catch (err) {
      console.error(`[CloudSync] Failed to process queue for ${dataKey}:`, err);
      // Count the attempt on EVERY failure, not just 404 — otherwise a
      // permanently-rejected item (400, oversized doc, revoked auth) is retried
      // forever and the queue grows without bound.
      if (attempts + 1 >= MAX_QUEUE_ATTEMPTS) {
        console.warn(`[CloudSync] Dropping ${dataKey} after ${MAX_QUEUE_ATTEMPTS} failed attempts.`);
        successIds.push(...group.items.map(i => i.id));
      } else {
        await bumpQueueAttempts(group.items);
      }
    }
  }

  if (successIds.length > 0) {
    await globalThis.JobAutofill.SyncQueue.removeItems(successIds);
  }
}

// Reads a document WITHOUT attempting decryption. Needed for sync_meta, which
// holds the PBKDF2 salt and the passphrase verifier and is deliberately plaintext.
// The in-memory sync key dies with the MV3 worker, but the account's E2EE status
// does not. Pushing without the key would rewrite encrypted documents as
// plaintext and report success — so refuse instead, and let the UI ask for the
// passphrase again.
async function assertNotDowngradingToPlaintext(dataKey) {
  if (globalThis.currentSyncKey) return;
  const usesE2ee = typeof accountUsesE2ee === 'function' ? await accountUsesE2ee() : false;
  if (usesE2ee) {
    throw new Error(`Sync passphrase required before syncing ${dataKey} (refusing to upload unencrypted).`);
  }
}

async function pullRawFromCloud(dataKey) {
  await ensureFirebaseConfigLoaded();
  const auth = await getAuthState();
  if (!auth) throw new Error('Not logged in');
  const token = await getValidToken();

  const resp = await fetch(firestoreUrl(`users/${auth.userId}/${dataKey}/data`), {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `Failed to pull ${dataKey}`);
  }
  return fromFirestoreDoc(await resp.json());
}

// Writes a document WITHOUT encrypting it. Same rationale as pullRawFromCloud.
async function pushRawToCloud(dataKey, data) {
  await ensureFirebaseConfigLoaded();
  const auth = await getAuthState();
  if (!auth) throw new Error('Not logged in');
  const token = await getValidToken();

  const resp = await fetch(firestoreUrl(`users/${auth.userId}/${dataKey}/data`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(toFirestoreDoc(data)),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `Failed to push ${dataKey}`);
  }
  return true;
}

async function pullDataFromCloud(dataKey) {
  await ensureFirebaseConfigLoaded();
  const auth = await getAuthState();
  if (!auth) throw new Error('Not logged in');
  const token = await getValidToken();

  const docPath = `users/${auth.userId}/${dataKey}/data`;
  const url = firestoreUrl(docPath);

  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (resp.status === 404) return null; // No data yet
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(err.error?.message || `Failed to pull ${dataKey}`);
  }

  const doc = await resp.json();
  const data = fromFirestoreDoc(doc);

  // E2EE: Decrypt if data is encrypted
  if (data && data.encrypted && data.ciphertext && data.iv) {
    if (!globalThis.currentSyncKey) {
      console.warn(`[CloudSync] Data for ${dataKey} is encrypted but no sync key is available.`);
      throw new Error('Sync passphrase required to decrypt data');
    }
    return await globalThis.JobAutofill.CryptoUtils.decrypt(data.ciphertext, data.iv, globalThis.currentSyncKey);
  }

  return data;
}

// ── Full Sync ──────────────────────────────────────────────────

async function pushAllToCloud(prefs = {}) {
  const auth = await getAuthState();
  if (!auth) throw new Error('Not logged in');

  const syncProfile = prefs.syncProfile !== false;
  const syncAutofill = !!prefs.syncAutofill;
  const syncApplications = !!prefs.syncApplications;
  const syncTasks = prefs.syncTasks !== false;
  const syncAiSettings = !!prefs.syncAiSettings;
  const syncResumes = prefs.syncResumes !== false;
  const syncMetrics = prefs.syncMetrics !== false;

  // Gather all local data using partitioned keys
  const fetchTasks = [];
  let autofillData, profile, aiSettings, applications, taskList, resumes, metrics;
  if (syncAutofill) {
    fetchTasks.push(
      chrome.storage.local.get(await getUserKey('autofill_data'))
        .then(r => { autofillData = r[Object.keys(r)[0]] || { sites: {}, hostnameMappings: {} }; })
    );
  }
  if (syncProfile) {
    fetchTasks.push(
      chrome.storage.local.get(await getUserKey('global_profile_data'))
        .then(r => { profile = r[Object.keys(r)[0]] || {}; })
    );
  }
  if (syncAiSettings) {
    fetchTasks.push(
      chrome.storage.local.get(await getUserKey('ai_settings'))
        .then(r => { aiSettings = r[Object.keys(r)[0]] || {}; })
    );
  }
  if (syncApplications) {
    fetchTasks.push(
      chrome.storage.local.get(await getUserKey('applications_data'))
        .then(r => { applications = r[Object.keys(r)[0]] || []; })
    );
  }
  if (syncTasks) {
    fetchTasks.push(
      chrome.storage.local.get(await getUserKey('tasks_data'))
        .then(r => { taskList = r[Object.keys(r)[0]] || []; })
    );
  }
  if (syncResumes) {
    fetchTasks.push(
      chrome.storage.local.get(await getUserKey('resumes_data'))
        .then(r => { resumes = r[Object.keys(r)[0]] || { items: [], defaultId: null }; })
    );
  }
  if (syncMetrics) {
    fetchTasks.push(
      chrome.storage.local.get(await getUserKey('usage_metrics'))
        .then(r => { metrics = r[Object.keys(r)[0]] || {}; })
    );
  }
  await Promise.all(fetchTasks);

  // Push each section in parallel
  const pushTasks = [];
  if (syncAutofill) pushTasks.push(pushDataToCloud('autofill', autofillData));
  if (syncProfile) pushTasks.push(pushDataToCloud('profile', profile));
  if (syncAiSettings) {
    pushTasks.push(pushDataToCloud('ai_settings', aiSettings || {}));
  }
  if (syncApplications) pushTasks.push(pushDataToCloud('applications', { list: applications }));
  if (syncTasks) pushTasks.push(pushDataToCloud('tasks', { list: taskList }));
  if (syncResumes) pushTasks.push(pushDataToCloud('resumes', resumes));
  if (syncMetrics) pushTasks.push(pushDataToCloud('metrics', metrics || {}));
  if (pushTasks.length) await Promise.all(pushTasks);

  // Clear sync queue since we just did a full push
  if (globalThis.JobAutofill?.SyncQueue) {
    await globalThis.JobAutofill.SyncQueue.clearQueue();
  }

  // Save sync metadata
  await chrome.storage.local.set({
    [SYNC_META_KEY]: {
      lastPushedAt: new Date().toISOString(),
      userId: auth.userId,
    },
  });

  return true;
}

// Global reference exported locally for queueCloudSync
globalThis.CloudSync = {
  drainSyncQueue,
  pullRawFromCloud,
  pushRawToCloud,
  pushAllToCloud,
  pullAllFromCloud,
  pullDataFromCloud,
  pushDataToCloud
};

async function pullAllFromCloud(prefs = {}) {
  const auth = await getAuthState();
  if (!auth) throw new Error('Not logged in');

  // Pull each section in parallel
  const syncProfile = prefs.syncProfile !== false;
  const syncAutofill = !!prefs.syncAutofill;
  const syncApplications = !!prefs.syncApplications;
  const syncTasks = prefs.syncTasks !== false;
  const syncAiSettings = !!prefs.syncAiSettings;
  const syncResumes = prefs.syncResumes !== false;
  const syncMetrics = prefs.syncMetrics !== false;

  const pullTasks = [];
  let autofillData, profile, aiSettings, appData, taskData, resumeData, metricsData;
  if (syncAutofill) pullTasks.push(pullDataFromCloud('autofill').then(r => { autofillData = r; }));
  if (syncProfile) pullTasks.push(pullDataFromCloud('profile').then(r => { profile = r; }));
  if (syncAiSettings) pullTasks.push(pullDataFromCloud('ai_settings').then(r => { aiSettings = r; }));
  if (syncApplications) pullTasks.push(pullDataFromCloud('applications').then(r => { appData = r; }));
  if (syncTasks) pullTasks.push(pullDataFromCloud('tasks').then(r => { taskData = r; }));
  if (syncResumes) pullTasks.push(pullDataFromCloud('resumes').then(r => { resumeData = r; }));
  if (syncMetrics) pullTasks.push(pullDataFromCloud('metrics').then(r => { metricsData = r; }));
  if (pullTasks.length) await Promise.all(pullTasks);

  // Fetch local keys
  const storageKeys = await Promise.all([
    getUserKey('autofill_data'),
    getUserKey('global_profile_data'),
    getUserKey('ai_settings'),
    getUserKey('applications_data'),
    getUserKey('tasks_data'),
    getUserKey('resumes_data'),
    getUserKey('usage_metrics')
  ]);

  const localResult = await chrome.storage.local.get(storageKeys);
  const updates = {};

  if (syncAutofill && autofillData) {
    const localAutofill = localResult[storageKeys[0]] || { sites: {}, hostnameMappings: {}, globalAliases: {}, excludedSites: [] };
    const mergedSites = { ...localAutofill.sites };
    for (const [hostname, site] of Object.entries(autofillData.sites || {})) {
      if (mergedSites[hostname]) {
        mergedSites[hostname] = {
          ...mergedSites[hostname],
          ...site,
          fields: { ...mergedSites[hostname].fields, ...(site.fields || {}) },
          mappings: mergeSiteMappings(mergedSites[hostname].mappings || [], site.mappings || []),
          flags: { ...(mergedSites[hostname].flags || {}), ...(site.flags || {}) },
          metrics: { ...(mergedSites[hostname].metrics || {}), ...(site.metrics || {}) },
          sandbox: { ...(mergedSites[hostname].sandbox || {}), ...(site.sandbox || {}) },
        };
      } else {
        mergedSites[hostname] = site;
      }
    }
    updates[storageKeys[0]] = {
      sites: mergedSites,
      hostnameMappings: {
        ...(localAutofill.hostnameMappings || {}),
        ...(autofillData.hostnameMappings || {}),
      },
      globalAliases: mergeAliasMaps(localAutofill.globalAliases || {}, autofillData.globalAliases || {}),
      excludedSites: Array.from(new Set([
        ...((localAutofill.excludedSites || []).filter(Boolean)),
        ...(((autofillData.excludedSites || []).filter(Boolean)))
      ])),
    };
  }

  if (syncProfile && profile) {
    const localProfile = localResult[storageKeys[1]] || {};
    updates[storageKeys[1]] = { ...localProfile, ...profile };
  }

  if (syncAiSettings && aiSettings) {
    const localAi = localResult[storageKeys[2]] || {};
    updates[storageKeys[2]] = { ...localAi, ...aiSettings };
  }

  if (syncApplications && appData?.list) {
    const localApps = localResult[storageKeys[3]] || [];
    const mergedApps = [...localApps];
    for (const cloudApp of appData.list) {
      const idx = mergedApps.findIndex(a => a.id === cloudApp.id);
      if (idx >= 0) {
        mergedApps[idx] = cloudApp;
      } else {
        mergedApps.push(cloudApp);
      }
    }
    updates[storageKeys[3]] = mergedApps;
  }

  if (syncTasks && taskData?.list) {
    const localTasks = localResult[storageKeys[4]] || [];
    const mergedTasks = [...localTasks];
    for (const cloudTask of taskData.list) {
      const idx = mergedTasks.findIndex(t => t.id === cloudTask.id);
      if (idx >= 0) {
        mergedTasks[idx] = cloudTask;
      } else {
        mergedTasks.push(cloudTask);
      }
    }
    updates[storageKeys[4]] = mergedTasks;
  }

  if (syncResumes && resumeData?.items) {
    const localResumes = localResult[storageKeys[5]] || { items: [], defaultId: null };
    const mergedById = new Map();
    (localResumes.items || []).forEach(item => {
      if (item?.id) mergedById.set(item.id, item);
    });
    (resumeData.items || []).forEach(item => {
      if (item?.id) mergedById.set(item.id, { ...(mergedById.get(item.id) || {}), ...item });
    });
    const mergedItems = Array.from(mergedById.values());
    updates[storageKeys[5]] = {
      items: mergedItems,
      defaultId: resumeData.defaultId || localResumes.defaultId || mergedItems[0]?.id || null,
    };
  }

  if (syncMetrics && metricsData) {
    const localMetrics = localResult[storageKeys[6]] || {};
    // Prefer higher totals to avoid double counting across devices
    const merged = (typeof mergeUsageMetrics === 'function')
      ? mergeUsageMetrics(localMetrics, metricsData)
      : { ...localMetrics, ...metricsData };
    updates[storageKeys[6]] = merged;
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }

  // Save sync metadata
  await chrome.storage.local.set({
    [SYNC_META_KEY]: {
      lastPulledAt: new Date().toISOString(),
      userId: auth.userId,
    },
  });

  return true;
}

// ── Delete Cloud Data ─────────────────────────────────────────
async function deleteCloudData(keys = []) {
  await ensureFirebaseConfigLoaded();
  const auth = await getAuthState();
  if (!auth) throw new Error('Not logged in');
  const token = await getValidToken();
  const deletions = (keys || []).map(async (key) => {
    const docPath = `users/${auth.userId}/${key}/data`;
    const url = firestoreUrl(docPath);
    const resp = await fetch(url, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } });
    if (!resp.ok && resp.status !== 404) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error?.message || `Failed to delete ${key}`);
    }
  });
  await Promise.all(deletions);
  return true;
}

async function getSyncMeta() {
  const result = await chrome.storage.local.get(SYNC_META_KEY);
  return result[SYNC_META_KEY] || null;
}
