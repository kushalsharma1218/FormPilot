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

console.log(`[Job Autofill] Content script loaded on: ${location.hostname} (stored under: ${hostname})`);

let currentGlobalProfile = {};

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

// ── Field key helpers ──────────────────────────────────────────

// Detect auto-generated/unstable IDs (UUIDs, purely numeric, long opaque hashes)
// These change every page load so are useless as storage keys.
function isUnstableId(str) {
  if (!str) return false;
  const s = str.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) // UUID
    || /^\d+$/.test(s)                          // purely numeric
    || /^[a-z0-9]{20,}$/i.test(s);              // long opaque hash (no separators)
}

// Known sensitive field patterns — never save these
const SENSITIVE_RE = /ssn|social.?sec|\bsin\b|tax.?id|\bein\b|passport|bank.?acc|routing|\bcvv\b|credit.?card|debit|secret/i;

function getFieldKey(el) {
  // 1. aria-labelledby: resolve the label element's text
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const labelText = labelledBy.split(' ')
      .map(id => document.getElementById(id)?.innerText?.trim())
      .filter(Boolean).join(' ');
    if (labelText) return labelText;
  }

  // 2. label[for="ID"]
  if (el.id) {
    const label = document.querySelector(`label[for="${el.id}"]`);
    if (label && label.innerText.trim()) return label.innerText.trim();
  }

  // 3. Closest label parent
  const parentLabel = el.closest('label');
  if (parentLabel && parentLabel.innerText.trim()) return parentLabel.innerText.trim();

  // 4. Preceding sibling label (common in simple layouts)
  const prev = el.previousElementSibling;
  if (prev && (prev.tagName === 'LABEL' || prev.classList.contains('label'))) {
    if (prev.innerText.trim()) return prev.innerText.trim();
  }

  // 5. Prefer name > stable id > aria-label > placeholder
  const candidates = [
    el.name,
    el.id,
    el.getAttribute('aria-label'),
    el.placeholder,
  ];
  for (const c of candidates) {
    if (!c || !c.trim()) continue;
    if (isUnstableId(c.trim())) continue;
    return c.trim();
  }
  return null;
}

// Returns true if a field likely holds sensitive personal data we should never store
function isSensitiveField(el) {
  const key = el.name || el.id || el.getAttribute('aria-label') || el.placeholder || '';
  const label = el.getAttribute('aria-labelledby')
    ? (el.getAttribute('aria-labelledby').split(' ')
      .map(id => document.getElementById(id)?.innerText || '').join(' '))
    : '';
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

  console.log(`[Job Autofill] Workday fields captured:`, fields);
  return fields;
}

