const { chromium } = require('playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');

const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'formpilot-e2e-'));

const DEFAULT_PROFILE = {
  firstName: 'Kushal',
  lastName: 'Sharma',
  email: 'kushal@example.com',
  phone: '555-111-2222',
  linkedin: 'https://linkedin.com/in/kushal',
  country: 'United States',
  workMode: 'Remote',
  preferredRole: 'Frontend Engineer',
};

const DEFAULT_URLS = [
  'https://job-boards.greenhouse.io/doordashcanada/jobs/5704481',
  'https://jobs.lever.co/lever/2b5f5f6a-3a39-4b4a-9f53-4e3c9cf5d6e1',
  'https://boards.greenhouse.io/airbnb/jobs/4986661',
  'https://jobs.ashbyhq.com/ashby/9e7dfb57-8f32-4c9a-9b4e-1b9f7a4e0b2e',
  'https://apply.workable.com/workable/j/3D7E9C3F1F',
  'https://boards.greenhouse.io/stripe/jobs/5634882',
  'https://jobs.lever.co/notion/2b2a1f60-1f9b-4d9d-8c23-8fd4f75d4d52',
  'https://jobs.smartrecruiters.com/SmartRecruiters/743999970334656-senior-frontend-engineer',
  'https://recruiting2.ultipro.com/SOM1001SOM/JobBoard/4b743d28-7c7d-4f8a-9f2f-0c7de24bfe77/OpportunityDetail?opportunityId=3d1a2a10-0bf0-49e4-b31e-9a1e4b2d8f20',
  'https://careers.google.com/jobs/results/1234567890/',
];

const URLS = (process.env.JOB_TEST_URLS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const TEST_URLS = URLS.length ? URLS : DEFAULT_URLS;

const LABEL_MATCHERS = [
  { key: 'firstName', pattern: /first\s*name|given\s*name/i },
  { key: 'lastName', pattern: /last\s*name|family\s*name|surname/i },
  { key: 'email', pattern: /email/i },
  { key: 'phone', pattern: /phone|mobile|tel/i },
  { key: 'linkedin', pattern: /linkedin/i },
  { key: 'country', pattern: /country/i },
  { key: 'workMode', pattern: /work\s*mode|remote|onsite|hybrid/i },
  { key: 'preferredRole', pattern: /role|position|job\s*title/i },
];

async function getExtensionId(context) {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const url = worker.url();
  const match = url.match(/chrome-extension:\/\/(.*?)\//);
  if (!match) throw new Error(`Could not determine extension id from ${url}`);
  return match[1];
}

async function seedProfile(context, extensionId, profile) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/dashboard/dashboard.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async (payload) => {
    await chrome.runtime.sendMessage({ type: 'SAVE_GLOBAL_PROFILE', profile: payload });
  }, profile);
  await page.close();
}

async function evaluateFormState(frame, profile) {
  return frame.evaluate((profile, matchers) => {
    const results = {
      filled: 0,
      totalCandidates: 0,
      matches: [],
      overlays: {
        coverage: !!document.getElementById('ja-coverage-banner'),
        review: !!document.getElementById('ja-review-panel'),
        prompt: !!document.getElementById('ja-job-context-prompt'),
      },
    };

    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const clean = (v) => (v || '').toString().trim();

    const getLabelText = (el) => {
      const aria = clean(el.getAttribute?.('aria-label'));
      if (aria) return aria;
      const labelledby = clean(el.getAttribute?.('aria-labelledby'));
      if (labelledby) {
        return labelledby.split(' ')
          .map(id => clean(document.getElementById(id)?.innerText))
          .filter(Boolean)
          .join(' ');
      }
      if (el.id) {
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (label) return clean(label.innerText);
      }
      const wrap = el.closest?.('label');
      if (wrap) return clean(wrap.innerText);
      const placeholder = clean(el.getAttribute?.('placeholder'));
      if (placeholder) return placeholder;
      return clean(el.name) || clean(el.id) || '';
    };

    const fields = Array.from(document.querySelectorAll(
      'input, textarea, select, [contenteditable=\"true\"], [role=\"textbox\"], [role=\"combobox\"], [role=\"listbox\"], [aria-haspopup=\"listbox\"]'
    )).filter(isVisible);
    for (const field of fields) {
      const type = (field.getAttribute('type') || '').toLowerCase();
      if (type === 'password' || type === 'hidden' || type === 'submit' || type === 'button' || type === 'file') continue;
      const label = getLabelText(field);
      if (!label) continue;
      const matcher = matchers.find(m => m.pattern.test(label));
      if (!matcher) continue;
      results.totalCandidates += 1;
      const expected = profile[matcher.key];
      let value = '';
      if (field.tagName === 'SELECT') {
        value = clean(field.options?.[field.selectedIndex]?.text);
      } else if (field.getAttribute && (field.getAttribute('role') === 'listbox' || field.getAttribute('role') === 'combobox')) {
        value = clean(field.innerText || field.textContent);
      } else if (field.isContentEditable || field.getAttribute?.('contenteditable') === 'true') {
        value = clean(field.innerText || field.textContent);
      } else {
        value = clean(field.value);
      }
      const ok = expected && value && value.toLowerCase().includes(expected.toLowerCase());
      if (ok) results.filled += 1;
      results.matches.push({ label, value, expected, ok });
    }

    return results;
  }, profile, LABEL_MATCHERS);
}

