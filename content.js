// content.js — Injected into every page (including ATS iframes)

// When inside an iframe (e.g. job-boards.greenhouse.io inside stripe.com),
// use the TOP-level page hostname so data groups under the company site.
let hostname;
try {
  // Same-origin top: works on same-origin iframes
  hostname = (window.top.location.hostname || location.hostname).replace(/^www\./, '');
} catch (_) {
  // Cross-origin top access blocked.
  // Use document.referrer to get the parent page's origin so data groups
  // under the company site (stripe.com) not the ATS domain (greenhouse.io)
  try {
    const ref = new URL(document.referrer);
    hostname = ref.hostname.replace(/^www\./, '');
  } catch (__) {
    hostname = location.hostname.replace(/^www\./, '');
  }
}

console.log(`[FormPilot] Content script loaded on: ${location.hostname} (stored under: ${hostname})`);

let currentGlobalProfile = {};
let siteData = { enabled: true, fields: {}, mappings: [], flags: {} };
let currentSiteKey = '';
let currentSiteActive = true;
let currentSiteMappings = [];
let siteFlags = {};
let sessionFlags = {};
let teachMode = false;
let teachHandlerAttached = false;
let teachHoverAttached = false;
let teachHoverBox = null;
let pendingCapture = {};
let captureTimer = null;
let lastFileInput = null;
let resumeMenuOpen = false;
let resumeCache = { items: [], defaultId: null, ts: 0 };
let pendingDropdownResolve = null;
let dropdownResolverOpen = false;
let lastSubmitIntent = null;
let approvalQueue = [];
const LEARNING_SESSION_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const ACCURACY_MODE = false;
const APPROVAL_REQUIRED_LEVEL = 'mid';
const FieldUtils = (globalThis.JobAutofill && JobAutofill.FieldUtils) || null;
const SELECT_VALUE_PREFIX = '__JA_SELECT__';
const SESSION_FLAG_KEYS = {
  autofillActive: 'ja_autofill_active',
  autofillDismissed: 'ja_autofill_dismissed',
  promptSkipped: 'ja_prompt_skipped',
  coverageDismissed: 'ja_coverage_dismissed',
  jobContextConfirmed: 'ja_job_context_confirmed',
  appAdded: 'ja_app_added',
  confidenceDismissed: 'ja_confidence_dismissed',
};

const JOB_HOST_PATTERNS = [
  /greenhouse\.io$/i,
  /lever\.co$/i,
  /myworkdayjobs\.com$/i,
  /workday\.com$/i,
  /icims\.com$/i,
  /smartrecruiters\.com$/i,
  /jobvite\.com$/i,
  /taleo\.net$/i,
  /successfactors\.com$/i,
  /bamboohr\.com$/i,
  /ashbyhq\.com$/i,
  /workable\.com$/i,
  /recruitee\.com$/i,
  /applytojob\.com$/i,
  /teamtailor\.com$/i,
  /pinpointhq\.com$/i,
  /breezy\.hr$/i,
  /applicantpro\.com$/i,
  /adp\.com$/i,
];

const JOB_TEXT_REGEX = /job application|apply now|apply for|candidate|applicant|resume|cv|cover letter|work authorization|sponsorship|position|role|career|employment|work experience|education|degree|compensation|salary|relocation|availability|notice period|preferred start|github|portfolio|workday|greenhouse|lever|icims|smartrecruiters|jobvite|taleo|successfactors|ashby|workable|recruitee|teamtailor|bamboohr/i;
const LOGIN_TEXT_REGEX = /sign in|log in|login|password|forgot password|two-factor|2fa|verification code/i;

function cleanLabelText(text) {
  if (FieldUtils && FieldUtils.cleanLabelText) return FieldUtils.cleanLabelText(text);
  if (!text) return '';
  return String(text).replace(/\*/g, '').replace(/:\s*$/, '').trim();
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inferFieldType(el, fieldKey) {
  const type = (el?.type || '').toLowerCase();
  if (type === 'email') return 'email';
  if (type === 'tel') return 'phone';
  if (type === 'url') return 'url';
  if (type === 'date') return 'date';
  if (type === 'number') return 'number';
  const key = (fieldKey || '').toLowerCase();
  if (/email|e-mail|mail\s*address/.test(key)) return 'email';
  if (/phone|mobile|cell|tel|telephone|contact.?number/.test(key)) return 'phone';
  if (/linkedin|github|portfolio|website|url/.test(key)) return 'url';
  if (/date|dob|birth|start|end/.test(key)) return 'date';
  if (/zip|postal/.test(key)) return 'zipcode';
  if (/state|province/.test(key)) return 'state';
  if (/city/.test(key)) return 'city';
  if (/salary|compensation|ctc|pay/.test(key)) return 'number';
  return 'text';
}

function validateValueForType(type, value) {
  if (value === undefined || value === null) return false;
  const v = String(value).trim();
  if (!v) return false;
  switch (type) {
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
    case 'phone': {
      const digits = v.replace(/\D/g, '');
      return digits.length >= 7;
    }
    case 'url':
      return /^(https?:\/\/)?[^\s]+\.[^\s]+/.test(v);
    case 'date': {
      const t = Date.parse(v);
      return !Number.isNaN(t);
    }
    case 'number':
      return !Number.isNaN(Number(v));
    case 'zipcode':
      return /^[A-Za-z0-9 -]{3,10}$/.test(v);
    default:
      return true;
  }
}

function shouldFillValue(el, fieldKey, value) {
  const tag = el?.tagName?.toUpperCase();
  const role = el?.getAttribute?.('role') || '';
  if (tag === 'SELECT' || role === 'listbox' || role === 'combobox') return true;
  const type = inferFieldType(el, fieldKey);
  return validateValueForType(type, value);
}

function classifyConfidence({ mapped, source, globalMeta }) {
  if (mapped?.mapping && !mapped.confidence) return 'high';
  if (mapped?.confidence >= 8) return 'high';
  if (mapped?.mapping || mapped?.confidence >= 6) return 'mid';
  if (source === 'site') return 'mid';
  if (source === 'global' && (globalMeta?.score || 0) >= 0.7) return 'mid';
  return 'low';
}

function shouldAutofillConfidence(level) {
  if (!ACCURACY_MODE) return true;
  return level === 'high';
}

function queueApproval(entry) {
  approvalQueue.push(entry);
}

function showApprovalBanner() {
  if (!approvalQueue.length) return;
  if (document.getElementById('ja-approval-banner')) return;
  if (getSessionFlag('promptSkipped')) return;
  if (!isJobContextPage()) return;
  const banner = document.createElement('div');
  banner.id = 'ja-approval-banner';
  banner.innerHTML = `
    <style>
      #ja-approval-banner {
        position: fixed; top: 18px; right: 18px; z-index: 2147483646;
        background: #0b1220; color: #e2e8f0;
        border: 1px solid rgba(10, 102, 194, 0.35);
        border-radius: 12px; padding: 12px 14px; max-width: 320px;
        box-shadow: 0 12px 32px rgba(0,0,0,0.5);
        font-family: 'Avenir Next', 'Helvetica Neue', 'Segoe UI', sans-serif;
        font-size: 12px;
      }
      #ja-approval-banner .actions { display:flex; gap:8px; margin-top: 8px; }
      #ja-approval-fill { background: #0a66c2; color: #fff; border: none; border-radius: 8px; padding: 6px 10px; cursor: pointer; }
      #ja-approval-skip { background: rgba(255,255,255,0.08); color: #cbd5f5; border: none; border-radius: 8px; padding: 6px 10px; cursor: pointer; }
    </style>
    <div><strong>Approve ${approvalQueue.length} suggestions?</strong></div>
    <div style="color:#94a3b8; margin-top:4px;">We’ll only fill medium‑confidence fields if you approve.</div>
    <div class="actions">
      <button id="ja-approval-fill">Fill Now</button>
      <button id="ja-approval-skip">Skip</button>
    </div>
  `;
  document.body.appendChild(banner);

  banner.querySelector('#ja-approval-fill')?.addEventListener('click', () => {
    approvalQueue.forEach(item => {
      applyValueToElement(item.el, item.fieldKey, item.val, item.altVal);
    });
    approvalQueue = [];
    banner.remove();
  });

  banner.querySelector('#ja-approval-skip')?.addEventListener('click', () => {
    approvalQueue = [];
    banner.remove();
  });

  setTimeout(() => {
    approvalQueue = [];
    banner.remove();
  }, 12000);
}

function applyValueToElement(el, fieldKey, primaryVal, altVal) {
  if (!el) return false;
  if (!shouldFillValue(el, fieldKey, primaryVal)) return false;
  const tag = el.tagName?.toUpperCase();
  const type = (el.type || '').toLowerCase();
  if (type === 'checkbox') {
    el.checked = primaryVal === 'true' || primaryVal === true;
    triggerEvents(el);
    return true;
  }
  if (tag === 'SELECT' && el.multiple) {
    const vals = String(primaryVal).split(',');
    Array.from(el.options).forEach(opt => { opt.selected = vals.includes(opt.value) || vals.includes(opt.text.trim()); });
    triggerEvents(el);
    return true;
  }
  if (tag === 'SELECT') {
    const targetText = String(primaryVal).toLowerCase().trim();
    const targetValue = String(altVal || primaryVal).toLowerCase().trim();
    for (let i = 0; i < el.options.length; i++) {
      const opt = el.options[i];
      const optVal = opt.value.toLowerCase().trim();
      const optText = opt.text.toLowerCase().trim();
      if (optVal === targetText || optText === targetText || optVal === targetValue || optText === targetValue) {
        el.selectedIndex = i;
        triggerEvents(el);
        return true;
      }
    }
    return false;
  }
  if (setEditableValue(el, primaryVal)) return true;
  const currentVal = el.value?.trim?.() || '';
  if (currentVal) return true;
  setNativeValue(el, primaryVal);
  triggerEvents(el);
  el.dispatchEvent(new Event('blur', { bubbles: true }));
  return true;
}

function encodeSelectValue(text, value) {
  const t = (text || '').toString().trim();
  const v = (value || '').toString().trim();
  if (!v || v === t) return t;
  try {
    return SELECT_VALUE_PREFIX + btoa(JSON.stringify({ text: t, value: v }));
  } catch (_) {
    return t || v;
  }
}

function decodeSelectValue(val) {
  if (typeof val !== 'string') return { text: val, value: val };
  if (!val.startsWith(SELECT_VALUE_PREFIX)) return { text: val, value: val };
  try {
    const json = atob(val.slice(SELECT_VALUE_PREFIX.length));
    const data = JSON.parse(json);
    return { text: data.text || '', value: data.value || data.text || '' };
  } catch (_) {
    return { text: val, value: val };
  }
}

function normalizeHint(str) {
  if (!str) return '';
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function scoreStringMatch(a, b) {
  const x = normalizeHint(a);
  const y = normalizeHint(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.7;
  const xt = new Set(x.split(/\s+/));
  const yt = new Set(y.split(/\s+/));
  let overlap = 0;
  xt.forEach(t => { if (yt.has(t)) overlap++; });
  const denom = Math.max(xt.size, yt.size);
  if (!denom) return 0;
  const ratio = overlap / denom;
  return ratio >= 0.5 ? 0.5 : 0;
}

function buildElementHints(el) {
  if (!el) return {};
  const role = el.getAttribute?.('role') || '';
  const siteLabel = getSiteLabel(el);
  const label = getFieldKey(el) || siteLabel || '';
  const dataField = el.getAttribute('data-field')
    || el.getAttribute('data-field-id')
    || el.getAttribute('data-field-name')
    || el.getAttribute('data-field-key')
    || '';
  const dataLabel = el.getAttribute('data-label')
    || el.getAttribute('data-title')
    || el.getAttribute('data-placeholder')
    || el.getAttribute('aria-placeholder')
    || '';
  return {
    label: cleanLabelText(label),
    siteLabel: cleanLabelText(siteLabel),
    ancestorLabel: cleanLabelText(getAncestorLabelText(el)),
    name: el.name || '',
    id: el.id || '',
    ariaLabel: el.getAttribute('aria-label') || '',
    placeholder: el.placeholder || '',
    dataAutomationId: el.getAttribute('data-automation-id') || '',
    dataTest: el.getAttribute('data-test') || el.getAttribute('data-testid') || '',
    dataQa: el.getAttribute('data-qa') || '',
    dataName: el.getAttribute('data-name') || '',
    dataField,
    dataLabel,
    role,
    type: (el.type || el.tagName || '').toLowerCase(),
    section: cleanLabelText(el.closest('fieldset')?.querySelector('legend')?.innerText?.trim() || ''),
    domPath: getDomPath(el),
  };
}

function scoreHintMatch(mappingHints, elementHints) {
  if (!mappingHints || !elementHints) return { score: 0, ratio: 0 };
  const weights = [
    ['label', 4],
    ['siteLabel', 4],
    ['name', 3],
    ['id', 3],
    ['dataField', 3],
    ['dataAutomationId', 2.5],
    ['ariaLabel', 2],
    ['ancestorLabel', 2],
    ['dataLabel', 1.5],
    ['placeholder', 1],
    ['dataTest', 1],
    ['dataQa', 1],
    ['dataName', 1],
    ['section', 1],
    ['role', 0.5],
    ['type', 0.5],
  ];
  let score = 0;
  let max = 0;
  for (const [key, weight] of weights) {
    max += weight;
    const m = mappingHints[key];
    const e = elementHints[key];
    const match = scoreStringMatch(m, e);
    if (match) score += weight * match;
  }
  return { score, ratio: max ? score / max : 0 };
}

function getSessionFlag(flag) {
  const key = SESSION_FLAG_KEYS[flag];
  if (!key) return false;
  try {
    const stored = sessionStorage.getItem(key);
    if (stored === 'true') return true;
    if (stored === 'false') return false;
  } catch (_) { }
  return !!sessionFlags[flag];
}

function setSessionFlag(flag, value) {
  const key = SESSION_FLAG_KEYS[flag];
  if (!key) return;
  sessionFlags[flag] = value;
  try { sessionStorage.setItem(key, value ? 'true' : 'false'); } catch (_) { }
  chrome.runtime.sendMessage({ type: 'SESSION_SET_FLAGS', hostname, flags: { [flag]: value } }).catch(() => { });
}

function hydrateSessionFlags(flags) {
  if (!flags) return;
  Object.keys(SESSION_FLAG_KEYS).forEach(flag => {
    if (flags[flag]) {
      try { sessionStorage.setItem(SESSION_FLAG_KEYS[flag], 'true'); } catch (_) { }
    }
  });
}

function getSiteFlag(flag) {
  if (!flag) return false;
  return !!(siteFlags && siteFlags[flag]);
}

function setSiteFlag(flag, value) {
  if (!flag) return;
  siteFlags = siteFlags || {};
  siteFlags[flag] = value;
  siteData.flags = { ...(siteData.flags || {}), [flag]: value };
  chrome.runtime.sendMessage({ type: 'SET_SITE_FLAGS', hostname, flags: { [flag]: value } }).catch(() => { });
}

function getPageTextSample() {
  try {
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    return text.substring(0, 4000);
  } catch (_) {
    return '';
  }
}

function getVisibleInputCount() {
  const selector = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=file]), textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]';
  const elements = collectElements(selector);
  let count = 0;
  elements.forEach(el => {
    const type = (el.type || '').toLowerCase();
    if (type === 'password') return;
    if (!isVisibleElement(el)) return;
    count += 1;
  });
  return count;
}

function hasFillableFields() {
  return getVisibleInputCount() > 0;
}

function hasResumeUploadSignal() {
  const fileInput = collectElements('input[type="file"]').find(el => isVisibleElement(el));
  if (fileInput) return true;
  const labels = collectElements('label, .label, .field-label, [data-automation-id="questionText"], [data-automation-id="promptText"]');
  return labels.some(el => /resume|cv|cover letter/i.test(el.innerText || ''));
}

