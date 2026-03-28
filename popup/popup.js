// popup.js — FormPilot AI Popup (Refactored)

let currentHostname = '';
let siteData = { enabled: true, fields: {} };
let aiEnabled = false;
let teachActive = false;
let initInFlight = false;
let initAttempts = 0;
const THEME_KEY = 'ui_theme';
let themePreference = 'system';
let themeMediaQuery = null;
let popupDragOffset = { x: 0, y: 0 };

function isSiteDisabledLocal() {
  return !!(siteData.disabled || siteData.enabled === false || siteData.flags?.neverPrompt);
}

function withTimeout(promise, ms, fallback = null) {
  let timeoutId;
  const timeout = new Promise(resolve => {
    timeoutId = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

// ── Utilities ──────────────────────────────────────────────────
function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function resolveTheme(pref) {
  if (pref === 'dark' || pref === 'light') return pref;
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  return prefersDark ? 'dark' : 'light';
}

function updateThemeIcon(resolved) {
  const icon = document.getElementById('theme-icon');
  if (!icon) return;
  if (resolved === 'dark') {
    icon.innerHTML = '<circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>';
  } else {
    icon.innerHTML = '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"></path>';
  }
}

function applyTheme(pref) {
  themePreference = pref || 'system';
  const resolved = resolveTheme(themePreference);
  document.documentElement.dataset.theme = resolved;
  updateThemeIcon(resolved);
}

async function initTheme() {
  try {
    const stored = await chrome.storage.local.get(THEME_KEY);
    const pref = stored?.[THEME_KEY] || 'system';
    applyTheme(pref);
  } catch (_) {
    applyTheme('system');
  }
  if (!themeMediaQuery && window.matchMedia) {
    themeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    themeMediaQuery.addEventListener('change', () => {
      if (themePreference === 'system') applyTheme('system');
    });
  }
}

async function cycleTheme() {
  const next = themePreference === 'system' ? 'light' : themePreference === 'light' ? 'dark' : 'system';
  applyTheme(next);
  try { await chrome.storage.local.set({ [THEME_KEY]: next }); } catch (_) {}
}

function showToast(msg, type = 'info') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translateX(-50%) translateY(8px) scale(0.95)';
    setTimeout(() => t.remove(), 300);
  }, 2200);
}

function renderFields(fields) {
  const list = document.getElementById('fields-list');
  const keys = Object.keys(fields || {});
  const disabled = isSiteDisabledLocal();
  document.getElementById('field-count').textContent = disabled ? '—' : keys.length;

  if (disabled) {
    list.innerHTML = '<div class="empty-state">Extension is disabled for this site.</div>';
    return;
  }

  if (keys.length === 0) {
    list.innerHTML = '<div class="empty-state">No data saved yet.<br/>Enable the site and submit a form.</div>';
    return;
  }

  list.innerHTML = '';
  keys.forEach(key => {
    const item = document.createElement('div');
    item.className = 'field-item';

    const keySpan = document.createElement('span');
    keySpan.className = 'field-key';
    keySpan.title = key;
    keySpan.textContent = key;

    const valInput = document.createElement('input');
    valInput.className = 'field-val';
    valInput.dataset.key = key;
    valInput.value = fields[key] || '';
    valInput.title = fields[key] || '';

    item.appendChild(keySpan);
    item.appendChild(valInput);
    list.appendChild(item);
  });

  // Save inline edits on change
  list.querySelectorAll('.field-val').forEach(input => {
    input.addEventListener('change', async () => {
      try {
        siteData.fields[input.dataset.key] = input.value;
        await chrome.runtime.sendMessage({
          type: 'SAVE_FIELDS', hostname: currentHostname, fields: siteData.fields
        });
        showToast('✓ Field updated', 'success');
      } catch (err) {
        showToast('⚠ Failed to save field', 'error');
      }
    });
  });
}