// ── General ATS display-field scraper ─────────────────────────
// For sites that render form data as label+value pairs in read-only
// display mode (common in many ATS review/confirmation pages)
function getDisplayFields() {
  const fields = {};

  // Pattern: <label>Text</label> followed by a sibling <span>/<div> with the value
  document.querySelectorAll('label').forEach(label => {
    const labelText = label.innerText?.trim()?.replace(/\*/g, '')?.trim();
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
      console.log(`[Job Autofill] Workday capture found ${Object.keys(wdFields).length} fields, skipping generic scan.`);
      return fields;
    }
  }

  // Exclude: hidden, submit, button, reset, file, PASSWORD (security!), single-char OTPs
  const selectors = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=file]):not([type=password]), textarea, select';

  // Handle radio buttons as a group — record the selected value per name
  const radioGroups = {};
  document.querySelectorAll('input[type=radio]').forEach(el => {
    if (!el.name) return;
    if (el.checked) radioGroups[el.name] = el.value;
  });
  Object.assign(fields, radioGroups);

  // ── Index-aware capture: duplicate keys get suffixed [0], [1], etc. ──
  const elements = [];
  document.querySelectorAll(selectors).forEach(el => {
    const type = (el.type || '').toLowerCase();
    if (type === 'radio') return;
    // Skip OTP-style single-character inputs
    if (type === 'text' && el.maxLength === 1) return;
    // Skip sensitive fields (SSN, bank, passport, etc.)
    if (isSensitiveField(el)) return;
    const key = getFieldKey(el);
    if (!key) return;
    elements.push({ el, key, type });
  });
  const keyCounts = {};
  elements.forEach(({ key }) => { keyCounts[key] = (keyCounts[key] || 0) + 1; });
  const keyIndex = {};
  elements.forEach(({ el, key, type }) => {
    keyIndex[key] = (keyIndex[key] || 0);
    const fieldKey = keyCounts[key] > 1 ? `${key}[${keyIndex[key]++}]` : key;

    if (type === 'checkbox') {
      fields[fieldKey] = el.checked ? 'true' : 'false';
    } else if (el.tagName === 'SELECT' && el.multiple) {
      const vals = Array.from(el.selectedOptions).map(o => o.value);
      if (vals.length) fields[fieldKey] = vals.join(',');
    } else if (el.tagName === 'SELECT') {
      // Skip placeholder options (empty value or value === text like "-- Select --")
      const opt = el.options[el.selectedIndex];
      const val = el.value;
      if (val && opt && opt.value !== '' && !/^[-\s]*(select|choose|pick)/i.test(opt.text)) {
        fields[fieldKey] = val;
      }
    } else {
      const value = el.value.trim();
      // Skip if value matches the placeholder exactly (browser autofill ghost text)
      if (value && value !== el.placeholder) {
        fields[fieldKey] = value;
      }
    }
  });

  // ── Custom ARIA comboboxes (index-aware) ──
  const comboEls = [];
  document.querySelectorAll('[role="combobox"]').forEach(el => {
    const key = getFieldKey(el);
    if (!key) return;
    comboEls.push({ el, key });
  });
  const comboCounts = {};
  comboEls.forEach(({ key }) => { comboCounts[key] = (comboCounts[key] || 0) + 1; });
  const comboIndex = {};
  comboEls.forEach(({ el, key }) => {
    comboIndex[key] = (comboIndex[key] || 0);
    const fieldKey = comboCounts[key] > 1 ? `${key}[${comboIndex[key]++}]` : key;
    const inputChild = el.tagName === 'INPUT' ? el : el.querySelector('input');
    if (inputChild && inputChild.value.trim()) {
      fields[fieldKey] = inputChild.value.trim();
      return;
    }
    const text = el.getAttribute('aria-valuenow')
      || el.getAttribute('data-value')
      || el.innerText?.trim();
    if (text) fields[fieldKey] = text;
  });

  // ── ARIA listboxes ──
  document.querySelectorAll('[role="listbox"]').forEach(listbox => {
    const key = getFieldKey(listbox);
    const selected = listbox.querySelectorAll('[role="option"][aria-selected="true"]');
    if (selected.length === 0 || !key) return;
    const values = Array.from(selected).map(o =>
      o.getAttribute('data-value') || o.getAttribute('value') || o.innerText?.trim()
    ).filter(Boolean);
    if (values.length) fields[key] = values.join(',');
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

function fillFields(savedFields) {
  // Exclude: hidden, submit, button, reset, file, PASSWORD (security!), single-char OTPs
  const selectors = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=file]):not([type=password]), textarea, select';

  // Radio buttons
  document.querySelectorAll('input[type=radio]').forEach(el => {
    if (!el.name || !(el.name in savedFields)) return;
    if (el.value === savedFields[el.name]) {
      el.checked = true;
      triggerEvents(el);
    }
  });

  // Build same index-aware key map as in getFormFields so positions match
  const elements = [];
  document.querySelectorAll(selectors).forEach(el => {
    const type = (el.type || '').toLowerCase();
    if (type === 'radio') return;
    const key = getFieldKey(el);
    if (!key) return;
    elements.push({ el, key, type });
  });
  const keyCounts = {};
  elements.forEach(({ key }) => { keyCounts[key] = (keyCounts[key] || 0) + 1; });
  const keyIndex = {};
  elements.forEach(({ el, key, type }) => {
    const isDuplicate = keyCounts[key] > 1;
    keyIndex[key] = (keyIndex[key] || 0);
    const fieldKey = isDuplicate ? `${key}[${keyIndex[key]++}]` : key;
    let val = savedFields[fieldKey];
    if (val === undefined) val = getGlobalMatch(fieldKey);
    if (val === undefined || val === null) return;

    if (type === 'checkbox') {
      el.checked = val === 'true' || val === true;
      triggerEvents(el);
    } else if (el.tagName === 'SELECT' && el.multiple) {
      const vals = String(val).split(',');
      Array.from(el.options).forEach(opt => { opt.selected = vals.includes(opt.value); });
      triggerEvents(el);
    } else {
      // Only fill if the field is currently empty — don't overwrite fresh user input
      const currentVal = el.tagName === 'SELECT' ? el.value : el.value.trim();
      if (currentVal) return;
      setNativeValue(el, val);
      triggerEvents(el);
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }
  });

  // ── Custom ARIA comboboxes (index-aware) ───────────────────────
  const comboboxEls = [];
  document.querySelectorAll('[role="combobox"]').forEach(el => {
    const key = getFieldKey(el);
    if (!key) return;
    comboboxEls.push({ el, key });
  });
  const comboKeyCounts = {};
  comboboxEls.forEach(({ key }) => { comboKeyCounts[key] = (comboKeyCounts[key] || 0) + 1; });
  const comboKeyIndex = {};
  comboboxEls.forEach(({ el, key }) => {
    const isDuplicate = comboKeyCounts[key] > 1;
    comboKeyIndex[key] = (comboKeyIndex[key] || 0);
    const fieldKey = isDuplicate ? `${key}[${comboKeyIndex[key]++}]` : key;
    let val = savedFields[fieldKey];
    if (val === undefined) val = getGlobalMatch(fieldKey);
    if (val === undefined || val === null) return;

    const inputChild = el.tagName === 'INPUT' ? el : el.querySelector('input');
    if (inputChild) {
      setNativeValue(inputChild, val);
      triggerEvents(inputChild);
      return;
    }
    el.click();
    setTimeout(() => {
      const allOptions = document.querySelectorAll('[role="option"]');
      for (const opt of allOptions) {
        const optVal = opt.getAttribute('data-value') || opt.getAttribute('value') || opt.innerText?.trim();
        if (optVal === val) { opt.click(); break; }
      }
    }, 150);
  });

  // ── Custom ARIA listboxes (already expanded) ───────────────────
  document.querySelectorAll('[role="listbox"]').forEach(listbox => {
    const key = getFieldKey(listbox);
    if (!key) return;
    let val = savedFields[key];
    if (val === undefined) val = getGlobalMatch(key);
    if (val === undefined || val === null) return;
    const vals = String(val).split(',');
    listbox.querySelectorAll('[role="option"]').forEach(opt => {
      const optVal = opt.getAttribute('data-value') || opt.getAttribute('value') || opt.innerText?.trim();
      if (vals.includes(optVal) && opt.getAttribute('aria-selected') !== 'true') opt.click();
    });
  });

  // ── MutationObserver: fill fields added dynamically (conditional logic, "+ Add job") ──
  // Disconnect any previous observer so we don't stack them
  if (window._jaObserver) window._jaObserver.disconnect();
  let observerTimer;
  window._jaObserver = new MutationObserver(() => {
    clearTimeout(observerTimer);
    // Debounce: wait for DOM to settle before re-filling
    observerTimer = setTimeout(() => {
      fillStandardFields(savedFields);
    }, 300);
  });
  window._jaObserver.observe(document.body, { childList: true, subtree: true, attributes: false });

  // Stop observing after 30s (form is likely done changing by then)
  setTimeout(() => window._jaObserver?.disconnect(), 30000);
}