function countJobLabelSignals() {
  const labels = collectElements('label, .label, .field-label, [data-automation-id="questionText"], [data-automation-id="promptText"]');
  let hits = 0;
  labels.forEach(el => {
    const text = cleanLabelText(el.innerText || '');
    if (JOB_TEXT_REGEX.test(text)) hits += 1;
  });
  return hits;
}

function getJobSignalScore() {
  let score = 0;
  const host = location.hostname || '';
  if (JOB_HOST_PATTERNS.some(rx => rx.test(host))) score += 3;
  const title = document.title || '';
  if (JOB_TEXT_REGEX.test(title)) score += 2;
  const sample = getPageTextSample();
  if (JOB_TEXT_REGEX.test(sample)) score += 2;
  const labelHits = countJobLabelSignals();
  if (labelHits >= 2) score += 2;
  if (labelHits >= 4) score += 1;
  if (hasResumeUploadSignal()) score += 2;
  const fieldCount = getVisibleInputCount();
  if (fieldCount >= 6) score += 1;
  return score;
}

function isLikelyLoginForm(jobScore) {
  const passwordInput = collectElements('input[type="password"]').find(el => isVisibleElement(el));
  if (!passwordInput) return false;
  const sample = `${document.title || ''} ${getPageTextSample()}`;
  const loginText = LOGIN_TEXT_REGEX.test(sample);
  const fieldCount = getVisibleInputCount();
  if (loginText && jobScore < 4) return true;
  if (fieldCount <= 3 && jobScore < 4) return true;
  return false;
}

function isJobContextPage() {
  const now = Date.now();
  const host = location.hostname || '';
  const path = location.pathname || '';
  if (/linkedin\.com$/i.test(host)) {
    if (!/\/jobs\//i.test(path)) {
      isJobContextPage.cache = { value: false, ts: now };
      return false;
    }
  }
  const bypassCache = /linkedin\.com$/i.test(host) && /\/jobs\//i.test(path);
  if (!bypassCache && isJobContextPage.cache && (now - isJobContextPage.cache.ts) < 10000) {
    return isJobContextPage.cache.value;
  }
  const jobScore = getJobSignalScore();
  if (isLikelyLoginForm(jobScore)) {
    isJobContextPage.cache = { value: false, ts: now };
    return false;
  }
  if (getSessionFlag('jobContextConfirmed')) {
    isJobContextPage.cache = { value: true, ts: now };
    return true;
  }
  if (jobScore >= 3) {
    setSessionFlag('jobContextConfirmed', true);
    isJobContextPage.cache = { value: true, ts: now };
    return true;
  }
  isJobContextPage.cache = { value: false, ts: now };
  return false;
}

function getMetaContent(...names) {
  for (const name of names) {
    const meta = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
    const content = meta?.getAttribute('content');
    if (content && content.trim()) return content.trim();
  }
  return '';
}

function deriveCompanyFromHost() {
  const host = hostname || location.hostname || '';
  const parts = host.split('.');
  if (parts.length >= 2) return parts[parts.length - 2].replace(/[-_]/g, ' ').trim();
  return host;
}

function deriveTitleFromDocument() {
  const title = document.title || '';
  if (!title) return '';
  const splitters = [' - ', ' | ', ' — ', ' · ', ' at '];
  for (const s of splitters) {
    if (title.includes(s)) return title.split(s)[0].trim();
  }
  return title.trim();
}

function getJobDescriptionText() {
  const container = document.querySelector('main, [role="main"], article, .job-description, #job-description, .posting, .posting-content, .job-details, .description');
  const text = (container?.innerText || document.body?.innerText || '').replace(/\s+/g, ' ').trim();
  return text.substring(0, 8000);
}

function extractJobInfoLocal() {
  const info = {
    companyName: '',
    jobTitle: '',
    location: '',
    jobType: '',
    salaryRange: '',
    jobDescription: '',
  };

  const titleEl = document.querySelector('[data-automation-id="jobTitle"], [data-automation-id="jobTitleText"], [data-qa="job-title"], .posting-headline h2, .app-title, .posting-title, h1');
  if (titleEl?.innerText?.trim()) info.jobTitle = titleEl.innerText.trim();
  if (!info.jobTitle) info.jobTitle = deriveTitleFromDocument();

  const companyEl = document.querySelector('[data-automation-id="companyName"], .company-name, .posting-company, .app-company, [data-qa="company-name"], [data-testid="company-name"]');
  if (companyEl?.innerText?.trim()) info.companyName = companyEl.innerText.trim();
  if (!info.companyName) info.companyName = getMetaContent('og:site_name', 'application-name', 'site_name');
  if (!info.companyName) info.companyName = deriveCompanyFromHost();

  const locationEl = document.querySelector('[data-automation-id="locations"], [data-automation-id="jobLocation"], .location, .job-location, .posting-categories .location, [data-qa="job-location"], [data-testid="job-location"]');
  if (locationEl?.innerText?.trim()) info.location = locationEl.innerText.trim();

  info.jobDescription = getJobDescriptionText();
  return info;
}

async function maybeAutoTrackApplication(stage) {
  if (stage !== 'final') return;
  if (getSessionFlag('appAdded')) return;
  if (!isJobContextPage()) return;

  const localInfo = extractJobInfoLocal();
  let mergedInfo = { ...localInfo };
  const pageText = localInfo.jobDescription || getPageTextSample();

  if (pageText && pageText.length > 200) {
    try {
      const aiResp = await chrome.runtime.sendMessage({ type: 'AI_EXTRACT_JOB', pageContent: pageText });
      if (aiResp?.ok && aiResp.info) {
        if (aiResp.info.isJobPosting !== false) {
          mergedInfo = {
            ...aiResp.info,
            companyName: aiResp.info.companyName || localInfo.companyName,
            jobTitle: aiResp.info.jobTitle || localInfo.jobTitle,
            location: aiResp.info.location || localInfo.location,
            jobDescription: aiResp.info.jobDescription || localInfo.jobDescription,
          };
        }
      }
    } catch (_) { }
  }

  const companyName = (mergedInfo.companyName || '').trim();
  const jobTitle = (mergedInfo.jobTitle || '').trim();
  if (!companyName && !jobTitle) return;

  const application = {
    companyName: companyName || deriveCompanyFromHost(),
    jobTitle: jobTitle || 'Job Application',
    location: mergedInfo.location || '',
    jobType: mergedInfo.jobType || '',
    salaryRange: mergedInfo.salaryRange || '',
    jobDescription: mergedInfo.jobDescription || '',
    url: location.href,
    source: 'auto',
  };

  try {
    const resp = await chrome.runtime.sendMessage({ type: 'APP_ADD', application });
    if (resp?.ok) {
      setSessionFlag('appAdded', true);
    }
  } catch (_) { }
}

const GLOBAL_HEURISTICS = [
  { pId: 'firstName', regex: /first.?name|given.?name|prenom|nombre/i },
  { pId: 'lastName', regex: /last.?name|family.?name|surname/i },
  { pId: 'email', regex: /e?mail|e-mail|mail\s*address/i },
  { pId: 'phone', regex: /phone|mobile|cell|tel|telephone|contact.?number/i },
  { pId: 'linkedin', regex: /linkedin|linked\s*in/i },
  { pId: 'github', regex: /github|git\s*hub/i },
  { pId: 'portfolio', regex: /portfolio|website|personal.?site/i },
  { pId: 'address', regex: /address|street/i },
  { pId: 'city', regex: /city/i },
  { pId: 'state', regex: /state|province/i },
  { pId: 'zipcode', regex: /zip|postal|post\s*code/i },
  { pId: 'currentCompany', regex: /company|employer/i }
];

function getGlobalMatch(fieldKey) {
  if (!fieldKey || !currentGlobalProfile) return null;
  // Strip any array index like [0] from the key for heuristic matching
  const cleanKey = fieldKey.replace(/\[\d+\]$/, '');
  for (const h of GLOBAL_HEURISTICS) {
    if (h.regex.test(cleanKey) && currentGlobalProfile[h.pId]) {
      return currentGlobalProfile[h.pId];
    }
  }
  return null;
}

function getGlobalMatchMeta(fieldKey) {
  if (!fieldKey || !currentGlobalProfile) return null;
  const cleanKey = fieldKey.replace(/\[\d+\]$/, '');
  for (const h of GLOBAL_HEURISTICS) {
    if (h.regex.test(cleanKey) && currentGlobalProfile[h.pId]) {
      const score = Math.max(0.7, scoreStringMatch(cleanKey, h.pId));
      return { value: currentGlobalProfile[h.pId], key: h.pId, score };
    }
  }
  return null;
}

// ── Field key helpers ──────────────────────────────────────────

// Detect auto-generated/unstable IDs (UUIDs, purely numeric, long opaque hashes)
// These change every page load so are useless as storage keys.
function isUnstableId(str) {
  if (FieldUtils && FieldUtils.isUnstableId) return FieldUtils.isUnstableId(str);
  if (!str) return false;
  const s = String(str).trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) // UUID
    || /^\d+$/.test(s)                          // purely numeric
    || /^[a-z0-9]{20,}$/i.test(s);              // long opaque hash (no separators)
}

// Known sensitive field patterns — never save these
const SENSITIVE_RE = /ssn|social.?sec|\bsin\b|tax.?id|\bein\b|passport|bank.?acc|routing|\bcvv\b|credit.?card|debit|secret/i;

function getRootNodeFor(el) {
  try {
    return el?.getRootNode ? el.getRootNode() : document;
  } catch (_) {
    return document;
  }
}

function escapeForSelector(value) {
  if (!value) return '';
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

function queryInRoot(root, selector) {
  if (!root || !root.querySelector) return null;
  try {
    return root.querySelector(selector);
  } catch (_) {
    return null;
  }
}

function getNodeTextById(root, id) {
  if (!id) return '';
  const safeId = escapeForSelector(id);
  let el = document.getElementById?.(id) || null;
  if (!el && root && root !== document) {
    el = queryInRoot(root, `#${safeId}`);
  }
  return el?.innerText?.trim() || '';
}

function getRadioOptionLabel(el) {
  if (!el) return '';
  if (el.id) {
    const label = document.querySelector(`label[for="${escapeForSelector(el.id)}"]`);
    if (label?.innerText?.trim()) return cleanLabelText(label.innerText);
  }
  const parentLabel = el.closest?.('label');
  if (parentLabel?.innerText?.trim()) return cleanLabelText(parentLabel.innerText);
  const nextText = el.nextElementSibling?.innerText?.trim();
  if (nextText) return cleanLabelText(nextText);
  return '';
}

function getAncestorLabelText(el) {
  if (!el || !el.closest) return '';
  const container = el.closest('[data-automation-label],[data-qa-label],[data-field-label],[data-label],[data-title],[data-field],[data-field-id],[data-field-name],[data-automation-id],[data-qa],[data-testid],[data-test],[data-name],.form-field,.field,.input-group,.field-wrapper');
  if (!container) return '';
  const attrLabel = container.getAttribute('data-automation-label')
    || container.getAttribute('data-qa-label')
    || container.getAttribute('data-field-label')
    || container.getAttribute('data-label')
    || container.getAttribute('data-title')
    || container.getAttribute('aria-label');
  if (attrLabel && String(attrLabel).trim()) return cleanLabelText(attrLabel);
  const labelEl = container.querySelector('label, [data-automation-id*="label"], [data-qa*="label"], [data-testid*="label"], [data-test*="label"], .label, .field-label, .input-label');
  if (labelEl?.innerText?.trim()) return cleanLabelText(labelEl.innerText);
  return '';
}

function isGreenhousePage() {
  return /greenhouse\.io/i.test(location.hostname)
    || document.querySelector('.application-form, .application-question')
    || document.querySelector('form[action*="greenhouse"]');
}

function isLeverPage() {
  return /lever\.co/i.test(location.hostname)
    || document.querySelector('.application-form, .application-question');
}

function isICIMSPage() {
  return /icims\.com/i.test(location.hostname)
    || document.querySelector('.iCIMS_Application');
}

function isSmartRecruitersPage() {
  return /smartrecruiters\.com/i.test(location.hostname)
    || document.querySelector('[data-qa="job-title"], [data-qa="apply-button"], .sr-apply');
}

function isWorkablePage() {
  return /workable\.com/i.test(location.hostname)
    || document.querySelector('.application-form, form[action*="workable"]');
}

function isAshbyPage() {
  return /ashbyhq\.com/i.test(location.hostname)
    || document.querySelector('[data-testid="application-form"], [data-testid="form-field"]');
}

function isTaleoPage() {
  return /taleo\.net/i.test(location.hostname)
    || document.querySelector('.taleo, [id*="taleo"]');
}

function isSuccessFactorsPage() {
  return /successfactors\.com/i.test(location.hostname)
    || document.querySelector('[id*="sfApply"], .sfApply');
}

function getWorkdayLabel(el) {
  const field = el.closest?.('[data-automation-id="field"], [data-automation-id^="field"]');
  if (!field) return '';
  const labelEl = field.querySelector('[data-automation-id="questionText"], [data-automation-id="promptText"], [data-automation-id*="label"], label, .label');
  if (labelEl?.innerText?.trim()) return cleanLabelText(labelEl.innerText);
  return '';
}

function getGreenhouseLabel(el) {
  const field = el.closest?.('.application-question, .field, .form-field');
  if (!field) return '';
  const labelEl = field.querySelector('label, .field-label, .application-label, .question-label');
  if (labelEl?.innerText?.trim()) return cleanLabelText(labelEl.innerText);
  return '';
}

function getLeverLabel(el) {
  const field = el.closest?.('.application-question, .field, .form-field');
  if (!field) return '';
  const labelEl = field.querySelector('label, .application-label, .question-label');
  if (labelEl?.innerText?.trim()) return cleanLabelText(labelEl.innerText);
  return '';
}

function getICIMSLabel(el) {
  const field = el.closest?.('.iCIMS_Question, .iCIMS_QuestionItem, .field, .form-field');
  if (!field) return '';
  const labelEl = field.querySelector('.iCIMS_QuestionLabel, label, .field-label');
  if (labelEl?.innerText?.trim()) return cleanLabelText(labelEl.innerText);
  return '';
}

function getSmartRecruitersLabel(el) {
  const field = el.closest?.('[data-qa="form-field"], .form-field, .field, .form-group, .sr-form-field');
  if (!field) return '';
  const labelEl = field.querySelector('label, .form-label, [data-qa*="label"], .sr-field-label');
  if (labelEl?.innerText?.trim()) return cleanLabelText(labelEl.innerText);
  return '';
}

function getWorkableLabel(el) {
  const field = el.closest?.('.field, .form-field, .input-group, .application-field');
  if (!field) return '';
  const labelEl = field.querySelector('label, .field-label, .application-label');
  if (labelEl?.innerText?.trim()) return cleanLabelText(labelEl.innerText);
  return '';
}

function getAshbyLabel(el) {
  const field = el.closest?.('[data-testid="form-field"], .form-field, .field, .input-group');
  if (!field) return '';
  const labelEl = field.querySelector('[data-testid="form-label"], label, .field-label');
  if (labelEl?.innerText?.trim()) return cleanLabelText(labelEl.innerText);
  return '';
}

function getTaleoLabel(el) {
  const field = el.closest?.('tr, .formField, .field, .form-field');
  if (!field) return '';
  const labelEl = field.querySelector('label, .label, .fieldLabel, [id*="label"]');
  if (labelEl?.innerText?.trim()) return cleanLabelText(labelEl.innerText);
  return '';
}

function getSuccessFactorsLabel(el) {
  const field = el.closest?.('.formRow, .form-field, .field, .input-group');
  if (!field) return '';
  const labelEl = field.querySelector('label, .formLabel, .field-label, [data-qa*="label"]');
  if (labelEl?.innerText?.trim()) return cleanLabelText(labelEl.innerText);
  return '';
}

function getSiteLabel(el) {
  if (isWorkdayPage()) {
    const wd = getWorkdayLabel(el);
    if (wd) return wd;
  }
  if (isGreenhousePage()) {
    const gh = getGreenhouseLabel(el);
    if (gh) return gh;
  }
  if (isLeverPage()) {
    const lv = getLeverLabel(el);
    if (lv) return lv;
  }
  if (isICIMSPage()) {
    const ic = getICIMSLabel(el);
    if (ic) return ic;
  }
  if (isSmartRecruitersPage()) {
    const sr = getSmartRecruitersLabel(el);
    if (sr) return sr;
  }
  if (isWorkablePage()) {
    const wk = getWorkableLabel(el);
    if (wk) return wk;
  }
  if (isAshbyPage()) {
    const ah = getAshbyLabel(el);
    if (ah) return ah;
  }
  if (isTaleoPage()) {
    const tl = getTaleoLabel(el);
    if (tl) return tl;
  }
  if (isSuccessFactorsPage()) {
    const sf = getSuccessFactorsLabel(el);
    if (sf) return sf;
  }
  return '';
}

function collectElements(selector) {
  const results = [];
  const seen = new Set();
  const walk = (root) => {
    if (!root || !root.querySelectorAll) return;
    try {
      root.querySelectorAll(selector).forEach(el => {
        if (seen.has(el)) return;
        seen.add(el);
        results.push(el);
      });
    } catch (_) { }
    root.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) walk(el.shadowRoot);
    });
  };
  walk(document);
  return results;
}