function updateStatusUI() {
  const tog = document.getElementById('enable-toggle');
  const sub = document.getElementById('toggle-sub');
  const st = document.getElementById('status-text');
  const btnSave = document.getElementById('btn-save');
  const btnFill = document.getElementById('btn-autofill');
  const btnTeach = document.getElementById('btn-teach');

  const disabled = isSiteDisabledLocal();

  if (disabled) {
    tog.checked = false;
    sub.innerHTML = '<span style="color:var(--danger)">Extension disabled for this site</span>';
    st.textContent = siteData.disabled ? 'Blocked' : 'Disabled';
    st.className = 'stat-value inactive';
    document.body.classList.add('site-disabled');
    btnSave.disabled = true;
    btnFill.disabled = true;
    if (btnTeach) btnTeach.disabled = true;
    renderFields({});
    return;
  }

  document.body.classList.remove('site-disabled');
  tog.checked = siteData.enabled;
  sub.textContent = siteData.enabled ? 'Autofill active' : 'Autofill paused';
  st.textContent = siteData.enabled ? 'Active' : 'Disabled';
  st.className = siteData.enabled ? 'stat-value active' : 'stat-value inactive';
  btnSave.disabled = !siteData.enabled;
  btnFill.disabled = !siteData.enabled;
  if (btnTeach) btnTeach.disabled = !siteData.enabled;
}

function setLoading(btnId, isLoading) {
  const btn = typeof btnId === 'string' ? document.getElementById(btnId) : btnId;
  if (!btn) return;
  if (isLoading) {
    btn.dataset.originalHtml = btn.innerHTML;
    btn.innerHTML = '<div class="spinner"></div>';
    btn.disabled = true;
  } else {
    if (btn.dataset.originalHtml) {
      btn.innerHTML = btn.dataset.originalHtml;
      delete btn.dataset.originalHtml;
    }
    btn.disabled = false;
  }
}

async function initPopupDrag() {
  const shell = document.getElementById('main-ui');
  const handle = document.querySelector('.drag-handle');
  if (!shell || !handle) return;

  try {
    const stored = await chrome.storage.local.get('popup_offset');
    const saved = stored?.popup_offset;
    if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
      popupDragOffset = { x: saved.x, y: saved.y };
      shell.style.transform = `translate(${popupDragOffset.x}px, ${popupDragOffset.y}px)`;
    }
  } catch (_) {}

  let dragging = false;
  let startX = 0;
  let startY = 0;
  let baseX = 0;
  let baseY = 0;

  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button, a, input, select, textarea')) return;
    dragging = true;
    handle.classList.add('dragging');
    startX = e.clientX;
    startY = e.clientY;
    baseX = popupDragOffset.x;
    baseY = popupDragOffset.y;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const maxX = 80;
    const maxY = 120;
    const nextX = Math.max(-maxX, Math.min(maxX, baseX + dx));
    const nextY = Math.max(-maxY, Math.min(maxY, baseY + dy));
    popupDragOffset = { x: nextX, y: nextY };
    shell.style.transform = `translate(${nextX}px, ${nextY}px)`;
  });

  document.addEventListener('mouseup', async () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    try { await chrome.storage.local.set({ popup_offset: popupDragOffset }); } catch (_) {}
  });
}

// ── Safe tab messaging ─────────────────────────────────────────
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    return null;
  }
}

