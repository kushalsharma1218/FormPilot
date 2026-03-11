// popup.js

let currentHostname = '';
let siteData = { enabled: false, fields: {} };
let aiEnabled = false;

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
  const keys = Object.keys(fields || {});
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
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function updateStatusUI() {
  const tog = document.getElementById('enable-toggle');
  const sub = document.getElementById('toggle-sub');
  const st = document.getElementById('status-text');

  if (siteData.disabled) {
    tog.checked = false;
    sub.innerHTML = '<span style="color:var(--danger)">Extension disabled for this site</span>';
    st.textContent = 'Blocked';
    st.className = 'stat-value inactive';
    document.body.classList.add('site-disabled');
    document.getElementById('btn-save').disabled = true;
    document.getElementById('btn-autofill').disabled = true;
    return;
  }

  document.body.classList.remove('site-disabled');
  tog.checked = siteData.enabled;
  sub.textContent = siteData.enabled ? 'Autofill active' : 'Autofill paused';
  st.textContent = siteData.enabled ? 'Active' : 'Disabled';
  st.className = siteData.enabled ? 'stat-value active' : 'stat-value inactive';
  document.getElementById('btn-save').disabled = !siteData.enabled;
  document.getElementById('btn-autofill').disabled = !siteData.enabled;
}

function setLoading(btnId, isLoading) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  if (isLoading) {
    btn.dataset.originalHtml = btn.innerHTML;
    btn.innerHTML = '<div class="spinner"></div>';
    btn.disabled = true;
  } else {
    btn.innerHTML = btn.dataset.originalHtml || btn.innerHTML;
    btn.disabled = false;
  }
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

  // Load site data & AI settings
  const [siteResp, aiResp, keyResp] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'GET_SITE_DATA', hostname: currentHostname }),
    chrome.runtime.sendMessage({ type: 'AI_GET_SETTINGS' }),
    chrome.runtime.sendMessage({ type: 'GET_SITE_KEY', hostname: currentHostname })
  ]);

  siteData = siteResp?.site || { enabled: false, fields: {} };

  const siteKey = keyResp?.siteKey || currentHostname;
  document.getElementById('site-key-input').value = siteKey;

  // Show AI section if enabled
  aiEnabled = aiResp?.settings?.enabled && aiResp?.settings?.apiKey;
  if (aiEnabled) {
    document.getElementById('ai-actions').style.display = 'block';
  }

  updateStatusUI();
  renderFields(siteData.fields || {});
}

// ── Events ─────────────────────────────────────────────────────
document.getElementById('enable-toggle').addEventListener('change', async (e) => {
  siteData.enabled = e.target.checked;
  if (siteData.enabled) siteData.disabled = false;
  await chrome.runtime.sendMessage({
    type: 'SET_ENABLED',
    hostname: currentHostname,
    enabled: siteData.enabled,
    clearDisabled: siteData.enabled
  });
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
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'MANUAL_SAVE' });
    if (resp?.ok) {
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

document.getElementById('btn-settings').addEventListener('click', () => {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    window.open(chrome.runtime.getURL('dashboard/dashboard.html'));
  }
});

// Rename logic
document.getElementById('btn-rename').addEventListener('click', async () => {
  const newKey = document.getElementById('site-key-input').value.trim();
  const oldKey = document.getElementById('site-badge').textContent;
  if (!newKey || newKey === oldKey) return;

  const resp = await chrome.runtime.sendMessage({ type: 'RENAME_SITE', hostname: currentHostname, newKey: newKey });
  if (resp?.ok) {
    document.getElementById('site-badge').textContent = resp.newKey;
    showToast('✓ Site key saved!');
    const dataResp = await chrome.runtime.sendMessage({ type: 'GET_SITE_DATA', hostname: currentHostname });
    siteData = dataResp?.site || siteData;
    renderFields(siteData.fields || {});
  }
});

// ── AI Copilot Events ──────────────────────────────────────────

async function extractJobContent() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_PAGE_TEXT' });
    return resp?.text || null;
  } catch {
    return null;
  }
}

function showAiResult(title, content, showCopy = false) {
  document.getElementById('ai-result-area').style.display = 'block';
  document.getElementById('ai-result-title').textContent = title;
  document.getElementById('ai-result-content').innerHTML = content;
  document.getElementById('ai-result-actions').style.display = showCopy ? 'flex' : 'none';
}