function getFieldKey(el) {
  const root = getRootNodeFor(el);
  // 1. aria-labelledby: resolve the label element's text
  const labelledBy = el.getAttribute('aria-labelledby');
  let labelledByText = '';
  if (labelledBy) {
    labelledByText = labelledBy.split(' ')
      .map(id => getNodeTextById(root, id))
      .filter(Boolean).join(' ');
    labelledByText = cleanLabelText(labelledByText);
  }

  // 1b. aria-describedby (some frameworks use it for label-like text)
  const describedBy = el.getAttribute('aria-describedby');
  let describedByText = '';
  if (describedBy) {
    describedByText = describedBy.split(' ')
      .map(id => getNodeTextById(root, id))
      .filter(Boolean).join(' ');
    describedByText = cleanLabelText(describedByText);
  }

  // 2. label[for="ID"]
  let labelForText = '';
  if (el.id) {
    const safeId = escapeForSelector(el.id);
    const label = queryInRoot(root, `label[for="${safeId}"]`) || document.querySelector(`label[for="${safeId}"]`);
    if (label && label.innerText.trim()) labelForText = cleanLabelText(label.innerText.trim());
  }

  // 3. Closest label parent
  let parentLabelText = '';
  const parentLabel = el.closest('label');
  if (parentLabel && parentLabel.innerText.trim()) parentLabelText = cleanLabelText(parentLabel.innerText.trim());

  // 4. Preceding sibling label (common in simple layouts)
  let prevLabelText = '';
  const prev = el.previousElementSibling;
  if (prev && (prev.tagName === 'LABEL' || prev.classList.contains('label'))) {
    if (prev.innerText.trim()) prevLabelText = cleanLabelText(prev.innerText.trim());
  }

  // 5. Ancestor Text Fallback (New)
  // If no direct label found, check the closest container for heading text
  const container = el.closest('.form-group, .field-wrapper, .input-row, [role="group"]');
  let headingText = '';
  if (container) {
    const heading = container.querySelector('h1, h2, h3, h4, .title, .heading');
    if (heading && heading.innerText.trim()) headingText = cleanLabelText(heading.innerText.trim());
  }

  const siteLabel = getSiteLabel(el);
  const ancestorLabelText = getAncestorLabelText(el);
  const dataAutomationLabel = el.getAttribute('data-automation-label')
    || el.getAttribute('data-qa-label')
    || el.getAttribute('data-field-label')
    || '';
  const dataField = el.getAttribute('data-field')
    || el.getAttribute('data-field-id')
    || el.getAttribute('data-field-name')
    || el.getAttribute('data-field-key')
    || '';
  const dataLabel = el.getAttribute('data-label')
    || el.getAttribute('data-title')
    || el.getAttribute('data-placeholder')
    || el.getAttribute('aria-placeholder')
    || '';
  const ancestorAutomationId = el.closest?.('[data-automation-id]')?.getAttribute('data-automation-id') || '';
  const ancestorTestId = el.closest?.('[data-testid],[data-test],[data-qa]')?.getAttribute('data-testid')
    || el.closest?.('[data-testid],[data-test],[data-qa]')?.getAttribute('data-test')
    || el.closest?.('[data-testid],[data-test],[data-qa]')?.getAttribute('data-qa')
    || '';

  // 6. Prefer name > stable id > aria-label > placeholder
  const candidates = {
    labelledByText,
    describedByText,
    labelForText,
    parentLabelText,
    prevLabelText,
    headingText,
    siteLabel,
    dataAutomationLabel,
    ancestorLabelText,
    dataLabel,
    name: el.name,
    dataField,
    ariaLabel: el.getAttribute('aria-label'),
    placeholder: el.placeholder,
    dataAutomationId: el.getAttribute('data-automation-id'),
    dataQa: el.getAttribute('data-qa'),
    dataTest: el.getAttribute('data-test') || el.getAttribute('data-testid'),
    dataName: el.getAttribute('data-name'),
    ancestorAutomationId,
    ancestorTestId,
  };

  if (FieldUtils && FieldUtils.selectFieldKey) {
    return FieldUtils.selectFieldKey(candidates);
  }

  // Fallback: simplified selection
  const fallbackOrder = [
    labelledByText,
    describedByText,
    labelForText,
    parentLabelText,
    prevLabelText,
    headingText,
    siteLabel,
    dataAutomationLabel,
    ancestorLabelText,
    dataLabel,
    el.name,
    dataField,
    el.getAttribute('aria-label'),
    el.placeholder,
    el.getAttribute('data-automation-id'),
    el.getAttribute('data-qa'),
    el.getAttribute('data-test') || el.getAttribute('data-testid'),
    el.getAttribute('data-name'),
    ancestorAutomationId,
    ancestorTestId,
    el.id,
  ];
  for (const c of fallbackOrder) {
    if (!c || !String(c).trim()) continue;
    if (isUnstableId(c)) continue;
    return String(c).trim();
  }
  return null;
}

function getFieldSignature(el) {
  const type = (el.type || '').toLowerCase();
  const role = el.getAttribute('role') || '';
  const label = getFieldKey(el) || '';
  const siteLabel = getSiteLabel(el) || '';
  const name = el.name || '';
  const id = el.id || '';
  const aria = el.getAttribute('aria-label') || '';
  const placeholder = el.placeholder || '';
  const dataField = el.getAttribute('data-field')
    || el.getAttribute('data-field-id')
    || el.getAttribute('data-field-name')
    || el.getAttribute('data-field-key')
    || '';
  const dataLabel = el.getAttribute('data-label')
    || el.getAttribute('data-title')
    || el.getAttribute('data-placeholder')
    || el.getAttribute('aria-placeholder')
    || '';
  const dataAutomationId = el.getAttribute('data-automation-id') || '';
  const dataTest = el.getAttribute('data-test') || el.getAttribute('data-testid') || '';
  const dataQa = el.getAttribute('data-qa') || '';
  const heading = el.closest('fieldset')?.querySelector('legend')?.innerText?.trim() || '';
  const path = getDomPath(el);
  const raw = [
    label, siteLabel, name, id, aria, placeholder, dataField, dataLabel, dataAutomationId, dataTest, dataQa, heading, role, type, path
  ].map(s => (s || '').toString().trim().toLowerCase()).join('|');
  return simpleHash(raw);
}

function getDomPath(el) {
  const parts = [];
  let node = el;
  let depth = 0;
  while (node && node !== document.body && depth < 5) {
    const tag = node.tagName ? node.tagName.toLowerCase() : 'node';
    const role = node.getAttribute?.('role') || '';
    const name = node.getAttribute?.('name') || '';
    const id = node.id || '';
    parts.push([tag, role, name, id].filter(Boolean).join('#'));
    node = node.parentElement;
    depth++;
  }
  return parts.reverse().join('>');
}

function simpleHash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & 0xffffffff;
  }
  return `h${Math.abs(hash)}`;
}

function resolveMappedKey(el) {
  const signature = getFieldSignature(el);
  const mapping = currentSiteMappings.find(m => m.signature === signature);
  if (mapping?.mappedKey) {
    return { key: mapping.mappedKey, signature, mapping };
  }
  // Fallback: best hint-based mapping
  const hints = buildElementHints(el);
  let best = null;
  let second = null;
  for (const m of currentSiteMappings) {
    if (!m?.hints) continue;
    const score = scoreHintMatch(m.hints, hints);
    const entry = { mapping: m, score: score.score, ratio: score.ratio };
    if (!best || entry.score > best.score) {
      second = best;
      best = entry;
    } else if (!second || entry.score > second.score) {
      second = entry;
    }
  }
  if (best && best.score >= 6 && best.ratio >= 0.35 && (!second || best.score >= (second.score + 2))) {
    return { key: best.mapping.mappedKey, signature, mapping: best.mapping, confidence: best.score };
  }
  return { key: null, signature, mapping: null };
}

function getFieldValue(el) {
  const tag = el.tagName?.toUpperCase();
  const type = (el.type || '').toLowerCase();
  if (type === 'radio') return el.checked ? (el.value || 'true') : '';
  if (type === 'checkbox') return el.checked ? 'true' : 'false';
  if (el.isContentEditable || el.getAttribute('role') === 'textbox') {
    return (el.innerText || el.textContent || '').trim();
  }
  if (tag === 'SELECT' && el.multiple) {
    const vals = Array.from(el.selectedOptions).map(o => o.value || o.textContent?.trim()).filter(Boolean);
    return vals.join(',');
  }
  if (tag === 'SELECT') {
    const opt = el.options[el.selectedIndex];
    if (!opt) return '';
    return opt.text?.trim() || opt.value || '';
  }
  const role = el.getAttribute('role');
  const hasPopupListbox = el.getAttribute('aria-haspopup') === 'listbox';
  if (role === 'combobox' || hasPopupListbox) {
    const inputChild = el.tagName === 'INPUT' ? el : el.querySelector('input');
    if (inputChild?.value) return inputChild.value.trim();
    const activeId = el.getAttribute('aria-activedescendant');
    if (activeId) {
      const root = getRootNodeFor(el);
      const activeEl = document.getElementById(activeId) || queryInRoot(root, `#${escapeForSelector(activeId)}`);
      const activeText = activeEl?.innerText?.trim();
      if (activeText) return activeText;
    }
    return el.getAttribute('aria-valuetext')
      || el.getAttribute('aria-valuenow')
      || el.getAttribute('data-value')
      || el.innerText?.trim()
      || '';
  }
  if (role === 'listbox') {
    const selected = el.querySelectorAll('[role="option"][aria-selected="true"]');
    if (selected.length === 0) {
      const activeId = el.getAttribute('aria-activedescendant');
      if (activeId) {
        const root = getRootNodeFor(el);
        const activeEl = document.getElementById(activeId) || queryInRoot(root, `#${escapeForSelector(activeId)}`);
        const activeText = activeEl?.innerText?.trim();
        if (activeText) return activeText;
      }
    }
    const vals = Array.from(selected).map(o => o.getAttribute('data-value') || o.getAttribute('value') || o.innerText?.trim()).filter(Boolean);
    return vals.join(',');
  }
  return (el.value || '').trim();
}

function getStoredValue(el) {
  if (!el) return '';
  const tag = el.tagName?.toUpperCase();
  const role = el.getAttribute?.('role') || '';
  const hasPopupListbox = el.getAttribute?.('aria-haspopup') === 'listbox';
  if (tag === 'SELECT') {
    if (el.multiple) {
      const vals = Array.from(el.selectedOptions).map(o => o.text?.trim() || o.value).filter(Boolean);
      return vals.join(',');
    }
    const opt = el.options?.[el.selectedIndex];
    const text = opt?.text?.trim() || '';
    const value = opt?.value || '';
    return encodeSelectValue(text || value, value);
  }
  if (role === 'listbox') {
    const selectedAll = el.querySelectorAll('[role="option"][aria-selected="true"]');
    if (selectedAll.length > 1) {
      const texts = Array.from(selectedAll).map(opt => opt.innerText?.trim()).filter(Boolean);
      return texts.join(',');
    }
    const selected = selectedAll[0];
    const text = selected?.innerText?.trim() || getFieldValue(el);
    const value = selected?.getAttribute('data-value') || selected?.getAttribute('value') || '';
    return encodeSelectValue(text || value, value || text);
  }
  if (role === 'combobox' || hasPopupListbox) {
    const activeId = el.getAttribute('aria-activedescendant');
    if (activeId) {
      const root = getRootNodeFor(el);
      const activeEl = document.getElementById(activeId) || queryInRoot(root, `#${escapeForSelector(activeId)}`);
      if (activeEl) {
        const text = activeEl.innerText?.trim() || getFieldValue(el);
        const value = activeEl.getAttribute('data-value') || activeEl.getAttribute('value') || '';
        return encodeSelectValue(text || value, value || text);
      }
    }
    const text = getFieldValue(el);
    return encodeSelectValue(text, text);
  }
  return getFieldValue(el);
}

function queueCapture(fields) {
  if (!fields || Object.keys(fields).length === 0) return;
  if (!currentSiteActive) return;
  pendingCapture = { ...pendingCapture, ...fields };
  if (captureTimer) clearTimeout(captureTimer);
  captureTimer = setTimeout(async () => {
    const payload = { ...pendingCapture };
    pendingCapture = {};
    try {
      await chrome.runtime.sendMessage({ type: 'SESSION_MERGE', hostname, fields: payload });
      await chrome.runtime.sendMessage({ type: 'SANDBOX_MERGE', hostname, fields: payload, sessionId: LEARNING_SESSION_ID });
    } catch (err) {
      console.warn('[FormPilot] Capture save failed:', err?.message || err);
    }
  }, 700);
}

// Returns true if a field likely holds sensitive personal data we should never store
function isSensitiveField(el) {
  const key = el.name || el.id || el.getAttribute('aria-label') || el.placeholder || '';
  const label = el.getAttribute('aria-labelledby')
    ? (el.getAttribute('aria-labelledby').split(' ')
      .map(id => document.getElementById(id)?.innerText || '').join(' '))
    : '';
  if (FieldUtils && FieldUtils.isSensitiveKey) {
    return FieldUtils.isSensitiveKey({ key, label });
  }
  return SENSITIVE_RE.test(key) || SENSITIVE_RE.test(label);
}

// ── Detect Workday ATS pages ──────────────────────────────────
function isWorkdayPage() {
  return !!(
    window.workday ||
    document.querySelector('[data-automation-id="applyFlowPage"]') ||
    document.querySelector('[data-automation-id="applyFlowReviewPage"]') ||
    /myworkdayjobs\.com|myworkday\.com/i.test(location.hostname)
  );
}