// ── Init ───────────────────────────────────────────────────────
async function init() {
  if (initInFlight) return;
  initInFlight = true;
  initAttempts += 1;
  try {
    const authEl = document.getElementById('auth-ui');
    const mainEl = document.getElementById('main-ui');

    // Default to main UI (local use should never be blocked by cloud auth)
    if (authEl) authEl.style.display = 'none';
    if (mainEl) mainEl.style.display = 'block';

    const tab = await getActiveTab();
    try {
      const url = new URL(tab.url);
      currentHostname = url.hostname.replace(/^www\./, '');
    } catch {
      currentHostname = 'unknown';
    }

    // Auth Gate
    const authStatus = await withTimeout(
      chrome.runtime.sendMessage({ type: 'CLOUD_GET_STATUS' }).catch(() => null),
      5000,
      null
    );
    if (!authStatus) {
      const errEl = document.getElementById('auth-error-msg');
      if (errEl) {
        errEl.innerHTML = 'Background not responding. <a href="#" id="auth-retry">Retry</a>';
        const retry = document.getElementById('auth-retry');
        if (retry) {
          retry.addEventListener('click', (e) => {
            e.preventDefault();
            init();
          });
        }
      }
      if (initAttempts < 3) {
        setTimeout(() => init(), 1200);
      }
    }
    document.getElementById('site-badge').textContent = currentHostname;

    // Load site data & AI settings in parallel
    const [siteResp, aiResp, keyResp] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'GET_SITE_DATA', hostname: currentHostname }),
      chrome.runtime.sendMessage({ type: 'AI_GET_SETTINGS' }),
      chrome.runtime.sendMessage({ type: 'GET_SITE_KEY', hostname: currentHostname })
    ]);

    siteData = siteResp?.site || { enabled: true, fields: {} };

    const siteKey = keyResp?.siteKey || currentHostname;
    document.getElementById('site-key-input').value = siteKey;

    // Show AI section if enabled (built-in doesn't need an API key)
    const settings = aiResp?.settings || {};
    aiEnabled = settings.enabled && (settings.provider === 'built-in' || !!settings.apiKey);
    document.getElementById('ai-actions').style.display = aiEnabled ? 'block' : 'none';

    updateStatusUI();
    renderFields(siteData.fields || {});
  } catch (err) {
    console.error('[Popup] Init error:', err);
    showToast('⚠ Failed to load data', 'error');
    document.getElementById('auth-ui').style.display = 'flex';
    document.getElementById('auth-error-msg').textContent = 'Initialization failed. Please reload the extension.';
  } finally {
    initInFlight = false;
  }
}

// ── Events ─────────────────────────────────────────────────────
document.getElementById('enable-toggle').addEventListener('change', async (e) => {
  try {
    siteData.enabled = e.target.checked;
    if (siteData.enabled) siteData.disabled = false;
    await chrome.runtime.sendMessage({
      type: 'SET_ENABLED',
      hostname: currentHostname,
      enabled: siteData.enabled,
      clearDisabled: siteData.enabled
    });
    if (siteData.enabled) {
      siteData.flags = siteData.flags || {};
      siteData.flags.neverPrompt = false;
      await chrome.runtime.sendMessage({
        type: 'SET_SITE_FLAGS',
        hostname: currentHostname,
        flags: { neverPrompt: false }
      });
    }
    const tab = await getActiveTab();
    if (tab?.id) {
      await sendToTab(tab.id, { type: 'SITE_SETTINGS_UPDATE', enabled: siteData.enabled });
    }
    updateStatusUI();
    showToast(siteData.enabled ? '✓ Enabled for ' + currentHostname : '✗ Disabled for ' + currentHostname);
  } catch (err) {
    showToast('⚠ Failed to update setting', 'error');
  }
});

document.getElementById('btn-autofill').addEventListener('click', async () => {
  const tab = await getActiveTab();
  const resp = await sendToTab(tab?.id, { type: 'MANUAL_AUTOFILL' });
  if (resp?.ok) {
    showToast('✓ Autofilled current page', 'success');
  } else {
    showToast('⚠ Enable site to autofill or save data first', 'error');
  }
});

document.getElementById('btn-teach').addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  const btn = document.getElementById('btn-teach');
  if (!btn.dataset.defaultHtml) btn.dataset.defaultHtml = btn.innerHTML;
  if (!teachActive) {
    await sendToTab(tab.id, { type: 'TEACH_MODE_START' });
    teachActive = true;
    btn.textContent = 'Teaching...';
    showToast('Click a field to teach mapping', 'success');
  } else {
    await sendToTab(tab.id, { type: 'TEACH_MODE_STOP' });
    teachActive = false;
    btn.innerHTML = btn.dataset.defaultHtml || btn.innerHTML;
    showToast('Teach mode stopped', 'info');
  }
});

