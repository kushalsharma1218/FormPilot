// dashboard.js — FormPilot AI Copilot Dashboard

// ── State ──────────────────────────────────────────────────────
let allData = { sites: {}, hostnameMappings: {} };
let globalProfile = {};
let applications = [];
let tasks = [];
let aiSettings = {};
let resumeVault = { items: [], defaultId: null };
let cloudPrefs = { enabled: false, syncProfile: true, syncAutofill: false, syncApplications: false, syncTasks: false, syncAiSettings: false };
let usageMetrics = {};
let cloudStatus = { configured: false, loggedIn: false, user: null, lastSync: null };
const THEME_KEY = 'ui_theme';
let themePreference = 'system';
let themeMediaQuery = null;

// ── Helpers ────────────────────────────────────────────────────
function bindEvent(id, event, handler) {
    const el = document.getElementById(id);
    if (!el) return null;
    el.addEventListener(event, handler);
    return el;
}

function escHtml(str) {
    const d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
}

function normalizeUrl(url) {
    const raw = (url || '').trim();
    if (!raw) return '';
    if (/^(https?:)?\/\//i.test(raw)) return raw;
    if (/^(mailto:|tel:)/i.test(raw)) return raw;
    return 'https://' + raw;
}

function setStatePill(id, text, state) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.classList.remove('state-on', 'state-off', 'state-warn');
    if (state) el.classList.add(state);
}

function resolveTheme(pref) {
    if (pref === 'dark' || pref === 'light') return pref;
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    return prefersDark ? 'dark' : 'light';
}

function applyTheme(pref) {
    themePreference = pref || 'system';
    const resolved = resolveTheme(themePreference);
    document.documentElement.dataset.theme = resolved;
    document.querySelectorAll('.theme-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.theme === themePreference);
    });
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
    bindThemeToggle();
}

function bindThemeToggle() {
    document.querySelectorAll('.theme-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const pref = btn.dataset.theme || 'system';
            applyTheme(pref);
            try {
                await chrome.storage.local.set({ [THEME_KEY]: pref });
            } catch (_) {}
        });
    });
}

function showToast(msg, type = 'info') {
    const c = document.getElementById('toast-container');
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(() => t.remove(), 3500);
}

function showStatus(msg, type) {
    const el = document.getElementById('save-status');
    if (!el) return;
    el.textContent = msg;
    el.className = `status-msg ${type}`;
    setTimeout(() => { el.className = 'status-msg'; }, 3000);
}

function getInitials(str) {
    return (str || '?').replace(/^www\./, '').substring(0, 2).toUpperCase();
}

function getSiteStatus(site) {
    return site?.disabled ? 'disabled' : site?.enabled ? 'active' : 'paused';
}

function getSiteStatusLabel(site) {
    return site?.disabled ? 'Disabled' : site?.enabled ? 'Active' : 'Paused';
}

function getSiteQuality(site) {
    const metrics = site?.metrics || {};
    const score = metrics.avgScore ?? metrics.last?.score;
    if (score === undefined || score === null || Number.isNaN(Number(score))) return null;
    return Math.round(Number(score));
}

function getQualityClass(score) {
    if (score === null || score === undefined) return '';
    if (score >= 80) return '';
    if (score >= 55) return 'mid';
    return 'low';
}