// Fills only standard (non-ARIA) fields — used by MutationObserver re-runs
function fillStandardFields(savedFields) {
  const selectors = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=file]):not([type=password]), textarea, select';
  const elements = [];
  document.querySelectorAll(selectors).forEach(el => {
    const type = (el.type || '').toLowerCase();
    if (type === 'radio') return;
    if (type === 'text' && el.maxLength === 1) return;
    const key = getFieldKey(el);
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
    if (type === 'checkbox') {
      el.checked = val === 'true' || val === true;
      triggerEvents(el);
    } else {
      setNativeValue(el, val);
      triggerEvents(el);
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }
  });
}

// ── Banner UI ──────────────────────────────────────────────────
function showAutofillBanner(savedFields) {
  if (document.getElementById('ja-banner')) return;
  // Don't show if user already skipped or accepted during this session
  if (sessionStorage.getItem('ja_autofill_dismissed') === 'true') {
    console.log('[Job Autofill] Autofill banner already dismissed this session, skipping.');
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
        font-family: 'Inter', system-ui, sans-serif;
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
      <strong>Job Autofill</strong>
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
    sessionStorage.setItem('ja_autofill_dismissed', 'true');
    fillFields(savedFields);
    banner.remove();
  };
  document.getElementById('ja-no').onclick = () => {
    sessionStorage.setItem('ja_autofill_dismissed', 'true');
    banner.remove();
  };
  document.getElementById('ja-never').onclick = () => {
    sessionStorage.setItem('ja_autofill_dismissed', 'true');
    chrome.runtime.sendMessage({ type: 'DISABLE_SITE', hostname });
    banner.remove();
  };

  // Auto-dismiss after 12s — also remember so it doesn't pop up again
  setTimeout(() => {
    const b = document.getElementById('ja-banner');
    if (b) {
      sessionStorage.setItem('ja_autofill_dismissed', 'true');
      b.remove();
    }
  }, 12000);
}

