#!/usr/bin/env node
/**
 * scripts/health-check.js — one command that answers "is this extension healthy?"
 *
 * Exists because the failures that actually hurt this project were invisible to
 * a green test suite: a duplicate top-level `const` that killed the service
 * worker before it ran, a settings panel implemented against element ids that
 * did not exist, a matcher that filled an employer name into a field measured in
 * days. Each file parsed fine; each check below is the thing that would have
 * caught it.
 *
 * Prints METRICS, not just pass/fail, so a human or an agent can see movement
 * over time rather than a bare red/green. Exits non-zero if anything is broken.
 *
 *   npm run health            full report
 *   npm run health -- --json  machine-readable, for automation
 */
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const JSON_OUT = process.argv.includes('--json');
const ACCEPT = process.argv.includes('--accept');

// A ratchet, not a floor. An absolute threshold lets quality erode right up to
// the line: removing one veto term dropped precision 100% -> 96.4% and still
// "passed" a >= 95% check. Comparing against the best previously achieved means
// any regression is a failure, however small.
const BASELINE_PATH = path.join(ROOT, 'tests/fixtures/quality-baseline.json');
const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));

const results = [];
function record(name, ok, detail, metrics) {
  results.push({ name, ok, detail, metrics: metrics || null });
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', ...opts });
}

// ── 1. Everything parses ──────────────────────────────────────
function checkSyntax() {
  const skip = /node_modules|pdf(\.worker)?\.min\.js/;
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (skip.test(full)) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  })(ROOT);

  const broken = [];
  for (const f of files) {
    try { run(process.execPath, ['--check', f]); }
    catch (err) { broken.push(path.relative(ROOT, f)); }
  }
  record('syntax', broken.length === 0, broken.length ? `cannot parse: ${broken.join(', ')}` : `${files.length} files parse`, { files: files.length });
}

// ── 2. Test suite ─────────────────────────────────────────────
function checkTests() {
  let out = '';
  let ok = true;
  try { out = run('npm', ['test', '--silent']); }
  catch (err) { out = `${err.stdout || ''}${err.stderr || ''}`; ok = false; }
  const pass = (out.match(/^✔/gm) || []).length;
  const fail = (out.match(/^✖/gm) || []).length;
  const names = [...out.matchAll(/^✖ (.+?) \(/gm)].map((m) => m[1]);
  record('tests', ok && fail === 0,
    fail ? `${fail} failing: ${[...new Set(names)].join('; ')}` : `${pass} passing`,
    { passing: pass, failing: fail });
}

// ── 3. Matching quality, as numbers ───────────────────────────
function checkMatching() {
  const FieldMatch = require(path.join(ROOT, 'lib/field-match.js'));
  const { profile, cases } = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'tests/fixtures/field-match-cases.json'), 'utf8'));

  let tp = 0, fp = 0, fn = 0;
  const wrong = [];
  for (const c of cases) {
    const got = (FieldMatch.matchField(c, profile) || {}).key || null;
    if (got === c.expect) { if (c.expect) tp++; continue; }
    if (got && !c.expect) { fp++; wrong.push(`filled "${c.label}" with ${got}`); }
    else if (!got && c.expect) { fn++; wrong.push(`missed "${c.label}"`); }
    else { fp++; fn++; wrong.push(`"${c.label}" -> ${got}, want ${c.expect}`); }
  }
  const precision = +(100 * (tp / (tp + fp || 1))).toFixed(1);
  const recall = +(100 * (tp / (tp + fn || 1))).toFixed(1);
  const want = baseline.matching;
  const ok = precision >= want.precision && recall >= want.recall;
  record('matching', ok,
    `precision ${precision}% (baseline ${want.precision}%), recall ${recall}% (baseline ${want.recall}%) over ${cases.length} cases` +
      (wrong.length ? ` — ${wrong.slice(0, 3).join('; ')}` : ''),
    { precision, recall, cases: cases.length });
}

