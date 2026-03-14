/* eslint-disable no-var */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.JobAutofill = root.JobAutofill || {};
    root.JobAutofill.AuthStore = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var AUTH_STORAGE_KEY = 'cloud_auth';

  async function getAuthState() {
    try {
      var result = await chrome.storage.local.get(AUTH_STORAGE_KEY);
      return result[AUTH_STORAGE_KEY] || null;
    } catch (err) {
      console.warn('[AuthStore] Failed to read auth state:', err);
      return null;
    }
  }

  async function saveAuthState(state) {
    await chrome.storage.local.set((function () {
      var obj = {};
      obj[AUTH_STORAGE_KEY] = state;
      return obj;
    })());
  }

  async function clearAuthState() {
    await chrome.storage.local.remove(AUTH_STORAGE_KEY);
  }

  async function getUserKey(baseKey) {
    var auth = await getAuthState();
    return auth ? ('user_' + auth.userId + '_' + baseKey) : baseKey;
  }

  return {
    AUTH_STORAGE_KEY: AUTH_STORAGE_KEY,
    getAuthState: getAuthState,
    saveAuthState: saveAuthState,
    clearAuthState: clearAuthState,
    getUserKey: getUserKey,
  };
});
