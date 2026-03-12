// dashboard.js — Job Autofill AI Copilot Dashboard

// ── State ──────────────────────────────────────────────────────
let allData = { sites: {}, hostnameMappings: {} };
let globalProfile = {};
let applications = [];
let aiSettings = {};

// ── Helpers ────────────────────────────────────────────────────
function escHtml(str) {
    const d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
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
document.getElementById('modal-cancel').addEventListener('click', () => {
    document.getElementById('confirm-modal').hidden = true;
    confirmCallback = null;
});
document.getElementById('modal-confirm').addEventListener('click', async () => {
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

document.getElementById('btn-view-all-apps').addEventListener('click', () => {
    document.querySelector('[data-tab="tracker"]').click();
});

// ── Data Loading ───────────────────────────────────────────────
async function loadAllData() {
    try {
        const authStatus = await chrome.runtime.sendMessage({ type: 'CLOUD_GET_STATUS' });
        if (!authStatus.loggedIn) {
            document.getElementById('dashboard-auth-shield').style.display = 'flex';
            document.getElementById('main-dashboard-app').style.display = 'none';
            if (!authStatus.configured) {
                const msg = document.getElementById('dash-auth-setup-msg');
                msg.innerHTML = 'Firebase config missing. Please read the <a href="#" id="dash-link-setup" style="color:var(--blue-400); text-decoration:none;">setup guide</a>.';
                const link = document.getElementById('dash-link-setup');
                if (link) link.addEventListener('click', (e) => {
                    e.preventDefault();
                    chrome.tabs.create({ url: chrome.runtime.getURL('SETUP_GUIDE.md') });
                });
            }
            return;
        }

        document.getElementById('dashboard-auth-shield').style.display = 'none';
        document.getElementById('main-dashboard-app').style.display = 'flex';

        const [dataResp, profileResp, aiResp, appsResp] = await Promise.all([
            chrome.runtime.sendMessage({ type: 'GET_ALL_DATA' }),
            chrome.runtime.sendMessage({ type: 'GET_GLOBAL_PROFILE' }),
            chrome.runtime.sendMessage({ type: 'AI_GET_SETTINGS' }),
            chrome.runtime.sendMessage({ type: 'APP_GET_ALL' }),
        ]);
        allData = dataResp?.data || { sites: {}, hostnameMappings: {} };
        globalProfile = profileResp?.profile || {};
        aiSettings = aiResp?.settings || {};
        applications = appsResp?.apps || [];
    } catch (err) {
        console.error('[Dashboard] Load error:', err);
        showToast('Failed to load data. Please reload.', 'error');
    }
    try {
        renderOverview();
        renderSites();
        renderProfile();
        renderTracker();
        renderInterviewAppSelect();
        renderDisabledSites();
        renderAiSettings();
        renderCloudSync();
    } catch (err) {
        console.error('[Dashboard] Render error:', err);
    }
}

// ── OVERVIEW TAB ───────────────────────────────────────────────
function renderOverview() {
    const sites = Object.keys(allData.sites || {});
    const activeSites = sites.filter(s => allData.sites[s]?.enabled && !allData.sites[s]?.disabled);

    document.getElementById('stat-total-sites').textContent = sites.length;
    document.getElementById('stat-active-sites').textContent = activeSites.length;
    document.getElementById('stat-applications').textContent = applications.length;
    document.getElementById('stat-ai-status').textContent = aiSettings.enabled ? 'Active' : 'Off';

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

document.getElementById('site-search').addEventListener('input', (e) => {
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

document.getElementById('btn-add-skill').addEventListener('click', addSkill);
document.getElementById('skill-input').addEventListener('keydown', e => {
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

document.getElementById('btn-add-work').addEventListener('click', () => {
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

document.getElementById('btn-add-edu').addEventListener('click', () => {
    if (!globalProfile.education) globalProfile.education = [];
    globalProfile.education.push({ school: '', degree: '', field: '', endDate: '', gpa: '' });
    renderEducation();
});

// Save Profile
document.getElementById('profile-form').addEventListener('submit', async (e) => {
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

// ── Resume Parsing ─────────────────────────────────────────────
document.getElementById('btn-upload-resume').addEventListener('click', () => {
    document.getElementById('resume-file-input').click();
});
document.getElementById('resume-file-input').addEventListener('change', async (e) => {
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

document.getElementById('btn-parse-resume').addEventListener('click', async () => {
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

function renderTracker() {
    const list = document.getElementById('applications-list');
    const filtered = currentFilter === 'all'
        ? applications
        : applications.filter(a => a.status === currentFilter);

    document.getElementById('tracker-count').textContent = `${filtered.length} application${filtered.length !== 1 ? 's' : ''}`;

    if (filtered.length === 0) {
        list.innerHTML = '<div class="empty-state">No applications found.<br>Applications auto-log when you apply, or add them manually.</div>';
        return;
    }

    list.innerHTML = filtered.map(app => `
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
                            ${['applied', 'screening', 'interviewing', 'offer', 'rejected'].map(s =>
        `<option value="${s}" ${s === app.status ? 'selected' : ''}>${s}</option>`
    ).join('')}
                        </select>
                    </div>
                    ${app.url ? `<div class="app-detail-item"><span class="app-detail-label">URL</span><a href="${app.url}" target="_blank" style="color:var(--blue-400);font-size:13px;text-decoration:none;">Open →</a></div>` : ''}
                </div>
                <div class="app-notes-area">
                    <label>Notes</label>
                    <textarea data-appnotes="${app.id}" placeholder="Add personal notes...">${escHtml(app.notes || '')}</textarea>
                </div>
                <div class="app-card-actions-row">
                    <button class="btn btn-secondary btn-sm" data-action="interview" data-app-id="${app.id}">💬 Interview Prep</button>
                    <button class="btn btn-secondary btn-sm" data-action="followup" data-app-id="${app.id}">📧 Follow-up</button>
                    <button class="btn btn-secondary btn-sm" data-action="tailor" data-app-id="${app.id}">📄 Tailor Resume</button>
                    <button class="btn btn-danger btn-sm" data-action="deleteapp" data-app-id="${app.id}">🗑 Delete</button>
                </div>
            </div>
        </div>
    `).join('');
    attachTrackerListeners();
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

// Add Application Modal
document.getElementById('btn-add-application').addEventListener('click', () => {
    document.getElementById('add-app-modal').hidden = false;
});
document.getElementById('add-app-cancel').addEventListener('click', () => {
    document.getElementById('add-app-modal').hidden = true;
});
document.getElementById('add-app-save').addEventListener('click', async () => {
    const app = {
        companyName: document.getElementById('app-company').value.trim(),
        jobTitle: document.getElementById('app-title').value.trim(),
        location: document.getElementById('app-location').value.trim(),
        status: document.getElementById('app-status').value,
        url: document.getElementById('app-url').value.trim(),
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

document.getElementById('interview-app-select').addEventListener('change', (e) => {
    const app = applications.find(a => a.id === e.target.value);
    if (app) document.getElementById('interview-jd-input').value = app.jobDescription || '';
});

document.getElementById('btn-generate-interview').addEventListener('click', async () => {
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
    const provider = aiSettings.provider || 'built-in';
    document.getElementById('ai-provider').value = provider;
    document.getElementById('ai-model').value = aiSettings.model || 'gemini-2.0-flash';
    document.getElementById('ai-api-key').value = aiSettings.apiKey || '';
    document.getElementById('ai-enabled').checked = aiSettings.enabled !== false; // default true

    updateProviderUI(provider);
    checkBuiltInAIStatus();
}

function updateProviderUI(provider) {
    const isBuiltIn = provider === 'built-in';
    document.getElementById('model-group').style.display = isBuiltIn ? 'none' : '';
    document.getElementById('api-key-group').style.display = isBuiltIn ? 'none' : '';

    if (!isBuiltIn) {
        // Populate models dynamically from the registry
        chrome.runtime.sendMessage({ type: 'AI_GET_PROVIDERS' }, (resp) => {
            if (!resp || !resp.providers || !resp.providers[provider]) return;
            const prov = resp.providers[provider];
            const modelSel = document.getElementById('ai-model');
            modelSel.innerHTML = prov.models.map(m =>
                `<option value="${m.id}">${m.name}</option>`
            ).join('');
            // Set default or saved model
            if (aiSettings.provider === provider && aiSettings.model) {
                modelSel.value = aiSettings.model;
            }
            // Update key hint
            const hint = document.getElementById('api-key-hint');
            if (prov.keyUrl) {
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

document.getElementById('ai-provider').addEventListener('change', (e) => {
    updateProviderUI(e.target.value);
});

document.getElementById('btn-toggle-key').addEventListener('click', () => {
    const input = document.getElementById('ai-api-key');
    input.type = input.type === 'password' ? 'text' : 'password';
});

document.getElementById('btn-save-ai').addEventListener('click', async () => {
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

document.getElementById('btn-test-ai').addEventListener('click', async () => {
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
document.getElementById('btn-export').addEventListener('click', async () => {
    const exportData = {
        version: '2.0.0',
        exportedAt: new Date().toISOString(),
        autofill_data: allData,
        global_profile: globalProfile,
        applications: applications,
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
document.getElementById('btn-import').addEventListener('click', () => {
    document.getElementById('import-file').click();
});
document.getElementById('import-file').addEventListener('change', async (e) => {
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
            showToast('✓ Data imported successfully', 'success');
            await loadAllData();
        });
    } catch (err) {
        showToast('Failed to read file: ' + err.message, 'error');
    }
    e.target.value = '';
});

// Nuke
document.getElementById('btn-nuke').addEventListener('click', () => {
    showConfirmModal('Delete All Data', 'This will permanently delete ALL extension data including sites, profile, applications, and AI settings. This cannot be undone.', async () => {
        await chrome.storage.local.clear();
        showToast('✓ All data deleted', 'success');
        await loadAllData();
    });
});

// ── Cloud Sync ─────────────────────────────────────────────────
async function renderCloudSync() {
    const statusResp = await chrome.runtime.sendMessage({ type: 'CLOUD_GET_STATUS' });
    const { configured, loggedIn, user, lastSync } = statusResp;

    const msgEl = document.getElementById('cloud-auth-msg');
    const badge = document.getElementById('cloud-status-badge');
    const authForms = document.getElementById('cloud-auth-forms');
    const loggedInView = document.getElementById('cloud-logged-in');

    msgEl.textContent = '';
    
    if (!configured) {
        badge.textContent = 'Not Configured';
        badge.style.background = 'rgba(239, 68, 68, 0.12)';
        badge.style.color = 'var(--red-400)';
        msgEl.textContent = 'Cloud sync requires Firebase config in setup.';
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
    } else {
        authForms.style.display = 'grid';
        loggedInView.style.display = 'none';
        badge.textContent = 'Disconnected';
        badge.style.background = 'rgba(251, 191, 36, 0.12)';
        badge.style.color = 'var(--amber-400)';
    }
}

document.getElementById('btn-cloud-signin').addEventListener('click', async () => {
    const email = document.getElementById('cloud-email').value;
    const pwd = document.getElementById('cloud-password').value;
    const msg = document.getElementById('cloud-auth-msg');
    const btn = document.getElementById('btn-cloud-signin');

    if (!email || !pwd) {
        msg.textContent = '❌ Email and password required.';
        msg.className = 'status-msg error';
        return;
    }

    setLoading(btn, true);
    msg.textContent = 'Signing in...';
    msg.className = 'status-msg';
    
    try {
        const resp = await chrome.runtime.sendMessage({ type: 'CLOUD_SIGN_IN', email, password: pwd });
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

document.getElementById('btn-cloud-signup').addEventListener('click', async () => {
    const email = document.getElementById('cloud-email').value;
    const pwd = document.getElementById('cloud-password').value;
    const msg = document.getElementById('cloud-auth-msg');
    const btn = document.getElementById('btn-cloud-signup');

    if (!email || !pwd) {
        msg.textContent = '❌ Email and password required.';
        msg.className = 'status-msg error';
        return;
    }

    setLoading(btn, true);
    msg.textContent = 'Creating account...';
    msg.className = 'status-msg';
    
    try {
        const resp = await chrome.runtime.sendMessage({ type: 'CLOUD_SIGN_UP', email, password: pwd });
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

document.getElementById('btn-cloud-sync').addEventListener('click', async () => {
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

document.getElementById('btn-cloud-signout').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'CLOUD_SIGN_OUT' });
    showToast('Signed out of cloud sync', 'success');
    await loadAllData();
});

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

        try {
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
        } catch (err) {
            msg.textContent = err.message;
            btnGoogle.disabled = false;
        }
    });
}

// ── Init ───────────────────────────────────────────────────────
setupDashAuth();
loadAllData();

