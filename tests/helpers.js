// Shared setup for the browser tests.
// The tests never contact Base44: the app's config is replaced in the page before it loads.
//   TEST_MODE=local  → no Base44 app id (browser-only mode, original storage keys)
//   TEST_MODE=shared → a fake app id (shared mode, keys end in @<app id>, signed out, no network)
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const MODE = process.env.TEST_MODE === 'shared' ? 'shared' : 'local';
const ROOT = path.resolve(__dirname, '..');
const FILE = 'file://' + path.join(ROOT, 'index.html');
const OUT = path.join(__dirname, 'output', MODE);
const FIXTURES = path.join(__dirname, 'fixtures');
fs.mkdirSync(OUT, { recursive: true });

const TEST_APP_ID = 'ci-test-app-000000000000';
const CONFIGS = {
  local: { base44AppId: '' },
  shared: { base44AppId: TEST_APP_ID, base44AppBaseUrl: 'https://preview--ci-test.base44.invalid', base44ServerUrl: 'https://preview--ci-test.base44.invalid' }
};

// Replaces window.EVERCRAFT_CONFIG (set by js/config.js) with the test values.
function configScript(overrides) {
  return `Object.defineProperty(window,'EVERCRAFT_CONFIG',{configurable:true,set(v){this.__testConfig={...v,...${JSON.stringify(overrides)}}},get(){return this.__testConfig}});`;
}
// Signed-out Base44 SDK: every call is refused, nothing is loaded from the network.
const SIGNED_OUT_SDK = `window.__EVERCRAFT_BASE44_SDK = window.__EVERCRAFT_BASE44_SDK || {createClient(){
  const no=()=>Promise.reject(Object.assign(new Error('HTTP 401'),{status:401}));
  const e={filter:no,list:no,get:no,create:no,update:no,delete:no,subscribe:()=>()=>{}};
  return {entities:new Proxy({},{get:()=>e}), auth:{me:no,updateMe:no,setToken(){},redirectToLogin(){},logout(){}}};
}};`;

// chromium.launch(), with the test config added to every new page.
// Pass { config } to use other config values (the cloud test uses its own fake app).
async function launch(opts = {}) {
  const executablePath = process.env.TEST_BROWSER || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  const browser = await chromium.launch({ executablePath });
  const config = opts.config || CONFIGS[MODE];
  const prepare = async ctx => {
    await ctx.addInitScript(configScript(config));
    if (!opts.config && MODE === 'shared') await ctx.addInitScript(SIGNED_OUT_SDK);
    return ctx;
  };
  const newContext = browser.newContext.bind(browser);
  // The browsers run in a European time zone (like the team's laptops), so the tests prove the
  // CRM uses Pacific time whatever the device is set to.
  browser.newContext = async (o) => prepare(await newContext({ timezoneId: DEVICE_TIME_ZONE, ...(o || {}) }));
  browser.newPage = async (o) => { const ctx = await browser.newContext(o); const p = await ctx.newPage(); p.close = async () => ctx.close(); return p; };
  return browser;
}

const DEVICE_TIME_ZONE = 'Europe/Kyiv';
// Today (or today + days) in Pacific time, the company's time zone: YYYY-MM-DD.
function pacificDate(days = 0) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  const t = new Date(Date.UTC(+p.year, +p.month - 1, +p.day + days));
  return t.toISOString().slice(0, 10);
}

module.exports = { MODE, ROOT, FILE, OUT, FIXTURES, TEST_APP_ID, SIGNED_OUT_SDK, DEVICE_TIME_ZONE, pacificDate, launch };