// Restore Teach button icon text when popup loads
const teachBtn = document.getElementById('btn-teach');
if (teachBtn && !teachBtn.dataset.defaultHtml) {
  teachBtn.dataset.defaultHtml = teachBtn.innerHTML;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'TEACH_MODE_DONE') {
    const btn = document.getElementById('btn-teach');
    teachActive = false;
    if (btn?.dataset.defaultHtml) btn.innerHTML = btn.dataset.defaultHtml;
  }
});

document.getElementById('btn-save').addEventListener('click', async () => {
  const tab = await getActiveTab();
  const resp = await sendToTab(tab?.id, { type: 'MANUAL_SAVE' });
  if (resp?.ok) {
    try {
      const fresh = await chrome.runtime.sendMessage({ type: 'GET_SITE_DATA', hostname: currentHostname });
      siteData = fresh?.site || siteData;
      renderFields(siteData.fields || {});
      showToast(`✓ Synced ${resp.count} field(s)`, 'success');
    } catch {
      showToast(`✓ Saved ${resp.count} field(s)`, 'success');
    }
  } else {
    showToast('⚠ No filled fields found on this page', 'error');
  }
});

document.getElementById('btn-clear').addEventListener('click', async () => {
  try {
    await chrome.runtime.sendMessage({ type: 'CLEAR_SITE', hostname: currentHostname });
    siteData.fields = {};
    renderFields({});
    showToast('🗑 Cleared data for ' + currentHostname, 'success');
  } catch (err) {
    showToast('⚠ Failed to clear data', 'error');
  }
});

document.getElementById('btn-settings').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD' }).catch(() => {});
});

// Rename logic
document.getElementById('btn-rename').addEventListener('click', async () => {
  const input = document.getElementById('site-key-input');
  const newKey = input.value.trim();
  const badge = document.getElementById('site-badge');
  const oldKey = badge.textContent;

  if (!newKey) {
    showToast('⚠ Site key cannot be empty', 'error');
    return;
  }
  if (newKey === oldKey) return;

  try {
    const resp = await chrome.runtime.sendMessage({ type: 'RENAME_SITE', hostname: currentHostname, newKey });
    if (resp?.ok) {
      badge.textContent = resp.newKey;
      showToast('✓ Site key saved!', 'success');
      const dataResp = await chrome.runtime.sendMessage({ type: 'GET_SITE_DATA', hostname: currentHostname });
      siteData = dataResp?.site || siteData;
      renderFields(siteData.fields || {});
    } else {
      showToast('⚠ Failed to rename site key', 'error');
    }
  } catch (err) {
    showToast('⚠ Failed to rename site key', 'error');
  }
});

// ── AI Copilot Events ──────────────────────────────────────────

async function extractJobContent() {
  const tab = await getActiveTab();
  if (!tab?.id) return null;

  // Can't run on restricted pages
  const restricted = ['chrome://', 'edge://', 'about:', 'chrome-extension://'];
  if (restricted.some(prefix => tab.url?.startsWith(prefix))) {
    return null;
  }

  return (await sendToTab(tab.id, { type: 'EXTRACT_PAGE_TEXT' }))?.text || null;
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
  try {
    const text = document.getElementById('ai-result-content').innerText;
    await navigator.clipboard.writeText(text);
    showToast('✓ Copied to clipboard!', 'success');
  } catch {
    showToast('⚠ Failed to copy', 'error');
  }
});

document.getElementById('btn-ai-upload').addEventListener('click', () => {
  // Open dashboard at the profile/resume tab
  chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD', hash: '#tab-profile' }).catch(() => {});
  showToast('Opening Dashboard → Profile tab to upload resume', 'info');
});