document.getElementById('btn-ai-close').addEventListener('click', () => {
  document.getElementById('ai-result-area').style.display = 'none';
});

document.getElementById('btn-ai-copy').addEventListener('click', async () => {
  const text = document.getElementById('ai-result-content').innerText;
  await navigator.clipboard.writeText(text);
  showToast('✓ Copied to clipboard!');
});

document.getElementById('btn-ai-upload').addEventListener('click', () => {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    window.open(chrome.runtime.getURL('dashboard/dashboard.html'));
  }
});

document.getElementById('btn-ai-match').addEventListener('click', async () => {
  setLoading('btn-ai-match', true);
  showAiResult('Match Score', 'Analyzing job description...');

  const pageText = await extractJobContent();
  if (!pageText) {
    showAiResult('Error', 'Could not read page content. Try refreshing.');
    setLoading('btn-ai-match', false);
    return;
  }

  try {
    const resp = await chrome.runtime.sendMessage({ type: 'AI_SCORE_MATCH', jobDescription: pageText });
    if (resp.ok && resp.score) {
      const s = resp.score;
      const html = `
        <div style="font-size: 24px; font-weight: 800; color: ${s.overallScore > 75 ? 'var(--green-400)' : s.overallScore > 50 ? 'var(--amber-400)' : 'var(--red-400)'};">
          ${s.overallScore}/100
        </div>
        <div style="margin-top: 8px;"><strong>Recommendation:</strong> ${escHtml(s.recommendation)}</div>
        <div style="margin-top: 8px;"><strong>Strengths:</strong> ${(s.keyStrengths || []).join(', ')}</div>
        ${s.gaps && s.gaps.length > 0 ? `<div style="margin-top: 8px;"><strong>Missing:</strong> ${(s.gaps).join(', ')}</div>` : ''}
      `;
      showAiResult('Match Score Result', html, false);
    } else {
      throw new Error(resp.error || 'Failed to score');
    }
  } catch (e) {
    showAiResult('Error', String(e.message));
  } finally {
    setLoading('btn-ai-match', false);
  }
});

document.getElementById('btn-ai-cover').addEventListener('click', async () => {
  setLoading('btn-ai-cover', true);
  showAiResult('Cover Letter', 'Drafting cover letter...');

  const pageText = await extractJobContent();
  if (!pageText) {
    showAiResult('Error', 'Could not read page content.');
    setLoading('btn-ai-cover', false);
    return;
  }

  try {
    const resp = await chrome.runtime.sendMessage({ type: 'AI_COVER_LETTER', jobDescription: pageText, tone: 'professional' });
    if (resp.ok && resp.letter) {
      showAiResult('AI Cover Letter', escHtml(resp.letter).replace(/\n/g, '<br>'), true);
    } else {
      throw new Error(resp.error || 'Failed to generate');
    }
  } catch (e) {
    showAiResult('Error', String(e.message));
  } finally {
    setLoading('btn-ai-cover', false);
  }
});

document.getElementById('btn-ai-track').addEventListener('click', async () => {
  setLoading('btn-ai-track', true);
  showAiResult('Applications Tracker', 'Extracting job details...');

  const pageText = await extractJobContent();
  if (!pageText) {
    showAiResult('Error', 'Could not read page content.');
    setLoading('btn-ai-track', false);
    return;
  }

  try {
    // 1. Extract info to get company name and title
    const extResp = await chrome.runtime.sendMessage({ type: 'AI_EXTRACT_JOB', pageContent: pageText });
    if (!extResp.ok || !extResp.info) throw new Error(extResp.error || 'Extraction failed');

    const info = extResp.info;
    if (!info.companyName) throw new Error('Could not identify company name');

    // 2. Add to tracker
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const app = {
      companyName: info.companyName,
      jobTitle: info.jobTitle || 'Unknown Role',
      location: info.location || '',
      status: 'applied',
      url: tab.url,
      jobDescription: pageText
    };

    const addResp = await chrome.runtime.sendMessage({ type: 'APP_ADD', application: app });
    if (addResp.ok) {
      showAiResult('Added to Tracker', `<strong style="color:var(--green-400)">✓ Tracked successfully!</strong><br><br>${escHtml(app.companyName)} — ${escHtml(app.jobTitle)}`, false);
    } else {
      throw new Error(addResp.error || 'Failed to add');
    }
  } catch (e) {
    showAiResult('Error', String(e.message));
  } finally {
    setLoading('btn-ai-track', false);
  }
});

init();
