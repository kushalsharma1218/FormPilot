// background.js — Service Worker

const STORAGE_KEY = 'autofill_data';

async function getData() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || { sites: {}, hostnameMappings: {} };
}

async function saveData(data) {
  await chrome.storage.local.set({ [STORAGE_KEY]: data });
}

// Resolve the effective site key for a hostname (custom or plain hostname)
function resolveSiteKey(data, hostname) {
  return (data.hostnameMappings || {})[hostname] || hostname;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const data = await getData();
    if (!data.hostnameMappings) data.hostnameMappings = {};

    if (msg.type === 'GET_SITE_KEY') {
      // Returns the effective site key (custom or plain hostname)
      const siteKey = resolveSiteKey(data, msg.hostname);
      sendResponse({ siteKey });

    } else if (msg.type === 'GET_SITE_DATA') {
      const siteKey = resolveSiteKey(data, msg.hostname);
      const site = data.sites[siteKey] || { enabled: false, fields: {} };
      sendResponse({ site, siteKey });

    } else if (msg.type === 'SET_ENABLED') {
      const siteKey = resolveSiteKey(data, msg.hostname);
      if (!data.sites[siteKey]) data.sites[siteKey] = { enabled: false, fields: {} };
      data.sites[siteKey].enabled = msg.enabled;
      await saveData(data);
      sendResponse({ ok: true });

    } else if (msg.type === 'SAVE_FIELDS') {
      const siteKey = resolveSiteKey(data, msg.hostname);
      if (!data.sites[siteKey]) data.sites[siteKey] = { enabled: true, fields: {} };
      // Merge new fields — works across multiple pages of same site
      data.sites[siteKey].fields = Object.assign(
        {},
        data.sites[siteKey].fields,
        msg.fields
      );
      await saveData(data);
      sendResponse({ ok: true });

    } else if (msg.type === 'CLEAR_SITE') {
      const siteKey = resolveSiteKey(data, msg.hostname);
      if (data.sites[siteKey]) data.sites[siteKey].fields = {};
      await saveData(data);
      sendResponse({ ok: true });

    } else if (msg.type === 'RENAME_SITE') {
      // msg.hostname = current browser hostname, msg.newKey = user-defined key
      const oldKey = resolveSiteKey(data, msg.hostname);
      const newKey = msg.newKey.trim();
      if (!newKey || newKey === oldKey) { sendResponse({ ok: false }); return; }

      // Move site data to new key
      if (data.sites[oldKey]) {
        data.sites[newKey] = data.sites[oldKey];
        delete data.sites[oldKey];
      }
      // Update mapping: this hostname now points to newKey
      data.hostnameMappings[msg.hostname] = newKey;
      await saveData(data);
      sendResponse({ ok: true, newKey });

    } else if (msg.type === 'GET_ALL_DATA') {
      sendResponse({ data });
    }
  })();
  return true; // keep message channel open for async
});