// ── Workday-specific field capture ───────────────────────────
// Workday uses custom React components instead of standard HTML form
// elements. On Review pages, data is in label+span pairs. On input
// pages, inputs have data-automation-id attributes.
function getWorkdayFields() {
  const fields = {};
  const NO_RESPONSE_CLASS = 'css-1j5bq6h'; // Workday's "No Response" styling

  // Strategy 1: Label → Value span pairs (Review pages)
  // Pattern: <label for="X">Label</label> ... <span id="X" class="css-1ccsoih">Value</span>
  document.querySelectorAll('label[for]').forEach(label => {
    const labelText = label.innerText?.trim();
    if (!labelText) return;
    // Clean label: remove required asterisks and excessive whitespace
    const cleanLabel = labelText.replace(/\*/g, '').trim();
    if (!cleanLabel) return;

    const forId = label.getAttribute('for');
    if (!forId) return;
    const valueEl = document.getElementById(forId);
    if (!valueEl) return;

    // Skip "No Response" values
    if (valueEl.classList.contains(NO_RESPONSE_CLASS)) return;

    const value = valueEl.innerText?.trim();
    if (value && value !== 'No Response') {
      fields[cleanLabel] = value;
    }
  });

  // Strategy 2: Section headings with direct value spans (no label[for])
  // Pattern: <h3>Section</h3> ... <span class="css-1ccsoih">Value</span>
  document.querySelectorAll('[aria-labelledby]').forEach(group => {
    const sectionId = group.getAttribute('aria-labelledby');
    if (!sectionId) return;
    const sectionLabel = document.getElementById(sectionId);
    if (!sectionLabel) return;
    const sectionName = sectionLabel.innerText?.trim();
    if (!sectionName) return;

    // Look for direct value spans that don't have a <label for> pointing at them
    group.querySelectorAll('span[id]').forEach(span => {
      // Already captured by Strategy 1? Skip if there's a label[for] pointing here
      if (document.querySelector(`label[for="${span.id}"]`)) return;
      if (span.classList.contains(NO_RESPONSE_CLASS)) return;
      const value = span.innerText?.trim();
      if (value && value !== 'No Response') {
        fields[sectionName] = value;
      }
    });
  });

  // Strategy 3: Rich-text questionnaire answers (Application Questions)
  // Pattern: <div id="rich-labelXXX">Question HTML</div> followed by value span
  document.querySelectorAll('[id^="rich-label"]').forEach(richLabel => {
    // Extract question text from the rich text container
    const questionText = richLabel.innerText?.trim()
      ?.replace(/\*/g, '')?.trim();
    if (!questionText) return;
    // Truncate very long questions to a reasonable key
    const key = questionText.length > 100
      ? questionText.substring(0, 100).trim()
      : questionText;

    // The answer span is typically in a sibling div.css-233int > span
    const parent = richLabel.closest('.css-7t35fz') || richLabel.parentElement;
    if (!parent) return;
    const answerSpan = parent.querySelector('span[id]:not([id^="rich-label"])');
    if (!answerSpan) return;
    if (answerSpan.classList.contains(NO_RESPONSE_CLASS)) return;
    const value = answerSpan.innerText?.trim();
    if (value && value !== 'No Response') {
      fields[key] = value;
    }
  });

  // Strategy 4: Workday input fields on non-review pages (actual form inputs)
  // These have data-automation-id attributes on inputs
  document.querySelectorAll('input[data-automation-id], textarea[data-automation-id], select[data-automation-id]').forEach(el => {
    const autoId = el.getAttribute('data-automation-id');
    if (!autoId) return;
    const type = (el.type || '').toLowerCase();
    if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'password' || type === 'file') return;
    if (isSensitiveField(el)) return;

    // Use label or automation-id as key
    let key = getFieldKey(el);
    if (!key || isUnstableId(key)) key = autoId;
    if (!key) return;

    if (type === 'checkbox') {
      fields[key] = el.checked ? 'true' : 'false';
    } else {
      const value = el.value?.trim();
      if (value) fields[key] = value;
    }
  });

  // Strategy 5: data-fkit-id containers (Workday FormKit fields)
  // These wrap Workday's custom form fields
  document.querySelectorAll('[data-fkit-id]').forEach(container => {
    // Find all label+value pairs inside this container
    container.querySelectorAll('label').forEach(label => {
      const labelText = label.innerText?.trim()?.replace(/\*/g, '')?.trim();
      if (!labelText) return;
      const forAttr = label.getAttribute('for');
      if (forAttr) {
        const valueEl = document.getElementById(forAttr);
        if (valueEl && !valueEl.classList.contains(NO_RESPONSE_CLASS)) {
          const value = valueEl.innerText?.trim();
          if (value && value !== 'No Response' && !fields[labelText]) {
            fields[labelText] = value;
          }
        }
      }
    });
  });

  // Strategy 6: File attachment info
  document.querySelectorAll('[data-automation-id="file-upload-item-name"]').forEach(el => {
    const filename = el.innerText?.trim();
    if (filename) {
      fields['Resume/CV Filename'] = filename;
    }
  });

  console.log(`[FormPilot] Workday fields captured:`, fields);
  return fields;
}

// ── General ATS display-field scraper ─────────────────────────
// For sites that render form data as label+value pairs in read-only
// display mode (common in many ATS review/confirmation pages)
function getDisplayFields() {
  const fields = {};

  // Pattern: <label>Text</label> followed by a sibling <span>/<div> with the value
  document.querySelectorAll('label').forEach(label => {
    const labelText = cleanLabelText(label.innerText?.trim());
    if (!labelText || labelText.length > 120) return;

    const forAttr = label.getAttribute('for');
    if (forAttr) {
      const target = document.getElementById(forAttr);
      if (!target) return;
      // If target is an input/select/textarea, skip (handled by standard capture)
      const tag = target.tagName.toUpperCase();
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      // It's a display element (span, div, etc.)
      const value = target.innerText?.trim();
      if (value && value !== 'No Response' && value.length < 2000) {
        fields[labelText] = value;
      }
    }
  });

  return fields;
}

function getFormFields() {
  const fields = {};

  // ── Workday-specific capture ──
  if (isWorkdayPage()) {
    const wdFields = getWorkdayFields();
    Object.assign(fields, wdFields);
    // If we got good Workday data, return early — no need for generic scraping
    if (Object.keys(wdFields).length > 3) {
      console.log(`[FormPilot] Workday capture found ${Object.keys(wdFields).length} fields, skipping generic scan.`);
      return fields;
    }
  }

  // Exclude: hidden, submit, button, reset, file, PASSWORD (security!), single-char OTPs
  const selectors = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=file]):not([type=password]), textarea, select, [contenteditable="true"], [role="textbox"]';

  // ── Index-aware capture: duplicate keys get suffixed [0], [1], etc. ──
  const elements = [];
  collectElements(selectors).forEach(el => {
    const type = (el.type || '').toLowerCase();
    if (type === 'radio') return;
    // Skip OTP-style single-character inputs
    if (type === 'text' && el.maxLength === 1) return;
    // Skip sensitive fields (SSN, bank, passport, etc.)
    if (isSensitiveField(el)) return;
    const mapped = resolveMappedKey(el);
    const key = mapped.key || getFieldKey(el);
    if (!key) return;
    elements.push({ el, key, type });
  });
  const keyCounts = {};
  elements.forEach(({ key }) => { keyCounts[key] = (keyCounts[key] || 0) + 1; });
  const keyIndex = {};
  elements.forEach(({ el, key, type }) => {
    keyIndex[key] = (keyIndex[key] || 0);
    const fieldKey = keyCounts[key] > 1 ? `${key}[${keyIndex[key]++}]` : key;

    const value = getStoredValue(el);
    if (value && value !== el.placeholder) {
      // Skip placeholder-like values
      if (el.tagName === 'SELECT') {
        const decoded = decodeSelectValue(value);
        const raw = decoded.text || decoded.value || '';
        if (/^[-\s]*(select|choose|pick)/i.test(raw)) return;
      }
      fields[fieldKey] = value;
    }
  });

  // ── Radio groups ────────────────────────────────────────────
  collectElements('input[type=radio]:checked').forEach(el => {
    const mapped = resolveMappedKey(el);
    const key = mapped.key || getFieldKey(el) || el.name;
    if (!key) return;
    const rawVal = el.value || '';
    const label = getRadioOptionLabel(el);
    if (!rawVal || rawVal === 'on' || rawVal === 'true' || rawVal === '1') {
      fields[key] = label || 'true';
    } else {
      fields[key] = rawVal;
    }
  });

  // ── Custom ARIA comboboxes (index-aware) ──
  const comboEls = [];
  collectElements('[role="combobox"], [aria-haspopup="listbox"]').forEach(el => {
    if (el.tagName === 'INPUT') return;
    const mapped = resolveMappedKey(el);
    const key = mapped.key || getFieldKey(el);
    if (!key) return;
    comboEls.push({ el, key });
  });
  const comboCounts = {};
  comboEls.forEach(({ key }) => { comboCounts[key] = (comboCounts[key] || 0) + 1; });
  const comboIndex = {};
  comboEls.forEach(({ el, key }) => {
    comboIndex[key] = (comboIndex[key] || 0);
    const fieldKey = comboCounts[key] > 1 ? `${key}[${comboIndex[key]++}]` : key;
    const value = getStoredValue(el);
    if (value) fields[fieldKey] = value;
  });

  // ── ARIA listboxes ──
  collectElements('[role="listbox"]').forEach(listbox => {
    const mapped = resolveMappedKey(listbox);
    const key = mapped.key || getFieldKey(listbox);
    const selected = listbox.querySelectorAll('[role="option"][aria-selected="true"]');
    if (!key) return;
    if (selected.length > 0) {
      const values = Array.from(selected).map(o =>
        o.getAttribute('data-value') || o.getAttribute('value') || o.innerText?.trim()
      ).filter(Boolean);
      if (values.length) fields[key] = values.join(',');
    } else {
      const value = getStoredValue(listbox);
      if (value) fields[key] = value;
    }
  });

  // ── General display-field capture (for review/confirmation pages) ──
  if (Object.keys(fields).length < 3) {
    const displayFields = getDisplayFields();
    Object.assign(fields, displayFields);
  }

  return fields;
}

function triggerEvents(el) {
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function setNativeValue(el, val) {
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype
    : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, val);
  else el.value = val;
}

function setEditableValue(el, val) {
  if (!el) return false;
  if (el.isContentEditable || el.getAttribute('role') === 'textbox') {
    el.innerText = val;
    triggerEvents(el);
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  }
  return false;
}

function fillFields(savedFields, opts = {}) {
  const skipObserver = !!opts.skipObserver;
  const stats = { detected: 0, matched: 0, filled: 0 };
  const unresolvedDropdowns = [];
  if (!skipObserver) {
    approvalQueue = [];
    showConfidenceOverlay(savedFields || {});
  }
  // Exclude: hidden, submit, button, reset, file, PASSWORD (security!), single-char OTPs
  const selectors = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=file]):not([type=password]), textarea, select, [contenteditable="true"], [role="textbox"]';

  // Radio buttons
  collectElements('input[type=radio]').forEach(el => {
    stats.detected += 1;
    const mapped = resolveMappedKey(el);
    const key = mapped.key || getFieldKey(el) || el.name;
    if (!key || !(key in savedFields)) return;
    stats.matched += 1;
    const decoded = decodeSelectValue(savedFields[key]);
    const saved = String(decoded.text || savedFields[key]).toLowerCase().trim();
    const optionVal = String(el.value || '').toLowerCase().trim();
    const optionLabel = String(getRadioOptionLabel(el) || '').toLowerCase().trim();
    if ((optionVal && saved === optionVal) || (optionLabel && saved === optionLabel)) {
      el.checked = true;
      triggerEvents(el);
      stats.filled += 1;
    }
  });

  // Build same index-aware key map as in getFormFields so positions match
  const elements = [];
  collectElements(selectors).forEach(el => {
    const type = (el.type || '').toLowerCase();
    if (type === 'radio') return;
    const mapped = resolveMappedKey(el);
    const key = mapped.key || getFieldKey(el);
    if (!key) return;
    elements.push({ el, key, type });
  });
  const keyCounts = {};
  elements.forEach(({ key }) => { keyCounts[key] = (keyCounts[key] || 0) + 1; });
  const keyIndex = {};
  elements.forEach(({ el, key, type }) => {
    stats.detected += 1;
    const isDuplicate = keyCounts[key] > 1;
    keyIndex[key] = (keyIndex[key] || 0);
    const fieldKey = isDuplicate ? `${key}[${keyIndex[key]++}]` : key;
    let val = savedFields[fieldKey];
    let source = 'site';
    let globalMeta = null;
    if (val === undefined) {
      globalMeta = getGlobalMatchMeta(fieldKey);
      val = globalMeta?.value;
      source = 'global';
    }
    if (val === undefined || val === null) return;
    stats.matched += 1;
    const decoded = decodeSelectValue(val);
    const primaryVal = decoded.text || val;
    const altVal = decoded.value || primaryVal;
    const confidence = classifyConfidence({ mapped, source, globalMeta });
    if (!shouldFillValue(el, fieldKey, primaryVal)) return;

    if (!shouldAutofillConfidence(confidence)) {
      if (confidence === 'mid') {
        queueApproval({ el, fieldKey, val: primaryVal, altVal });
      }
      return;
    }

    const filled = applyValueToElement(el, fieldKey, primaryVal, altVal);
    if (filled) {
      stats.filled += 1;
    } else if (el.tagName === 'SELECT') {
      unresolvedDropdowns.push({ el, key: fieldKey, desired: primaryVal, type: 'select' });
    }
  });

  // ── Custom ARIA comboboxes (index-aware) ───────────────────────
  try {
    const comboboxEls = [];
    collectElements('[role="combobox"], [aria-haspopup="listbox"]').forEach(el => {
      if (el.tagName === 'INPUT') return;
      const mapped = resolveMappedKey(el);
      const key = mapped.key || getFieldKey(el);
      if (!key) return;
      comboboxEls.push({ el, key });
    });
    const comboKeyCounts = {};
    comboboxEls.forEach(({ key }) => { comboKeyCounts[key] = (comboKeyCounts[key] || 0) + 1; });
    const comboKeyIndex = {};
    comboboxEls.forEach(({ el, key }) => {
      stats.detected += 1;
      const isDuplicate = comboKeyCounts[key] > 1;
      comboKeyIndex[key] = (comboKeyIndex[key] || 0);
      const fieldKey = isDuplicate ? `${key}[${comboKeyIndex[key]++}]` : key;
      let val = savedFields[fieldKey];
      let source = 'site';
      let globalMeta = null;
      if (val === undefined) {
        globalMeta = getGlobalMatchMeta(fieldKey);
        val = globalMeta?.value;
        source = 'global';
      }
      if (val === undefined || val === null) return;
      stats.matched += 1;
      const decoded = decodeSelectValue(val);
      const primaryVal = decoded.text || val;
      const altVal = decoded.value || primaryVal;
      const confidence = classifyConfidence({ mapped: resolveMappedKey(el), source, globalMeta });
      if (!shouldFillValue(el, fieldKey, primaryVal)) return;
      if (!shouldAutofillConfidence(confidence)) {
        if (confidence === 'mid') {
          queueApproval({ el, fieldKey, val: primaryVal, altVal });
        }
        return;
      }

      const inputChild = el.tagName === 'INPUT' ? el : el.querySelector('input');
      if (inputChild) {
        setNativeValue(inputChild, primaryVal);
        triggerEvents(inputChild);
        if (inputChild.value || !primaryVal) {
          stats.filled += 1;
          return;
        }
      }
      el.click();
      setTimeout(() => {
        const root = getRootNodeFor(el);
        const optionSets = [root, document].filter((r, idx, arr) => r && arr.indexOf(r) === idx);
        for (const r of optionSets) {
          const picked = selectBestOption([primaryVal, altVal], r);
          if (picked) {
            stats.filled += 1;
            return;
          }
        }
        unresolvedDropdowns.push({ el, key: fieldKey, desired: primaryVal, type: 'combobox' });
      }, 150);
    });
  } catch (err) {
    console.warn('[FormPilot] Combobox fill error:', err?.message || err);
  }

  // ── Custom ARIA listboxes (already expanded) ───────────────────
  collectElements('[role="listbox"]').forEach(listbox => {
    stats.detected += 1;
    const mapped = resolveMappedKey(listbox);
    const key = mapped.key || getFieldKey(listbox);
    if (!key) return;
    let val = savedFields[key];
    let source = 'site';
    let globalMeta = null;
    if (val === undefined) {
      globalMeta = getGlobalMatchMeta(key);
      val = globalMeta?.value;
      source = 'global';
    }
    if (val === undefined || val === null) return;
    stats.matched += 1;
    const decoded = decodeSelectValue(val);
    const raw = decoded.text || val;
    const alt = decoded.value || raw;
    const confidence = classifyConfidence({ mapped, source, globalMeta });
    if (!shouldAutofillConfidence(confidence)) {
      if (confidence === 'mid') {
        queueApproval({ el: listbox, fieldKey: key, val: raw, altVal: alt });
      }
      return;
    }
    const vals = String(raw).split(',').map(v => v.toLowerCase().trim()).filter(Boolean);
    const altVals = String(alt).split(',').map(v => v.toLowerCase().trim()).filter(Boolean);
    let matched = false;
    listbox.querySelectorAll('[role="option"]').forEach(opt => {
      const optValRaw = opt.getAttribute('data-value') || opt.getAttribute('value') || opt.innerText?.trim() || '';
      const optVal = optValRaw.toLowerCase().trim();
      if ((vals.includes(optVal) || altVals.includes(optVal)) && opt.getAttribute('aria-selected') !== 'true') {
        opt.click();
        stats.filled += 1;
        matched = true;
      }
    });
    if (!matched) {
      unresolvedDropdowns.push({ el: listbox, key, desired: raw, type: 'listbox' });
    }
  });

  // ── MutationObserver: fill fields added dynamically (conditional logic, "+ Add job") ──
  // Disconnect any previous observer so we don't stack them
  if (!skipObserver) {
    if (window._jaObserver) window._jaObserver.disconnect();
    let observerTimer;
    window._jaObserver = new MutationObserver(() => {
      clearTimeout(observerTimer);
      // Debounce: wait for DOM to settle before re-filling
      observerTimer = setTimeout(() => {
        fillFields(savedFields, { skipObserver: true });
      }, 300);
    });
    window._jaObserver.observe(document.body, { childList: true, subtree: true, attributes: false });

    // Stop observing after 30s (form is likely done changing by then)
    setTimeout(() => window._jaObserver?.disconnect(), 30000);
  }

  if (!skipObserver) {
    showCoverageBanner(stats);
    reportSiteMetrics(stats);
    if (unresolvedDropdowns.length > 0) {
      showDropdownResolver(unresolvedDropdowns);
    }
    if (approvalQueue.length > 0) {
      showApprovalBanner();
    }
  }
}

