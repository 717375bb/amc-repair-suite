#!/usr/bin/env node
// Companion to .devcontainer/setup.sh's Codespaces equivalent, for local
// double-click launches (Start-AMC-Repair-Suite.bat). Creates backend/.env
// from backend/.env.example if missing, and fills only genuinely-blank
// CREDENTIAL_ENCRYPTION_KEY / AUTOMATION_API_KEY with a fresh random value
// — never overwrites anything already set. .cjs extension is deliberate:
// root package.json has "type": "module", and this needs plain require().
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const repoRoot = path.join(__dirname, '..');
const envPath = path.join(repoRoot, 'backend', '.env');
const examplePath = path.join(repoRoot, 'backend', '.env.example');

if (!fs.existsSync(envPath)) {
  console.log('  No backend/.env found — copying from .env.example...');
  fs.copyFileSync(examplePath, envPath);
}

let content = fs.readFileSync(envPath, 'utf8');

function fillIfBlank(key) {
  const re = new RegExp(`^${key}=(.*)$`, 'm');
  const match = content.match(re);
  const current = match ? match[1].trim() : null;
  if (current === null) {
    const value = crypto.randomBytes(32).toString('hex');
    content += `\n${key}=${value}\n`;
    console.log(`  generated a fresh ${key} (was missing from .env)`);
  } else if (current === '') {
    const value = crypto.randomBytes(32).toString('hex');
    content = content.replace(re, `${key}=${value}`);
    console.log(`  generated a fresh ${key} (blank before)`);
  }
}

fillIfBlank('CREDENTIAL_ENCRYPTION_KEY');
fillIfBlank('AUTOMATION_API_KEY');

fs.writeFileSync(envPath, content);

const hasAnthropicKey = /^ANTHROPIC_API_KEY=.+$/m.test(content);
if (!hasAnthropicKey) {
  console.log('  [note] ANTHROPIC_API_KEY is blank in backend/.env — ESD Finder\'s');
  console.log('         AI classification step will fail until you set it there.');
  console.log('         Everything else (login, Order Write-Ups) still works.');
}

console.log('  backend/.env ready.');
