// popup.js

let currentHostname = '';
let siteData = { enabled: false, fields: {} };

// ── Utilities ──────────────────────────────────────────────────
function showToast(msg) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

function renderFields(fields) {
  const list = document.getElementById('fields-list');
  const keys = Object.keys(fields);
  document.getElementById('field-count').textContent = keys.length;

  if (keys.length === 0) {
    list.innerHTML = '<div class="empty-state">No data saved yet.<br/>Enable the site and submit a form.</div>';
    return;
  }

  list.innerHTML = '';
  keys.forEach(key => {
    const item = document.createElement('div');
    item.className = 'field-item';
    item.innerHTML = `
      <span class="field-key" title="${key}">${key}</span>
      <input class="field-val" data-key="${key}" value="${escHtml(fields[key])}" title="${escHtml(fields[key])}"/>
    `;
    list.appendChild(item);
  });

  // Save inline edits on blur
  list.querySelectorAll('.field-val').forEach(input => {
    input.addEventListener('change', async () => {
      siteData.fields[input.dataset.key] = input.value;
      await chrome.runtime.sendMessage({
        type: 'SAVE_FIELDS', hostname: currentHostname, fields: siteData.fields
      });
    });
  });
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function updateStatusUI() {
  const tog = document.getElementById('enable-toggle');
  const sub = document.getElementById('toggle-sub');
  const st  = document.getElementById('status-text');
  tog.checked = siteData.enabled;
  sub.textContent = siteData.enabled ? 'Autofill active' : 'Autofill paused';
  st.textContent = siteData.enabled ? 'Active' : 'Disabled';
  st.className = siteData.enabled ? 'stat-value active' : 'stat-value inactive';
}

// ── Init ───────────────────────────────────────────────────────
async function init() {
  // Get active tab hostname
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const url = new URL(tab.url);
    currentHostname = url.hostname.replace(/^www\./, '');
  } catch {
    currentHostname = 'unknown';
  }

  document.getElementById('site-badge').textContent = currentHostname;

  // Load site data
  const resp = await chrome.runtime.sendMessage({ type: 'GET_SITE_DATA', hostname: currentHostname });
  siteData = resp?.site || { enabled: false, fields: {} };

  updateStatusUI();
  renderFields(siteData.fields || {});
}

// ── Events ─────────────────────────────────────────────────────
document.getElementById('enable-toggle').addEventListener('change', async (e) => {
  siteData.enabled = e.target.checked;
  await chrome.runtime.sendMessage({ type: 'SET_ENABLED', hostname: currentHostname, enabled: siteData.enabled });
  updateStatusUI();
  showToast(siteData.enabled ? '✓ Enabled for ' + currentHostname : '✗ Disabled for ' + currentHostname);
});

document.getElementById('btn-autofill').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'MANUAL_AUTOFILL' });
    if (resp?.ok) {
      showToast('✓ Autofilled current page');
    } else {
      showToast('⚠ Enable site to autofill or save data first');
    }
  } catch {
    showToast('⚠ Could not reach page — try refreshing');
  }
});

document.getElementById('btn-save').addEventListener('click', async () => {
  // Ask the content script to grab current page fields
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'MANUAL_SAVE' });
    if (resp?.ok) {
      // Refresh local data
      const fresh = await chrome.runtime.sendMessage({ type: 'GET_SITE_DATA', hostname: currentHostname });
      siteData = fresh?.site || siteData;
      renderFields(siteData.fields || {});
      showToast(`✓ Synced ${resp.count} field(s)`);
    } else {
      showToast('⚠ No filled fields found on this page');
    }
  } catch {
    showToast('⚠ Could not reach page — try refreshing');
  }
});

document.getElementById('btn-clear').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'CLEAR_SITE', hostname: currentHostname });
  siteData.fields = {};
  renderFields({});
  showToast('🗑 Cleared data for ' + currentHostname);
});

init();