function reportSiteMetrics(stats) {
  if (!stats) return;
  if (getSiteFlag('neverPrompt')) return;
  if (!isJobContextPage()) return;
  const detected = Number(stats.detected || 0);
  if (detected < 3) return;
  chrome.runtime.sendMessage({ type: 'SITE_METRICS_UPDATE', hostname, stats }).catch(() => { });
}

function attachLiveCapture() {
  if (window._jaLiveCaptureAttached) return;
  window._jaLiveCaptureAttached = true;
  const handler = (e) => {
    if (getSiteFlag('neverPrompt')) return;
    if (!isJobContextPage()) return;
    let el = e.target;
    if (!el) return;

    // If clicking an option inside a custom dropdown, capture on the parent listbox/combobox
    if (el.getAttribute && el.getAttribute('role') === 'option') {
      const listbox = el.closest?.('[role="listbox"]');
      const combo = el.closest?.('[role="combobox"]');
      el = combo || listbox || el;
    }

    const tag = (el.tagName || '').toUpperCase();
    const role = el.getAttribute?.('role');
    const hasPopupListbox = el.getAttribute?.('aria-haspopup') === 'listbox';
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' && role !== 'combobox' && role !== 'listbox' && role !== 'textbox' && !hasPopupListbox && !el.isContentEditable) return;
    const type = (el.type || '').toLowerCase();
    if (type === 'password' || type === 'file' || type === 'hidden') return;
    if (type === 'radio' && !el.checked) return;
    if (isSensitiveField(el)) return;
    const mapped = resolveMappedKey(el);
    const key = mapped.key || getFieldKey(el);
    if (!key) return;
    const value = getStoredValue(el);
    if (!value) return;
    if (!shouldFillValue(el, key, value)) return;
    if (el.tagName === 'SELECT') {
      const decoded = decodeSelectValue(value);
      const raw = decoded.text || decoded.value || '';
      if (/^[-\s]*(select|choose|pick)/i.test(raw)) return;
    }
    queueCapture({ [key]: value });
  };
  document.addEventListener('input', handler, true);
  document.addEventListener('change', handler, true);
  document.addEventListener('blur', handler, true);
  document.addEventListener('click', handler, true);
}

// ── Resume Attach (Local Resume Vault) ─────────────────────────
function isVisibleElement(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function findFileInputFromTarget(target) {
  if (!target) return null;
  if (target.tagName === 'INPUT' && target.type === 'file') return target;
  const label = target.closest?.('label');
  if (label) {
    const forId = label.getAttribute('for');
    if (forId) {
      const byFor = document.getElementById(forId);
      if (byFor && byFor.type === 'file') return byFor;
    }
    const inputInside = label.querySelector('input[type="file"]');
    if (inputInside) return inputInside;
  }
  const container = target.closest?.('[data-automation-id*="upload"],[data-automation-id*="file"],.file-upload,.upload,.resume-upload,[role="button"],.button');
  if (container) {
    const input = container.querySelector?.('input[type="file"]') || container.parentElement?.querySelector?.('input[type="file"]');
    if (input) return input;
  }
  const fieldWrap = target.closest?.('form,.form-field,.field,.input-group,.field-wrapper,[role="group"]');
  if (fieldWrap) {
    const input = fieldWrap.querySelector?.('input[type="file"]');
    if (input) return input;
  }
  return null;
}

function getFirstFileInput() {
  const inputs = collectElements('input[type="file"]');
  if (!inputs.length) return null;
  return inputs.find(el => !el.disabled) || inputs[0];
}

function findAnchorForInput(input) {
  if (!input) return null;
  if (isVisibleElement(input)) return input;
  if (input.id) {
    const label = document.querySelector(`label[for="${escapeForSelector(input.id)}"]`);
    if (isVisibleElement(label)) return label;
  }
  const container = input.closest?.('.file-upload,.upload,.resume-upload,.field,.form-field,.input-group,.field-wrapper,[data-automation-id*="upload"],[data-automation-id*="file"]');
  if (isVisibleElement(container)) return container;
  return null;
}

function ensureResumeAttachUI() {
  if (document.getElementById('ja-resume-attach')) return;
  const wrap = document.createElement('div');
  wrap.id = 'ja-resume-attach';
  wrap.style.display = 'none';
  wrap.innerHTML = `
    <style>
      #ja-resume-attach {
        position: fixed; z-index: 2147483646; font-family: 'Avenir Next', 'Helvetica Neue', 'Segoe UI', sans-serif;
      }
      #ja-resume-attach .ja-resume-btn {
        background: #0f172a; color: #e2e8f0; border: 1px solid rgba(148,163,184,0.3);
        border-radius: 10px; padding: 8px 12px; font-size: 12px; font-weight: 600;
        cursor: pointer; box-shadow: 0 8px 24px rgba(0,0,0,0.35);
        display: inline-flex; align-items: center; gap: 6px;
      }
      #ja-resume-attach .ja-resume-btn:hover { border-color: rgba(99,102,241,0.6); }
      #ja-resume-attach .ja-resume-menu {
        position: absolute; top: 38px; right: 0; min-width: 240px;
        background: #0b1220; border: 1px solid rgba(99,102,241,0.35);
        border-radius: 12px; padding: 8px; display: none;
        box-shadow: 0 12px 30px rgba(0,0,0,0.5);
      }
      #ja-resume-attach.open .ja-resume-menu { display: block; }
      #ja-resume-attach .ja-resume-item {
        display: flex; flex-direction: column; gap: 2px; padding: 8px;
        border-radius: 8px; cursor: pointer; color: #e2e8f0;
      }
      #ja-resume-attach .ja-resume-item:hover { background: rgba(148,163,184,0.12); }
      #ja-resume-attach .ja-resume-name { font-size: 12px; font-weight: 600; }
      #ja-resume-attach .ja-resume-meta { font-size: 11px; color: #94a3b8; }
      #ja-resume-attach .ja-resume-pill {
        display: inline-block; font-size: 10px; padding: 2px 6px; border-radius: 999px;
        background: rgba(59,130,246,0.18); color: #93c5fd; margin-left: 6px;
      }
      #ja-resume-attach .ja-resume-empty { font-size: 12px; color: #94a3b8; padding: 8px; }
    </style>
    <div class="ja-resume-btn">📎 Attach Resume</div>
    <div class="ja-resume-menu"></div>
  `;
  document.body.appendChild(wrap);

  wrap.querySelector('.ja-resume-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!resumeMenuOpen) {
      await openResumeMenu();
    } else {
      closeResumeMenu();
    }
  });

  document.addEventListener('click', (e) => {
    if (!resumeMenuOpen) return;
    const root = document.getElementById('ja-resume-attach');
    if (root && !root.contains(e.target)) closeResumeMenu();
  }, true);
}

function positionResumeAttach(anchor) {
  const wrap = document.getElementById('ja-resume-attach');
  if (!wrap) return;
  wrap.style.display = 'block';
  wrap.style.bottom = '';
  wrap.style.right = '';
  if (anchor && isVisibleElement(anchor)) {
    const rect = anchor.getBoundingClientRect();
    const top = Math.max(rect.top - 8, 8);
    const left = Math.max(rect.right - 170, 8);
    wrap.style.top = `${top}px`;
    wrap.style.left = `${left}px`;
  } else {
    wrap.style.top = '';
    wrap.style.left = '';
    wrap.style.bottom = '18px';
    wrap.style.right = '18px';
  }
}

async function fetchResumeList(force = false) {
  if (!force && (Date.now() - resumeCache.ts) < 4000 && resumeCache.items.length) return resumeCache;
  const resp = await chrome.runtime.sendMessage({ type: 'RESUME_LIST' }).catch(() => null);
  if (resp?.ok) {
    resumeCache = { items: resp.items || [], defaultId: resp.defaultId || null, ts: Date.now() };
  }
  return resumeCache;
}

function dataUrlToFile(dataUrl, filename, mimeHint) {
  if (!dataUrl) return null;
  let mime = mimeHint || 'application/octet-stream';
  let data = '';
  let isBase64 = false;
  if (dataUrl.startsWith('data:')) {
    const comma = dataUrl.indexOf(',');
    const header = dataUrl.substring(5, comma);
    data = dataUrl.substring(comma + 1);
    const headerParts = header.split(';');
    if (headerParts[0]) mime = headerParts[0];
    if (headerParts.includes('base64')) isBase64 = true;
  } else {
    return null;
  }
  let bytes;
  if (isBase64) {
    bytes = atob(data);
  } else {
    bytes = decodeURIComponent(data);
  }
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new File([arr], filename || 'resume', { type: mime });
}

function getOptionText(opt) {
  if (!opt) return '';
  return cleanLabelText(opt.getAttribute?.('data-label') || opt.innerText || opt.textContent || '');
}

function getOptionValue(opt) {
  if (!opt) return '';
  return (opt.getAttribute?.('data-value') || opt.getAttribute?.('value') || opt.getAttribute?.('data-id') || '').toString();
}

function findVisibleOptions() {
  const selectors = [
    '[role="option"]',
    '.select__option',
    '.dropdown-item',
    '.option',
    'li[role="option"]',
  ].join(',');
  const options = Array.from(document.querySelectorAll(selectors));
  return options.filter(isVisibleElement);
}

function selectBestOption(targets, container) {
  const options = container ? Array.from(container.querySelectorAll('[role="option"]')) : findVisibleOptions();
  if (!options.length) return false;
  let best = { el: null, score: 0 };
  for (const opt of options) {
    const text = getOptionText(opt);
    const value = getOptionValue(opt);
    let score = 0;
    targets.forEach(t => {
      score = Math.max(score, scoreStringMatch(text, t) * 3);
      score = Math.max(score, scoreStringMatch(value, t) * 2);
    });
    if (score > best.score) best = { el: opt, score };
  }
  if (best.el && best.score >= 1.2) {
    best.el.click();
    return true;
  }
  return false;
}

function showResumeToast(message, isError = false) {
  const existing = document.getElementById('ja-resume-toast');
  if (existing) existing.remove();
  const t = document.createElement('div');
  t.id = 'ja-resume-toast';
  t.textContent = message;
  t.style.cssText = `
    position: fixed; bottom: 64px; right: 18px; z-index: 2147483647;
    background: ${isError ? '#7f1d1d' : '#111827'}; color: #e2e8f0; padding: 8px 12px; border-radius: 10px;
    border: 1px solid ${isError ? 'rgba(248,113,113,0.5)' : 'rgba(99,102,241,0.4)'}; font-size: 12px;
  `;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2000);
}

async function attachResumeToInput(resumeId, inputEl) {
  const target = inputEl || lastFileInput || getFirstFileInput();
  if (!target) throw new Error('No file input found');
  if (target.disabled) throw new Error('File input is disabled');
  const resp = await chrome.runtime.sendMessage({ type: 'RESUME_GET', id: resumeId }).catch(() => null);
  if (!resp?.ok || !resp.resume?.dataUrl) throw new Error(resp?.error || 'Resume not found');
  const resume = resp.resume;
  const file = dataUrlToFile(resume.dataUrl, resume.name || 'resume.pdf', resume.mime);
  if (!file) throw new Error('Unsupported resume data');
  const dt = new DataTransfer();
  dt.items.add(file);
  target.files = dt.files;
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.dispatchEvent(new Event('change', { bubbles: true }));
  showResumeToast('Resume attached');
}

async function openResumeMenu() {
  ensureResumeAttachUI();
  const wrap = document.getElementById('ja-resume-attach');
  const menu = wrap.querySelector('.ja-resume-menu');
  const { items, defaultId } = await fetchResumeList(true);
  if (!items || items.length === 0) {
    menu.innerHTML = `<div class="ja-resume-empty">No resumes saved. Add one in the extension dashboard.</div>`;
  } else {
    menu.innerHTML = items.map(item => {
      const def = item.id === defaultId ? '<span class="ja-resume-pill">Default</span>' : '';
      const label = item.label ? ` · ${item.label}` : '';
      return `
        <div class="ja-resume-item" data-resume-id="${item.id}">
          <div class="ja-resume-name">${item.name || 'Resume'} ${def}</div>
          <div class="ja-resume-meta">${(item.mime || 'file').toLowerCase()}${label}</div>
        </div>
      `;
    }).join('');
    menu.querySelectorAll('.ja-resume-item').forEach(el => {
      el.addEventListener('click', async () => {
        const id = el.getAttribute('data-resume-id');
        closeResumeMenu();
        try {
          await attachResumeToInput(id, lastFileInput);
        } catch (err) {
          showResumeToast(err.message || 'Attach failed', true);
        }
      });
    });
  }
  wrap.classList.add('open');
  resumeMenuOpen = true;
}

function closeResumeMenu() {
  const wrap = document.getElementById('ja-resume-attach');
  if (wrap) wrap.classList.remove('open');
  resumeMenuOpen = false;
}

function hideResumeAttach() {
  const wrap = document.getElementById('ja-resume-attach');
  if (!wrap) return;
  wrap.style.display = 'none';
  closeResumeMenu();
}

function initResumeAttach() {
  if (window._jaResumeAttachInit) return;
  window._jaResumeAttachInit = true;

  ensureResumeAttachUI();

  document.addEventListener('focusin', (e) => {
    const input = findFileInputFromTarget(e.target);
    if (!input) return;
    lastFileInput = input;
    positionResumeAttach(findAnchorForInput(input));
  }, true);

  document.addEventListener('click', (e) => {
    const input = findFileInputFromTarget(e.target);
    if (!input) return;
    lastFileInput = input;
    positionResumeAttach(findAnchorForInput(input));
  }, true);

  const obs = new MutationObserver(() => {
    const first = getFirstFileInput();
    if (!first && lastFileInput) {
      lastFileInput = null;
      hideResumeAttach();
    }
    if (!lastFileInput && first) {
      lastFileInput = first;
      positionResumeAttach(findAnchorForInput(first));
    }
  });
  obs.observe(document.documentElement || document.body, { childList: true, subtree: true });

  const initial = getFirstFileInput();
  if (initial) {
    lastFileInput = initial;
    positionResumeAttach(findAnchorForInput(initial));
  } else {
    hideResumeAttach();
  }
}