async function clickIfPresent(page, selector) {
  try {
    const el = await page.$(selector);
    if (el) {
      await el.click({ timeout: 2000 });
      return true;
    }
  } catch (_) {}
  return false;
}

async function autoScroll(page) {
  try {
    await page.evaluate(async () => {
      await new Promise(resolve => {
        let total = 0;
        const distance = 600;
        const timer = setInterval(() => {
          window.scrollBy(0, distance);
          total += distance;
          if (total >= document.body.scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 150);
      });
    });
  } catch (_) {}
}

async function hasVisibleFields(page) {
  try {
    return await page.evaluate(() => {
      const isVisible = (el) => {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
    const fields = Array.from(document.querySelectorAll(
      'input, textarea, select, [contenteditable=\"true\"], [role=\"textbox\"], [role=\"combobox\"], [role=\"listbox\"], [aria-haspopup=\"listbox\"]'
    )).filter(isVisible);
      return fields.length > 0;
    });
  } catch (_) {
    return false;
  }
}

async function tryClickApply(page) {
  const context = page.context();
  // Try to accept cookie/consent banners first
  try {
    const consentSelectors = [
      'button:has-text("Accept")',
      'button:has-text("Agree")',
      'button:has-text("I Agree")',
      'button:has-text("OK")',
      'button:has-text("Got it")',
      'button:has-text("Allow all")',
      'button:has-text("Accept All")',
    ];
    for (const sel of consentSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.count()) {
        await btn.click({ timeout: 1500, force: true }).catch(() => {});
        break;
      }
    }
  } catch (_) {}

  // Try direct DOM click by text (works for custom elements)
  const domClicked = await page.evaluate(() => {
    const isVisible = (el) => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const candidates = Array.from(document.querySelectorAll('a,button,div,span'))
      .filter(el => isVisible(el) && /apply/i.test(el.innerText || ''));
    const target = candidates.find(el => /apply now|apply for|start application|apply/i.test(el.innerText || '')) || candidates[0];
    if (target) {
      target.click();
      return true;
    }
    return false;
  }).catch(() => false);

  if (domClicked) {
    await page.waitForTimeout(2500);
    if (await hasVisibleFields(page)) return page;
  }

  const candidates = [
    page.getByRole('button', { name: /apply/i }),
    page.getByRole('link', { name: /apply/i }),
    page.locator('a[href*=\"apply\"]'),
    page.locator('a[href*=\"application\"]'),
    page.locator('button:has-text(\"Apply\")'),
    page.locator('a:has-text(\"Apply\")'),
    page.locator('[data-automation-id*=\"apply\"], [data-ui*=\"apply\"], [data-test*=\"apply\"], [data-testid*=\"apply\"]'),
  ];

  for (const candidate of candidates) {
    try {
      if ((await candidate.count()) === 0) continue;
      const count = await candidate.count();
      const maxClicks = Math.min(count, 3);
      for (let i = 0; i < maxClicks; i++) {
        const handle = candidate.nth(i);
        const newPagePromise = context.waitForEvent('page', { timeout: 6000 }).catch(() => null);
        await handle.scrollIntoViewIfNeeded().catch(() => {});
        await handle.click({ timeout: 6000, force: true });
        const newPage = await newPagePromise;
        if (newPage) {
          await newPage.waitForLoadState('domcontentloaded', { timeout: 60000 });
          return newPage;
        }
        await page.waitForTimeout(3000);
        if (await hasVisibleFields(page)) return page;
      }
    } catch (_) {
      // try next candidate
    }
  }

  // Try to open explicit apply link href if available
  try {
    const href = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      const scored = anchors.map(a => {
        const text = (a.innerText || '').toLowerCase();
        const href = (a.getAttribute('href') || '').toLowerCase();
        let score = 0;
        if (/apply|application|candidate|submit/.test(text)) score += 2;
        if (/apply|application|jobs\/.*\/apply|\/applications\//.test(href)) score += 3;
        if (href.startsWith('#')) score -= 1;
        return { href: a.href, score };
      }).filter(x => x.score > 0);
      scored.sort((a, b) => b.score - a.score);
      return scored[0]?.href || null;
    });
    if (href) {
      const newPage = await page.context().newPage();
      await newPage.goto(href, { waitUntil: 'domcontentloaded', timeout: 90000 });
      return newPage;
    }
  } catch (_) {}

  return domClicked ? page : null;
}

async function tryOpenFrameApplication(page) {
  const frames = page.frames();
  const candidate = frames
    .map(f => f.url())
    .find(url => /apply|application|jobs|greenhouse|lever|workday|icims|taleo|jobvite|smartrecruiters|ashby|workable|bamboohr/i.test(url));
  if (!candidate || candidate === page.url()) return null;
  const newPage = await page.context().newPage();
  await newPage.goto(candidate, { waitUntil: 'domcontentloaded', timeout: 90000 });
  return newPage;
}

async function tryOpenApplyUrlFromHtml(page) {
  try {
    const urls = await page.evaluate(() => {
      const html = document.documentElement.innerHTML || '';
      const re = new RegExp('https?:\\\\/\\\\/[^\"\\s>]*(apply|application|applicant|jobApplication)[^\"\\s>]*', 'gi');
      const matches = html.match(re) || [];
      const unique = Array.from(new Set(matches)).slice(0, 5);
      return unique;
    });
    for (const url of urls) {
      if (!url || url === page.url()) continue;
      const newPage = await page.context().newPage();
      await newPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
      return newPage;
    }
  } catch (_) {}
  return null;
}

async function run() {
  console.log('[E2E] Launching Chromium with extension...');
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--disable-blink-features=AutomationControlled',
      '--disable-crashpad',
      '--no-crashpad',
      '--disable-breakpad',
      '--crash-dumps-dir=/tmp',
    ],
  });

  const extensionId = await getExtensionId(context);
  console.log('[E2E] Extension ID:', extensionId);
  await seedProfile(context, extensionId, DEFAULT_PROFILE);

  const results = [];
  for (const url of TEST_URLS) {
    const page = await context.newPage();
    const record = { url, status: 'unknown', filled: 0, total: 0, overlays: {}, matches: [] };
    try {
      console.log(`\n[E2E] Visiting: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForTimeout(5000);
      await autoScroll(page);
      await page.waitForTimeout(1500);

      // Try to open application flow if no fields are visible yet.
      let workingPage = page;
      let aggregate = { filled: 0, totalCandidates: 0, overlays: { coverage: false, review: false, prompt: false }, matches: [] };

      for (const frame of workingPage.frames()) {
        try {
          const res = await evaluateFormState(frame, DEFAULT_PROFILE);
          aggregate.filled += res.filled;
          aggregate.totalCandidates += res.totalCandidates;
          aggregate.overlays.coverage = aggregate.overlays.coverage || res.overlays.coverage;
          aggregate.overlays.review = aggregate.overlays.review || res.overlays.review;
          aggregate.overlays.prompt = aggregate.overlays.prompt || res.overlays.prompt;
          aggregate.matches.push(...res.matches);
        } catch (_) {}
      }

      if (aggregate.totalCandidates === 0) {
        const maybePage = await tryClickApply(page);
        if (maybePage && maybePage !== page) workingPage = maybePage;
      }

      if (workingPage === page && aggregate.totalCandidates === 0) {
        const framePage = await tryOpenFrameApplication(page);
        if (framePage) workingPage = framePage;
      }

      if (workingPage === page && aggregate.totalCandidates === 0) {
        const htmlPage = await tryOpenApplyUrlFromHtml(page);
        if (htmlPage) workingPage = htmlPage;
      }

      if (workingPage !== page) {
        await workingPage.waitForTimeout(3000);
        await autoScroll(workingPage);
        await workingPage.waitForTimeout(1500);
      }

      // Auto-confirm job context prompt / approval banner when present
      await clickIfPresent(workingPage, '#ja-job-yes');
      await clickIfPresent(workingPage, '#ja-approval-fill');
      await workingPage.waitForTimeout(2500);

      aggregate = { filled: 0, totalCandidates: 0, overlays: { coverage: false, review: false, prompt: false }, matches: [] };
      for (const frame of workingPage.frames()) {
        try {
          const res = await evaluateFormState(frame, DEFAULT_PROFILE);
          aggregate.filled += res.filled;
          aggregate.totalCandidates += res.totalCandidates;
          aggregate.overlays.coverage = aggregate.overlays.coverage || res.overlays.coverage;
          aggregate.overlays.review = aggregate.overlays.review || res.overlays.review;
          aggregate.overlays.prompt = aggregate.overlays.prompt || res.overlays.prompt;
          aggregate.matches.push(...res.matches);
        } catch (err) {
          // Ignore frame-level errors (cross-origin or blocked)
        }
      }

      record.filled = aggregate.filled;
      record.total = aggregate.totalCandidates;
      record.overlays = aggregate.overlays;
      record.matches = aggregate.matches;
      record.status = aggregate.filled > 0 ? 'pass' : (aggregate.totalCandidates > 0 ? 'partial' : 'no-fields-detected');

      if (record.status === 'no-fields-detected') {
        const frameUrls = workingPage.frames().map(f => f.url()).filter(Boolean);
        const debug = await workingPage.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a[href]'))
            .map(a => ({ text: (a.innerText || '').trim().slice(0, 60), href: a.href }))
            .filter(a => a.text || a.href)
            .slice(0, 10);
          const title = document.title;
          const applyTextCount = Array.from(document.querySelectorAll('a,button,div,span'))
            .filter(el => /apply/i.test(el.innerText || '')).length;
          return { title, links, applyTextCount };
        }).catch(() => ({}));
        record.debug = { frameUrls: frameUrls.slice(0, 10), ...debug };
      }
    } catch (err) {
      record.status = 'error';
      record.error = err.message || String(err);
    }
    results.push(record);
    await page.close();
  }

  await context.close();

  console.log('\n[E2E] Summary');
  results.forEach(r => {
    console.log(`- ${r.status.toUpperCase()} | ${r.url}`);
    console.log(`  fields: ${r.filled}/${r.total} | overlays: coverage=${r.overlays.coverage} review=${r.overlays.review} prompt=${r.overlays.prompt}`);
    if (r.status === 'error') console.log(`  error: ${r.error}`);
    if (r.status === 'no-fields-detected' && r.debug) {
      const info = r.debug;
      console.log(`  debug: title="${(info.title || '').slice(0, 80)}" applyTextCount=${info.applyTextCount || 0}`);
      if (info.frameUrls?.length) console.log(`  frameUrls: ${info.frameUrls.join(' | ')}`);
      if (info.links?.length) console.log(`  sampleLinks: ${info.links.map(l => l.href).join(' | ')}`);
    }
  });

  const passCount = results.filter(r => r.status === 'pass').length;
  const partialCount = results.filter(r => r.status === 'partial').length;
  const errorCount = results.filter(r => r.status === 'error').length;
  console.log(`\n[E2E] Pass: ${passCount}, Partial: ${partialCount}, Errors: ${errorCount}`);
}

run().catch(err => {
  console.error('[E2E] Fatal error:', err);
  process.exit(1);
});
