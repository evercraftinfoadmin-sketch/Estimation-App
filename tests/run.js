// Runs every browser test suite and exits with an error if any check fails.
//   node run.js            all suites, in browser-only mode and in shared mode
//   node run.js crm photo  only these suites
const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = ['crm', 'category', 'lineedit', 'terms', 'photo', 'address', 'import', 'restore', 'delete', 'invoice', 'cloud', 'mailsend', 'signing', 'options', 'calendar', 'calpage', 'finance', 'finsync', 'mailworker', 'signworker', 'calworker'];
const SHARED_ONLY = new Set(['cloud', 'mailsend', 'signing', 'options', 'calendar', 'calpage', 'finsync']); // use their own fake services
const NODE_ONLY = new Set(['mailworker', 'signworker', 'calworker']); // the mail and signing service
const only = process.argv.slice(2);
const runs = [];
for (const s of SUITES.filter(s => !only.length || only.includes(s))) {
  for (const mode of NODE_ONLY.has(s) ? ['node'] : SHARED_ONLY.has(s) ? ['shared'] : ['local', 'shared']) runs.push([s, mode]);
}

let failed = 0;
const rows = [];
for (const [suite, mode] of runs) {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'suites', suite + '.test.js')], {
    env: { ...process.env, TEST_MODE: mode }, encoding: 'utf8', timeout: 10 * 60 * 1000
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/(\d+) passed, (\d+) failed\s*$/);
  const ok = r.status === 0 && m && m[2] === '0';
  if (!ok) {
    failed++;
    console.log(`\n--- ${suite} (${mode}) ---`);
    console.log(out.split('\n').filter(l => !l.startsWith('PASS ')).join('\n').trim());
  }
  rows.push(`${ok ? 'ok  ' : 'FAIL'}  ${suite.padEnd(9)} ${mode.padEnd(7)} ${m ? `${m[1]} passed, ${m[2]} failed` : 'did not finish (exit ' + r.status + ')'}`);
}
console.log('\n' + rows.join('\n'));
console.log(failed ? `\n${failed} of ${runs.length} runs failed` : `\nall ${runs.length} runs passed`);
process.exit(failed ? 1 : 0);