function isTeachTarget(el) {
  if (!el) return false;
  const tag = (el.tagName || '').toUpperCase();
  const role = el.getAttribute?.('role');
  if (tag === 'INPUT') {
    const type = (el.type || '').toLowerCase();
    if (type === 'password' || type === 'file' || type === 'hidden' || type === 'submit' || type === 'button' || type === 'reset') return false;
    return true;
  }
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (role === 'combobox' || role === 'listbox' || role === 'textbox') return true;
  if (el.getAttribute && el.getAttribute('aria-haspopup') === 'listbox') return true;
  if (el.isContentEditable) return true;
  return false;
}

function attachTeachHover() {
  if (teachHoverAttached) return;
  teachHoverAttached = true;
  const onHover = (e) => {
    if (!teachMode) return;
    const el = e.target;
    if (!isTeachTarget(el) || isSensitiveField(el)) {
      hideTeachHover();
      return;
    }
    showTeachHover(el);
  };
  const onLeave = (e) => {
    if (!teachMode) return;
    if (!e.relatedTarget || !isTeachTarget(e.relatedTarget)) hideTeachHover();
  };
  document.addEventListener('mouseover', onHover, true);
  document.addEventListener('mouseout', onLeave, true);
  teachHoverBox = { onHover, onLeave };
}

function detachTeachHover() {
  if (!teachHoverAttached) return;
  teachHoverAttached = false;
  if (teachHoverBox?.onHover) document.removeEventListener('mouseover', teachHoverBox.onHover, true);
  if (teachHoverBox?.onLeave) document.removeEventListener('mouseout', teachHoverBox.onLeave, true);
  teachHoverBox = null;
  hideTeachHover();
}

function showTeachHover(el) {
  if (!el) return;
  let hover = document.getElementById('ja-teach-hover');
  if (!hover) {
    hover = document.createElement('div');
    hover.id = 'ja-teach-hover';
    hover.style.cssText = `
      position: fixed; z-index: 2147483646; pointer-events: none;
      border: 2px solid rgba(99,102,241,0.9); border-radius: 8px;
      box-shadow: 0 0 0 2px rgba(99,102,241,0.2);
      background: rgba(99,102,241,0.06);
    `;
    document.body.appendChild(hover);
  }
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  hover.style.top = `${Math.max(rect.top - 2, 0)}px`;
  hover.style.left = `${Math.max(rect.left - 2, 0)}px`;
  hover.style.width = `${Math.max(rect.width + 4, 8)}px`;
  hover.style.height = `${Math.max(rect.height + 4, 8)}px`;
  hover.style.display = 'block';
}

function hideTeachHover() {
  const hover = document.getElementById('ja-teach-hover');
  if (hover) hover.style.display = 'none';
}

function startTeachMode() {
  if (teachMode) return;
  teachMode = true;
  showTeachBanner();
  attachTeachHover();
  if (!teachHandlerAttached) {
    document.addEventListener('click', handleTeachClick, true);
    document.addEventListener('keydown', handleTeachKeydown, true);
    teachHandlerAttached = true;
  }
}

function stopTeachMode() {
  teachMode = false;
  removeTeachBanner();
  removeTeachOverlay();
  detachTeachHover();
  if (teachHandlerAttached) {
    document.removeEventListener('click', handleTeachClick, true);
    document.removeEventListener('keydown', handleTeachKeydown, true);
    teachHandlerAttached = false;
  }
  chrome.runtime.sendMessage({ type: 'TEACH_MODE_DONE' }).catch(() => {});
}

function handleTeachKeydown(e) {
  if (e.key === 'Escape') {
    stopTeachMode();
  }
}

function handleTeachClick(e) {
  if (!teachMode) return;
  const el = e.target;
  if (!el) return;
  if (!isTeachTarget(el)) return;
  if (isSensitiveField(el)) return;
  e.preventDefault();
  e.stopPropagation();

  const label = cleanLabelText(getFieldKey(el) || el.getAttribute('aria-label') || el.placeholder || 'Field');
  const signature = getFieldSignature(el);
  const type = (el.type || el.tagName || '').toLowerCase();
  const value = getStoredValue(el);
  showTeachOverlay({ el, label, signature, type, value });
}

function showTeachBanner() {
  if (document.getElementById('ja-teach-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'ja-teach-banner';
  banner.innerHTML = `
    <style>
      #ja-teach-banner {
        position: fixed; bottom: 18px; right: 18px; z-index: 2147483647;
        background: rgba(17,24,39,0.95); color: #fff; padding: 10px 14px;
        border-radius: 10px; border: 1px solid rgba(99,102,241,0.4);
        font-size: 12px; font-family: 'Avenir Next', 'Helvetica Neue', 'Segoe UI', sans-serif;
        box-shadow: 0 8px 20px rgba(0,0,0,0.35);
      }
      #ja-teach-banner strong { color: #a5b4fc; }
    </style>
    <div><strong>Teach Mode</strong>: click fields to map them. Press Esc to exit.</div>
  `;
  document.body.appendChild(banner);
}

function removeTeachBanner() {
  const banner = document.getElementById('ja-teach-banner');
  if (banner) banner.remove();
}

function removeTeachOverlay() {
  const overlay = document.getElementById('ja-teach-overlay');
  if (overlay) overlay.remove();
}

function showTeachOverlay({ el, label, signature, type, value }) {
  removeTeachOverlay();
  const overlay = document.createElement('div');
  overlay.id = 'ja-teach-overlay';
  const globalKeys = Object.keys(currentGlobalProfile || {});
  const customKeys = new Set();
  Object.keys((siteData && siteData.fields) || {}).forEach(k => {
    if (k.startsWith('custom:')) customKeys.add(k.replace('custom:', ''));
  });
  currentSiteMappings.forEach(m => {
    if (m.mappedKey?.startsWith('custom:')) customKeys.add(m.mappedKey.replace('custom:', ''));
  });
  const options = [
    ...globalKeys.sort().map(k => `<option value="${k}">${k}</option>`),
    ...Array.from(customKeys).sort().map(k => `<option value="custom:${k}">custom: ${k}</option>`),
    `<option value="__custom__">+ Add custom field</option>`
  ].join('');

  overlay.innerHTML = `
    <style>
      #ja-teach-overlay {
        position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
        z-index: 2147483647; background: #0f172a; color: #e2e8f0;
        border: 1px solid rgba(99,102,241,0.4); border-radius: 12px;
        padding: 14px; min-width: 280px; max-width: 360px;
        font-family: 'Avenir Next', 'Helvetica Neue', 'Segoe UI', sans-serif; box-shadow: 0 12px 30px rgba(0,0,0,0.45);
      }
      #ja-teach-overlay h4 { margin: 0 0 6px; font-size: 13px; color: #a5b4fc; }
      #ja-teach-overlay .label { font-size: 12px; margin-bottom: 10px; color: #cbd5f5; }
      #ja-teach-overlay select, #ja-teach-overlay input {
        width: 100%; padding: 8px 10px; border-radius: 8px;
        border: 1px solid rgba(99,102,241,0.3); background: #0b1220; color: #e2e8f0;
        font-size: 12px; margin-bottom: 8px;
      }
      #ja-teach-overlay .actions { display:flex; gap:8px; justify-content:flex-end; }
      #ja-teach-overlay button {
        padding: 6px 10px; border-radius: 8px; border: none; cursor: pointer;
        font-size: 12px; font-weight: 600;
      }
      #ja-teach-save { background: #6366f1; color: #fff; }
      #ja-teach-cancel { background: rgba(255,255,255,0.08); color: #cbd5f5; }
    </style>
    <h4>Teach Field</h4>
    <div class="label">Detected: ${label}</div>
    <select id="ja-teach-select">${options}</select>
    <input id="ja-teach-custom" placeholder="Custom field name" style="display:none;" />
    <div class="actions">
      <button id="ja-teach-cancel">Cancel</button>
      <button id="ja-teach-save">Save</button>
    </div>
  `;

  document.body.appendChild(overlay);
  const select = overlay.querySelector('#ja-teach-select');
  const customInput = overlay.querySelector('#ja-teach-custom');
  select.addEventListener('change', () => {
    if (select.value === '__custom__') {
      customInput.style.display = 'block';
      customInput.focus();
    } else {
      customInput.style.display = 'none';
    }
  });

  overlay.querySelector('#ja-teach-cancel').addEventListener('click', () => {
    removeTeachOverlay();
  });
  overlay.querySelector('#ja-teach-save').addEventListener('click', async () => {
    let mappedKey = select.value;
    if (mappedKey === '__custom__') {
      const customLabel = (customInput.value || '').trim();
      if (!customLabel) return;
      mappedKey = `custom:${customLabel}`;
    }
    const hints = buildElementHints(el);
    const mapping = { signature, mappedKey, label, type, hints };
    const resp = await chrome.runtime.sendMessage({ type: 'SAVE_SITE_MAPPING', hostname, mapping }).catch(() => null);
    if (resp?.mappings) {
      currentSiteMappings = resp.mappings;
      siteData.mappings = resp.mappings;
    } else {
      const idx = currentSiteMappings.findIndex(m => m.signature === mapping.signature);
      if (idx >= 0) currentSiteMappings[idx] = { ...currentSiteMappings[idx], ...mapping };
      else currentSiteMappings.push(mapping);
      siteData.mappings = currentSiteMappings;
    }
    if (value) {
      const payload = { [mappedKey]: value };
      await chrome.runtime.sendMessage({ type: 'SAVE_FIELDS', hostname, fields: payload });
      await chrome.runtime.sendMessage({ type: 'SESSION_MERGE', hostname, fields: payload });
    }
    removeTeachOverlay();
    showSaveToast('Field learned');
  });
}

function showSaveToast(message) {
  const existing = document.getElementById('ja-teach-toast');
  if (existing) existing.remove();
  const t = document.createElement('div');
  t.id = 'ja-teach-toast';
  t.textContent = message;
  t.style.cssText = `
    position: fixed; bottom: 60px; right: 18px; z-index: 2147483647;
    background: #111827; color: #e2e8f0; padding: 8px 12px; border-radius: 10px;
    border: 1px solid rgba(99,102,241,0.4); font-size: 12px;
  `;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}

function saveFieldValue(key, value) {
  if (!key) return;
  const payload = { [key]: value };
  chrome.runtime.sendMessage({ type: 'SAVE_FIELDS', hostname, fields: payload }).catch(() => { });
  chrome.runtime.sendMessage({ type: 'SESSION_MERGE', hostname, fields: payload }).catch(() => { });
}

function getFieldLabelForDisplay(el, fallback) {
  const label = cleanLabelText(getSiteLabel(el) || getFieldKey(el) || fallback || '');
  return label || 'Dropdown';
}

function attachDropdownResolveListener() {
  if (window._jaDropdownResolveListener) return;
  window._jaDropdownResolveListener = true;
  document.addEventListener('click', (e) => {
    if (!pendingDropdownResolve) return;
    const opt = e.target.closest?.('[role="option"], option');
    if (!opt) return;
    const text = getOptionText(opt) || opt.textContent || '';
    const value = getOptionValue(opt) || opt.value || text;
    const encoded = encodeSelectValue(text, value);
    saveFieldValue(pendingDropdownResolve.key, encoded);
    showSaveToast('Saved dropdown choice');
    pendingDropdownResolve = null;
  }, true);
  document.addEventListener('change', (e) => {
    if (!pendingDropdownResolve) return;
    const el = e.target;
    if (!el || el.tagName !== 'SELECT') return;
    const text = el.selectedOptions?.[0]?.text || el.value || '';
    const value = el.value || text;
    const encoded = encodeSelectValue(text, value);
    saveFieldValue(pendingDropdownResolve.key, encoded);
    showSaveToast('Saved dropdown choice');
    pendingDropdownResolve = null;
  }, true);
}

function showDropdownResolver(unresolved) {
  if (!unresolved || unresolved.length === 0) return;
  if (getSiteFlag('neverPrompt')) return;
  if (!isJobContextPage()) return;
  if (dropdownResolverOpen) return;
  if (document.getElementById('ja-dropdown-resolver')) return;
  dropdownResolverOpen = true;
  attachDropdownResolveListener();

  const panel = document.createElement('div');
  panel.id = 'ja-dropdown-resolver';
  const rows = unresolved.slice(0, 3).map((item, idx) => {
    const label = getFieldLabelForDisplay(item.el, item.key);
    if (item.el && item.el.tagName === 'SELECT') {
      const options = Array.from(item.el.options || []).map(opt => {
        const val = opt.value ?? opt.textContent ?? '';
        const txt = opt.textContent ?? opt.value ?? '';
        return `<option value="${escapeHtml(val)}">${escapeHtml(txt)}</option>`;
      }).join('');
      return `
        <div class="ja-dd-row">
          <div class="ja-dd-label">${escapeHtml(label)}</div>
          <select data-resolve-idx="${idx}" class="ja-dd-select">
            <option value="">Choose…</option>
            ${options}
          </select>
        </div>
      `;
    }
    return `
      <div class="ja-dd-row">
        <div class="ja-dd-label">${escapeHtml(label)}</div>
        <button class="ja-dd-btn" data-resolve-idx="${idx}">Pick Option</button>
      </div>
    `;
  }).join('');

  panel.innerHTML = `
    <style>
      #ja-dropdown-resolver {
        position: fixed; bottom: 18px; right: 18px; z-index: 2147483646;
        background: #0b1220; color: #e2e8f0;
        border: 1px solid rgba(10, 102, 194, 0.35);
        border-radius: 12px; padding: 12px 14px; width: 320px;
        box-shadow: 0 12px 32px rgba(0,0,0,0.5);
        font-family: 'Avenir Next', 'Helvetica Neue', 'Segoe UI', sans-serif;
        font-size: 12px;
      }
      #ja-dropdown-resolver h4 { margin: 0 0 8px 0; font-size: 13px; color: #93c5fd; }
      #ja-dropdown-resolver .ja-dd-row { display:flex; gap:8px; align-items:center; margin-bottom: 8px; }
      #ja-dropdown-resolver .ja-dd-label { flex:1; color:#e2e8f0; }
      #ja-dropdown-resolver .ja-dd-select {
        background: #111827; color:#e2e8f0; border:1px solid rgba(148,163,184,0.35);
        border-radius: 8px; padding: 4px 6px; font-size: 12px; min-width: 140px;
      }
      #ja-dropdown-resolver .ja-dd-btn {
        background: #0a66c2; color: #fff; border: none; border-radius: 8px;
        padding: 5px 10px; font-size: 12px; cursor: pointer;
      }
      #ja-dropdown-resolver .ja-dd-actions { display:flex; justify-content:flex-end; gap:8px; margin-top: 6px; }
      #ja-dropdown-resolver .ja-dd-dismiss {
        background: rgba(255,255,255,0.08); color:#cbd5f5; border: none; border-radius: 8px;
        padding: 5px 10px; font-size: 12px; cursor: pointer;
      }
    </style>
    <h4>Resolve Dropdowns</h4>
    ${rows}
    <div class="ja-dd-actions">
      <button class="ja-dd-dismiss">Dismiss</button>
    </div>
  `;
  document.body.appendChild(panel);

  const cleanupResolver = () => {
    if (!panel.querySelector('.ja-dd-row')) {
      dropdownResolverOpen = false;
      panel.remove();
    }
  };

  panel.querySelectorAll('.ja-dd-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const idx = Number(sel.getAttribute('data-resolve-idx'));
      const entry = unresolved[idx];
      const value = sel.value;
      if (!entry || !value) return;
      const original = entry.el;
      if (original && original.tagName === 'SELECT') {
        original.value = value;
        if (original.selectedIndex === -1) {
          const text = sel.selectedOptions?.[0]?.text || value;
          Array.from(original.options || []).forEach((opt, i) => {
            if (opt.text === text) original.selectedIndex = i;
          });
        }
        triggerEvents(original);
      }
      const text = sel.selectedOptions?.[0]?.text || value;
      saveFieldValue(entry.key, encodeSelectValue(text, value));
      showSaveToast('Dropdown saved');
      sel.closest('.ja-dd-row')?.remove();
      cleanupResolver();
    });
  });

  panel.querySelectorAll('.ja-dd-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.getAttribute('data-resolve-idx'));
      const entry = unresolved[idx];
      if (!entry) return;
      pendingDropdownResolve = { key: entry.key, ts: Date.now() };
      entry.el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      entry.el?.focus?.();
      entry.el?.click?.();
      showSaveToast('Pick an option to save');
      setTimeout(() => {
        if (pendingDropdownResolve && (Date.now() - pendingDropdownResolve.ts > 30000)) {
          pendingDropdownResolve = null;
        }
      }, 30000);
    });
  });

  panel.querySelector('.ja-dd-dismiss')?.addEventListener('click', () => {
    dropdownResolverOpen = false;
    panel.remove();
  });
}