function formatDate(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function relativeDate(dateStr) {
    const d = new Date(dateStr);
    const days = Math.floor((Date.now() - d.getTime()) / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days} days ago`;
    if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
    return formatDate(dateStr);
}

function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 KB';
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    return `${mb.toFixed(1)} MB`;
}

function formatDuration(seconds) {
    const total = Math.max(0, Number(seconds || 0));
    const hours = Math.floor(total / 3600);
    const mins = Math.floor((total % 3600) / 60);
    if (hours <= 0 && mins <= 0) return '0m';
    if (hours <= 0) return `${mins}m`;
    if (mins <= 0) return `${hours}h`;
    return `${hours}h ${mins}m`;
}

function getLocalDateKey(d = new Date()) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function getDayLabel(dateKey) {
    const d = new Date(dateKey + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-US', { weekday: 'short' });
}

function getRecentDateKeys(days = 7) {
    const keys = [];
    const now = new Date();
    for (let i = 0; i < days; i += 1) {
        const d = new Date(now);
        d.setDate(now.getDate() - i);
        keys.push(getLocalDateKey(d));
    }
    return keys.reverse();
}

function setLoading(btn, loading) {
    if (loading) btn.classList.add('loading');
    else btn.classList.remove('loading');
}

// ── Confirm Modal ──────────────────────────────────────────────
let confirmCallback = null;
function showConfirmModal(title, message, onConfirm) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-message').textContent = message;
    document.getElementById('confirm-modal').hidden = false;
    confirmCallback = onConfirm;
}
bindEvent('modal-cancel','click', () => {
    document.getElementById('confirm-modal').hidden = true;
    confirmCallback = null;
});
bindEvent('modal-confirm','click', async () => {
    document.getElementById('confirm-modal').hidden = true;
    if (confirmCallback) await confirmCallback();
    confirmCallback = null;
});

// Close modals with Escape key or by clicking overlay
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        document.getElementById('confirm-modal').hidden = true;
        document.getElementById('add-app-modal').hidden = true;
        confirmCallback = null;
    }
});

document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            overlay.hidden = true;
            confirmCallback = null;
        }
    });
});

// ── Tab Navigation ─────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    });
});

bindEvent('btn-view-all-apps','click', () => {
    document.querySelector('[data-tab="tracker"]').click();
});

// ── Data Loading ───────────────────────────────────────────────
async function loadAllData() {
    try {
        const authStatus = await chrome.runtime.sendMessage({ type: 'CLOUD_GET_STATUS' });
        cloudStatus = {
            configured: !!authStatus?.configured,
            loggedIn: !!authStatus?.loggedIn,
            user: authStatus?.user || null,
            lastSync: authStatus?.lastSync || null,
        };
        // Allow local-only usage without login
        document.getElementById('dashboard-auth-shield').style.display = 'none';
        document.getElementById('main-dashboard-app').style.display = 'flex';

        const [dataResp, profileResp, aiResp, appsResp, tasksResp, metricsResp] = await Promise.all([
            chrome.runtime.sendMessage({ type: 'GET_ALL_DATA' }),
            chrome.runtime.sendMessage({ type: 'GET_GLOBAL_PROFILE' }),
            chrome.runtime.sendMessage({ type: 'AI_GET_SETTINGS' }),
            chrome.runtime.sendMessage({ type: 'APP_GET_ALL' }),
            chrome.runtime.sendMessage({ type: 'TASK_GET_ALL' }),
            chrome.runtime.sendMessage({ type: 'GET_USAGE_METRICS' }),
        ]);
        allData = dataResp?.data || { sites: {}, hostnameMappings: {} };
        globalProfile = profileResp?.profile || {};
        aiSettings = aiResp?.settings || {};
        applications = appsResp?.apps || [];
        tasks = tasksResp?.tasks || [];
        usageMetrics = metricsResp?.metrics || {};
    } catch (err) {
        console.error('[Dashboard] Load error:', err);
        showToast('Failed to load data. Please reload.', 'error');
    }
    try {
        renderOverview();
        renderMetrics();
        renderSites();
        renderProfile();
        renderTracker();
        renderTasks();
        renderInterviewAppSelect();
        renderDisabledSites();
        renderAiSettings();
        loadResumeVault();
        renderDebugLogs();
    } catch (err) {
        console.error('[Dashboard] Render error:', err);
    }
}

// ── OVERVIEW TAB ───────────────────────────────────────────────
function renderOverview() {
    const sites = Object.keys(allData.sites || {});
    const activeSites = sites.filter(s => allData.sites[s]?.enabled && !allData.sites[s]?.disabled);
    const disabledSites = sites.filter(s => allData.sites[s]?.disabled || allData.sites[s]?.enabled === false);
    const qualityScores = sites
        .map(s => getSiteQuality(allData.sites[s]))
        .filter(v => typeof v === 'number');
    const avgQuality = qualityScores.length
        ? Math.round(qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length)
        : null;

    document.getElementById('stat-total-sites').textContent = sites.length;
    document.getElementById('stat-active-sites').textContent = activeSites.length;
    document.getElementById('stat-applications').textContent = applications.length;
    document.getElementById('stat-ai-status').textContent = aiSettings.enabled ? 'Active' : 'Off';
    const qualityEl = document.getElementById('stat-quality-score');
    if (qualityEl) qualityEl.textContent = avgQuality === null ? '--' : `${avgQuality}`;

    const cloudText = cloudStatus.configured
        ? (cloudStatus.loggedIn ? 'Cloud Sync: Connected' : 'Cloud Sync: Disconnected')
        : 'Cloud Sync: Not Configured';
    const cloudState = cloudStatus.configured ? (cloudStatus.loggedIn ? 'state-on' : 'state-warn') : 'state-off';
    setStatePill('state-cloud', cloudText, cloudState);
    setStatePill('state-disabled-sites', `Disabled Sites: ${disabledSites.length}`, disabledSites.length > 0 ? 'state-warn' : 'state-on');

    // Recent Applications
    const list = document.getElementById('recent-apps-list');
    if (applications.length === 0) {
        list.innerHTML = '<div class="empty-state">No applications tracked yet. Apply to a job to get started!</div>';
    } else {
        list.innerHTML = applications.slice(0, 5).map(app => `
            <div class="recent-site-item">
                <div class="recent-site-info">
                    <div class="site-favicon">${getInitials(app.companyName)}</div>
                    <div>
                        <div class="recent-site-name">${escHtml(app.companyName)}</div>
                        <div class="recent-site-fields">${escHtml(app.jobTitle || 'Untitled')} · ${relativeDate(app.appliedAt)}</div>
                    </div>
                </div>
                <span class="app-status-badge ${app.status}">${app.status}</span>
            </div>
        `).join('');
    }

    // Profile completeness
    const profileFields = ['firstName', 'lastName', 'email', 'phone', 'linkedin', 'currentTitle', 'summary', 'skills', 'workHistory', 'education'];
    let filled = 0;
    profileFields.forEach(f => {
        const val = globalProfile[f];
        if (Array.isArray(val) ? val.length > 0 : val) filled++;
    });
    const pct = Math.round((filled / profileFields.length) * 100);
    document.getElementById('profile-progress').style.width = pct + '%';
    document.getElementById('profile-percent').textContent = pct + '%';
    document.getElementById('profile-hint').textContent =
        pct === 100 ? 'Your profile is complete! 🎉' :
            pct >= 50 ? 'Keep going! Add more to unlock better AI features.' :
                'Upload your resume for instant AI-powered profile setup';
    setStatePill('state-profile', `Profile: ${pct}% complete`, pct >= 80 ? 'state-on' : (pct >= 40 ? 'state-warn' : 'state-off'));
}

// ── METRICS TAB ───────────────────────────────────────────────
function renderMetrics() {
    const m = usageMetrics || {};
    const totalRuns = Number(m.totalRuns || 0);
    const totalFilled = Number(m.totalFieldsFilled || 0);
    const totalDetected = Number(m.totalFieldsDetected || 0);
    const totalTimeSaved = Number(m.totalTimeSavedSec || 0);

    const timeEl = document.getElementById('metric-time-saved');
    const fieldsEl = document.getElementById('metric-fields-filled');
    const runsEl = document.getElementById('metric-autofill-runs');
    const accuracyEl = document.getElementById('metric-fill-accuracy');

    if (timeEl) timeEl.textContent = formatDuration(totalTimeSaved);
    if (fieldsEl) fieldsEl.textContent = totalFilled.toLocaleString();
    if (runsEl) runsEl.textContent = totalRuns.toLocaleString();
    if (accuracyEl) {
        if (totalDetected > 0) {
            accuracyEl.textContent = `${Math.round((totalFilled / totalDetected) * 100)}%`;
        } else {
            accuracyEl.textContent = '--';
        }
    }

    const dailyList = document.getElementById('metric-daily-list');
    if (dailyList) {
        const keys = getRecentDateKeys(7);
        const rows = keys.map(key => {
            const day = (m.daily || {})[key] || {};
            const filled = Number(day.fieldsFilled || 0);
            const timeSaved = Number(day.timeSavedSec || 0);
            return { key, filled, timeSaved };
        });
        const hasData = rows.some(r => r.filled > 0 || r.timeSaved > 0);
        if (!hasData) {
            dailyList.innerHTML = '<div class="empty-state">No usage data yet. Fill a job form to get started.</div>';
        } else {
            dailyList.innerHTML = rows.map(r => `
                <div class="recent-site-item">
                    <div class="recent-site-info">
                        <div class="site-favicon">${getDayLabel(r.key)}</div>
                        <div>
                            <div class="recent-site-name">${r.key}</div>
                            <div class="recent-site-fields">${r.filled} fields · ${formatDuration(r.timeSaved)} saved</div>
                        </div>
                    </div>
                </div>
            `).join('');
        }
    }

    const topSites = document.getElementById('metric-top-sites');
    if (topSites) {
        const sites = Object.entries(m.perSite || {})
            .map(([host, data]) => ({
                host,
                timeSavedSec: Number(data.timeSavedSec || 0),
                fieldsFilled: Number(data.fieldsFilled || 0),
            }))
            .filter(s => s.timeSavedSec > 0 || s.fieldsFilled > 0)
            .sort((a, b) => b.timeSavedSec - a.timeSavedSec)
            .slice(0, 6);

        if (sites.length === 0) {
            topSites.innerHTML = '<div class="empty-state">No site metrics yet.</div>';
        } else {
            topSites.innerHTML = sites.map(site => `
                <div class="recent-site-item">
                    <div class="recent-site-info">
                        <div class="site-favicon">${getInitials(site.host)}</div>
                        <div>
                            <div class="recent-site-name">${escHtml(site.host)}</div>
                            <div class="recent-site-fields">${site.fieldsFilled} fields · ${formatDuration(site.timeSavedSec)} saved</div>
                        </div>
                    </div>
                </div>
            `).join('');
        }
    }
}

// ── SITES TAB ──────────────────────────────────────────────────
function renderSites(filter = '') {
    const list = document.getElementById('all-sites-list');
    const sites = Object.entries(allData.sites || {})
        .filter(([hostname]) => !filter || hostname.toLowerCase().includes(filter.toLowerCase()));

    if (sites.length === 0) {
        list.innerHTML = '<div class="empty-state">No sites recorded yet. Visit a job application page to get started.</div>';
        return;
    }

    list.innerHTML = sites.map(([hostname, site]) => {
        const fields = Object.entries(site.fields || {});
        const status = getSiteStatus(site);
        const label = getSiteStatusLabel(site);
        const quality = getSiteQuality(site);
        const qualityBadge = quality !== null ? `<span class="site-quality-badge ${getQualityClass(quality)}">Quality ${quality}</span>` : '';
        return `
        <div class="site-card" data-hostname="${hostname}">
            <div class="site-card-header" data-toggle="${hostname}">
                <div class="site-card-left">
                    <div class="site-favicon">${getInitials(hostname)}</div>
                    <div>
                        <div class="site-card-name">${escHtml(hostname)}</div>
                        <div class="site-card-meta">${fields.length} field(s)</div>
                    </div>
                </div>
                <div class="site-card-right">
                    ${qualityBadge}
                    <span class="site-status-badge ${status}">${label}</span>
                    <svg class="chevron-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                </div>
            </div>
            <div class="site-card-body" id="body-${hostname}">
                <div class="site-fields-grid">
                    ${fields.map(([k, v]) => `
                        <div class="site-field-row">
                            <span class="site-field-key" title="${escHtml(k)}">${escHtml(k)}</span>
                            <input class="site-field-value" data-hostname="${hostname}" data-key="${escHtml(k)}" value="${escHtml(v)}" />
                            <button class="btn-field-delete" data-hostname="${hostname}" data-key="${k}" title="Delete field">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                            </button>
                        </div>
                    `).join('')}
                    ${fields.length === 0 ? '<div class="empty-state" style="padding:20px">No fields saved</div>' : ''}
                </div>
                <div style="display:flex;gap:8px;margin-top:14px;">
                    <button class="btn btn-danger btn-sm" data-action="clear" data-hostname="${hostname}">Clear Data</button>
                    <button class="btn btn-danger btn-sm" data-action="disable" data-hostname="${hostname}">${site.disabled ? 'Re-enable' : 'Disable Site'}</button>
                </div>
            </div>
        </div>`;
    }).join('');
    attachSiteListeners();
}

function attachSiteListeners() {
    // Toggle expand
    document.querySelectorAll('[data-toggle]').forEach(header => {
        header.addEventListener('click', () => {
            const card = header.closest('.site-card');
            const body = card.querySelector('.site-card-body');
            card.classList.toggle('open');
            body.classList.toggle('open');
        });
    });
    // Field edit
    document.querySelectorAll('.site-field-value').forEach(input => {
        input.addEventListener('change', async () => {
            const hostname = input.dataset.hostname;
            const site = allData.sites[hostname];
            if (site) {
                site.fields[input.dataset.key] = input.value;
                try {
                    await chrome.runtime.sendMessage({ type: 'SAVE_FIELDS', hostname, fields: site.fields });
                    showToast('✓ Field updated', 'success');
                } catch (err) {
                    showToast('⚠ Failed to save field', 'error');
                }
            }
        });
    });
    // Delete field
    document.querySelectorAll('.btn-field-delete').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const hostname = btn.dataset.hostname;
            const key = btn.dataset.key;
            if (allData.sites[hostname]?.fields) {
                delete allData.sites[hostname].fields[key];
                await chrome.runtime.sendMessage({ type: 'SAVE_FIELDS', hostname, fields: allData.sites[hostname].fields });
                renderSites();
                showToast('✓ Field deleted', 'success');
            }
        });
    });
    // Actions
    document.querySelectorAll('[data-action="clear"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            await chrome.runtime.sendMessage({ type: 'CLEAR_SITE', hostname: btn.dataset.hostname });
            if (allData.sites[btn.dataset.hostname]) allData.sites[btn.dataset.hostname].fields = {};
            renderSites();
            showToast('✓ Site data cleared', 'success');
        });
    });
    document.querySelectorAll('[data-action="disable"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const hostname = btn.dataset.hostname;
            const site = allData.sites[hostname];
            if (site?.disabled) {
                await chrome.runtime.sendMessage({ type: 'SET_ENABLED', hostname, enabled: false, clearDisabled: true });
                site.disabled = false;
            } else {
                await chrome.runtime.sendMessage({ type: 'DISABLE_SITE', hostname });
                if (site) site.disabled = true;
            }
            renderSites();
            renderDisabledSites();
            showToast('✓ Updated', 'success');
        });
    });
}

bindEvent('site-search','input', (e) => {
    renderSites(e.target.value);
});

// ── PROFILE TAB ────────────────────────────────────────────────
function renderProfile() {
    // Basic fields
    const basicFields = ['firstName', 'lastName', 'email', 'phone', 'linkedin', 'github', 'portfolio', 'address', 'city', 'state', 'zipcode', 'currentCompany', 'currentTitle', 'totalYearsExperience', 'summary'];
    basicFields.forEach(field => {
        const el = document.getElementById(field);
        if (el && globalProfile[field]) el.value = globalProfile[field];
    });
    // Skills
    renderSkills();
    // Work History
    renderWorkHistory();
    // Education
    renderEducation();
}

// Skills
function renderSkills() {
    const container = document.getElementById('skills-container');
    const skills = globalProfile.skills || [];
    container.innerHTML = skills.map((s, i) => `
        <span class="skill-tag">${escHtml(s)}<span class="skill-remove" data-index="${i}">×</span></span>
    `).join('');
    container.querySelectorAll('.skill-remove').forEach(btn => {
        btn.addEventListener('click', () => {
            globalProfile.skills.splice(parseInt(btn.dataset.index), 1);
            renderSkills();
        });
    });
}

function addSkill() {
    const input = document.getElementById('skill-input');
    const skill = input.value.trim();
    if (!skill) return;
    if (!globalProfile.skills) globalProfile.skills = [];
    if (!globalProfile.skills.includes(skill)) {
        globalProfile.skills.push(skill);
        renderSkills();
    }
    input.value = '';
    input.focus();
}

bindEvent('btn-add-skill','click', addSkill);
bindEvent('skill-input','keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addSkill(); }
});

// Work History
function renderWorkHistory() {
    const container = document.getElementById('work-history-container');
    const history = globalProfile.workHistory || [];
    if (history.length === 0) {
        container.innerHTML = '<div class="empty-state" style="padding:20px">No work history added. Click "+ Add Position" or parse your resume.</div>';
        return;
    }
    container.innerHTML = history.map((w, i) => `
        <div class="work-entry" data-index="${i}">
            <div class="work-entry-header">
                <h4>${escHtml(w.title || 'Position')} at ${escHtml(w.company || 'Company')}</h4>
                <button class="btn btn-danger btn-sm" data-remove-work="${i}">Remove</button>
            </div>
            <div class="form-grid">
                <div class="form-group"><label>Company</label><input type="text" data-wf="company" data-wi="${i}" value="${escHtml(w.company || '')}"></div>
                <div class="form-group"><label>Title</label><input type="text" data-wf="title" data-wi="${i}" value="${escHtml(w.title || '')}"></div>
                <div class="form-group"><label>Location</label><input type="text" data-wf="location" data-wi="${i}" value="${escHtml(w.location || '')}"></div>
                <div class="form-group"><label>Start Date</label><input type="text" data-wf="startDate" data-wi="${i}" value="${escHtml(w.startDate || '')}"></div>
                <div class="form-group"><label>End Date</label><input type="text" data-wf="endDate" data-wi="${i}" value="${escHtml(w.endDate || '')}"></div>
            </div>
            <div class="work-bullets">
                <label>Achievements (one per line)</label>
                <textarea data-wf="bullets" data-wi="${i}">${(w.bullets || []).join('\n')}</textarea>
            </div>
        </div>
    `).join('');
    // Remove buttons
    container.querySelectorAll('[data-remove-work]').forEach(btn => {
        btn.addEventListener('click', () => {
            globalProfile.workHistory.splice(parseInt(btn.dataset.removeWork), 1);
            renderWorkHistory();
        });
    });
}

bindEvent('btn-add-work','click', () => {
    if (!globalProfile.workHistory) globalProfile.workHistory = [];
    globalProfile.workHistory.push({ company: '', title: '', location: '', startDate: '', endDate: '', bullets: [] });
    renderWorkHistory();
});

// Education
function renderEducation() {
    const container = document.getElementById('education-container');
    const education = globalProfile.education || [];
    if (education.length === 0) {
        container.innerHTML = '<div class="empty-state" style="padding:20px">No education added. Click "+ Add Education" or parse your resume.</div>';
        return;
    }
    container.innerHTML = education.map((e, i) => `
        <div class="edu-entry" data-index="${i}">
            <div class="edu-entry-header">
                <h4>${escHtml(e.degree || 'Degree')} — ${escHtml(e.school || 'School')}</h4>
                <button class="btn btn-danger btn-sm" data-remove-edu="${i}">Remove</button>
            </div>
            <div class="form-grid">
                <div class="form-group"><label>School</label><input type="text" data-ef="school" data-ei="${i}" value="${escHtml(e.school || '')}"></div>
                <div class="form-group"><label>Degree</label><input type="text" data-ef="degree" data-ei="${i}" value="${escHtml(e.degree || '')}"></div>
                <div class="form-group"><label>Field of Study</label><input type="text" data-ef="field" data-ei="${i}" value="${escHtml(e.field || '')}"></div>
                <div class="form-group"><label>End Date</label><input type="text" data-ef="endDate" data-ei="${i}" value="${escHtml(e.endDate || '')}"></div>
                <div class="form-group"><label>GPA</label><input type="text" data-ef="gpa" data-ei="${i}" value="${escHtml(e.gpa || '')}"></div>
            </div>
        </div>
    `).join('');
    container.querySelectorAll('[data-remove-edu]').forEach(btn => {
        btn.addEventListener('click', () => {
            globalProfile.education.splice(parseInt(btn.dataset.removeEdu), 1);
            renderEducation();
        });
    });
}

bindEvent('btn-add-edu','click', () => {
    if (!globalProfile.education) globalProfile.education = [];
    globalProfile.education.push({ school: '', degree: '', field: '', endDate: '', gpa: '' });
    renderEducation();
});

// Save Profile
bindEvent('profile-form','submit', async (e) => {
    e.preventDefault();
    // Collect basic fields from form
    const basicFields = ['firstName', 'lastName', 'email', 'phone', 'linkedin', 'github', 'portfolio', 'address', 'city', 'state', 'zipcode', 'currentCompany', 'currentTitle', 'totalYearsExperience', 'summary'];
    basicFields.forEach(field => {
        const el = document.getElementById(field);
        if (el) globalProfile[field] = el.value;
    });
    // Collect work history from DOM
    if (globalProfile.workHistory) {
        document.querySelectorAll('[data-wf]').forEach(el => {
            const i = parseInt(el.dataset.wi);
            const f = el.dataset.wf;
            if (f === 'bullets') {
                globalProfile.workHistory[i][f] = el.value.split('\n').filter(l => l.trim());
            } else {
                globalProfile.workHistory[i][f] = el.value;
            }
        });
    }
    // Collect education from DOM
    if (globalProfile.education) {
        document.querySelectorAll('[data-ef]').forEach(el => {
            const i = parseInt(el.dataset.ei);
            globalProfile.education[i][el.dataset.ef] = el.value;
        });
    }
    try {
        await chrome.runtime.sendMessage({ type: 'SAVE_GLOBAL_PROFILE', profile: globalProfile });
        showStatus('✓ Profile saved successfully', 'success');
        showToast('✓ Profile saved', 'success');
        renderOverview();
    } catch (err) {
        showStatus('Failed to save profile.', 'error');
        showToast('Failed to save profile', 'error');
    }
});

// ── Resume Vault (Local) ───────────────────────────────────────
async function loadResumeVault() {
    try {
        const resp = await chrome.runtime.sendMessage({ type: 'RESUME_LIST' });
        if (resp?.ok) {
            resumeVault.items = resp.items || [];
            resumeVault.defaultId = resp.defaultId || null;
        }
    } catch (err) {
        console.warn('[Dashboard] Resume vault load failed:', err);
    }
    renderResumeVault();
}

function renderResumeVault() {
    const list = document.getElementById('resume-vault-list');
    if (!list) return;
    if (!resumeVault.items || resumeVault.items.length === 0) {
        list.innerHTML = '<div class="empty-state">No resumes saved yet.</div>';
        return;
    }
    list.innerHTML = resumeVault.items.map(item => {
        const isDefault = resumeVault.defaultId === item.id;
        const label = item.label ? `<span class="resume-pill">${escHtml(item.label)}</span>` : '';
        const def = isDefault ? `<span class="resume-pill default">Default</span>` : '';
        return `
        <div class="resume-vault-item" data-resume-id="${item.id}">
            <div class="resume-vault-meta">
                <div class="resume-vault-name">${escHtml(item.name || 'Resume')}</div>
                <div class="resume-vault-sub">${formatBytes(item.size)} · ${item.mime || 'file'} · ${relativeDate(item.updatedAt)}</div>
                <div class="resume-vault-sub">${label} ${def}</div>
            </div>
            <div class="resume-vault-actions-row">
                <input class="resume-label-input" placeholder="Label (e.g., ATS)" value="${escHtml(item.label || '')}" />
                ${isDefault ? '' : `<button class="btn btn-secondary btn-sm btn-resume-default">Set Default</button>`}
                <button class="btn btn-danger btn-sm btn-resume-delete">Delete</button>
            </div>
        </div>`;
    }).join('');

    list.querySelectorAll('.resume-vault-item').forEach(el => {
        const id = el.dataset.resumeId;
        const input = el.querySelector('.resume-label-input');
        if (input) {
            input.addEventListener('change', async () => {
                try {
                    const label = input.value.trim();
                    await chrome.runtime.sendMessage({ type: 'RESUME_ADD', resume: { id, label } });
                    loadResumeVault();
                } catch (err) {
                    showToast('Failed to update label', 'error');
                }
            });
        }
        const btnDefault = el.querySelector('.btn-resume-default');
        if (btnDefault) {
            btnDefault.addEventListener('click', async () => {
                await chrome.runtime.sendMessage({ type: 'RESUME_SET_DEFAULT', id });
                loadResumeVault();
            });
        }
        const btnDelete = el.querySelector('.btn-resume-delete');
        if (btnDelete) {
            btnDelete.addEventListener('click', async () => {
                showConfirmModal('Delete resume?', 'This will remove the file from local storage (and cloud if sync is enabled).', async () => {
                    await chrome.runtime.sendMessage({ type: 'RESUME_DELETE', id });
                    loadResumeVault();
                });
            });
        }
    });
}

async function readFileAsDataUrl(file) {
    return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

const resumeVaultInput = document.getElementById('resume-vault-input');
const resumeVaultBtn = document.getElementById('btn-resume-vault-upload');
const resumeVaultStatus = document.getElementById('resume-vault-status');
const resumeVaultLabel = document.getElementById('resume-vault-label');

if (resumeVaultBtn && resumeVaultInput) {
    resumeVaultBtn.addEventListener('click', () => resumeVaultInput.click());
    resumeVaultInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (!/\.(pdf|doc|docx)$/i.test(file.name)) {
            resumeVaultStatus.textContent = '✗ Only PDF/DOC/DOCX supported';
            resumeVaultStatus.className = 'status-msg error';
            return;
        }
        resumeVaultStatus.textContent = 'Uploading...';
        resumeVaultStatus.className = 'status-msg';
        try {
            const dataUrl = await readFileAsDataUrl(file);
            const label = (resumeVaultLabel?.value || '').trim();
            await chrome.runtime.sendMessage({
                type: 'RESUME_ADD',
                resume: { name: file.name, label, mime: file.type, size: file.size, dataUrl }
            });
            if (resumeVaultLabel) resumeVaultLabel.value = '';
            resumeVaultStatus.textContent = '✓ Resume saved';
            resumeVaultStatus.className = 'status-msg success';
            loadResumeVault();
        } catch (err) {
            resumeVaultStatus.textContent = '✗ Upload failed';
            resumeVaultStatus.className = 'status-msg error';
        } finally {
            e.target.value = '';
        }
    });
}

// ── Resume Parsing ─────────────────────────────────────────────
bindEvent('btn-upload-resume','click', () => {
    document.getElementById('resume-file-input').click();
});
bindEvent('resume-file-input','change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const btn = document.getElementById('btn-parse-resume');
    const statusEl = document.getElementById('parse-status');

    if (file.name.toLowerCase().endsWith('.pdf')) {
        // Extract text from PDF using local pdf.js bundle
        setLoading(btn, true);
        statusEl.textContent = 'Extracting text from PDF...';
        statusEl.className = 'status-msg success';

        try {
            if (!window.pdfjsLib) {
                throw new Error('PDF library failed to load locally.');
            }

            // Set the worker source safely within the extension directory
            window.pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('dashboard/pdf.worker.min.js');

            const arrayBuffer = await file.arrayBuffer();
            const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;

            let fullText = '';
            let extractedLinks = [];

            for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i);

                // 1. Extract raw text
                const content = await page.getTextContent();
                const pageText = content.items.map(item => item.str).join(' ');
                fullText += pageText + '\n';

                // 2. Extract embedded annotations (hyperlinks)
                const annotations = await page.getAnnotations();
                annotations.forEach(anno => {
                    if (anno.subtype === 'Link' && anno.url) {
                        extractedLinks.push(anno.url);
                    }
                });
            }

            if (!fullText.trim()) {
                throw new Error('This PDF may be image-based or encrypted. Please copy-paste your resume text into the box instead.');
            }

            // 3. Fallback: Manually regex scrape for any un-clickable text URLs (like github.com/user)
            const urlRegex = /(?:https?:\/\/)?(?:www\.)?(?:linkedin\.com\/in\/|github\.com\/|[\w-]+\.(?:com|net|org|io|me))\S+/gi;
            const textUrls = fullText.match(urlRegex) || [];

            extractedLinks = [...extractedLinks, ...textUrls];

            // Append extracted URLs to the end of the text so the AI parser can see them
            if (extractedLinks.length > 0) {
                // Remove duplicates and clean trailing punctuation
                extractedLinks = [...new Set(extractedLinks.map(u => u.replace(/[.,:)]$/, '')))];
                fullText += '\n\n--- DETECTED URLS (USE THESE FOR LINKEDIN/GITHUB/PORTFOLIO) ---\n';
                fullText += extractedLinks.join('\n');
            }

            document.getElementById('resume-text').value = fullText.trim();
            statusEl.textContent = '✓ PDF text extracted! Parsing with AI...';

            // Auto-trigger AI parsing
            setTimeout(() => document.getElementById('btn-parse-resume').click(), 100);

        } catch (err) {
            statusEl.textContent = '✗ ' + err.message;
            statusEl.className = 'status-msg error';
            showToast('PDF: ' + err.message, 'error');
            setLoading(btn, false);
        }
    } else {
        // Text file — load directly
        const text = await file.text();
        document.getElementById('resume-text').value = text;
        statusEl.textContent = '✓ File loaded! Parsing with AI...';
        statusEl.className = 'status-msg success';
        // Auto-trigger AI parsing
        setTimeout(() => document.getElementById('btn-parse-resume').click(), 100);
    }
    e.target.value = '';
});

bindEvent('btn-parse-resume','click', async () => {
    const text = document.getElementById('resume-text').value.trim();
    if (!text) { showToast('Please paste or upload your resume text first', 'error'); return; }

    // Check if AI is enabled
    if (!aiSettings.enabled) {
        showToast('Please enable AI in the Settings tab first', 'error');
        return;
    }

    const btn = document.getElementById('btn-parse-resume');
    const statusEl = document.getElementById('parse-status');
    setLoading(btn, true);
    statusEl.textContent = 'Parsing with AI...';
    statusEl.className = 'status-msg success';
    try {
        const resp = await chrome.runtime.sendMessage({ type: 'AI_PARSE_RESUME', text });
        if (!resp.ok) throw new Error(resp.error || 'Parse failed');
        const parsed = resp.parsed;
        // Merge parsed data into globalProfile
        Object.entries(parsed).forEach(([key, value]) => {
            if (value && (typeof value === 'string' ? value.trim() : true)) {
                globalProfile[key] = value;
            }
        });
        // Save immediately
        await chrome.runtime.sendMessage({ type: 'SAVE_GLOBAL_PROFILE', profile: globalProfile });
        renderProfile();
        renderOverview();
        statusEl.textContent = '✓ Resume parsed! Profile updated.';
        showToast('✓ Resume parsed and profile populated!', 'success');
    } catch (err) {
        statusEl.textContent = '✗ ' + err.message;
        statusEl.className = 'status-msg error';
        showToast('Failed: ' + err.message, 'error');
    } finally {
        setLoading(btn, false);
    }
});

// ── APPLICATION TRACKER TAB ────────────────────────────────────
let currentFilter = 'all';
let currentTrackerView = 'board';
let dragAppId = null;

const TRACKER_STATUSES = ['applied', 'screening', 'interviewing', 'offer', 'rejected'];

function getFilteredApplications() {
    return currentFilter === 'all'
        ? applications
        : applications.filter(a => a.status === currentFilter);
}

function statusLabel(status) {
    return status ? status.charAt(0).toUpperCase() + status.slice(1) : 'Unknown';
}

function renderTrackerSummary() {
    const summaryRoot = document.querySelector('.tracker-summary');
    if (!summaryRoot) return;
    const counts = TRACKER_STATUSES.reduce((acc, status) => {
        acc[status] = applications.filter(app => app.status === status).length;
        return acc;
    }, {});
    const total = applications.length;

    const totalEl = document.getElementById('summary-total');
    if (totalEl) totalEl.textContent = total;
    const mapping = {
        applied: 'summary-applied',
        screening: 'summary-screening',
        interviewing: 'summary-interviewing',
        offer: 'summary-offer',
        rejected: 'summary-rejected',
    };
    Object.entries(mapping).forEach(([status, id]) => {
        const el = document.getElementById(id);
        if (el) el.textContent = counts[status] || 0;
    });

    document.querySelectorAll('.tracker-summary-item').forEach(item => {
        const status = item.dataset.summaryStatus || 'all';
        const active = currentFilter === status || (currentFilter === 'all' && status === 'all');
        item.classList.toggle('active', active);
    });
}

function bindTrackerSummary() {
    if (window._trackerSummaryBound) return;
    window._trackerSummaryBound = true;
    document.querySelectorAll('.tracker-summary-item').forEach(item => {
        item.addEventListener('click', () => {
            const status = item.dataset.summaryStatus || 'all';
            currentFilter = status;
            document.querySelectorAll('.filter-btn').forEach(b => {
                b.classList.toggle('active', b.dataset.status === status);
            });
            renderTracker();
        });
    });
}

function renderTracker() {
    const list = document.getElementById('applications-list');
    const board = document.getElementById('applications-board');
    const filtered = getFilteredApplications();

    document.getElementById('tracker-count').textContent = `${filtered.length} application${filtered.length !== 1 ? 's' : ''}`;
    renderTrackerSummary();
    bindTrackerSummary();

    if (currentTrackerView === 'list') {
        board.hidden = true;
        list.hidden = false;
        renderTrackerList(filtered);
    } else {
        list.hidden = true;
        board.hidden = false;
        renderTrackerBoard(filtered);
    }
}

function renderTrackerList(filtered) {
    const list = document.getElementById('applications-list');

    if (filtered.length === 0) {
        list.innerHTML = '<div class="empty-state">No applications found.<br>Applications auto-log when you apply, or add them manually.</div>';
        return;
    }

    list.innerHTML = filtered.map(app => {
        const hasMatch = typeof app.matchScore === 'number';
        const ms = hasMatch ? app.matchScore : null;
        const msColor = ms !== null ? (ms >= 75 ? '#22c55e' : ms >= 50 ? '#f59e0b' : '#ef4444') : 'var(--text-dim)';
        const msLabel = ms !== null ? `${ms}%` : '?';
        const matchBadge = `
          <div title="AI Match Score" style="display:flex;align-items:center;gap:4px;font-size:11px;font-weight:700;color:${msColor};padding:3px 7px;background:${msColor}15;border-radius:20px;border:1px solid ${msColor}33;">
            🤖 ${msLabel}
          </div>`;
        const linkIcon = app.url
            ? `<a class="app-link-icon" href="${normalizeUrl(app.url)}" target="_blank" title="Open job link">↗</a>`
            : '';
        return `
        <div class="app-card" data-app-id="${app.id}">
            <div class="app-card-header" data-apptoggle="${app.id}">
                <div class="app-card-left">
                    <div class="app-card-icon">${getInitials(app.companyName)}</div>
                    <div class="app-card-info">
                        <div class="app-card-company">${escHtml(app.companyName)}</div>
                        <div class="app-card-title">${escHtml(app.jobTitle || 'Untitled Role')}</div>
                    </div>
                </div>
                <div class="app-card-right">
                    ${linkIcon}
                    ${matchBadge}
                    <span class="app-card-date">${relativeDate(app.appliedAt)}</span>
                    <span class="app-status-badge ${app.status}">${app.status}</span>
                    <svg class="chevron-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                </div>
            </div>
            <div class="app-card-body" id="appbody-${app.id}">
                <div class="app-detail-grid">
                    <div class="app-detail-item">
                        <span class="app-detail-label">Location</span>
                        <span class="app-detail-value">${escHtml(app.location || '—')}</span>
                    </div>
                    <div class="app-detail-item">
                        <span class="app-detail-label">Applied</span>
                        <span class="app-detail-value">${formatDate(app.appliedAt)}</span>
                    </div>
                    <div class="app-detail-item">
                        <span class="app-detail-label">Status</span>
                        <select class="app-status-select" data-appstatus="${app.id}">
                            ${TRACKER_STATUSES.map(s =>
        `<option value="${s}" ${s === app.status ? 'selected' : ''}>${s}</option>`
    ).join('')}
                        </select>
                    </div>
                    ${hasMatch ? `
                    <div class="app-detail-item">
                        <span class="app-detail-label">AI Match</span>
                        <span class="app-detail-value" style="color:${msColor};font-weight:700;">
                            ${ms}/100 &mdash; ${app.matchDetails?.recommendation ? escHtml(app.matchDetails.recommendation.substring(0, 60)) : ''}
                        </span>
                    </div>` : ''}
                    ${app.url ? `<div class="app-detail-item"><span class="app-detail-label">URL</span><a href="${normalizeUrl(app.url)}" target="_blank" class="app-link-icon" style="border:none;padding:0;">Open →</a></div>` : ''}
                </div>
                <div class="app-notes-area">
                    <label>Notes</label>
                    <textarea data-appnotes="${app.id}" placeholder="Add personal notes...">${escHtml(app.notes || '')}</textarea>
                </div>
                <div class="app-card-actions-row">
                    <button class="btn btn-secondary btn-sm" data-action="rematch" data-app-id="${app.id}" title="Re-run AI match score">🤖 Re-match</button>
                    <button class="btn btn-secondary btn-sm" data-action="interview" data-app-id="${app.id}">💬 Interview Prep</button>
                    <button class="btn btn-secondary btn-sm" data-action="followup" data-app-id="${app.id}">📧 Follow-up</button>
                    <button class="btn btn-secondary btn-sm" data-action="tailor" data-app-id="${app.id}">📄 Tailor Resume</button>
                    <button class="btn btn-danger btn-sm" data-action="deleteapp" data-app-id="${app.id}">🗑 Delete</button>
                </div>
            </div>
        </div>`;
    }).join('');
    attachTrackerListeners();
}

function renderTrackerBoard(filtered) {
    const board = document.getElementById('applications-board');

    if (filtered.length === 0) {
        board.innerHTML = '<div class="empty-state">No applications found.<br>Applications auto-log when you apply, or add them manually.</div>';
        return;
    }

    const statuses = currentFilter === 'all' ? TRACKER_STATUSES : [currentFilter];
    const grouped = {};
    statuses.forEach(s => { grouped[s] = []; });
    filtered.forEach(app => {
        if (grouped[app.status]) grouped[app.status].push(app);
    });

    const columns = statuses.map(status => {
        const items = grouped[status] || [];
        const cards = items.map(app => {
            const hasMatch = typeof app.matchScore === 'number';
            const ms = hasMatch ? app.matchScore : null;
            const msColor = ms !== null ? (ms >= 75 ? '#22c55e' : ms >= 50 ? '#f59e0b' : '#ef4444') : 'var(--text-dim)';
            const matchBadge = hasMatch
                ? `<span style="font-size:10px;font-weight:700;color:${msColor};background:${msColor}15;border-radius:12px;padding:2px 6px;border:1px solid ${msColor}33;">🤖 ${ms}%</span>`
                : '';
            return `
              <div class="kanban-card" data-app-id="${app.id}">
                <div class="kanban-card-header">
                  <div class="kanban-card-title">${escHtml(app.companyName)}</div>
                  <span class="kanban-drag" draggable="true" data-app-id="${app.id}" title="Drag to move">⋮⋮</span>
                </div>
                <div class="kanban-card-role">${escHtml(app.jobTitle || 'Untitled Role')}</div>
                <div class="kanban-card-meta">
                  <span>${relativeDate(app.appliedAt)}</span>
                  ${matchBadge}
                  ${app.url ? `<a class="kanban-card-link" href="${normalizeUrl(app.url)}" target="_blank">Open</a>` : ''}
                </div>
              </div>
            `;
        }).join('');
        return `
          <div class="kanban-column" data-status="${status}">
            <div class="kanban-column-header">
              <span>${statusLabel(status)}</span>
              <span class="kanban-count">${items.length}</span>
            </div>
            <div class="kanban-list">
              ${cards || '<div class="empty-state" style="padding:6px 8px;">No items</div>'}
            </div>
          </div>
        `;
    }).join('');

    board.innerHTML = `<div class="kanban-board">${columns}</div>`;
    attachBoardListeners();
}

function attachTrackerListeners() {
    // Toggle expand
    document.querySelectorAll('[data-apptoggle]').forEach(header => {
        header.addEventListener('click', () => {
            const card = header.closest('.app-card');
            const body = card.querySelector('.app-card-body');
            card.classList.toggle('open');
            body.classList.toggle('open');
        });
    });
    // Status change
    document.querySelectorAll('[data-appstatus]').forEach(sel => {
        sel.addEventListener('change', async (e) => {
            e.stopPropagation();
            const id = sel.dataset.appstatus;
            const resp = await chrome.runtime.sendMessage({ type: 'APP_UPDATE', id, updates: { status: sel.value } });
            if (resp.ok) {
                applications = resp.apps;
                renderTracker();
                renderOverview();
                showToast('✓ Status updated', 'success');
            }
        });
    });
    // Prevent job link clicks from toggling cards
    document.querySelectorAll('.app-link-icon').forEach(link => {
        link.addEventListener('click', (e) => {
            e.stopPropagation();
        });
    });
    // Notes save on blur
    document.querySelectorAll('[data-appnotes]').forEach(ta => {
        ta.addEventListener('blur', async () => {
            await chrome.runtime.sendMessage({ type: 'APP_UPDATE', id: ta.dataset.appnotes, updates: { notes: ta.value } });
        });
    });
    // Action buttons
    document.querySelectorAll('[data-action="deleteapp"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            showConfirmModal('Delete Application', 'Are you sure you want to delete this application?', async () => {
                const resp = await chrome.runtime.sendMessage({ type: 'APP_DELETE', id: btn.dataset.appId });
                if (resp.ok) { applications = resp.apps; renderTracker(); renderOverview(); showToast('✓ Deleted', 'success'); }
            });
        });
    });

    document.querySelectorAll('[data-action="interview"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const app = applications.find(a => a.id === btn.dataset.appId);
            if (app && app.jobDescription) {
                document.getElementById('interview-jd-input').value = app.jobDescription;
                document.querySelector('[data-tab="interview"]').click();
            } else {
                showToast('Add a job description to this application first', 'error');
            }
        });
    });
    document.querySelectorAll('[data-action="followup"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const app = applications.find(a => a.id === btn.dataset.appId);
            if (!app) return;
            setLoading(btn, true);
            try {
                const resp = await chrome.runtime.sendMessage({ type: 'AI_FOLLOW_UP', application: app });
                if (resp.ok) {
                    await navigator.clipboard.writeText(resp.email);
                    showToast('✓ Follow-up email copied to clipboard!', 'success');
                } else throw new Error(resp.error);
            } catch (err) {
                showToast('Failed: ' + err.message, 'error');
            } finally { setLoading(btn, false); }
        });
    });
    document.querySelectorAll('[data-action="tailor"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const app = applications.find(a => a.id === btn.dataset.appId);
            if (!app?.jobDescription) { showToast('Add a job description to this application first', 'error'); return; }
            setLoading(btn, true);
            try {
                const resp = await chrome.runtime.sendMessage({ type: 'AI_TAILOR_RESUME', jobDescription: app.jobDescription });
                if (resp.ok) {
                    const tailored = resp.tailored;
                    const text = [
                        tailored.tailoredSummary,
                        '',
                        'SKILLS: ' + (tailored.highlightedSkills || []).join(', '),
                        '',
                        ...(tailored.tailoredWorkHistory || []).map(w =>
                            `${w.title} at ${w.company} (${w.startDate} - ${w.endDate})\n${(w.bullets || []).map(b => '• ' + b).join('\n')}`
                        ),
                        '',
                        'CHANGES MADE:',
                        ...(tailored.changes || []).map(c => `• ${c.section}: ${c.change}`),
                    ].join('\n');
                    await navigator.clipboard.writeText(text);
                    showToast('✓ Tailored resume copied to clipboard!', 'success');
                } else throw new Error(resp.error);
            } catch (err) {
                showToast('Failed: ' + err.message, 'error');
            } finally { setLoading(btn, false); }
        });
    });

    // ── Re-match: re-run AI match score using stored job description
    document.querySelectorAll('[data-action="rematch"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const app = applications.find(a => a.id === btn.dataset.appId);
            if (!app) return;
            const jd = app.jobDescription;
            if (!jd || jd.length < 50) {
                showToast('⚠️ No job description stored. Open the job URL and use Match Score first.', 'error');
                return;
            }
            setLoading(btn, true);
            btn.textContent = '⏳ Scoring...';
            try {
                const resp = await chrome.runtime.sendMessage({ type: 'AI_SCORE_MATCH', jobDescription: jd });
                if (resp?.ok && resp.score) {
                    const score = resp.score;
                    const overallScore = Number(score.overallScore) || 0;
                    const updResp = await chrome.runtime.sendMessage({
                        type: 'APP_UPDATE',
                        id: app.id,
                        updates: {
                            matchScore: overallScore,
                            matchDetails: score,
                            matchedAt: new Date().toISOString()
                        }
                    });
                    if (updResp.ok) {
                        applications = updResp.apps;
                        renderTracker();
                        showToast(`🤖 Match Score: ${overallScore}/100`, 'success');
                    }
                } else {
                    throw new Error(resp?.error || 'Failed to score');
                }
            } catch (err) {
                showToast('Re-match failed: ' + err.message, 'error');
            } finally {
                setLoading(btn, false);
                btn.textContent = '🤖 Re-match';
            }
        });
    });
}

function attachBoardListeners() {
    document.querySelectorAll('.kanban-drag').forEach(handle => {
        handle.addEventListener('dragstart', (e) => {
            const id = handle.dataset.appId;
            dragAppId = id;
            e.dataTransfer.setData('text/plain', id);
            e.dataTransfer.effectAllowed = 'move';
        });
        handle.addEventListener('dragend', () => {
            dragAppId = null;
            document.querySelectorAll('.kanban-column').forEach(col => col.classList.remove('drag-over'));
        });
    });

    document.querySelectorAll('.kanban-column').forEach(col => {
        col.addEventListener('dragover', (e) => {
            e.preventDefault();
            col.classList.add('drag-over');
        });
        col.addEventListener('dragleave', () => {
            col.classList.remove('drag-over');
        });
        col.addEventListener('drop', async (e) => {
            e.preventDefault();
            col.classList.remove('drag-over');
            const id = e.dataTransfer.getData('text/plain') || dragAppId;
            const status = col.dataset.status;
            if (!id || !status) return;
            const app = applications.find(a => a.id === id);
            if (!app || app.status === status) return;
            const resp = await chrome.runtime.sendMessage({ type: 'APP_UPDATE', id, updates: { status } });
            if (resp.ok) {
                applications = resp.apps;
                renderTracker();
                renderOverview();
                showToast(`✓ Moved to ${statusLabel(status)}`, 'success');
            }
        });
    });
}

// Filter buttons
document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.status;
        renderTracker();
    });
});

document.querySelectorAll('.view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentTrackerView = btn.dataset.view || 'board';
        renderTracker();
    });
});

// ── TASK TRACKER TAB ───────────────────────────────────────────
let currentTaskView = 'board';
let currentTaskFilter = 'all';
let dragTaskId = null;

const TASK_STATUSES = ['new', 'backlog', 'in_progress', 'blocked', 'done'];

function getEpicTasks() {
    return tasks.filter(t => t.type === 'epic');
}

function getEpicById(id) {
    return tasks.find(t => t.id === id && t.type === 'epic');
}

function renderEpicOptions(selectEl, currentValue = '', excludeId = '') {
    if (!selectEl) return;
    const epics = getEpicTasks().filter(e => e.id !== excludeId);
    const options = ['<option value="">No Epic</option>']
        .concat(epics.map(e => `<option value="${e.id}">${escHtml(e.title)}</option>`));
    selectEl.innerHTML = options.join('');
    if (currentValue && epics.some(e => e.id === currentValue)) {
        selectEl.value = currentValue;
    } else {
        selectEl.value = '';
    }
}

function refreshEpicSelectors() {
    const addSel = document.getElementById('task-parent');
    const modalSel = document.getElementById('task-modal-parent');
    const addVal = addSel?.value || '';
    const modalVal = modalSel?.value || '';
    renderEpicOptions(addSel, addVal);
    renderEpicOptions(modalSel, modalVal, activeTaskId || '');
}

function taskStatusLabel(status) {
    switch (status) {
        case 'new': return 'New';
        case 'backlog': return 'Backlog';
        case 'in_progress': return 'In Progress';
        case 'blocked': return 'Blocked';
        case 'done': return 'Completed';
        default: return 'Backlog';
    }
}

async function refreshTasksFromStorage(showError = false) {
    const resp = await chrome.runtime.sendMessage({ type: 'TASK_GET_ALL' }).catch(err => ({
        error: err?.message || 'Failed to refresh tasks'
    }));
    if (resp?.tasks) {
        tasks = resp.tasks;
        renderTasks();
        return true;
    }
    if (showError) showToast(resp?.error || 'Failed to refresh tasks', 'error');
    return false;
}

async function updateTaskAndRender(id, updates, successMsg = '') {
    const resp = await chrome.runtime.sendMessage({ type: 'TASK_UPDATE', id, updates }).catch(err => ({
        ok: false,
        error: err?.message || 'Failed to update task'
    }));
    if (resp?.ok) {
        tasks = resp.tasks || tasks;
        renderTasks();
        if (successMsg) showToast(successMsg, 'success');
        return true;
    }
    await refreshTasksFromStorage();
    showToast(resp?.error || 'Failed to update task', 'error');
    return false;
}

async function deleteTaskAndRender(id) {
    const resp = await chrome.runtime.sendMessage({ type: 'TASK_DELETE', id }).catch(err => ({
        ok: false,
        error: err?.message || 'Failed to delete task'
    }));
    if (resp?.ok) {
        tasks = resp.tasks || tasks;
        renderTasks();
        return true;
    }
    await refreshTasksFromStorage();
    showToast(resp?.error || 'Failed to delete task', 'error');
    return false;
}

function isTaskOverdue(task) {
    if (!task?.dueDate) return false;
    if (task.status === 'done') return false;
    const due = new Date(task.dueDate);
    if (Number.isNaN(due.getTime())) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return due.getTime() < today.getTime();
}

function taskDueBadge(task) {
    if (!task?.dueDate) return '';
    const due = new Date(task.dueDate);
    if (Number.isNaN(due.getTime())) return '';
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.floor((due.getTime() - today.getTime()) / 86400000);
    if (diffDays < 0) return 'Overdue';
    if (diffDays === 0) return 'Due Today';
    if (diffDays === 1) return 'Due Tomorrow';
    return `Due ${formatDate(task.dueDate)}`;
}

function getFilteredTasks() {
    if (currentTaskFilter === 'all') return tasks;
    if (currentTaskFilter === 'overdue') return tasks.filter(t => isTaskOverdue(t));
    return tasks.filter(t => t.status === currentTaskFilter);
}

function renderTaskSummary() {
    const counts = TASK_STATUSES.reduce((acc, status) => {
        acc[status] = tasks.filter(t => t.status === status).length;
        return acc;
    }, {});
    const total = tasks.length;
    const overdue = tasks.filter(t => isTaskOverdue(t)).length;
    const mapping = {
        total: 'task-summary-total',
        new: 'task-summary-new',
        backlog: 'task-summary-backlog',
        in_progress: 'task-summary-progress',
        blocked: 'task-summary-blocked',
        done: 'task-summary-done',
        overdue: 'task-summary-overdue',
    };
    if (document.getElementById(mapping.total)) document.getElementById(mapping.total).textContent = total;
    if (document.getElementById(mapping.new)) document.getElementById(mapping.new).textContent = counts.new || 0;
    if (document.getElementById(mapping.backlog)) document.getElementById(mapping.backlog).textContent = counts.backlog || 0;
    if (document.getElementById(mapping.in_progress)) document.getElementById(mapping.in_progress).textContent = counts.in_progress || 0;
    if (document.getElementById(mapping.blocked)) document.getElementById(mapping.blocked).textContent = counts.blocked || 0;
    if (document.getElementById(mapping.done)) document.getElementById(mapping.done).textContent = counts.done || 0;
    if (document.getElementById(mapping.overdue)) document.getElementById(mapping.overdue).textContent = overdue;
    document.querySelectorAll('.task-summary-item').forEach(item => {
        const status = item.dataset.taskSummary || 'all';
        item.classList.toggle('active', status === currentTaskFilter);
    });
}

function renderTasks() {
    const board = document.getElementById('tasks-board');
    const list = document.getElementById('tasks-list');
    if (!board || !list) return;
    refreshEpicSelectors();
    renderTaskSummary();
    const filtered = getFilteredTasks();
    document.getElementById('task-count').textContent = `${filtered.length} task${filtered.length !== 1 ? 's' : ''}`;

    if (currentTaskView === 'list') {
        board.hidden = true;
        list.hidden = false;
        renderTaskList(filtered);
    } else {
        list.hidden = true;
        board.hidden = false;
        renderTaskBoard(filtered);
    }
}

function renderTaskBoard(filtered) {
    const board = document.getElementById('tasks-board');
    if (!board) return;
    if (!filtered.length) {
        board.innerHTML = '<div class="empty-state">No tasks yet. Add one above to get started.</div>';
        return;
    }

    const statuses = currentTaskFilter === 'all' || currentTaskFilter === 'overdue'
        ? TASK_STATUSES
        : [currentTaskFilter];

    const grouped = {};
    statuses.forEach(s => { grouped[s] = []; });
    filtered.forEach(task => {
        if (grouped[task.status]) grouped[task.status].push(task);
    });

    const columns = statuses.map(status => {
        const items = grouped[status] || [];
        const cards = items.map(task => {
            const overdue = isTaskOverdue(task);
            const dueLabel = taskDueBadge(task);
            const priority = task.priority || 'medium';
            const isEpic = task.type === 'epic';
            const parentEpic = task.parentId ? getEpicById(task.parentId) : null;
            const children = isEpic ? tasks.filter(t => t.parentId === task.id && t.type !== 'epic') : [];
            const doneCount = isEpic ? children.filter(c => c.status === 'done').length : 0;
            const dueBadge = dueLabel
                ? `<span class="task-badge ${overdue ? 'overdue' : priority}">${escHtml(dueLabel)}</span>`
                : '';
            const epicBadge = isEpic
                ? `<span class="task-epic-pill">Epic</span>`
                : (parentEpic ? `<span class="task-epic-pill">${escHtml(parentEpic.title)}</span>` : '');
            const progressBadge = isEpic && children.length
                ? `<span class="task-badge ${doneCount === children.length ? 'low' : 'medium'}">${doneCount}/${children.length} done</span>`
                : '';
            const dragHandle = isEpic ? '' : `<span class="kanban-drag" draggable="true" data-task-id="${task.id}" title="Drag to move">⋮⋮</span>`;
            const descText = task.description ? task.description.slice(0, 140) : '';
            const descLine = descText ? `<div class="task-desc">${escHtml(descText)}${task.description.length > 140 ? '…' : ''}</div>` : '';
            return `
              <div class="task-card ${overdue ? 'overdue' : ''}" data-task-id="${task.id}">
                <div class="task-card-header">
                  <div class="task-title">${escHtml(task.title)}</div>
                  ${dragHandle}
                </div>
                <div class="task-meta">
                  ${epicBadge}
                  <span class="task-badge ${priority}">${priority}</span>
                  ${progressBadge}
                  ${dueBadge}
                </div>
                ${descLine}
              </div>
            `;
        }).join('');
        return `
          <div class="task-column" data-task-status="${status}">
            <div class="task-column-header">
              <span>${taskStatusLabel(status)}</span>
              <span class="kanban-count">${items.length}</span>
            </div>
            <div class="kanban-list">
              ${cards || '<div class="empty-state" style="padding:6px 8px;">No items</div>'}
            </div>
          </div>
        `;
    }).join('');

    board.innerHTML = `<div class="tasks-kanban">${columns}</div>`;
    attachTaskBoardListeners();
}

function renderTaskList(filtered) {
    const list = document.getElementById('tasks-list');
    if (!list) return;
    if (!filtered.length) {
        list.innerHTML = '<div class="empty-state">No tasks yet. Add one above to get started.</div>';
        return;
    }
    list.innerHTML = filtered.map(task => {
        const overdue = isTaskOverdue(task);
        const isEpic = task.type === 'epic';
        const parentEpic = task.parentId ? getEpicById(task.parentId) : null;
        const children = isEpic ? tasks.filter(t => t.parentId === task.id && t.type !== 'epic') : [];
        const doneCount = isEpic ? children.filter(c => c.status === 'done').length : 0;
        const epicLine = isEpic
            ? `<div class="task-desc">Epic · ${doneCount}/${children.length} done</div>`
            : (parentEpic ? `<div class="task-desc">Epic: ${escHtml(parentEpic.title)}</div>` : '');
        return `
          <div class="task-list-row ${overdue ? 'overdue' : ''}" data-task-id="${task.id}">
            <div>
              <strong>${escHtml(task.title)}</strong>
              <div style="font-size:11px;color:var(--text-dim);margin-top:4px;">${escHtml(task.description || '—')}</div>
              ${epicLine}
            </div>
            <input type="date" data-task-due="${task.id}" value="${task.dueDate || ''}" />
            <select data-task-priority="${task.id}">
              <option value="low" ${task.priority === 'low' ? 'selected' : ''}>Low</option>
              <option value="medium" ${task.priority === 'medium' ? 'selected' : ''}>Medium</option>
              <option value="high" ${task.priority === 'high' ? 'selected' : ''}>High</option>
            </select>
            <select data-task-status="${task.id}">
              ${TASK_STATUSES.map(s => `<option value="${s}" ${s === task.status ? 'selected' : ''}>${taskStatusLabel(s)}</option>`).join('')}
            </select>
            <button class="btn btn-secondary btn-sm" data-task-edit="${task.id}">Edit</button>
          </div>
        `;
    }).join('');
    attachTaskListListeners();
}

function attachTaskBoardListeners() {
    document.querySelectorAll('.task-card').forEach(card => {
        card.addEventListener('click', (e) => {
            if (e.target?.closest('.kanban-drag')) return;
            const id = card.dataset.taskId;
            openTaskModal(id);
        });
    });
    document.querySelectorAll('.kanban-drag[data-task-id]').forEach(handle => {
        handle.addEventListener('dragstart', (e) => {
            const id = handle.dataset.taskId;
            dragTaskId = id;
            e.dataTransfer.setData('text/plain', id);
            e.dataTransfer.effectAllowed = 'move';
        });
        handle.addEventListener('dragend', () => {
            dragTaskId = null;
            document.querySelectorAll('.task-column').forEach(col => col.classList.remove('drag-over'));
        });
    });
    document.querySelectorAll('.task-column').forEach(col => {
        col.addEventListener('dragover', (e) => {
            e.preventDefault();
            col.classList.add('drag-over');
        });
        col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
        col.addEventListener('drop', async (e) => {
            e.preventDefault();
            col.classList.remove('drag-over');
            const id = e.dataTransfer.getData('text/plain') || dragTaskId;
            const status = col.dataset.taskStatus;
            if (!id || !status) return;
            const task = tasks.find(t => t.id === id);
            if (!task || task.type === 'epic') return;
            if (task.status === status) return;
            await updateTaskAndRender(id, { status }, `✓ Moved to ${taskStatusLabel(status)}`);
        });
    });
    document.querySelectorAll('.task-column .kanban-list').forEach(list => {
        list.addEventListener('dragover', (e) => {
            e.preventDefault();
            const col = list.closest('.task-column');
            if (col) col.classList.add('drag-over');
        });
        list.addEventListener('dragleave', () => {
            const col = list.closest('.task-column');
            if (col) col.classList.remove('drag-over');
        });
        list.addEventListener('drop', async (e) => {
            e.preventDefault();
            const col = list.closest('.task-column');
            if (col) col.classList.remove('drag-over');
            const id = e.dataTransfer.getData('text/plain') || dragTaskId;
            const status = col?.dataset?.taskStatus;
            if (!id || !status) return;
            const task = tasks.find(t => t.id === id);
            if (!task || task.type === 'epic') return;
            if (task.status === status) return;
            await updateTaskAndRender(id, { status }, `✓ Moved to ${taskStatusLabel(status)}`);
        });
    });
}

function attachTaskListListeners() {
    document.querySelectorAll('[data-task-edit]').forEach(btn => {
        btn.addEventListener('click', () => {
            openTaskModal(btn.dataset.taskEdit);
        });
    });
    document.querySelectorAll('[data-task-due]').forEach(input => {
        input.addEventListener('change', async () => {
            const id = input.dataset.taskDue;
            await updateTaskAndRender(id, { dueDate: input.value });
        });
    });
    document.querySelectorAll('[data-task-priority]').forEach(sel => {
        sel.addEventListener('change', async () => {
            const id = sel.dataset.taskPriority;
            await updateTaskAndRender(id, { priority: sel.value });
        });
    });
    document.querySelectorAll('[data-task-status]').forEach(sel => {
        sel.addEventListener('change', async () => {
            const id = sel.dataset.taskStatus;
            await updateTaskAndRender(id, { status: sel.value });
        });
    });
    document.querySelectorAll('.task-list-row').forEach(row => {
        const id = row.dataset.taskId;
        const task = tasks.find(t => t.id === id);
        if (task?.type === 'epic') {
            const statusSel = row.querySelector('[data-task-status]');
            if (statusSel) statusSel.disabled = true;
        }
    });
}

function bindTaskControls() {
    if (window._taskControlsBound) return;
    window._taskControlsBound = true;

    const form = document.getElementById('task-add-form');
    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const title = document.getElementById('task-title').value.trim();
            if (!title) return;
            const task = {
                title,
                dueDate: document.getElementById('task-due').value,
                priority: document.getElementById('task-priority').value,
                status: document.getElementById('task-status').value,
                description: document.getElementById('task-desc').value.trim(),
                type: document.getElementById('task-type').value,
                parentId: document.getElementById('task-parent').value,
            };
            const resp = await chrome.runtime.sendMessage({ type: 'TASK_ADD', task });
            if (resp.ok) {
                tasks = resp.tasks;
                form.reset();
                document.getElementById('task-priority').value = 'medium';
                document.getElementById('task-status').value = 'new';
                document.getElementById('task-type').value = 'task';
                document.getElementById('task-parent').value = '';
                renderTasks();
                showToast('✓ Task added', 'success');
            }
        });
    }

    const typeSelect = document.getElementById('task-type');
    const parentSelect = document.getElementById('task-parent');
    if (typeSelect && parentSelect) {
        const syncType = () => {
            const isEpic = typeSelect.value === 'epic';
            parentSelect.disabled = isEpic;
            if (isEpic) parentSelect.value = '';
        };
        typeSelect.addEventListener('change', syncType);
        syncType();
    }

    document.querySelectorAll('.task-view-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.task-view-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentTaskView = btn.dataset.taskView || 'board';
            renderTasks();
        });
    });

    document.querySelectorAll('.task-summary-item').forEach(item => {
        item.addEventListener('click', () => {
            const filter = item.dataset.taskSummary || 'all';
            currentTaskFilter = filter;
            renderTasks();
        });
    });
}

let activeTaskId = null;
function openTaskModal(taskId) {
    const modal = document.getElementById('task-modal');
    const task = tasks.find(t => t.id === taskId);
    if (!modal || !task) return;
    activeTaskId = taskId;
    document.getElementById('task-modal-name').value = task.title || '';
    document.getElementById('task-modal-type').value = task.type || 'task';
    renderEpicOptions(document.getElementById('task-modal-parent'), task.parentId || '', taskId);
    document.getElementById('task-modal-parent').value = task.parentId || '';
    document.getElementById('task-modal-due').value = task.dueDate || '';
    document.getElementById('task-modal-priority').value = task.priority || 'medium';
    document.getElementById('task-modal-status').value = task.status || 'new';
    document.getElementById('task-modal-desc').value = task.description || '';
    const isEpic = (task.type || 'task') === 'epic';
    document.getElementById('task-modal-parent').disabled = isEpic;
    document.getElementById('task-modal-status').disabled = isEpic;
    modal.hidden = false;
}

function closeTaskModal() {
    const modal = document.getElementById('task-modal');
    if (modal) modal.hidden = true;
    activeTaskId = null;
}

function bindTaskModal() {
    if (window._taskModalBound) return;
    window._taskModalBound = true;
    const modal = document.getElementById('task-modal');
    if (!modal) return;
    document.getElementById('task-modal-cancel').addEventListener('click', () => closeTaskModal());
    const modalType = document.getElementById('task-modal-type');
    const modalParent = document.getElementById('task-modal-parent');
    const modalStatus = document.getElementById('task-modal-status');
    if (modalType && modalParent && modalStatus) {
        const syncModalType = () => {
            const isEpic = modalType.value === 'epic';
            modalParent.disabled = isEpic;
            modalStatus.disabled = isEpic;
            if (isEpic) modalParent.value = '';
        };
        modalType.addEventListener('change', syncModalType);
        syncModalType();
    }
    document.getElementById('task-modal-save').addEventListener('click', async () => {
        if (!activeTaskId) return;
        const updates = {
            title: document.getElementById('task-modal-name').value.trim(),
            dueDate: document.getElementById('task-modal-due').value,
            priority: document.getElementById('task-modal-priority').value,
            status: document.getElementById('task-modal-status').value,
            description: document.getElementById('task-modal-desc').value.trim(),
            type: document.getElementById('task-modal-type').value,
            parentId: document.getElementById('task-modal-parent').value,
        };
        const ok = await updateTaskAndRender(activeTaskId, updates, '✓ Task updated');
        if (ok) closeTaskModal();
    });
    document.getElementById('task-modal-delete').addEventListener('click', async () => {
        if (!activeTaskId) return;
        showConfirmModal('Delete Task', 'Are you sure you want to delete this task? This cannot be undone.', async () => {
            const ok = await deleteTaskAndRender(activeTaskId);
            if (ok) {
                closeTaskModal();
                showToast('✓ Task deleted', 'success');
            }
        });
    });
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeTaskModal();
    });
}

// Add Application Modal
bindEvent('btn-add-application','click', () => {
    document.getElementById('add-app-modal').hidden = false;
});
bindEvent('add-app-cancel','click', () => {
    document.getElementById('add-app-modal').hidden = true;
});
bindEvent('add-app-save','click', async () => {
    const rawUrl = document.getElementById('app-url').value.trim();
    const app = {
        companyName: document.getElementById('app-company').value.trim(),
        jobTitle: document.getElementById('app-title').value.trim(),
        location: document.getElementById('app-location').value.trim(),
        status: document.getElementById('app-status').value,
        url: normalizeUrl(rawUrl),
        jobDescription: document.getElementById('app-jd').value.trim(),
    };
    if (!app.companyName) { showToast('Company name is required', 'error'); return; }
    const resp = await chrome.runtime.sendMessage({ type: 'APP_ADD', application: app });
    if (resp.ok) {
        applications = resp.apps;
        renderTracker();
        renderOverview();
        showToast('✓ Application added', 'success');
        document.getElementById('add-app-modal').hidden = true;
        // Clear form
        ['app-company', 'app-title', 'app-location', 'app-url', 'app-jd'].forEach(id => document.getElementById(id).value = '');
    }
});



// ── INTERVIEW PREP TAB ─────────────────────────────────────────
function renderInterviewAppSelect() {
    const sel = document.getElementById('interview-app-select');
    sel.innerHTML = '<option value="">— Select an application —</option>' +
        applications.filter(a => a.jobDescription).map(a =>
            `<option value="${a.id}">${escHtml(a.companyName)} — ${escHtml(a.jobTitle)}</option>`
        ).join('');
}

bindEvent('interview-app-select','change', (e) => {
    const app = applications.find(a => a.id === e.target.value);
    if (app) document.getElementById('interview-jd-input').value = app.jobDescription || '';
});

bindEvent('btn-generate-interview','click', async () => {
    const jd = document.getElementById('interview-jd-input').value.trim();
    if (!jd) { showToast('Please select an application or paste a job description', 'error'); return; }
    const btn = document.getElementById('btn-generate-interview');
    setLoading(btn, true);
    try {
        const resp = await chrome.runtime.sendMessage({ type: 'AI_INTERVIEW_PREP', jobDescription: jd });
        if (!resp.ok) throw new Error(resp.error);
        renderInterviewResults(resp.prep);
        document.getElementById('interview-results').hidden = false;
        showToast('✓ Interview prep generated!', 'success');
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    } finally { setLoading(btn, false); }
});

function renderInterviewResults(prep) {
    renderQuestionList('behavioral-questions', prep.behavioralQuestions || []);
    renderQuestionList('technical-questions', prep.technicalQuestions || []);
    renderQuestionList('company-questions', prep.companyQuestions || []);
    renderQuestionsToAsk('questions-to-ask', prep.questionsToAsk || []);
}

function renderQuestionList(containerId, questions) {
    const container = document.getElementById(containerId);
    container.innerHTML = questions.map((q, i) => `
        <div class="question-card">
            <div class="question-card-header" data-qtoggle="${containerId}-${i}">
                <span class="question-q">${escHtml(q.question)}</span>
                <svg class="chevron-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
            </div>
            <div class="question-card-body" id="qbody-${containerId}-${i}">
                <div class="question-answer">${escHtml(q.suggestedAnswer)}</div>
                <div class="question-tip">💡 ${escHtml(q.tip)}</div>
            </div>
        </div>
    `).join('');
    container.querySelectorAll('[data-qtoggle]').forEach(h => {
        h.addEventListener('click', () => {
            const body = document.getElementById(`qbody-${h.dataset.qtoggle}`);
            body.classList.toggle('open');
        });
    });
}

function renderQuestionsToAsk(containerId, questions) {
    const container = document.getElementById(containerId);
    container.innerHTML = questions.map((q, i) => `
        <div class="question-card">
            <div class="question-card-header" data-qtoggle="${containerId}-${i}">
                <span class="question-q">${escHtml(q.question)}</span>
                <svg class="chevron-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
            </div>
            <div class="question-card-body" id="qbody-${containerId}-${i}">
                <div class="question-why">${escHtml(q.why)}</div>
            </div>
        </div>
    `).join('');
    container.querySelectorAll('[data-qtoggle]').forEach(h => {
        h.addEventListener('click', () => {
            document.getElementById(`qbody-${h.dataset.qtoggle}`).classList.toggle('open');
        });
    });
}

// ── SETTINGS TAB ───────────────────────────────────────────────
function renderAiSettings() {
    const providerEl = document.getElementById('ai-provider');
    if (!providerEl) return;
    const provider = aiSettings.provider || 'groq';
    providerEl.value = provider;
    const modelEl = document.getElementById('ai-model');
    if (modelEl) modelEl.value = aiSettings.model || 'llama-3.3-70b-versatile';
    const keyEl = document.getElementById('ai-api-key');
    if (keyEl) keyEl.value = aiSettings.apiKey || '';
    const enabledEl = document.getElementById('ai-enabled');
    if (enabledEl) enabledEl.checked = aiSettings.enabled !== false; // default true

    updateProviderUI(provider);
    checkBuiltInAIStatus();
}

function updateProviderUI(provider) {
    const providerEl = document.getElementById('ai-provider');
    if (!providerEl) return;
    const isBuiltIn = provider === 'built-in';
    const modelGroup = document.getElementById('model-group');
    const keyGroup = document.getElementById('api-key-group');
    if (modelGroup) modelGroup.style.display = isBuiltIn ? 'none' : '';
    if (keyGroup) keyGroup.style.display = isBuiltIn ? 'none' : '';

    if (!isBuiltIn) {
        // Populate models dynamically from the registry
        chrome.runtime.sendMessage({ type: 'AI_GET_PROVIDERS' }, (resp) => {
            if (!resp || !resp.providers || !resp.providers[provider]) return;
            const prov = resp.providers[provider];
            const modelSel = document.getElementById('ai-model');
            if (!modelSel) return;
            modelSel.innerHTML = prov.models.map(m =>
                `<option value="${m.id}">${m.name}</option>`
            ).join('');
            // Set default or saved model
            if (aiSettings.provider === provider && aiSettings.model) {
                modelSel.value = aiSettings.model;
            }
            // Update key hint
            const hint = document.getElementById('api-key-hint');
            if (hint && prov.keyUrl) {
                hint.innerHTML = `Get your API key at <a href="${prov.keyUrl}" target="_blank" rel="noopener">${prov.keyUrl.replace('https://', '')}</a>`;
            }
        });
    }
}

async function checkBuiltInAIStatus() {
    const icon = document.getElementById('builtin-status-icon');
    const text = document.getElementById('builtin-status-text');
    const hint = document.getElementById('builtin-status-hint');
    const box = document.getElementById('builtin-status');
    if (!icon || !text || !hint || !box) return;

    try {
        const resp = await chrome.runtime.sendMessage({ type: 'AI_CHECK_BUILTIN' });
        if (resp.available) {
            icon.textContent = '✅';
            text.textContent = 'Built-in AI is available!';
            hint.textContent = resp.needsDownload
                ? 'Gemini Nano model needs to download first (happens automatically)'
                : 'Gemini Nano model is ready — free, private, on-device AI';
            box.style.borderColor = 'rgba(52, 211, 153, 0.3)';
            box.style.background = 'rgba(52, 211, 153, 0.06)';
        } else {
            icon.textContent = '⚠️';
            text.textContent = 'Built-in AI not available';
            hint.textContent = resp.reason || 'Chrome 138+ required. Use Groq (free) or another provider.';
            box.style.borderColor = 'rgba(251, 191, 36, 0.3)';
            box.style.background = 'rgba(251, 191, 36, 0.06)';
        }
    } catch (err) {
        icon.textContent = '❌';
        text.textContent = 'Could not check Built-in AI';
        hint.textContent = 'Use Groq (free tier) or another provider as fallback';
        box.style.borderColor = 'rgba(248, 113, 113, 0.3)';
        box.style.background = 'rgba(248, 113, 113, 0.06)';
    }
}

bindEvent('ai-provider','change', (e) => {
    updateProviderUI(e.target.value);
});

bindEvent('btn-toggle-key','click', () => {
    const input = document.getElementById('ai-api-key');
    input.type = input.type === 'password' ? 'text' : 'password';
});

bindEvent('btn-save-ai','click', async () => {
    const provider = document.getElementById('ai-provider').value;
    const isBuiltIn = provider === 'built-in';
    const settings = {
        provider,
        model: isBuiltIn ? 'gemini-nano' : document.getElementById('ai-model').value,
        apiKey: isBuiltIn ? '' : document.getElementById('ai-api-key').value.trim(),
        enabled: document.getElementById('ai-enabled').checked,
    };
    await chrome.runtime.sendMessage({ type: 'AI_SAVE_SETTINGS', settings });
    aiSettings = settings;
    renderOverview();
    const msg = document.getElementById('ai-status-msg');
    msg.textContent = '✓ Saved';
    msg.className = 'status-msg success';
    showToast('✓ AI settings saved', 'success');
    setTimeout(() => { msg.className = 'status-msg'; }, 3000);
});

bindEvent('btn-test-ai','click', async () => {
    const btn = document.getElementById('btn-test-ai');
    const msg = document.getElementById('ai-status-msg');
    const provider = document.getElementById('ai-provider').value;
    const isBuiltIn = provider === 'built-in';

    // Temporarily save settings for testing
    const settings = {
        provider,
        model: isBuiltIn ? 'gemini-nano' : document.getElementById('ai-model').value,
        apiKey: isBuiltIn ? '' : document.getElementById('ai-api-key').value.trim(),
        enabled: true,
    };
    await chrome.runtime.sendMessage({ type: 'AI_SAVE_SETTINGS', settings });
    setLoading(btn, true);
    msg.textContent = provider === 'built-in' ? 'Testing Built-in AI...' : 'Testing API connection...';
    msg.className = 'status-msg success';
    try {
        const resp = await chrome.runtime.sendMessage({ type: 'AI_TEST_CONNECTION' });
        if (resp.ok) {
            msg.textContent = '✓ Connection successful!';
            msg.className = 'status-msg success';
            showToast('✓ AI connection works!', 'success');
        } else {
            msg.textContent = '✗ ' + (resp.error || 'Failed');
            msg.className = 'status-msg error';
        }
    } catch (err) {
        msg.textContent = '✗ ' + err.message;
        msg.className = 'status-msg error';
    } finally {
        setLoading(btn, false);
        // Restore original settings
        await chrome.runtime.sendMessage({ type: 'AI_SAVE_SETTINGS', settings: aiSettings });
    }
});

function renderDisabledSites() {
    const list = document.getElementById('disabled-sites-list');
    const disabled = Object.entries(allData.sites || {}).filter(([, s]) => s.disabled);
    document.getElementById('disabled-count').textContent = disabled.length;
    if (disabled.length === 0) {
        list.innerHTML = '<div class="empty-state">No sites are currently disabled.</div>';
        return;
    }
    list.innerHTML = disabled.map(([hostname]) => `
        <div class="disabled-site-item">
            <span class="disabled-site-name">${escHtml(hostname)}</span>
            <button class="btn btn-secondary btn-sm" data-reenable="${hostname}">Re-enable</button>
        </div>
    `).join('');
    list.querySelectorAll('[data-reenable]').forEach(btn => {
        btn.addEventListener('click', async () => {
            await chrome.runtime.sendMessage({ type: 'SET_ENABLED', hostname: btn.dataset.reenable, enabled: false, clearDisabled: true });
            if (allData.sites[btn.dataset.reenable]) allData.sites[btn.dataset.reenable].disabled = false;
            renderDisabledSites();
            renderSites();
            showToast('✓ Site re-enabled', 'success');
        });
    });
}

// Export
bindEvent('btn-export','click', async () => {
    const exportData = {
        version: '2.0.0',
        exportedAt: new Date().toISOString(),
        autofill_data: allData,
        global_profile: globalProfile,
        applications: applications,
        tasks: tasks,
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `job-autofill-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('✓ Data exported successfully', 'success');
});