document.getElementById('btn-ai-match').addEventListener('click', async () => {
  setLoading('btn-ai-match', true);
  showAiResult('Match Score', '<div style="color:var(--text-dim)">Analyzing job description...</div>');

  const pageText = await extractJobContent();
  if (!pageText) {
    showAiResult('Error', '<span style="color:var(--red)">Could not read page content.</span><br/><br/><strong>Try refreshing the page</strong> or ensuring you are on a job application site.');
    setLoading('btn-ai-match', false);
    return;
  }

  try {
    const resp = await chrome.runtime.sendMessage({ type: 'AI_SCORE_MATCH', jobDescription: pageText });
    if (resp.ok && resp.score) {
      const s = resp.score;
      const scoreColor = s.overallScore > 75 ? 'var(--green)' : s.overallScore > 50 ? 'var(--amber)' : 'var(--red)';
      const scoreLabel = s.overallScore > 75 ? '🟢 Strong Fit' : s.overallScore > 50 ? '🟡 Fair Match' : '🔴 Weak Match';
      const html = `
        <div style="display:flex; align-items:center; gap:12px; margin-bottom:10px;">
          <div style="font-size: 32px; font-weight: 800; color: ${scoreColor};">
            ${Number(s.overallScore) || 0}
          </div>
          <div>
            <div style="font-weight:700; color:${scoreColor}; font-size:13px;">${scoreLabel}</div>
            <div style="color:var(--text-dim); font-size:11px;">out of 100</div>
          </div>
        </div>
        <div style="margin-bottom:6px;"><strong>Recommendation:</strong> ${escHtml(s.recommendation)}</div>
        <div style="margin-bottom:6px;"><strong>Strengths:</strong> ${escHtml((s.keyStrengths || []).join(', '))}</div>
        ${s.gaps && s.gaps.length > 0 ? `<div style="margin-bottom:6px;"><strong>Gaps:</strong> ${escHtml(s.gaps.join(', '))}</div>` : ''}
        ${s.tips && s.tips.length > 0 ? `<div style="margin-bottom:6px;"><strong>Tips:</strong> ${escHtml(s.tips.join('; '))}</div>` : ''}
        <div style="margin-top:8px;padding:6px 8px;background:rgba(99,102,241,0.1);border-radius:6px;font-size:11px;color:var(--text-dim);">🤖 AI learns from every application you track — results improve over time</div>
      `;
      showAiResult('Match Score Result', html, false);
    } else {
      throw new Error(resp.error || 'Failed to score match');
    }
  } catch (e) {
    showAiResult('Error', `<span style="color:var(--red)">${escHtml(e.message)}</span>`);
  } finally {
    setLoading('btn-ai-match', false);
  }
});

document.getElementById('btn-ai-track').addEventListener('click', async () => {
  setLoading('btn-ai-track', true);
  showAiResult('Application Tracker', '<div style="color:var(--text-dim)">Extracting job details...</div>');

  const pageText = await extractJobContent();
  if (!pageText) {
    showAiResult('Error', '<span style="color:var(--red)">Could not read page content.</span>');
    setLoading('btn-ai-track', false);
    return;
  }

  try {
    // 1. Extract job info
    const extResp = await chrome.runtime.sendMessage({ type: 'AI_EXTRACT_JOB', pageContent: pageText });
    if (!extResp.ok || !extResp.info) throw new Error(extResp.error || 'Extraction failed');

    const info = extResp.info;
    if (!info.companyName) throw new Error('Could not identify company name from the page');

    // 2. Add to tracker
    const tab = await getActiveTab();
    const app = {
      companyName: info.companyName,
      jobTitle: info.jobTitle || 'Unknown Role',
      location: info.location || '',
      status: 'applied',
      url: tab?.url || '',
      jobDescription: pageText
    };

    const addResp = await chrome.runtime.sendMessage({ type: 'APP_ADD', application: app });
    if (addResp.ok) {
      showAiResult('Added to Tracker',
        `<strong style="color:var(--green)">✓ Tracked successfully!</strong><br><br>${escHtml(app.companyName)} — ${escHtml(app.jobTitle)}`,
        false
      );
    } else {
      throw new Error(addResp.error || 'Failed to add application');
    }
  } catch (e) {
    showAiResult('Error', `<span style="color:var(--red)">${escHtml(e.message)}</span>`);
  } finally {
    setLoading('btn-ai-track', false);
  }
});

