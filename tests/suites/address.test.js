const { launch, FILE, OUT, FIXTURES, MODE } = require('../helpers');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m); };

// Fake Google Places API (New): same shapes as google.maps.importLibrary("places")
const MOCK = () => {
  const comps = o => [
    ['street_number', o.num], ['route', o.route], ['subpremise', o.sub], ['locality', o.city],
    ['administrative_area_level_1', o.stateLong, o.state], ['postal_code', o.zip], ['country', 'United States', 'US']
  ].filter(x => x[1]).map(([t, l, s]) => ({ types: [t], longText: l, shortText: s || l }));
  const P = {
    P1: { formattedAddress: '123 Main St, Los Angeles, CA 90012, USA', main: '123 Main St', secondary: 'Los Angeles, CA, USA', num: '123', route: 'Main St', city: 'Los Angeles', stateLong: 'California', state: 'CA', zip: '90012', lat: 34.0522, lng: -118.2437 },
    P4: { formattedAddress: '123 Main St, Glendale, CA 91203, USA', main: '123 Main St', secondary: 'Glendale, CA, USA', num: '123', route: 'Main St', city: 'Glendale', stateLong: 'California', state: 'CA', zip: '91203', lat: 34.1425, lng: -118.2551 },
    P2: { formattedAddress: '500 Rural Rd, Smalltown, CA, USA', main: '500 Rural Rd', secondary: 'Smalltown, CA, USA', num: '500', route: 'Rural Rd', city: 'Smalltown', stateLong: 'California', state: 'CA', lat: 36.1, lng: -119.2 },
    P3: { formattedAddress: '900 Tower Ave #12, Burbank, CA 91502, USA', main: '900 Tower Ave #12', secondary: 'Burbank, CA, USA', num: '900', route: 'Tower Ave', sub: '12', city: 'Burbank', stateLong: 'California', state: 'CA', zip: '91502', lat: 34.18, lng: -118.31 },
    P5: { formattedAddress: 'Main St, Los Angeles, CA, USA', main: 'Main St', secondary: 'Los Angeles, CA, USA', route: 'Main St', city: 'Los Angeles', stateLong: 'California', state: 'CA', lat: 34.05, lng: -118.25 },
    P6: { formattedAddress: '1 Nowhere Ln, Ghost, CA, USA', main: '1 Nowhere Ln', secondary: 'Ghost, CA, USA', num: '1', route: 'Nowhere Ln', city: 'Ghost', state: 'CA', lat: null },
    P7: { formattedAddress: '77 Oak Blvd, Pasadena, CA 91101, USA', main: '77 Oak Blvd', secondary: 'Pasadena, CA, USA', num: '77', route: 'Oak Blvd', city: 'Pasadena', stateLong: 'California', state: 'CA', zip: '91101', lat: 34.14, lng: -118.13 },
    PX: { formattedAddress: '5 <img src=x onerror=window.__xss=1> St, LA, CA 90001, USA', main: '5 <img src=x onerror=window.__xss=1> St', secondary: 'LA', num: '5', route: '<img src=x onerror=window.__xss=1> St', city: 'LA', state: 'CA', zip: '90001', lat: 34, lng: -118 }
  };
  const rules = q => {
    q = q.toLowerCase();
    if (q.includes('zzz')) return [];
    if (q.includes('xss')) return ['PX'];
    if (q.includes('rural')) return ['P2'];
    if (q.includes('tower')) return ['P3'];
    if (q.includes('nowhere')) return ['P6'];
    if (q.includes('oak')) return ['P7'];
    if (q.startsWith('main st')) return ['P5', 'P1', 'P4'];
    if (q.includes('123 m')) return ['P1', 'P4'];
    return [];
  };
  window.__places = { mode: 'ok', calls: 0, details: 0, tokens: [], regions: null };
  class Token {}
  class FakePlace {
    constructor(id) { this.id = id; }
    async fetchFields({ fields }) {
      window.__places.details++;
      window.__places.lastFields = fields;
      const p = P[this.id];
      this.formattedAddress = p.formattedAddress;
      this.addressComponents = comps(p);
      this.location = p.lat == null ? null : { lat: () => p.lat, lng: () => p.lng };
    }
  }
  const lib = {
    AutocompleteSessionToken: Token,
    AutocompleteSuggestion: {
      async fetchAutocompleteSuggestions(req) {
        const st = window.__places;
        st.calls++; st.tokens.push(req.sessionToken); st.regions = req.includedRegionCodes;
        if (st.mode === 'quota') throw new Error('RESOURCE_EXHAUSTED: Quota exceeded for quota metric');
        if (st.mode === 'network') throw new TypeError('Failed to fetch');
        if (st.mode === 'denied') throw new Error('REQUEST_DENIED: API key not authorized');
        return { suggestions: rules(req.input).map(id => ({ placePrediction: {
          placeId: id, text: { text: P[id].formattedAddress }, mainText: { text: P[id].main }, secondaryText: { text: P[id].secondary },
          toPlace() { return new FakePlace(id); } } })) };
      }
    }
  };
  window.google = { maps: { importLibrary: async name => { window.__places.lib = name; return lib; } } };
  window.__opened = [];
  window.open = (url, target, features) => { window.__opened.push({ url, target, features }); return null; };
};