function getFormCompletionStats() {
  const selectors = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=file]):not([type=password]), textarea, select, [contenteditable="true"], [role="textbox"]';
  const elements = collectElements(selectors);
  let total = 0;
  let filled = 0;
  const missing = [];

  elements.forEach(el => {
    const type = (el.type || '').toLowerCase();
    if (type === 'radio') return;
    if (!isVisibleElement(el)) return;
    if (isSensitiveField(el)) return;
    total += 1;
    const value = getStoredValue(el);
    const normalized = (value || '').toString().trim();
    const isEmpty = !normalized || (el.tagName === 'SELECT' && /^[-\s]*(select|choose|pick)/i.test(normalized));
    if (!isEmpty) filled += 1;
    const required = el.required || el.getAttribute('aria-required') === 'true' || /\*/.test(getFieldKey(el) || '');
    if (required && isEmpty) {
      const label = getFieldLabelForDisplay(el, getFieldKey(el));
      if (label && missing.length < 6) missing.push(label);
    }
  });

  return { total, filled, missing };
}

function showReviewPanel() {
  if (document.getElementById('ja-review-panel')) return;
  if (!isJobContextPage()) return;
  const stats = getFormCompletionStats();
  if (stats.total < 4) return;

  const panel = document.createElement('div');
  panel.id = 'ja-review-panel';
  const missingList = stats.missing.length
    ? `<ul>${stats.missing.map(m => `<li>${escapeHtml(m)}</li>`).join('')}</ul>`
    : `<div class="ja-review-good">Looks good. No required fields missing.</div>`;
  panel.innerHTML = `
    <style>
      #ja-review-panel {
        position: fixed; top: 18px; left: 18px; z-index: 2147483646;
        background: #0b1220; color: #e2e8f0;
        border: 1px solid rgba(10, 102, 194, 0.35);
        border-radius: 12px; padding: 12px 14px; width: 320px;
        box-shadow: 0 12px 32px rgba(0,0,0,0.5);
        font-family: 'Avenir Next', 'Helvetica Neue', 'Segoe UI', sans-serif;
        font-size: 12px;
      }
      #ja-review-panel h4 { margin: 0 0 6px 0; font-size: 13px; color: #93c5fd; }
      #ja-review-panel .ja-review-sub { color:#94a3b8; margin-bottom: 8px; }
      #ja-review-panel ul { margin: 6px 0 0 16px; padding: 0; color: #fbbf24; }
      #ja-review-panel .ja-review-actions { display:flex; gap:8px; margin-top: 10px; }
      #ja-review-panel button {
        border: none; border-radius: 8px; padding: 6px 10px; font-size: 12px; cursor: pointer;
      }
      #ja-review-teach { background: #0a66c2; color: #fff; }
      #ja-review-dismiss { background: rgba(255,255,255,0.08); color: #cbd5f5; }
      #ja-review-panel .ja-review-good { color:#86efac; }
    </style>
    <h4>Pre‑Submit Review</h4>
    <div class="ja-review-sub">Filled ${stats.filled} of ${stats.total} fields.</div>
    ${missingList}
    <div class="ja-review-actions">
      <button id="ja-review-teach">Teach Missing</button>
      <button id="ja-review-dismiss">Dismiss</button>
    </div>
  `;
  document.body.appendChild(panel);

  panel.querySelector('#ja-review-teach')?.addEventListener('click', () => {
    panel.remove();
    startTeachMode();
  });
  panel.querySelector('#ja-review-dismiss')?.addEventListener('click', () => {
    panel.remove();
  });
  setTimeout(() => panel.remove(), 12000);
}

function showConfidenceOverlay(savedFields) {
  if (document.getElementById('ja-confidence-layer')) return;
  if (getSessionFlag('confidenceDismissed')) return;
  if (!isJobContextPage()) return;
  if (getSiteFlag('neverPrompt')) return;

  const selectors = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=file]):not([type=password]), textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]';
  const elements = [];
  collectElements(selectors).forEach(el => {
    const type = (el.type || '').toLowerCase();
    if (type === 'radio') return;
    if (!isVisibleElement(el)) return;
    const mapped = resolveMappedKey(el);
    const key = mapped.key || getFieldKey(el);
    if (!key) return;
    elements.push({ el, key, mapped });
  });
  if (!elements.length) return;

  const keyCounts = {};
  elements.forEach(({ key }) => { keyCounts[key] = (keyCounts[key] || 0) + 1; });
  const keyIndex = {};
  const dots = [];

  elements.forEach(({ el, key, mapped }) => {
    keyIndex[key] = (keyIndex[key] || 0);
    const fieldKey = keyCounts[key] > 1 ? `${key}[${keyIndex[key]++}]` : key;
    let val = savedFields?.[fieldKey];
    let source = 'site';
    let globalMeta = null;
    if (val === undefined) {
      globalMeta = getGlobalMatchMeta(fieldKey);
      val = globalMeta?.value;
      source = 'global';
    }
    if (val === undefined || val === null) return;
    const level = classifyConfidence({ mapped, source, globalMeta });
    dots.push({ el, level });
  });

  if (!dots.length) return;

  const layer = document.createElement('div');
  layer.id = 'ja-confidence-layer';
  layer.innerHTML = `
    <style>
      #ja-confidence-layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483645; }
      .ja-conf-dot {
        width: 8px; height: 8px; border-radius: 999px; position: absolute;
        box-shadow: 0 0 0 2px rgba(11,18,32,0.9);
      }
      .ja-conf-legend .ja-conf-dot { position: static; display: inline-block; }
      .ja-conf-high { background: #22c55e; }
      .ja-conf-mid { background: #f59e0b; }
      .ja-conf-low { background: #ef4444; }
      .ja-conf-legend {
        position: fixed; bottom: 18px; left: 18px; pointer-events: auto;
        background: #0b1220; border: 1px solid rgba(148,163,184,0.3);
        border-radius: 10px; padding: 8px 10px; color: #e2e8f0;
        font-family: 'Avenir Next', 'Helvetica Neue', 'Segoe UI', sans-serif; font-size: 11px;
      }
      .ja-conf-legend span { display: inline-flex; align-items:center; gap:6px; margin-right: 8px; }
      .ja-conf-legend button {
        border: none; border-radius: 6px; padding: 4px 8px; font-size: 11px;
        background: rgba(255,255,255,0.08); color: #cbd5f5; cursor: pointer;
      }
    </style>
    <div class="ja-conf-legend">
      <span><i class="ja-conf-dot ja-conf-high"></i>High</span>
      <span><i class="ja-conf-dot ja-conf-mid"></i>Medium</span>
      <span><i class="ja-conf-dot ja-conf-low"></i>Low</span>
      <button id="ja-conf-hide">Hide</button>
    </div>
  `;
  document.body.appendChild(layer);

  const dotEls = dots.map(d => {
    const el = document.createElement('div');
    el.className = `ja-conf-dot ja-conf-${d.level}`;
    layer.appendChild(el);
    return { target: d.el, dot: el };
  });

  const positionDots = () => {
    dotEls.forEach(({ target, dot }) => {
      const rect = target.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        dot.style.display = 'none';
        return;
      }
      dot.style.display = 'block';
      dot.style.left = `${Math.min(window.innerWidth - 10, rect.right - 6)}px`;
      dot.style.top = `${Math.min(window.innerHeight - 10, rect.top - 4)}px`;
    });
  };
  positionDots();
  const onScroll = () => positionDots();
  const onResize = () => positionDots();
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize);

  layer.querySelector('#ja-conf-hide')?.addEventListener('click', () => {
    setSessionFlag('confidenceDismissed', true);
    layer.remove();
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onResize);
  });
  setTimeout(() => {
    layer.remove();
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onResize);
  }, 12000);
}

function showCoverageBanner(stats) {
  if (!stats) return;
  if (document.getElementById('ja-coverage-banner')) return;
  if (getSessionFlag('coverageDismissed')) return;
  const detected = stats.detected || 0;
  const matched = stats.matched || 0;
  const filled = stats.filled || 0;
  if (detected < 4) return;
  const matchRatio = detected ? matched / detected : 1;
  const fillRatio = matched ? filled / matched : 1;
  if (matchRatio >= 0.85 && fillRatio >= 0.85) return;

  const banner = document.createElement('div');
  banner.id = 'ja-coverage-banner';
  banner.innerHTML = `
    <style>
      #ja-coverage-banner {
        position: fixed; bottom: 18px; left: 18px; z-index: 2147483646;
        background: linear-gradient(135deg, #0b1220 0%, #111827 100%);
        border: 1px solid rgba(56,189,248,0.35);
        border-radius: 12px; padding: 12px 14px;
        box-shadow: 0 8px 28px rgba(0,0,0,0.5);
        font-family: 'Avenir Next', 'Helvetica Neue', 'Segoe UI', sans-serif; color: #e2e8f0; font-size: 12px;
        max-width: 320px;
      }
      #ja-coverage-banner .row { display:flex; gap:10px; align-items:center; justify-content: space-between; }
      #ja-coverage-banner .stats { color: #93c5fd; font-weight: 600; }
      #ja-coverage-banner .actions { display:flex; gap:8px; margin-top: 8px; }
      #ja-coverage-banner button {
        border: none; border-radius: 8px; padding: 6px 10px;
        font-size: 12px; font-weight: 600; cursor: pointer;
      }
      #ja-coverage-teach { background: #38bdf8; color: #0b1220; }
      #ja-coverage-dismiss { background: rgba(255,255,255,0.08); color: #cbd5f5; }
    </style>
    <div class="row">
      <div><strong>Autofill Coverage</strong></div>
      <div class="stats">${filled}/${matched}/${detected}</div>
    </div>
    <div style="margin-top:4px; color:#94a3b8">Filled / Matched / Detected fields</div>
    <div class="actions">
      <button id="ja-coverage-teach">Teach Missing</button>
      <button id="ja-coverage-dismiss">Dismiss</button>
    </div>
  `;
  document.body.appendChild(banner);

  document.getElementById('ja-coverage-teach').onclick = () => {
    setSessionFlag('coverageDismissed', true);
    banner.remove();
    startTeachMode();
  };
  document.getElementById('ja-coverage-dismiss').onclick = () => {
    setSessionFlag('coverageDismissed', true);
    banner.remove();
  };
}

// Fills only standard (non-ARIA) fields — used by MutationObserver re-runs
function fillStandardFields(savedFields) {
  const selectors = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=file]):not([type=password]), textarea, select, [contenteditable="true"], [role="textbox"]';
  const elements = [];
  collectElements(selectors).forEach(el => {
    const type = (el.type || '').toLowerCase();
    if (type === 'radio') return;
    if (type === 'text' && el.maxLength === 1) return;
    const mapped = resolveMappedKey(el);
    const key = mapped.key || getFieldKey(el);
    if (!key) return;
    elements.push({ el, key, type });
  });
  const keyCounts = {};
  elements.forEach(({ key }) => { keyCounts[key] = (keyCounts[key] || 0) + 1; });
  const keyIndex = {};
  elements.forEach(({ el, key, type }) => {
    keyIndex[key] = (keyIndex[key] || 0);
    const fieldKey = keyCounts[key] > 1 ? `${key}[${keyIndex[key]++}]` : key;
    let val = savedFields[fieldKey];
    if (val === undefined) val = getGlobalMatch(fieldKey);
    if (val === undefined || val === null) return;
    const decoded = decodeSelectValue(val);
    const primaryVal = decoded.text || val;
    const altVal = decoded.value || primaryVal;
    if (!shouldFillValue(el, fieldKey, primaryVal)) return;
    if (type === 'checkbox') {
      el.checked = primaryVal === 'true' || primaryVal === true;
      triggerEvents(el);
    } else if (el.tagName === 'SELECT') {
      const targetText = String(primaryVal).toLowerCase().trim();
      const targetValue = String(altVal).toLowerCase().trim();
      let matched = false;
      for (let i = 0; i < el.options.length; i++) {
        const opt = el.options[i];
        const optVal = opt.value.toLowerCase().trim();
        const optText = opt.text.toLowerCase().trim();
        if (optVal === targetText || optText === targetText || optVal === targetValue || optText === targetValue) {
          el.selectedIndex = i;
          matched = true;
          break;
        }
      }
      if (!matched && targetText) {
        for (let i = 0; i < el.options.length; i++) {
          const optText = el.options[i].text.toLowerCase();
          if (optText.includes(targetText) || optText.includes(targetValue)) {
            el.selectedIndex = i;
            matched = true;
            break;
          }
        }
      }
      if (matched) {
        triggerEvents(el);
      }
    } else if (setEditableValue(el, primaryVal)) {
      return;
    } else {
      setNativeValue(el, primaryVal);
      triggerEvents(el);
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }
  });
}

// ── Banner UI ──────────────────────────────────────────────────
function showAutofillBanner(savedFields) {
  if (document.getElementById('ja-banner')) return;
  if (getSiteFlag('neverPrompt')) return;
  if (!isJobContextPage()) return;
  if (!hasFillableFields()) return;
  // Don't show if user already skipped or accepted during this session
  if (getSessionFlag('autofillDismissed')) {
    console.log('[FormPilot] Autofill banner already dismissed this session, skipping.');
    return;
  }

  const banner = document.createElement('div');
  banner.id = 'ja-banner';
  banner.innerHTML = `
    <style>
      #ja-banner {
        position: fixed; top: 18px; right: 18px; z-index: 2147483647;
        background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
        border: 1px solid rgba(59,130,246,0.45);
        border-radius: 14px; padding: 14px 18px;
        display: flex; align-items: center; gap: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.55), 0 0 0 1px rgba(59,130,246,0.15);
        font-family: 'Avenir Next', 'Helvetica Neue', 'Segoe UI', sans-serif;
        color: #e2e8f0; font-size: 14px;
        animation: ja-slide-in 0.35s cubic-bezier(0.34,1.56,0.64,1);
        max-width: 340px;
      }
      @keyframes ja-slide-in {
        from { opacity:0; transform: translateY(-20px) scale(0.95); }
        to   { opacity:1; transform: translateY(0) scale(1); }
      }
      #ja-banner .ja-icon { font-size: 22px; flex-shrink:0; }
      #ja-banner .ja-text { flex:1; line-height:1.4; }
      #ja-banner .ja-text strong { color: #93c5fd; display:block; margin-bottom:2px; }
      #ja-banner .ja-btns { display:flex; gap:8px; flex-shrink:0; }
      #ja-banner button {
        border: none; border-radius: 8px; padding: 7px 14px;
        font-size: 13px; font-weight: 600; cursor: pointer;
        transition: all 0.18s;
      }
      #ja-yes { background: #3b82f6; color: #fff; }
      #ja-yes:hover { background: #2563eb; transform: scale(1.04); }
      #ja-no  { background: rgba(255,255,255,0.08); color: #94a3b8; }
      #ja-no:hover { background: rgba(255,255,255,0.15); }
      #ja-never { background: rgba(239, 68, 68, 0.1); color: #ef4444; }
      #ja-never:hover { background: rgba(239, 68, 68, 0.2); }
    </style>
    <span class="ja-icon">⚡</span>
    <div class="ja-text">
      <strong>FormPilot AI</strong>
      Fill your previous data for this site?
    </div>
    <div class="ja-btns">
      <button id="ja-yes">Yes</button>
      <button id="ja-no">Skip</button>
      <button id="ja-never">Never</button>
    </div>
  `;

  document.body.appendChild(banner);

  document.getElementById('ja-yes').onclick = () => {
    setSessionFlag('autofillDismissed', true);
    setSessionFlag('autofillActive', true); // Enable auto-fill for this session
    fillFields(savedFields);
    banner.remove();
  };
  document.getElementById('ja-no').onclick = () => {
    setSessionFlag('autofillDismissed', true);
    banner.remove();
  };
  document.getElementById('ja-never').onclick = () => {
    setSessionFlag('autofillDismissed', true);
    setSiteFlag('neverPrompt', true);
    banner.remove();
  };

  // Auto-dismiss after 12s — also remember so it doesn't pop up again
  setTimeout(() => {
    const b = document.getElementById('ja-banner');
    if (b) {
      setSessionFlag('autofillDismissed', true);
      b.remove();
    }
  }, 12000);
}