// ── Save Data Prompt ──────────────────────────────────────────
function showSaveDataBanner(fields) {
  if (document.getElementById('ja-save-banner')) return;
  if (sessionStorage.getItem('ja_prompt_skipped') === 'true') return;

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
        font-family: 'Inter', system-ui, sans-serif;
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
    sessionStorage.setItem('ja_prompt_skipped', 'true');
    banner.remove();
  };
  document.getElementById('ja-save-no').onmousedown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    sessionStorage.setItem('ja_prompt_skipped', 'true');
    banner.remove();
  };
  document.getElementById('ja-save-never').onmousedown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: 'DISABLE_SITE', hostname });
    banner.remove();
  };

  // Auto-dismiss after 12s
  setTimeout(() => {
    const b = document.getElementById('ja-save-banner');
    if (b) {
      sessionStorage.setItem('ja_prompt_skipped', 'true');
      b.remove();
    }
  }, 12000);
}

// ── Recording: capture on form submit or button click ─────────
function attachRecorder() {
  // Debounce: prevent double-banner when BOTH mousedown + submit events fire
  // for the same button click (common on native HTML forms)
  let submissionDebounceTimer = null;

  const handleSubmission = (source) => {
    if (submissionDebounceTimer) return; // already handling this click
    submissionDebounceTimer = setTimeout(() => { submissionDebounceTimer = null; }, 600);

    console.log(`[Job Autofill] Intercepted submission via: ${source}`);
    const fields = getFormFields();
    console.log(`[Job Autofill] Captured fields:`, fields);

    if (Object.keys(fields).length > 0) {
      // If user previously clicked Save on page 1, silently save page 2+ data
      if (sessionStorage.getItem('ja_prompt_skipped') === 'true') {
        console.log(`[Job Autofill] Banner skipped this session. Silently saving data.`);
        chrome.runtime.sendMessage({ type: 'SAVE_FIELDS', hostname, fields });
      } else {
        console.log(`[Job Autofill] Prompting to save data.`);
        showSaveDataBanner(fields);
      }
    } else {
      console.log(`[Job Autofill] No fields found, skipping prompt.`);
    }
  };

  // Intercept standard form submits
  document.addEventListener('submit', (e) => {
    handleSubmission('submit event');
  }, true);

  // Use mousedown instead of click to beat event.stopPropagation() from modern frameworks
  document.addEventListener('mousedown', (e) => {
    let el = e.target;
    let isSubmit = false;

    // traverse up to catch icons inside buttons (5 levels for nested ATS UIs)
    let depth = 0;
    while (el && el !== document.body && depth < 5) {
      const tagName = (el.tagName || '').toUpperCase();
      const type = (el.type || '').toLowerCase();

      // Workday-specific: detect buttons by data-automation-id
      const autoId = el.getAttribute?.('data-automation-id') || '';
      if (/pageFooterNextButton|pageFooterSubmitButton|bottom-navigation-next/i.test(autoId)) {
        isSubmit = true;
        break;
      }

      if (tagName === 'BUTTON' || (tagName === 'INPUT' && (type === 'submit' || type === 'button'))) {
        const text = (el.innerText || el.value || '').toLowerCase();
        if (/(submit|apply|save|continue|next|send)/i.test(text)) {
          isSubmit = true;
          break;
        }
      }
      if (el.getAttribute && el.getAttribute('role') === 'button') {
        const text = (el.innerText || '').toLowerCase();
        if (/(submit|apply|save|continue|next|send)/i.test(text)) {
          isSubmit = true;
          break;
        }
      }
      el = el.parentElement;
      depth++;
    }

    if (isSubmit) {
      handleSubmission('button mousedown');
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
        chrome.runtime.sendMessage({ type: 'SAVE_FIELDS', hostname, fields })
          .then(() => sendResponse({ ok: true, count }))
          .catch(() => sendResponse({ ok: false, count: 0 }));
      } else {
        sendResponse({ ok: false, count: 0 });
      }
    } catch (err) {
      console.error('[Job Autofill] MANUAL_SAVE error:', err);
      sendResponse({ ok: false, count: 0 });
    }
    return true;
  }

  if (msg.type === 'MANUAL_AUTOFILL') {
    chrome.runtime.sendMessage({ type: 'GET_SITE_DATA', hostname })
      .then(resp => {
        if (resp?.site?.fields && Object.keys(resp.site.fields).length > 0) {
          fillFields(resp.site.fields);
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false });
        }
      })
      .catch(err => {
        console.error('[Job Autofill] MANUAL_AUTOFILL error:', err);
        sendResponse({ ok: false });
      });
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
    console.log(`[Job Autofill] Initializing on ${location.href}`);

    const resp = await chrome.runtime.sendMessage({ type: 'GET_SITE_DATA', hostname });
    const site = resp?.site;
    if (site?.disabled) {
      console.log(`[Job Autofill] Extension explicitly disabled for this site.`);
      return;
    }

    // Always attach the recorder so we can prompt to save on any site
    attachRecorder();

    const profileResp = await chrome.runtime.sendMessage({ type: 'GET_GLOBAL_PROFILE' });
    currentGlobalProfile = profileResp?.profile || {};

    if (!site?.enabled) return;

    const savedCount = Object.keys(site.fields || {}).length;
    const globalCount = Object.keys(currentGlobalProfile || {}).length;
    if (savedCount > 0 || globalCount > 0) {
      // Small delay to let the page fully render
      setTimeout(() => showAutofillBanner(site.fields || {}), 800);
    }
  } catch (err) {
    // Extension context invalidated (e.g., extension was updated/reloaded)
    if (err.message?.includes('Extension context invalidated')) {
      console.log('[Job Autofill] Extension context invalidated, stopping.');
      return;
    }
    console.error('[Job Autofill] Init error:', err);
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
  console.log('[Job Autofill] Hash change detected, re-initializing...');
  debouncedInit();
});

// Watch for path changes in SPAs
let lastPath = location.pathname + location.search + location.hash;
const navObserver = new MutationObserver(() => {
  const currentPath = location.pathname + location.search + location.hash;
  if (currentPath !== lastPath) {
    lastPath = currentPath;
    console.log('[Job Autofill] Path change detected, re-initializing...');
    debouncedInit();
  }
});
try {
  if (document.head) navObserver.observe(document.head, { childList: true, subtree: true });
  if (document.body) navObserver.observe(document.body, { childList: true });
} catch (err) {
  console.warn('[Job Autofill] Could not attach navigation observer:', err.message);
}
