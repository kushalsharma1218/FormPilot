#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'manifest.json');
const keyPath = path.join(root, 'manifest.key');

if (!fs.existsSync(keyPath)) {
  console.error('Missing manifest.key. Create it first before running this script.');
  process.exit(1);
}

const key = fs.readFileSync(keyPath, 'utf8').trim();
if (!key) {
  console.error('manifest.key is empty.');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.key = key;

// Keep manifest_version first for readability
const ordered = {};
if (manifest.manifest_version) ordered.manifest_version = manifest.manifest_version;
ordered.key = manifest.key;
Object.keys(manifest).forEach((k) => {
  if (k === 'manifest_version' || k === 'key') return;
  ordered[k] = manifest[k];
});

fs.writeFileSync(manifestPath, JSON.stringify(ordered, null, 2) + '\n');
console.log('Applied manifest.key to manifest.json');