// Import
bindEvent('btn-import','click', () => {
    document.getElementById('import-file').click();
});
bindEvent('import-file','change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
        const text = await file.text();
        const imported = JSON.parse(text);
        if (!imported.autofill_data) {
            showToast('Invalid backup file format', 'error');
            return;
        }
        showConfirmModal('Import Data', 'This will merge imported data with your existing data. Continue?', async () => {
            const mergedSites = { ...allData.sites };
            for (const [hostname, site] of Object.entries(imported.autofill_data.sites || {})) {
                if (mergedSites[hostname]) {
                    mergedSites[hostname].fields = { ...mergedSites[hostname].fields, ...(site.fields || {}) };
                } else {
                    mergedSites[hostname] = site;
                }
            }
            const mergedData = {
                sites: mergedSites,
                hostnameMappings: { ...allData.hostnameMappings, ...(imported.autofill_data.hostnameMappings || {}) }
            };
            await chrome.storage.local.set({ autofill_data: mergedData });
            if (imported.global_profile) {
                const mergedProfile = { ...globalProfile };
                for (const [key, val] of Object.entries(imported.global_profile)) {
                    if (val && !mergedProfile[key]) mergedProfile[key] = val;
                }
                await chrome.runtime.sendMessage({ type: 'SAVE_GLOBAL_PROFILE', profile: mergedProfile });
            }
            if (imported.applications) {
                for (const app of imported.applications) {
                    await chrome.runtime.sendMessage({ type: 'APP_ADD', application: app });
                }
            }
            if (imported.tasks) {
                for (const task of imported.tasks) {
                    await chrome.runtime.sendMessage({ type: 'TASK_ADD', task });
                }
            }
            showToast('✓ Data imported successfully', 'success');
            await loadAllData();
        });
    } catch (err) {
        showToast('Failed to read file: ' + err.message, 'error');
    }
    e.target.value = '';
});