function checkDropdowns() {
  const Vocab = require(path.join(ROOT, 'lib/value-vocab.js'));
  const { cases } = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'tests/fixtures/dropdown-cases.json'), 'utf8'));
  let ok = 0;
  const wrong = [];
  for (const c of cases) {
    const opts = c.options.filter((o) => !/^select/i.test(o)).map((t) => ({ text: t, value: '' }));
    const chosen = Vocab.chooseOption(c.valueType, c.saved, opts);
    const got = chosen ? chosen.option.text : null;
    if (got === c.expect) ok++;
    else wrong.push(`${c.valueType} "${c.saved}" -> ${got}`);
  }
  const want = baseline.dropdowns;
  record('dropdowns', ok >= want.correct,
    `${ok}/${cases.length} correct (baseline ${want.correct})` + (wrong.length ? ` — ${wrong.slice(0, 3).join('; ')}` : ''),
    { correct: ok, total: cases.length });
}

// ── 4. Nothing secret is about to ship ────────────────────────
function checkSecrets() {
  const patterns = /gsk_[A-Za-z0-9]{10,}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}/;
  let tracked = [];
  try { tracked = run('git', ['ls-files']).split('\n').filter(Boolean); } catch (_) { }
  const hits = [];
  for (const f of tracked) {
    if (!/\.(js|json|html|md|ya?ml)$/.test(f)) continue;
    const full = path.join(ROOT, f);
    if (!fs.existsSync(full)) continue;
    if (patterns.test(fs.readFileSync(full, 'utf8'))) hits.push(f);
  }
  // config.private.js must never become tracked.
  const leaked = tracked.includes('config.private.js');
  record('secrets', hits.length === 0 && !leaked,
    leaked ? 'config.private.js is TRACKED' : hits.length ? `possible key in: ${hits.join(', ')}` : `${tracked.length} tracked files clean`,
    { scanned: tracked.length });
}

// ── 5. The manifest still points at files that exist ──────────
function checkManifest() {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const referenced = [
    m.background && m.background.service_worker,
    m.action && m.action.default_popup,
    m.options_ui && m.options_ui.page,
    ...(m.content_scripts || []).flatMap((c) => c.js || []),
    ...(m.web_accessible_resources || []).flatMap((w) => w.resources || []),
    ...Object.values(m.icons || {}),
  ].filter(Boolean);

  const missing = referenced.filter((p) => !fs.existsSync(path.join(ROOT, p)));
  // Permissions that were removed as unused — flag if they creep back without cause.
  const unexpected = (m.permissions || []).filter((p) => ['sidePanel', 'scripting', 'activeTab'].includes(p));
  const noCsp = !m.content_security_policy;

  const problems = [];
  if (missing.length) problems.push(`missing files: ${missing.join(', ')}`);
  if (unexpected.length) problems.push(`unused permissions back: ${unexpected.join(', ')}`);
  if (noCsp) problems.push('no content_security_policy declared');
  record('manifest', problems.length === 0, problems.join('; ') || `${referenced.length} referenced files present`,
    { referenced: referenced.length, permissions: (m.permissions || []).length });
}

// ── Report ────────────────────────────────────────────────────
const checks = [checkSyntax, checkTests, checkMatching, checkDropdowns, checkSecrets, checkManifest];
for (const check of checks) {
  try { check(); }
  catch (err) { record(check.name, false, `check threw: ${err.message}`); }
}

const healthy = results.every((r) => r.ok);

if (ACCEPT) {
  const m = (results.find((r) => r.name === 'matching') || {}).metrics;
  const d = (results.find((r) => r.name === 'dropdowns') || {}).metrics;
  if (m && d) {
    const next = {
      _comment: baseline._comment,
      matching: { precision: m.precision, recall: m.recall },
      dropdowns: { correct: d.correct, total: d.total },
    };
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + '\n');
    console.log(`  baseline updated -> precision ${m.precision}%, recall ${m.recall}%, dropdowns ${d.correct}/${d.total}`);
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({
    healthy,
    at: new Date().toISOString(),
    checks: results,
  }, null, 2));
} else {
  console.log('\n  FormPilot health\n');
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(11)} ${r.detail}`);
  }
  console.log(`\n  ${healthy ? 'healthy' : 'NEEDS ATTENTION'}\n`);
}

process.exit(healthy ? 0 : 1);