(async () => {
  const b = await launch();
  const errors = [];
  const newPage = async (withMock = true, ctxOpts = {}) => {
    const ctx = await b.newContext({ viewport: { width: 1360, height: 1000 }, ...ctxOpts });
    const p = await ctx.newPage();
    p.on('pageerror', e => errors.push('pageerror: ' + e.message));
    p.on('console', m => { if (m.type() === 'error' && !/ERR_FAILED|net::/.test(m.text())) errors.push('console: ' + m.text()); });
    p.dialogs = []; p.on('dialog', d => { p.dialogs.push(d.message()); d.accept(); });
    if (withMock) await p.addInitScript(MOCK);
    return p;
  };
  const p = await newPage();
  await p.goto(FILE);
  const st = sel => p.evaluate(s => { const e = document.querySelector(s); return { state: e.dataset.state, msg: e.querySelector('.addr-message').textContent, detail: e.querySelector('.addr-detail').textContent, buttons: [...e.querySelectorAll('[data-addr]')].filter(x => !x.hidden).map(x => x.dataset.addr) }; }, sel);
  const B = '#projectAddress-status', M = '#pmAddress-status';
  const type = async (sel, text) => { await p.fill(sel, ''); await p.fill(sel, text); };
  const waitOptions = async (sel, n) => p.waitForFunction(([s, n]) => document.querySelectorAll(s + '-suggestions .addr-option').length === n && !document.querySelector(s + '-suggestions').hidden, [sel, n], { timeout: 4000 }).then(() => true, () => false);
  const pick = async (sel, i) => { await p.locator(`${sel}-suggestions .addr-option`).nth(i).click(); await p.waitForFunction(s => document.querySelector(s + '-status').dataset.state !== 'loading', sel); };
  const builderData = () => p.evaluate(() => BUILDER_ADDRESS.getData());

  // initial state
  let s = await st(B);
  ok(s.msg === 'Start typing and select a suggested address.', 'initial hint under the address field');
  ok(await p.getAttribute('#projectAddress', 'role') === 'combobox' && await p.getAttribute('#projectAddress', 'aria-controls') === 'projectAddress-suggestions', 'accessible combobox attributes');

  // 1. valid address
  await type('#projectAddress', '123 Main');
  ok(await waitOptions('#projectAddress', 2), '1. suggestions shown (Places API New, region ' + JSON.stringify(await p.evaluate(() => window.__places.regions)) + ')');
  await pick('#projectAddress', 0);
  let d = await builderData();
  s = await st(B);
  ok(d.addressStatus === 'verified' && d.address === '123 Main St, Los Angeles, CA 90012, USA' && d.addressPlaceId === 'P1', '1. valid address verified with formatted address + place id');
  ok(d.addressStreetNumber === '123' && d.addressRoute === 'Main St' && d.addressCity === 'Los Angeles' && d.addressState === 'CA' && d.addressPostalCode === '90012' && d.addressCountry === 'US', '1. components parsed');
  ok(d.addressLatitude === 34.0522 && d.addressLongitude === -118.2437 && !!d.addressLastVerifiedAt, '1. coordinates + verification time saved');
  ok(s.state === 'verified' && s.msg.includes('Address verified with Google Places') && s.buttons.join() === 'map', '1. status "verified" + Open in Google Maps button');
  ok(JSON.stringify(await p.evaluate(() => window.__places.lastFields)) === JSON.stringify(['formattedAddress', 'addressComponents', 'location', 'id']), '1. only needed Place fields requested');
  const tokens = await p.evaluate(() => window.__places.tokens);
  ok(tokens.length >= 1 && tokens.every(t => t === tokens[0]), '1. one session token reused during typing');

  // 16. Open in Google Maps
  await p.locator(`${B} [data-addr=map]`).click();
  const opened = await p.evaluate(() => window.__opened.at(-1));
  ok(opened.url === 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('34.0522,-118.2437') && opened.target === '_blank' && opened.features === 'noopener,noreferrer', '16. Open in Google Maps uses coordinates, new tab, noopener,noreferrer');

  // 10. manual edit after verification
  await p.locator('#projectAddress').press('End'); await p.keyboard.type('x');
  d = await builderData(); s = await st(B);
  ok(d.addressStatus === 'unverified' && !d.addressPlaceId && d.addressLatitude === null && !d.addressLastVerifiedAt && d.address.endsWith('USAx'), '10. manual edit removes verification (status, place id, coords)');
  ok(s.msg === 'Select a suggested address to verify it.' && s.buttons.includes('keep') && !s.buttons.includes('map'), '10. status asks to select a suggestion; map hidden');
  const tokensBefore = (await p.evaluate(() => window.__places.tokens)).length;

  // 2. misspelled
  await type('#projectAddress', '123 Mian Stret');
  ok(await waitOptions('#projectAddress', 2), '2. misspelled input still gets suggestions');
  await pick('#projectAddress', 0);
  d = await builderData();
  ok(d.address === '123 Main St, Los Angeles, CA 90012, USA' && d.addressStatus === 'verified', '2. selecting corrects the spelling');
  const tk = await p.evaluate(() => window.__places.tokens);
  ok(tk.length > tokensBefore && tk.at(-1) !== tk[0], '2. a new session token after each completed selection');

  // 3. missing ZIP
  await type('#projectAddress', '500 Rural');
  await waitOptions('#projectAddress', 1); await pick('#projectAddress', 0);
  d = await builderData(); s = await st(B);
  ok(d.addressStatus === 'verified' && d.addressPostalCode === '' && s.detail.includes('ZIP code'), '3. missing ZIP: still verified, ZIP left empty (not invented), note shown');

  // 4. unit / apartment
  await type('#projectAddress', '123 Main St Apt 4B');
  await waitOptions('#projectAddress', 2); await pick('#projectAddress', 0);
  d = await builderData();
  ok(d.addressStatus === 'verified' && d.addressUnit === 'Apt 4B' && d.address === '123 Main St, Apt 4B, Los Angeles, CA 90012, USA', '4. typed unit "Apt 4B" kept: ' + d.address);
  await type('#projectAddress', '900 Tower');
  await waitOptions('#projectAddress', 1); await pick('#projectAddress', 0);
  d = await builderData();
  ok(d.addressUnit === '#12' && d.address === '900 Tower Ave #12, Burbank, CA 91502, USA', '4. unit from Google (subpremise) kept');

  // 5. ambiguous
  await type('#projectAddress', '123 Main');
  await waitOptions('#projectAddress', 2);
  const opts = await p.locator('#projectAddress-suggestions .addr-option').allInnerTexts();
  await p.keyboard.press('ArrowDown'); await p.keyboard.press('ArrowDown'); await p.keyboard.press('Enter');
  await p.waitForFunction(() => BUILDER_ADDRESS.data.addressPlaceId === 'P4');
  d = await builderData();
  ok(opts.length === 2 && /Los Angeles/.test(opts[0]) && /Glendale/.test(opts[1]) && d.addressCity === 'Glendale', '5. ambiguous: both shown, keyboard choice (↓↓ Enter) picks Glendale');

  // 6. no street number
  await type('#projectAddress', 'Main St');
  await waitOptions('#projectAddress', 3); await pick('#projectAddress', 0);
  d = await builderData(); s = await st(B);
  ok(d.addressStatus === 'unverified' && s.msg.includes('may not be a complete street address') && s.detail.includes('Main St, Los Angeles') && s.buttons.join() === 'confirm,keep,map', '6. result without street number: needs confirmation (Confirm / Keep / Map)');
  await p.locator(`${B} [data-addr=confirm]`).click();
  d = await builderData(); s = await st(B);
  ok(d.addressStatus === 'needs_review' && d.addressPlaceId === 'P5' && d.addressStreetNumber === '' && s.msg.includes('could not be fully verified'), '6. Confirm Address → saved as "needs review", nothing invented');
  await type('#projectAddress', 'Main St');
  await waitOptions('#projectAddress', 3); await pick('#projectAddress', 0);
  await p.locator(`${B} [data-addr=keep]`).click();
  d = await builderData();
  ok(d.addressStatus === 'needs_review' && d.address === 'Main St' && !d.addressPlaceId && d.addressLatitude === null, '6. Keep Entered Address → typed text kept, needs review, no Google data');

  // result without location
  await type('#projectAddress', '1 Nowhere');
  await waitOptions('#projectAddress', 1); await pick('#projectAddress', 0);
  d = await builderData(); s = await st(B);
  ok(d.addressStatus === 'unverified' && s.msg.includes('no map location'), 'result without coordinates is not verified');

  // 7. no results
  await type('#projectAddress', 'zzzz qqq');
  await p.waitForSelector('#projectAddress-suggestions .addr-empty');
  ok((await p.textContent('#projectAddress-suggestions')).includes('No matching addresses found'), '7. no results message');
  await p.keyboard.press('Escape');
  ok(await p.isHidden('#projectAddress-suggestions'), 'Escape closes suggestions');

  // XSS safety
  await type('#projectAddress', 'xss test');
  await waitOptions('#projectAddress', 1); await pick('#projectAddress', 0);
  ok(await p.evaluate(() => !window.__xss && !document.querySelector('#projectAddress-suggestions img, #projectAddress-status img')), 'suggestion/status text with HTML is not executed');

  // 9. quota / network errors
  await p.evaluate(() => { window.__places.mode = 'quota'; });
  await type('#projectAddress', '77 Oak');
  await p.waitForFunction(() => document.querySelector('#projectAddress-status .addr-message').textContent.includes('limit'));
  s = await st(B);
  ok(s.msg.includes('Address lookup limit reached') && s.buttons.includes('keep'), '9. quota error: clear message, manual entry still possible');
  await p.evaluate(() => { window.__places.mode = 'network'; });
  await type('#projectAddress', '77 Oak Blvd');
  await p.waitForFunction(() => document.querySelector('#projectAddress-status .addr-message').textContent.includes('network'));
  ok(true, '9. network error: "unavailable (network problem)" message');
  await p.evaluate(() => { window.__places.mode = 'ok'; });

  // 11. save + reopen estimate
  await p.fill('#clientName', 'Verified Client');
  await type('#projectAddress', '77 Oak');
  await waitOptions('#projectAddress', 1); await pick('#projectAddress', 0);
  await p.click('#btnSaveEstimate');
  let est = await p.evaluate(() => JSON.parse(localStorage.getItem(storageKey('constructionEstimatorSavedEstimates'))));
  const e1 = est[0];
  ok(e1.addressStatus === 'verified' && e1.addressPlaceId === 'P7' && e1.addressLatitude === 34.14 && e1.addressCity === 'Pasadena' && e1.address === '77 Oak Blvd, Pasadena, CA 91101, USA', '11. estimate saved with all address fields');
  await p.reload();
  await p.click('#mainNav [data-page=estimates]');
  ok((await p.innerText('#estimatesBody')).includes('✓ Verified'), '11. Saved Estimates shows "Verified" badge');
  await p.locator('#estimatesBody [data-action=open]').click();
  d = await builderData(); s = await st(B);
  ok(d.addressStatus === 'verified' && d.addressPlaceId === 'P7' && s.state === 'verified' && await p.inputValue('#projectAddress') === e1.address, '11. reopened estimate restores verified address + status');
  ok(!(await p.evaluate(() => hasUnsavedChanges())), '11. reopened estimate is not marked as changed');

  // 12. duplicate
  await p.click('#mainNav [data-page=estimates]');
  await p.locator('#estimatesBody [data-action=duplicate]').click();
  est = await p.evaluate(() => JSON.parse(localStorage.getItem(storageKey('constructionEstimatorSavedEstimates'))));
  const dup = est.find(e => e.id !== e1.id);
  ok(['address', 'addressStatus', 'addressPlaceId', 'addressLatitude', 'addressLongitude', 'addressCity', 'addressPostalCode'].every(k => dup[k] === e1[k]), '12. duplicate keeps all address fields');

  // 13 + 17. CRM project from estimate, reopen
  await p.locator('#estimatesBody tr', { hasText: e1.estimateNumber }).locator('[data-action=crm]').click();
  let crm = await p.evaluate(() => JSON.parse(localStorage.getItem(storageKey('constructionEstimatorCRM'))));
  ok(crm.length === 1 && crm[0].addressStatus === 'verified' && crm[0].addressPlaceId === 'P7' && crm[0].addressLatitude === 34.14, '13. CRM project created with the verified address');
  s = await st(M);
  ok(await p.inputValue('#pmAddress') === e1.address && s.state === 'verified', '13. CRM project window shows verified address');
  await p.click('#projectModal [data-close=projectModal]');
  await p.click('#mainNav [data-page=estimates]');
  await p.locator('#estimatesBody tr', { hasText: e1.estimateNumber }).locator('[data-action=crm]').click();
  ok((await p.evaluate(() => JSON.parse(localStorage.getItem(storageKey('constructionEstimatorCRM'))))).length === 1, '17. no duplicate CRM project');

  // 14. sync CRM → estimate (verified wins)
  await type('#pmAddress', '123 Main');
  await waitOptions('#pmAddress', 2); await pick('#pmAddress', 1);
  await p.click('#projectForm button[type=submit]');
  est = await p.evaluate(() => JSON.parse(localStorage.getItem(storageKey('constructionEstimatorSavedEstimates'))));
  let linked = est.find(e => e.id === e1.id);
  ok(linked.address === '123 Main St, Glendale, CA 91203, USA' && linked.addressStatus === 'verified' && linked.addressPlaceId === 'P4', '14. verified CRM address copied to the linked estimate');
  ok(dup.addressPlaceId === 'P7', '14. unlinked duplicate untouched');
  // estimate → CRM with an unverified edit: blocked (verified kept)
  await p.click('#mainNav [data-page=estimates]');
  await p.locator('#estimatesBody tr', { hasText: e1.estimateNumber }).locator('[data-action=open]').click();
  await type('#projectAddress', '123 Main Street Glendale');
  await p.locator('#projectAddress').blur();
  await p.click('#btnSaveEstimate');
  crm = await p.evaluate(() => JSON.parse(localStorage.getItem(storageKey('constructionEstimatorCRM'))));
  est = await p.evaluate(() => JSON.parse(localStorage.getItem(storageKey('constructionEstimatorSavedEstimates'))));
  linked = est.find(e => e.id === e1.id);
  ok(linked.addressStatus === 'unverified' && linked.address === '123 Main Street Glendale' && crm[0].addressStatus === 'verified' && crm[0].address === '123 Main St, Glendale, CA 91203, USA', '14. unverified estimate edit does not overwrite the verified CRM address');
  await p.waitForTimeout(3000);
  ok((await p.textContent('#toast')).includes('keeps its verified address'), '14. user is told why the CRM address was kept');
  // estimate verified → CRM updated
  await type('#projectAddress', '900 Tower');
  await waitOptions('#projectAddress', 1); await pick('#projectAddress', 0);
  await p.click('#btnSaveEstimate');
  crm = await p.evaluate(() => JSON.parse(localStorage.getItem(storageKey('constructionEstimatorCRM'))));
  ok(crm[0].address === '900 Tower Ave #12, Burbank, CA 91502, USA' && crm[0].addressUnit === '#12' && crm[0].addressPlaceId === 'P3', '14. verified estimate address copied to CRM (unit kept)');
  // CRM card badge + map
  await p.click('#mainNav [data-page=crm]');
  await p.locator('.kcard [data-action=map]').first().click();
  ok((await p.evaluate(() => window.__opened.at(-1).url)).endsWith(encodeURIComponent('34.18,-118.31')), '16. CRM card "Open in Google Maps"');

  // new lead from CRM with verified address, reopen
  await p.click('#btnNewLead');
  await p.fill('#pmClientName', 'Lead With Address');
  await type('#pmAddress', '123 Main');
  await waitOptions('#pmAddress', 2); await pick('#pmAddress', 0);
  await p.click('#projectForm button[type=submit]');
  await p.reload();
  await p.locator('.kcard', { hasText: 'Lead With Address' }).locator('[data-action=open]').click();
  ok((await st(M)).state === 'verified' && await p.inputValue('#pmAddress') === '123 Main St, Los Angeles, CA 90012, USA', '13. new lead: verified address restored after reload');
  await p.click('#projectModal [data-close=projectModal]');
  // create estimate from that lead → address fields carried over
  await p.locator('.kcard', { hasText: 'Lead With Address' }).locator('[data-action=estimate]').click();
  d = await builderData();
  ok(d.addressStatus === 'verified' && d.addressPlaceId === 'P1', 'CRM → Create Estimate carries the verified address');

  // 15. legacy records
  await p.evaluate(() => {
    localStorage.setItem(storageKey('constructionEstimatorSavedEstimates'), JSON.stringify([
      { id: 'old1', estimateNumber: 'EST-2025-0001', date: '2025-05-01', clientName: 'Legacy A', address: '12 Old Rd Apt 3, Van Nuys CA', items: [], customerTotal: 100, status: 'sent' },
      { id: 'old2', estimateNumber: 'EST-2025-0002', date: '2025-05-02', clientName: 'Legacy B', address: '', items: [], customerTotal: 50, status: 'draft' },
      { id: 'old3', estimateNumber: 'EST-2025-0003', date: '2025-05-03', clientName: 'Fake Verified', address: '1 Fake St', addressStatus: 'verified', items: [], customerTotal: 10, status: 'draft' }
    ]));
    localStorage.setItem(storageKey('constructionEstimatorCRM'), JSON.stringify([{ id: 'oldp', clientName: 'Legacy A', address: '12 Old Rd Apt 3, Van Nuys CA', stage: 'lead' }]));
  });
  await p.reload();
  await p.click('#mainNav [data-page=estimates]');
  const optsF = await p.locator('#estimateAddressFilter option').allTextContents();
  ok(optsF.includes('Unverified (2)') && optsF.includes('Missing address (1)'), '15. address filter counts legacy records: ' + optsF.join(' | '));
  ok((await p.innerText('#estimatesBody tr:has-text("Fake Verified")')).includes('Unverified'), '15. "verified" without a Google place id is treated as unverified');
  await p.selectOption('#estimateAddressFilter', 'missing');
  ok(await p.locator('#estimatesBody tr').count() === 1 && (await p.innerText('#estimatesBody')).includes('Legacy B'), 'review list: missing addresses');
  await p.selectOption('#estimateAddressFilter', 'unverified');
  ok(await p.locator('#estimatesBody tr').count() === 2, 'review list: unverified addresses');
  await p.locator('#estimatesBody tr', { hasText: 'Legacy A' }).locator('[data-action=open]').click();
  ok(await p.inputValue('#projectAddress') === '12 Old Rd Apt 3, Van Nuys CA' && (await st(B)).msg === 'Select a suggested address to verify it.', '15. legacy address shown unchanged, asks for verification');
  const raw = await p.evaluate(() => JSON.parse(localStorage.getItem(storageKey('constructionEstimatorSavedEstimates'))).find(e => e.id === 'old1'));
  ok(raw.address === '12 Old Rd Apt 3, Van Nuys CA' && raw.addressStatus === undefined, '15. historical record not modified just by opening it');
  await p.click('#mainNav [data-page=crm]');
  await p.selectOption('#crmAddressFilter', 'unverified');
  ok(await p.locator('.kcard').count() === 1 && (await p.innerText('.kcard')).includes('Unverified'), 'CRM address filter + badge for legacy project');

  // 18 console errors so far
  ok(errors.length === 0, '18. no console errors (mocked Google) ' + JSON.stringify(errors));

  // 8. API unavailable: no key, no Google
  const q = await newPage(false);
  await q.goto(FILE);
  await q.fill('#projectAddress', '123 Main St');
  await q.waitForTimeout(400);
  let sq = await q.evaluate(() => document.querySelector('#projectAddress-status .addr-message').textContent);
  ok(sq.includes('add a Google Maps API key in Settings') && await q.evaluate(() => !document.getElementById('google-maps-loader')), '8. no API key: clear message, Google not loaded, typing still works');
  await q.fill('#clientName', 'No Google'); await q.click('#btnSaveEstimate');
  const qe = await q.evaluate(() => JSON.parse(localStorage.getItem(storageKey('constructionEstimatorSavedEstimates')))[0]);
  ok(qe.address === '123 Main St' && qe.addressStatus === 'unverified', '8. estimate still saves without Google (unverified)');
  await q.click('#mainNav [data-page=settings]');
  ok((await q.textContent('#mapsKeyStatus')).includes('No key'), '8. Settings shows key status');

  // 8. key set, Google script blocked (network) → loader error, one script at a time
  await q.route('https://maps.googleapis.com/**', r => r.abort());
  await q.fill('#setMapsKey', 'TEST_KEY_123'); await q.click('#settingsForm .terms-card button[type=submit] >> nth=0');
  await q.click('#mainNav [data-page=builder]');
  await q.fill('#projectAddress', '');
  await q.fill('#projectAddress', '77 Oak Blvd');
  await q.waitForFunction(() => document.querySelector('#projectAddress-status .addr-message').textContent.includes('network'), null, { timeout: 5000 }).then(() => ok(true, '8. Google script blocked: "network problem" message'), () => ok(false, '8. Google script blocked message'));
  ok(await q.evaluate(() => document.querySelectorAll('script[src*="maps.googleapis.com"]').length === 0), '8. failed loader script removed (can retry later)');

  // denied key via gm_authFailure, single loader
  const r = await newPage(false);
  await r.route('https://maps.googleapis.com/**', route => {
    const u = new URL(route.request().url());
    r.loaderUrl = u;
    route.fulfill({ contentType: 'application/javascript', body: `
      window.google={maps:{importLibrary:async()=>({AutocompleteSessionToken:class{},AutocompleteSuggestion:{fetchAutocompleteSuggestions:async()=>{throw new Error("REQUEST_DENIED")}}})}};
      setTimeout(()=>{ window.${u.searchParams.get('callback')}(); window.gm_authFailure && window.gm_authFailure(); },10);` });
  });
  await r.goto(FILE);
  await r.evaluate(() => { SETTINGS.googleMapsApiKey = 'TEST_KEY_123'; });
  for (let i = 0; i < 3; i++) { await r.focus('#projectAddress'); await r.locator('#projectAddress').blur(); }
  await r.fill('#projectAddress', '123 Main St');
  await r.waitForFunction(() => document.querySelector('#projectAddress-status .addr-message').textContent.includes('rejected'), null, { timeout: 5000 }).then(() => ok(true, '8. invalid/restricted key (gm_authFailure / REQUEST_DENIED): clear message'), () => ok(false, '8. denied key message'));
  ok(await r.evaluate(() => document.querySelectorAll('script[src*="maps.googleapis.com"]').length) === 1, 'Google Maps loaded only once (repeated focus)');
  ok(r.loaderUrl && r.loaderUrl.searchParams.get('key') === 'TEST_KEY_123' && r.loaderUrl.searchParams.get('libraries') === 'places' && r.loaderUrl.searchParams.get('loading') === 'async', 'loader URL: key, libraries=places, loading=async');

  // mobile layout
  await p.setViewportSize({ width: 390, height: 844 });
  await p.click('#mainNav [data-page=builder]');
  await type('#projectAddress', '123 Main');
  await waitOptions('#projectAddress', 2);
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile: suggestions fit, no horizontal scroll');
  await p.screenshot({ path: OUT + '/addr-mobile.png' });

  ok(errors.length === 0, '18. no console errors (all pages) ' + JSON.stringify(errors));
  console.log(`\n${pass} passed, ${fail} failed`);
  await b.close();
})().catch(e => { console.error(e); process.exit(2); });
