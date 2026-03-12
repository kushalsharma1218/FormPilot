// cloud-sync.js — Firebase REST API Cloud Sync for Job Autofill
// Uses Firebase Auth REST API + Firestore REST API (no SDK needed)

// ── Firebase Config ────────────────────────────────────────────
// Users must fill in their own Firebase project details.
// See SETUP_GUIDE.md for instructions.
const FIREBASE_CONFIG = {
  apiKey: '',       // e.g. 'AIzaSyD...'
  projectId: '',    // e.g. 'job-autofill-12345'
};

const AUTH_STORAGE_KEY = 'cloud_auth';
const SYNC_META_KEY = 'cloud_sync_meta';

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
async function getAuthState() {
  try {
    const result = await chrome.storage.local.get(AUTH_STORAGE_KEY);
    return result[AUTH_STORAGE_KEY] || null;
  } catch {
    return null;
  }
}

async function saveAuthState(state) {
  await chrome.storage.local.set({ [AUTH_STORAGE_KEY]: state });
}

async function clearAuthState() {
  await chrome.storage.local.remove(AUTH_STORAGE_KEY);
}

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
  if (!isCloudConfigured()) throw new Error('Cloud sync not configured. Add Firebase config first.');

  const resp = await fetch(authUrl('signInWithIdp'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      postBody: `access_token=${googleAccessToken}&providerId=google.com`,
      requestUri: 'http://localhost',
      returnIdpCredential: true,
      returnSecureToken: true
    }),
  });

  const data = await resp.json();
  if (data.error) {
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

// ── Firestore Data Conversion ──────────────────────────────────
// Convert JS values to Firestore REST API format and back

function toFirestoreValue(val) {
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
    for (const [k, v] of Object.entries(val)) {
      fields[k] = toFirestoreValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function fromFirestoreValue(fv) {
  if (!fv) return null;
  if ('nullValue' in fv) return null;
  if ('booleanValue' in fv) return fv.booleanValue;
  if ('integerValue' in fv) return parseInt(fv.integerValue);
  if ('doubleValue' in fv) return fv.doubleValue;
  if ('stringValue' in fv) return fv.stringValue;
  if ('arrayValue' in fv) {
    return (fv.arrayValue.values || []).map(fromFirestoreValue);
  }
  if ('mapValue' in fv) {
    const obj = {};
    for (const [k, v] of Object.entries(fv.mapValue.fields || {})) {
      obj[k] = fromFirestoreValue(v);
    }
    return obj;
  }
  return null;
}

function toFirestoreDoc(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    fields[k] = toFirestoreValue(v);
  }
  return { fields };
}

function fromFirestoreDoc(doc) {
  if (!doc || !doc.fields) return {};
  const obj = {};
  for (const [k, v] of Object.entries(doc.fields)) {
    obj[k] = fromFirestoreValue(v);
  }
  return obj;
}

// ── Cloud Data Operations ──────────────────────────────────────

async function pushDataToCloud(dataKey, data) {
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

  // Gather all local data
  const result = await chrome.storage.local.get([
    'autofill_data',
    'global_profile_data',
    'ai_settings',
    'job_applications',
  ]);

  const autofillData = result.autofill_data || { sites: {}, hostnameMappings: {} };
  const profile = result.global_profile_data || {};
  const aiSettings = result.ai_settings || {};
  const applications = result.job_applications || [];

  // Push each section in parallel
  await Promise.all([
    pushDataToCloud('autofill', autofillData),
    pushDataToCloud('profile', profile),
    pushDataToCloud('ai_settings', {
      ...aiSettings,
      // Don't sync API keys for security — user must set them per device
      apiKey: '',
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

  // Merge cloud data with local (cloud wins for conflicts)
  const localResult = await chrome.storage.local.get([
    'autofill_data',
    'global_profile_data',
    'ai_settings',
    'job_applications',
  ]);

  const updates = {};

  if (autofillData) {
    const localAutofill = localResult.autofill_data || { sites: {}, hostnameMappings: {} };
    // Deep merge: cloud sites + local sites (cloud fields overwrite, local-only fields kept)
    const mergedSites = { ...localAutofill.sites };
    for (const [hostname, site] of Object.entries(autofillData.sites || {})) {
      if (mergedSites[hostname]) {
        mergedSites[hostname] = {
          ...mergedSites[hostname],
          ...site,
          fields: { ...mergedSites[hostname].fields, ...(site.fields || {}) },
        };
      } else {
        mergedSites[hostname] = site;
      }
    }
    updates.autofill_data = {
      sites: mergedSites,
      hostnameMappings: {
        ...(localAutofill.hostnameMappings || {}),
        ...(autofillData.hostnameMappings || {}),
      },
    };
  }

  if (profile) {
    const localProfile = localResult.global_profile_data || {};
    // Cloud wins, but keep local-only fields
    updates.global_profile_data = { ...localProfile, ...profile };
  }

  if (aiSettings) {
    const localAi = localResult.ai_settings || {};
    // Cloud wins EXCEPT for apiKey (keep local key)
    updates.ai_settings = {
      ...localAi,
      ...aiSettings,
      apiKey: localAi.apiKey || aiSettings.apiKey || '',
    };
  }

  if (appData?.list) {
    const localApps = localResult.job_applications || [];
    // Merge by ID: cloud wins for duplicates, keep local-only apps
    const mergedApps = [...localApps];
    for (const cloudApp of appData.list) {
      const idx = mergedApps.findIndex(a => a.id === cloudApp.id);
      if (idx >= 0) {
        mergedApps[idx] = cloudApp; // Cloud wins
      } else {
        mergedApps.push(cloudApp);
      }
    }
    updates.job_applications = mergedApps;
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
