// Checks that js/config.js points at the right Base44 app for the branch, and that no secret is committed.
//   node check-config.js [branch]   (default: $GITHUB_REF_NAME, else the current git branch)
// main → production app only. Every other branch → the dev app, or no app.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APPS = {
  production: { base44AppId: '6aceadfed0aa786c7c2934ff', base44AppBaseUrl: 'https://ever-craft-crm-7c2934ff.base44.app', base44ServerUrl: '' },
  dev: { base44AppId: '6acd6d429d6ed1576d7696b7', base44AppBaseUrl: 'https://preview--ever-craft-crm-dev-6d7696b7.base44.app', base44ServerUrl: 'https://preview--ever-craft-crm-dev-6d7696b7.base44.app' }
};
const PRODUCTION_BRANCHES = ['main'];

let branch = process.argv[2] || process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME;
if (!branch) { try { branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT }).toString().trim(); } catch (e) { branch = ''; } }

const problems = [];
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'js/config.js'), 'utf8'), sandbox);
const cfg = sandbox.window.EVERCRAFT_CONFIG || {};
const pick = c => ({ base44AppId: c.base44AppId || '', base44AppBaseUrl: c.base44AppBaseUrl || '', base44ServerUrl: c.base44ServerUrl || '' });
const same = (a, b) => JSON.stringify(pick(a)) === JSON.stringify(pick(b));

const isProduction = PRODUCTION_BRANCHES.includes(branch);
if (isProduction && !same(cfg, APPS.production)) problems.push(`branch ${branch} must use the production Base44 app ${APPS.production.base44AppId}`);
if (!isProduction && cfg.base44AppId && !same(cfg, APPS.dev)) problems.push(`branch ${branch || '(unknown)'} must use the dev Base44 app ${APPS.dev.base44AppId} or none (found ${cfg.base44AppId})`);
if (cfg.googleMapsApiKey && cfg.googleMapsApiKey !== 'YOUR_RESTRICTED_API_KEY') problems.push('js/config.js contains a Google Maps key; keep the placeholder (the key is entered per browser)');

// No secrets anywhere in the app files.
const SECRET_PATTERNS = [
  [/AIza[0-9A-Za-z_-]{35}/, 'Google API key'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'sign-in token (JWT)'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\b(api[_-]?key|secret|password)\s*[:=]\s*["'][^"'\s]{16,}["']/i, 'hard-coded secret']
];
const files = execSync('git ls-files', { cwd: ROOT }).toString().split('\n')
  .filter(f => f && !f.startsWith('tests/') && /\.(js|html|css|json|md)$/.test(f));
for (const f of files) {
  const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const [re, what] of SECRET_PATTERNS) if (re.test(text)) problems.push(`${f}: looks like a ${what}`);
}

const env = isProduction ? 'production' : (cfg.base44AppId ? 'dev' : 'browser only');
if (problems.length) { console.log(`config check FAILED (branch ${branch}):\n- ` + problems.join('\n- ')); process.exit(1); }
console.log(`config check ok: branch ${branch} → ${env} (${cfg.base44AppId || 'no Base44 app'}); ${files.length} files scanned, no secrets found`);