// ── Save Data Prompt ──────────────────────────────────────────
function showSaveDataBanner(fields) {
  if (document.getElementById('ja-save-banner')) return;
  if (getSessionFlag('promptSkipped')) return;
  if (getSiteFlag('neverPrompt')) return;
  if (!isJobContextPage()) return;

  const banner = document.createElement('div');
  banner.id = 'ja-save-banner';
  banner.innerHTML = `
    <style>
      #ja-save-banner {
        position: fixed; top: 18px; right: 18px; z-index: 2147483647;
        background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
        border: 1px solid rgba(16, 185, 129, 0.45);
        border-radius: 14px; padding: 14px 18px;
        display: flex; align-items: center; gap: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.55), 0 0 0 1px rgba(16, 185, 129, 0.15);
        font-family: 'Avenir Next', 'Helvetica Neue', 'Segoe UI', sans-serif;
        color: #e2e8f0; font-size: 14px;
        animation: ja-slide-in 0.35s cubic-bezier(0.34,1.56,0.64,1);
        max-width: 360px;
      }
      #ja-save-banner .ja-icon { font-size: 22px; flex-shrink:0; }
      #ja-save-banner .ja-text { flex:1; line-height:1.4; }
      #ja-save-banner .ja-text strong { color: #6ee7b7; display:block; margin-bottom:2px; }
      #ja-save-banner .ja-btns { display:flex; gap:8px; flex-shrink:0; }
      #ja-save-banner button {
        border: none; border-radius: 8px; padding: 7px 14px;
        font-size: 13px; font-weight: 600; cursor: pointer;
        transition: all 0.18s;
      }
      #ja-save-yes { background: #10b981; color: #fff; }
      #ja-save-yes:hover { background: #059669; transform: scale(1.04); }
      #ja-save-no  { background: rgba(255,255,255,0.08); color: #94a3b8; }
      #ja-save-no:hover { background: rgba(255,255,255,0.15); }
      #ja-save-never { background: rgba(239, 68, 68, 0.1); color: #ef4444; }
      #ja-save-never:hover { background: rgba(239, 68, 68, 0.2); }
    </style>
    <span class="ja-icon">💾</span>
    <div class="ja-text">
      <strong>Save Data?</strong>
      Do you want to save the entered data for next time?
    </div>
    <div class="ja-btns">
      <button id="ja-save-yes">Save</button>
      <button id="ja-save-no">Skip</button>
      <button id="ja-save-never">Never</button>
    </div>
  `;

  document.body.appendChild(banner);

  document.getElementById('ja-save-yes').onmousedown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: 'SAVE_FIELDS', hostname, fields });
    // Don't show again this session regardless of the page we land on next
    setSessionFlag('promptSkipped', true);
    banner.remove();
  };
  document.getElementById('ja-save-no').onmousedown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setSessionFlag('promptSkipped', true);
    banner.remove();
  };
  document.getElementById('ja-save-never').onmousedown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setSiteFlag('neverPrompt', true);
    setSessionFlag('promptSkipped', true);
    banner.remove();
  };

  // Auto-dismiss after 12s
  setTimeout(() => {
    const b = document.getElementById('ja-save-banner');
    if (b) {
      setSessionFlag('promptSkipped', true);
      b.remove();
    }
  }, 12000);
}

// ── Recording: capture on form submit or button click ─────────
function attachRecorder() {
  if (window._jaRecorderAttached) return;
  window._jaRecorderAttached = true;
  // Debounce: prevent double-banner when BOTH mousedown + submit events fire
  // for the same button click (common on native HTML forms)
  let submissionDebounceTimer = null;

  const handleSubmission = (source, meta = {}) => {
    if (submissionDebounceTimer) return; // already handling this click
    submissionDebounceTimer = setTimeout(() => { submissionDebounceTimer = null; }, 600);

    if (getSiteFlag('neverPrompt')) {
      console.log('[FormPilot] Site prompts disabled. Skipping auto-capture.');
      return;
    }
    if (!isJobContextPage()) {
      console.log('[FormPilot] Non-job context detected. Skipping auto-capture.');
      return;
    }

    const stage = meta.stage || 'unknown';
    const effectiveStage = stage === 'unknown' ? 'final' : stage;

    console.log(`[FormPilot] Intercepted submission via: ${source}`);
    const fields = getFormFields();
    console.log(`[FormPilot] Captured fields:`, fields);

    if (Object.keys(fields).length > 0) {
      chrome.runtime.sendMessage({ type: 'SESSION_MERGE', hostname, fields }).catch(() => {});
      // Multi-step flow: on "Next/Continue", enable session autofill but don't prompt to save
      if (effectiveStage === 'next') {
        setSessionFlag('autofillActive', true);
        console.log('[FormPilot] Multi-step detected. Carrying data forward silently.');
        return;
      }

      // If user previously clicked Save on page 1, silently save page 2+ data
      if (getSessionFlag('promptSkipped')) {
        console.log(`[FormPilot] Banner skipped this session. Silently saving data.`);
        chrome.runtime.sendMessage({ type: 'SAVE_FIELDS', hostname, fields });
      } else {
        console.log(`[FormPilot] Prompting to save data.`);
        showSaveDataBanner(fields);
      }

    } else {
      console.log(`[FormPilot] No fields found, skipping prompt.`);
    }

    // Show a quick review panel and auto-track application on final submit
    if (effectiveStage === 'final') {
      showReviewPanel();
      maybeAutoTrackApplication(effectiveStage);
    }
  };

  // Intercept standard form submits
  document.addEventListener('submit', (e) => {
    const meta = lastSubmitIntent && (Date.now() - lastSubmitIntent.ts < 5000) ? lastSubmitIntent : {};
    handleSubmission('submit event', meta);
    lastSubmitIntent = null;
  }, true);

  // Use mousedown instead of click to beat event.stopPropagation() from modern frameworks
  document.addEventListener('mousedown', (e) => {
    let el = e.target;
    let isSubmit = false;
    let stage = 'unknown';

    // traverse up to catch icons inside buttons (5 levels for nested ATS UIs)
    let depth = 0;
    while (el && el !== document.body && depth < 5) {
      const tagName = (el.tagName || '').toUpperCase();
      const type = (el.type || '').toLowerCase();

      // Workday-specific: detect buttons by data-automation-id
      const autoId = el.getAttribute?.('data-automation-id') || '';
      if (/pageFooterNextButton|pageFooterSubmitButton|bottom-navigation-next/i.test(autoId)) {
        isSubmit = true;
        stage = /submit/i.test(autoId) ? 'final' : 'next';
        break;
      }

      if (tagName === 'BUTTON' || (tagName === 'INPUT' && (type === 'submit' || type === 'button'))) {
        const text = (el.innerText || el.value || '').toLowerCase();
        if (/(submit|apply|save|continue|next|send|finish|complete|review)/i.test(text)) {
          isSubmit = true;
          if (/(submit|apply|finish|complete|send)/i.test(text)) stage = 'final';
          else if (/(next|continue|review|save)/i.test(text)) stage = 'next';
          break;
        }
      }
      if (el.getAttribute && el.getAttribute('role') === 'button') {
        const text = (el.innerText || '').toLowerCase();
        if (/(submit|apply|save|continue|next|send|finish|complete|review)/i.test(text)) {
          isSubmit = true;
          if (/(submit|apply|finish|complete|send)/i.test(text)) stage = 'final';
          else if (/(next|continue|review|save)/i.test(text)) stage = 'next';
          break;
        }
      }
      el = el.parentElement;
      depth++;
    }

    if (isSubmit) {
      lastSubmitIntent = { stage, ts: Date.now() };
      handleSubmission('button mousedown', { stage });
    }
  }, true);
}

// ── Incoming Messages (from popup) ───────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === 'MANUAL_SAVE') {
    try {
      const fields = getFormFields();
      const count = Object.keys(fields).length;
      if (count > 0) {
        Promise.all([
          chrome.runtime.sendMessage({ type: 'SESSION_MERGE', hostname, fields }),
          chrome.runtime.sendMessage({ type: 'SAVE_FIELDS', hostname, fields }),
        ])
          .then(() => sendResponse({ ok: true, count }))
          .catch(() => sendResponse({ ok: false, count: 0 }));
      } else {
        sendResponse({ ok: false, count: 0 });
      }
    } catch (err) {
      console.error('[FormPilot] MANUAL_SAVE error:', err);
      sendResponse({ ok: false, count: 0 });
    }
    return true;
  }

  if (msg.type === 'MANUAL_AUTOFILL') {
    Promise.all([
      chrome.runtime.sendMessage({ type: 'GET_SITE_DATA', hostname }),
      chrome.runtime.sendMessage({ type: 'SESSION_GET', hostname }).catch(() => ({ ok: false, fields: {} })),
    ])
      .then(([resp, sessionResp]) => {
        const site = resp?.site || { enabled: true, fields: {}, mappings: [], flags: {} };
        currentSiteMappings = site.mappings || currentSiteMappings;
        siteData = site;
        siteFlags = site.flags || {};
        currentSiteActive = !(site?.disabled || site?.enabled === false);
        const merged = { ...(site.fields || {}), ...(sessionResp?.fields || {}) };
        if (Object.keys(merged).length > 0 || Object.keys(currentGlobalProfile || {}).length > 0) {
          setSessionFlag('autofillActive', true);
          fillFields(merged);
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false });
        }
      })
      .catch(err => {
        console.error('[FormPilot] MANUAL_AUTOFILL error:', err);
        sendResponse({ ok: false });
      });
    return true;
  }

  if (msg.type === 'TEACH_MODE_START') {
    startTeachMode();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'TEACH_MODE_STOP') {
    stopTeachMode();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'EXTRACT_PAGE_TEXT') {
    try {
      let container = document.querySelector('main, [role="main"], article, .job-description, #job-description, .posting-content, .job-details');
      if (!container) container = document.body;

      let text = (container.innerText || '').replace(/\s+/g, ' ').trim();
      if (text.length > 15000) text = text.substring(0, 15000);

      sendResponse({ ok: true, text });
    } catch (err) {
      sendResponse({ ok: false, text: '' });
    }
    return true;
  }

  return false;
});

// ── Helper: Check if extension context is still valid ─────────
function isExtensionValid() {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

// ── Init ───────────────────────────────────────────────────────
let initRunning = false;
async function init() {
  if (initRunning) return;
  if (!isExtensionValid()) return;
  initRunning = true;

  try {
    console.log(`[FormPilot] Initializing on ${location.href}`);

    const [resp, profileResp, sessionResp] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'GET_SITE_DATA', hostname }),
      chrome.runtime.sendMessage({ type: 'GET_GLOBAL_PROFILE' }),
      chrome.runtime.sendMessage({ type: 'SESSION_GET', hostname }).catch(() => ({ ok: false, fields: {} }))
    ]);
    sessionFlags = sessionResp?.flags || {};
    hydrateSessionFlags(sessionFlags);
    const site = resp?.site;
    siteData = site || { enabled: true, fields: {}, mappings: [], flags: {} };
    siteFlags = siteData.flags || {};
    currentSiteKey = resp?.siteKey || hostname;
    currentSiteMappings = siteData.mappings || [];
    
    // 1. If explicitly blocked ("Never") OR toggled off in popup, stop completely
    currentSiteActive = !(site?.disabled || site?.enabled === false);
    if (!currentSiteActive) {
      console.log(`[FormPilot] Extension inactive for ${hostname} (Disabled: ${!!site?.disabled}, Enabled: ${site?.enabled})`);
      return;
    }

    const jobContextOk = isJobContextPage();
    const allowAuto = jobContextOk && !getSiteFlag('neverPrompt');

    // Only attach recorders on job-application contexts (privacy + fewer false prompts)
    if (allowAuto) {
      attachRecorder();
    }

    currentGlobalProfile = profileResp?.profile || {};
    const sessionFields = sessionResp?.fields || {};
    const mergedFields = { ...(site?.fields || {}), ...(sessionFields || {}) };

    const savedCount = Object.keys(mergedFields || {}).length;
    const globalCount = Object.keys(currentGlobalProfile || {}).length;
    if (allowAuto && (savedCount > 0 || globalCount > 0)) {
      if (!ACCURACY_MODE) {
        console.log('[FormPilot] Aggressive autofill enabled. Auto-filling now.');
        setSessionFlag('autofillActive', true);
        fillFields(mergedFields || {});
      } else if (getSessionFlag('autofillActive')) {
        console.log(`[FormPilot] Autofill session active. Auto-filling new fields...`);
        fillFields(mergedFields || {});
      } else {
        // Small delay to let the page fully render
        setTimeout(() => showAutofillBanner(mergedFields || {}), 800);
      }
    }

    if (allowAuto) {
      attachLiveCapture();
      initResumeAttach();
    }

    // If job context wasn't ready yet (SPA or late render), re-check once.
    if (!allowAuto) {
      setTimeout(() => {
        if (!isExtensionValid()) return;
        if (getSiteFlag('neverPrompt')) return;
        if (!currentSiteActive) return;
        if (!isJobContextPage()) return;

        attachRecorder();
        attachLiveCapture();
        initResumeAttach();

        if (savedCount > 0 || globalCount > 0) {
          if (getSessionFlag('autofillActive')) {
            fillFields(mergedFields || {});
          } else {
            showAutofillBanner(mergedFields || {});
          }
        }
      }, 1200);
    }
  } catch (err) {
    // Extension context invalidated (e.g., extension was updated/reloaded)
    if (err.message?.includes('Extension context invalidated')) {
      console.log('[FormPilot] Extension context invalidated, stopping.');
      return;
    }
    console.error('[FormPilot] Init error:', err?.name || 'Error', err?.message || err);
  } finally {
    initRunning = false;
  }
}

// ── Debounced init for SPA navigation ──────────────────────────
let reinitTimer = null;
function debouncedInit() {
  if (reinitTimer) clearTimeout(reinitTimer);
  reinitTimer = setTimeout(() => {
    if (isExtensionValid()) init();
  }, 300);
}

// Initial run
init();

// Handle SPA navigation (hash changes)
window.addEventListener('hashchange', () => {
  console.log('[FormPilot] Hash change detected, re-initializing...');
  debouncedInit();
});

// Watch for path changes in SPAs
let lastPath = location.pathname + location.search + location.hash;
const navObserver = new MutationObserver(() => {
  const currentPath = location.pathname + location.search + location.hash;
  if (currentPath !== lastPath) {
    lastPath = currentPath;
    console.log('[FormPilot] Path change detected, re-initializing...');
    debouncedInit();
  }
});
try {
  if (document.head) navObserver.observe(document.head, { childList: true, subtree: true });
  if (document.body) navObserver.observe(document.body, { childList: true });
} catch (err) {
  console.warn('[FormPilot] Could not attach navigation observer:', err.message);
}