// ── Auth Gate Setup ────────────────────────────────────────────
function setupAuthListeners() {
  const btnGoogle = document.getElementById('btn-auth-google');
  const btnEmail = document.getElementById('btn-auth-signin');
  const msg = document.getElementById('auth-error-msg');

  document.getElementById('auth-link-setup').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD' }).catch(() => {});
  });

  btnEmail.addEventListener('click', async () => {
    const email = document.getElementById('auth-email').value;
    const pwd = document.getElementById('auth-password').value;
    if (!email || !pwd) {
      msg.textContent = 'Email and password required.';
      return;
    }
    
    msg.textContent = '';
    btnEmail.disabled = true;
    btnEmail.textContent = 'Signing in...';

    try {
      const resp = await withTimeout(
        chrome.runtime.sendMessage({ type: 'CLOUD_SIGN_IN', email, password: pwd }).catch(() => null),
        6000,
        null
      );
      if (!resp) {
        msg.textContent = 'Background not responding. Please reload the extension.';
        return;
      }
      if (resp.ok) {
        window.location.reload(); // Reload popup to show main UI
      } else {
        msg.textContent = resp.error;
      }
    } catch (err) {
      msg.textContent = err.message;
    } finally {
      btnEmail.disabled = false;
      btnEmail.textContent = 'Sign In';
    }
  });

  if (btnGoogle) {
    btnGoogle.addEventListener('click', async () => {
      msg.textContent = '';
      btnGoogle.disabled = true;
      
      try {
        if (!chrome.identity || !chrome.identity.getAuthToken) {
          msg.textContent = 'Google Sign-in unavailable. Check identity permission.';
          btnGoogle.disabled = false;
          return;
        }
        // 1. Get Google Access Token via Chrome Identity API
        chrome.identity.getAuthToken({ interactive: true }, async (token) => {
          if (chrome.runtime.lastError || !token) {
            const errorMsg = chrome.runtime.lastError?.message || 'Google Auth failed';
            console.error('[Popup] getAuthToken error:', errorMsg);
            msg.textContent = errorMsg + (errorMsg.includes('mismatch') ? ' (Check Extension ID)' : '');
            btnGoogle.disabled = false;
            return;
          }

          // 2. Pass to Background for Firebase Auth
          try {
            const resp = await chrome.runtime.sendMessage({ type: 'CLOUD_SIGN_IN_GOOGLE', accessToken: token });
            if (resp.ok) {
              window.location.reload();
            } else {
              console.error('[Popup] CLOUD_SIGN_IN_GOOGLE error:', resp.error);
              // If Firebase rejects the token, it might be expired or cached wrong.
              // We'll clear the cache so the next click forces a fresh one.
              if (chrome.identity.removeCachedAuthToken) {
                chrome.identity.removeCachedAuthToken({ token: token }, () => {});
              }
              msg.textContent = resp.error;
              btnGoogle.disabled = false;
            }
          } catch (err) {
            msg.textContent = 'Connection error. Check background console.';
            btnGoogle.disabled = false;
          }
        });
      } catch (err) {
        msg.textContent = err.message;
        btnGoogle.disabled = false;
      }
    });
  }
}

// ── Kickoff ────────────────────────────────────────────────────
initTheme();
initPopupDrag();
const themeBtn = document.getElementById('btn-theme-toggle');
if (themeBtn) themeBtn.addEventListener('click', () => { cycleTheme(); });
init();