// Nuke
bindEvent('btn-nuke','click', () => {
    showConfirmModal('Delete All Data', 'This will permanently delete ALL extension data including sites, profile, applications, and AI settings. This cannot be undone.', async () => {
        await chrome.storage.local.clear();
        showToast('✓ All data deleted', 'success');
        await loadAllData();
    });
});

// ── Diagnostics Logs ───────────────────────────────────────────
async function renderDebugLogs() {
    const output = document.getElementById('debug-log-output');
    if (!output) return;
    try {
        const resp = await chrome.runtime.sendMessage({ type: 'LOG_GET' });
        const logs = resp?.logs || [];
        if (!logs.length) {
            output.textContent = 'No logs yet.';
            return;
        }
        const lines = logs.map(l => {
            const ts = l.ts || '';
            const type = l.type || l.kind || 'log';
            const field = l.field ? ` field="${l.field}"` : '';
            const tag = l.tag ? ` tag=${l.tag}` : '';
            const src = l.source ? ` src=${l.source}` : '';
            const filled = typeof l.filled === 'boolean' ? ` filled=${l.filled}` : '';
            const match = typeof l.match === 'boolean' ? ` match=${l.match}` : '';
            const visible = typeof l.visible === 'boolean' ? ` visible=${l.visible}` : '';
            const interactable = typeof l.interactable === 'boolean' ? ` interactable=${l.interactable}` : '';
            const frame = l.frameType ? ` frame=${l.frameType}` : '';
            const url = l.url ? ` url=${l.url}` : '';
            const confidence = l.confidence ? ` conf=${l.confidence}` : '';
            const canFill = typeof l.canFill === 'boolean' ? ` canFill=${l.canFill}` : '';
            let counts = '';
            if (l.counts) {
                const c = l.counts;
                counts = ` counts(site=${c.siteFields ?? '-'},session=${c.sessionFields ?? '-'},global=${c.global ?? '-'},merged=${c.merged ?? '-'})`;
            }
            return `[${ts}] ${type}${field}${tag}${src}${confidence}${canFill}${filled}${match}${visible}${interactable}${frame}${url}${counts}`;
        });
        output.textContent = lines.join('\n');
    } catch (err) {
        output.textContent = `Failed to load logs: ${err?.message || err}`;
    }
}

