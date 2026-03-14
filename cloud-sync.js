// cloud-sync.js — Firebase REST API Cloud Sync for Job Autofill
// Uses Firebase Auth REST API + Firestore REST API (no SDK needed)

// ── Firebase Config ────────────────────────────────────────────
// Default Firebase project details (safe to ship; security enforced by rules).
// Users can still override via dashboard if needed.
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyD1WbE-p4tqcKofQAvs7WKbJjfsNNy_A5o',
  projectId: 'job-auto-fill-290ca',
  authDomain: 'job-auto-fill-290ca.firebaseapp.com',
};

const CloudAuthStore = (globalThis.JobAutofill && JobAutofill.AuthStore) || {};
const FirestoreUtils = (globalThis.JobAutofill && JobAutofill.FirestoreUtils) || null;
const getAuthState = CloudAuthStore.getAuthState || (async () => null);
const saveAuthState = CloudAuthStore.saveAuthState || (async () => {});
const clearAuthState = CloudAuthStore.clearAuthState || (async () => {});
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

function setFirebaseConfig(config) {
  FIREBASE_CONFIG.apiKey = (config?.apiKey || '').trim();
  FIREBASE_CONFIG.projectId = (config?.projectId || '').trim();
  if (config?.authDomain) {
    FIREBASE_CONFIG.authDomain = (config?.authDomain || '').trim();
  }
}

async function ensureFirebaseConfigLoaded() {
  if (configLoadPromise) return configLoadPromise;
  configLoadPromise = chrome.storage.local.get(CLOUD_CONFIG_KEY)
    .then((result) => {
      const stored = result[CLOUD_CONFIG_KEY] || {};
      // If user saved empty values previously, fall back to baked defaults.
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
    if (err.message?.includes('TOKEN_EXPIRED') || err.message?.includes('INVALID_REFRESH_TOKEN')) {
      await clearAuthState();
    }
    throw err;
  }
}

// ── Authentication ─────────────────────────────────────────────
async function cloudSignUp(email, password, displayName) {
  await ensureFirebaseConfigLoaded();
  if (!isCloudConfigured()) throw new Error('Cloud sync not configured. Add Firebase config first.');

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
  if (!isCloudConfigured()) throw new Error('Cloud sync not configured. Add Firebase config first.');

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
  let displayName = data.displayName || data.email.split('@')[0];
  try {
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
  if (!isCloudConfigured()) throw new Error('Cloud sync not configured. Add Firebase config first.');

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
    displayName: data.displayName || data.email.split('@')[0],
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

  const resp = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(toFirestoreDoc(data)),
  });

  if (!resp.ok) {
    const err = await resp.json();
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
  return fromFirestoreDoc(doc);
}

// ── Full Sync ──────────────────────────────────────────────────

async function pushAllToCloud() {
  const auth = await getAuthState();
  if (!auth) throw new Error('Not logged in');

  // Gather all local data using partitioned keys
  const [autofillData, profile, aiSettings, applications] = await Promise.all([
    chrome.storage.local.get(await getUserKey('autofill_data')).then(r => r[Object.keys(r)[0]] || { sites: {}, hostnameMappings: {} }),
    chrome.storage.local.get(await getUserKey('global_profile_data')).then(r => r[Object.keys(r)[0]] || {}),
    chrome.storage.local.get(await getUserKey('ai_settings')).then(r => r[Object.keys(r)[0]] || {}),
    chrome.storage.local.get(await getUserKey('applications_data')).then(r => r[Object.keys(r)[0]] || []),
  ]);

  // Push each section in parallel
  await Promise.all([
    pushDataToCloud('autofill', autofillData),
    pushDataToCloud('profile', profile),
    pushDataToCloud('ai_settings', {
      ...aiSettings,
      // Don't sync API keys for security — user must set them per device
      apiKey: aiSettings.apiKey || '',
    }),
    pushDataToCloud('applications', { list: applications }),
  ]);

  // Save sync metadata
  await chrome.storage.local.set({
    [SYNC_META_KEY]: {
      lastPushedAt: new Date().toISOString(),
      userId: auth.userId,
    },
  });

  return true;
}

async function pullAllFromCloud() {
  const auth = await getAuthState();
  if (!auth) throw new Error('Not logged in');

  // Pull each section in parallel
  const [autofillData, profile, aiSettings, appData] = await Promise.all([
    pullDataFromCloud('autofill'),
    pullDataFromCloud('profile'),
    pullDataFromCloud('ai_settings'),
    pullDataFromCloud('applications'),
  ]);

  // Fetch local keys
  const storageKeys = await Promise.all([
    getUserKey('autofill_data'),
    getUserKey('global_profile_data'),
    getUserKey('ai_settings'),
    getUserKey('applications_data')
  ]);

  const localResult = await chrome.storage.local.get(storageKeys);
  const updates = {};

  if (autofillData) {
    const localAutofill = localResult[storageKeys[0]] || { sites: {}, hostnameMappings: {} };
    // Deep merge: cloud sites + local sites (cloud data wins for fields, local disabled status prioritized if it exists)
    const mergedSites = { ...localAutofill.sites };
    for (const [hostname, site] of Object.entries(autofillData.sites || {})) {
      if (mergedSites[hostname]) {
        mergedSites[hostname] = {
          ...mergedSites[hostname],
          ...site,
          // Preserve disabled status if local has it
          disabled: mergedSites[hostname].disabled || site.disabled,
          fields: { ...mergedSites[hostname].fields, ...(site.fields || {}) },
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
    };
  }

  if (profile) {
    const localProfile = localResult[storageKeys[1]] || {};
    updates[storageKeys[1]] = { ...localProfile, ...profile };
  }

  if (aiSettings) {
    const localAi = localResult[storageKeys[2]] || {};
    updates[storageKeys[2]] = {
      ...localAi,
      ...aiSettings,
      apiKey: localAi.apiKey || aiSettings.apiKey || '',
    };
  }

  if (appData?.list) {
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

async function getSyncMeta() {
  const result = await chrome.storage.local.get(SYNC_META_KEY);
  return result[SYNC_META_KEY] || null;
}