bindEvent('btn-debug-refresh','click', async () => {
    await renderDebugLogs();
    showToast('Logs refreshed', 'info');
});

bindEvent('btn-debug-copy','click', async () => {
    const output = document.getElementById('debug-log-output');
    if (!output) return;
    const text = output.textContent || '';
    try {
        await navigator.clipboard.writeText(text);
        showToast('✓ Logs copied', 'success');
    } catch (_) {
        showToast('Failed to copy logs', 'error');
    }
});

bindEvent('btn-debug-clear','click', async () => {
    await chrome.runtime.sendMessage({ type: 'LOG_CLEAR' });
    await renderDebugLogs();
    showToast('✓ Logs cleared', 'success');
});

// ── Cloud Sync ─────────────────────────────────────────────────
function withTimeout(promise, ms, fallback = null) {
    let timeoutId;
    const timeout = new Promise(resolve => {
        timeoutId = setTimeout(() => resolve(fallback), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

async function renderCloudSync() {
    const badge = document.getElementById('cloud-status-badge');
    if (!badge) return;
    // Load config (not displayed in UI)
    try {
        await chrome.runtime.sendMessage({ type: 'CLOUD_GET_CONFIG' });
    } catch (_) { /* ignore */ }

    const statusResp = await chrome.runtime.sendMessage({ type: 'CLOUD_GET_STATUS' });
    const { configured, loggedIn, user, lastSync } = statusResp;
    cloudStatus = { configured: !!configured, loggedIn: !!loggedIn, user: user || null, lastSync: lastSync || null };
    const prefsResp = await chrome.runtime.sendMessage({ type: 'CLOUD_GET_PREFS' }).catch(() => null);
    if (prefsResp?.prefs) cloudPrefs = prefsResp.prefs;

    const msgEl = document.getElementById('cloud-auth-msg');
    const authForms = document.getElementById('cloud-auth-forms');
    const loggedInView = document.getElementById('cloud-logged-in');
    const prefsWrap = document.getElementById('cloud-sync-prefs');

    msgEl.textContent = '';
    
    if (!configured) {
        badge.textContent = 'Not Configured';
        badge.style.background = 'rgba(239, 68, 68, 0.12)';
        badge.style.color = 'var(--red-400)';
        msgEl.textContent = 'Cloud sync is not configured.';
        if (prefsWrap) prefsWrap.style.display = 'none';
        return;
    }

    if (loggedIn && user) {
        authForms.style.display = 'none';
        loggedInView.style.display = 'block';
        badge.textContent = 'Connected';
        badge.style.background = 'rgba(34, 197, 94, 0.12)';
        badge.style.color = 'var(--green-400)';

        document.getElementById('cloud-user-name').textContent = user.displayName || 'Job Hunter';
        document.getElementById('cloud-user-email').textContent = user.email;

        const timeStr = lastSync?.lastPushedAt || lastSync?.lastPulledAt 
            ? new Date(lastSync.lastPushedAt || lastSync.lastPulledAt).toLocaleString() 
            : 'Never';
        document.getElementById('cloud-last-sync').textContent = timeStr;
        if (prefsWrap) prefsWrap.style.display = 'block';
    } else {
        authForms.style.display = 'grid';
        loggedInView.style.display = 'none';
        badge.textContent = 'Disconnected';
        badge.style.background = 'rgba(251, 191, 36, 0.12)';
        badge.style.color = 'var(--amber-400)';
        if (prefsWrap) prefsWrap.style.display = 'block';
    }

    // Apply prefs to UI
    const enabledEl = document.getElementById('cloud-sync-enabled');
    const profileEl = document.getElementById('cloud-sync-profile');
    const autofillEl = document.getElementById('cloud-sync-autofill');
    const appsEl = document.getElementById('cloud-sync-apps');
    const aiEl = document.getElementById('cloud-sync-ai');
    if (enabledEl) enabledEl.checked = !!cloudPrefs.enabled;
    if (profileEl) profileEl.checked = true;
    if (autofillEl) autofillEl.checked = !!cloudPrefs.syncAutofill;
    if (appsEl) appsEl.checked = !!cloudPrefs.syncApplications;
    if (aiEl) aiEl.checked = !!cloudPrefs.syncAiSettings;

    renderOverview();

    setupCloudPrefListeners();
}

function setupCloudPrefListeners() {
    if (window._cloudPrefsBound) return;
    window._cloudPrefsBound = true;

    const enabledEl = document.getElementById('cloud-sync-enabled');
    const autofillEl = document.getElementById('cloud-sync-autofill');
    const appsEl = document.getElementById('cloud-sync-apps');
    const aiEl = document.getElementById('cloud-sync-ai');
    const msg = document.getElementById('cloud-sync-msg');

    async function savePrefs(extra = {}) {
        try {
            const resp = await chrome.runtime.sendMessage({
                type: 'CLOUD_SAVE_PREFS',
                prefs: {
                    enabled: enabledEl?.checked,
                    syncAutofill: autofillEl?.checked,
                    syncApplications: appsEl?.checked,
                    syncAiSettings: aiEl?.checked,
                    ...extra,
                }
            });
            if (resp?.ok) {
                cloudPrefs = resp.prefs;
                if (enabledEl) enabledEl.checked = !!cloudPrefs.enabled;
                if (autofillEl) autofillEl.checked = !!cloudPrefs.syncAutofill;
                if (appsEl) appsEl.checked = !!cloudPrefs.syncApplications;
                if (aiEl) aiEl.checked = !!cloudPrefs.syncAiSettings;
                msg.textContent = '✓ Preferences saved';
                msg.className = 'status-msg success';
            } else {
                msg.textContent = resp?.error || 'Failed to save';
                msg.className = 'status-msg error';
            }
        } catch (err) {
            msg.textContent = err.message || 'Failed to save';
            msg.className = 'status-msg error';
        }
    }

    [enabledEl, autofillEl, appsEl, aiEl].forEach(el => {
        if (!el) return;
        el.addEventListener('change', () => savePrefs());
    });

    const btnPush = document.getElementById('btn-cloud-push');
    const btnPull = document.getElementById('btn-cloud-pull');
    const btnDelete = document.getElementById('btn-cloud-delete');

    if (btnPush) {
        btnPush.addEventListener('click', async () => {
            try {
                const resp = await chrome.runtime.sendMessage({ type: 'CLOUD_PUSH' });
                msg.textContent = resp.ok ? '✓ Pushed to cloud' : ('❌ ' + resp.error);
                msg.className = resp.ok ? 'status-msg success' : 'status-msg error';
            } catch (err) {
                msg.textContent = err.message || 'Push failed';
                msg.className = 'status-msg error';
            }
        });
    }
    if (btnPull) {
        btnPull.addEventListener('click', async () => {
            try {
                const resp = await chrome.runtime.sendMessage({ type: 'CLOUD_PULL' });
                msg.textContent = resp.ok ? '✓ Pulled from cloud' : ('❌ ' + resp.error);
                msg.className = resp.ok ? 'status-msg success' : 'status-msg error';
                await loadAllData();
            } catch (err) {
                msg.textContent = err.message || 'Pull failed';
                msg.className = 'status-msg error';
            }
        });
    }
    if (btnDelete) {
        btnDelete.addEventListener('click', () => {
            showConfirmModal('Delete cloud data?', 'This will remove all your data stored online. Local data will remain.', async () => {
                try {
                    const resp = await chrome.runtime.sendMessage({ type: 'CLOUD_DELETE_REMOTE' });
                    msg.textContent = resp.ok ? '✓ Cloud data deleted' : ('❌ ' + resp.error);
                    msg.className = resp.ok ? 'status-msg success' : 'status-msg error';
                } catch (err) {
                    msg.textContent = err.message || 'Delete failed';
                    msg.className = 'status-msg error';
                }
            });
        });
    }
}

const cloudUiRoot = document.getElementById('cloud-status-badge');
if (cloudUiRoot) {
    bindEvent('btn-cloud-signin','click', async () => {
        const email = document.getElementById('cloud-email').value;
        const pwd = document.getElementById('cloud-password').value;
        const msg = document.getElementById('cloud-auth-msg');
        const btn = document.getElementById('btn-cloud-signin');

        if (!email || !pwd) {
            msg.textContent = '❌ Email and password required.';
            msg.className = 'status-msg error';
            return;
        }

        // Ensure cloud is configured before attempting sign-in
        try {
            const status = await chrome.runtime.sendMessage({ type: 'CLOUD_GET_STATUS' }).catch(() => null);
            if (!status?.configured) {
                msg.textContent = '❌ Cloud sync is not configured. Add config.private.js and reload the extension.';
                msg.className = 'status-msg error';
                return;
            }
        } catch (_) {}

        setLoading(btn, true);
        msg.textContent = 'Signing in...';
        msg.className = 'status-msg';
        
        try {
            const resp = await withTimeout(
                chrome.runtime.sendMessage({ type: 'CLOUD_SIGN_IN', email, password: pwd }).catch(() => null),
                6000,
                null
            );
            if (!resp) {
                msg.textContent = '❌ Background not responding. Reload extension.';
                msg.className = 'status-msg error';
                return;
            }
            if (resp.ok) {
                msg.textContent = '✓ Sign in successful!';
                msg.className = 'status-msg success';
                document.getElementById('cloud-email').value = '';
                document.getElementById('cloud-password').value = '';
                await loadAllData();
            } else {
                msg.textContent = '❌ ' + resp.error;
                msg.className = 'status-msg error';
            }
        } catch (err) {
            msg.textContent = '❌ ' + err.message;
            msg.className = 'status-msg error';
        } finally {
            setLoading(btn, false);
        }
    });

    bindEvent('btn-cloud-signup','click', async () => {
        const email = document.getElementById('cloud-email').value;
        const pwd = document.getElementById('cloud-password').value;
        const msg = document.getElementById('cloud-auth-msg');
        const btn = document.getElementById('btn-cloud-signup');

        if (!email || !pwd) {
            msg.textContent = '❌ Email and password required.';
            msg.className = 'status-msg error';
            return;
        }

        // Ensure cloud is configured before attempting sign-up
        try {
            const status = await chrome.runtime.sendMessage({ type: 'CLOUD_GET_STATUS' }).catch(() => null);
            if (!status?.configured) {
                msg.textContent = '❌ Cloud sync is not configured. Add config.private.js and reload the extension.';
                msg.className = 'status-msg error';
                return;
            }
        } catch (_) {}

        setLoading(btn, true);
        msg.textContent = 'Creating account...';
        msg.className = 'status-msg';
        
        try {
            const resp = await withTimeout(
                chrome.runtime.sendMessage({ type: 'CLOUD_SIGN_UP', email, password: pwd }).catch(() => null),
                6000,
                null
            );
            if (!resp) {
                msg.textContent = '❌ Background not responding. Reload extension.';
                msg.className = 'status-msg error';
                return;
            }
            if (resp.ok) {
                msg.textContent = '✓ Account created & logged in!';
                msg.className = 'status-msg success';
                document.getElementById('cloud-email').value = '';
                document.getElementById('cloud-password').value = '';
                await loadAllData();
            } else {
                msg.textContent = '❌ ' + resp.error;
                msg.className = 'status-msg error';
            }
        } catch (err) {
            msg.textContent = '❌ ' + err.message;
            msg.className = 'status-msg error';
        } finally {
            setLoading(btn, false);
        }
    });

    bindEvent('btn-cloud-sync','click', async () => {
        const btn = document.getElementById('btn-cloud-sync');
        setLoading(btn, true);
        showToast('Syncing with cloud...', 'success');
        
        try {
            const resp = await chrome.runtime.sendMessage({ type: 'CLOUD_SYNC' });
            if (resp.ok) {
                showToast('✓ Cloud sync complete', 'success');
                await loadAllData();
            } else {
                showToast('❌ Sync failed: ' + resp.error, 'error');
            }
        } catch (err) {
            showToast('❌ Sync failed: ' + err.message, 'error');
        } finally {
            setLoading(btn, false);
        }
    });

    bindEvent('btn-cloud-signout','click', async () => {
        // 1. Clear Google Identity Cache if possible
        try {
            chrome.identity.getAuthToken({ interactive: false }, (token) => {
                if (token) {
                    chrome.identity.removeCachedAuthToken({ token }, () => {
                        console.log('Google token cleared from cache');
                    });
                }
            });
        } catch (e) { console.warn('Identity clear failed:', e); }

        // 2. Logout from Firebase
        await chrome.runtime.sendMessage({ type: 'CLOUD_SIGN_OUT' });
        showToast('Signed out. Local data for this account is still saved.', 'success');
        await loadAllData();
    });
}

// ── Dashboard Auth Listeners ───────────────────────────────────
function setupDashAuth() {
    const btnEmail = document.getElementById('btn-dash-signin');
    const btnGoogle = document.getElementById('btn-dash-google');
    const msg = document.getElementById('dash-auth-error');

    btnEmail.addEventListener('click', async () => {
        const email = document.getElementById('dash-auth-email').value;
        const pwd = document.getElementById('dash-auth-password').value;
        if (!email || !pwd) {
            msg.textContent = 'Email and password required.';
            return;
        }

        msg.textContent = '';
        btnEmail.disabled = true;
        btnEmail.textContent = 'Signing in...';

        try {
            const resp = await chrome.runtime.sendMessage({ type: 'CLOUD_SIGN_IN', email, password: pwd });
            if (resp.ok) {
                loadAllData();
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

    btnGoogle.addEventListener('click', async () => {
        msg.textContent = '';
        btnGoogle.disabled = true;

        // Clear existing token first to force account picker
        chrome.identity.getAuthToken({ interactive: false }, (oldToken) => {
            if (oldToken) chrome.identity.removeCachedAuthToken({ token: oldToken });
            
            chrome.identity.getAuthToken({ interactive: true }, async (token) => {
                if (chrome.runtime.lastError || !token) {
                    msg.textContent = chrome.runtime.lastError?.message || 'Google Auth failed or cancelled.';
                    btnGoogle.disabled = false;
                    return;
                }

                const resp = await chrome.runtime.sendMessage({ type: 'CLOUD_SIGN_IN_GOOGLE', accessToken: token });
                if (resp.ok) {
                    loadAllData();
                } else {
                    msg.textContent = resp.error;
                    btnGoogle.disabled = false;
                }
            });
        });
    });
}

// ── Init ───────────────────────────────────────────────
initTheme();
setupDashAuth();
loadAllData().then(() => {
    bindTaskControls();
    bindTaskModal();
    // Handle hash-based tab navigation (e.g. #tab-profile from popup)
    const hash = window.location.hash;
    if (hash && hash.startsWith('#tab-')) {
        const tabId = hash.slice(1); // e.g. 'tab-profile'
        const tabBtn = document.querySelector(`[data-tab="${tabId.replace('tab-', '')}"]`);
        if (tabBtn) {
            setTimeout(() => tabBtn.click(), 300);
        }
    }
});

// Also handle if user navigates with hash after page load
window.addEventListener('hashchange', () => {
    const hash = window.location.hash;
    if (hash && hash.startsWith('#tab-')) {
        const tabBtn = document.querySelector(`[data-tab="${hash.slice(5)}"]`);
        if (tabBtn) tabBtn.click();
    }
});
