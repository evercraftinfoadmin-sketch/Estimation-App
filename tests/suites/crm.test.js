const { launch, FILE, OUT, FIXTURES, MODE } = require('../helpers');
let pass = 0, fail = 0;
const results = [];
function ok(cond, name) { results.push([cond, name]); cond ? pass++ : fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name); }
const money = n => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
  const b = await launch();
  const ctx = await b.newContext({ viewport: { width: 1360, height: 1000 } });
  const p = await ctx.newPage();
  const printAndWait = async () => { const n = await p.evaluate(() => window.__prints); await p.click('#btnPrint'); await p.waitForFunction(n => window.__prints > n, n, { timeout: 5000 }); };

  const errors = [];
  p.on('pageerror', e => errors.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  const dialogs = []; let nextConfirm = true;
  p.on('dialog', d => { dialogs.push(d.type() + ': ' + d.message()); if (d.type() === 'confirm' && !nextConfirm) { nextConfirm = true; d.dismiss(); } else d.accept(); });
  await p.addInitScript(() => { window.__prints = 0; window.print = () => { window.__prints++; }; });

  const v = s => p.inputValue(s);
  const t = s => p.textContent(s);
  const store = key => p.evaluate(k => JSON.parse(localStorage.getItem(storageKey(k)) || 'null'), key);
  const estimates = () => store('constructionEstimatorSavedEstimates').then(x => x || []);
  const services = () => store('constructionEstimatorServices').then(x => x || []);
  const projects = () => store('constructionEstimatorCRM').then(x => x || []);
  const nav = page => p.click(`#mainNav [data-page=${page}]`);
  const lastDialog = () => dialogs[dialogs.length - 1] || '';
  const visibleText = () => p.evaluate(() => document.querySelector('.app').innerText);
  const checkNumbers = async label => {
    const txt = await visibleText();
    ok(!/NaN/.test(txt), `no NaN (${label})`);
    ok(!/Infinity/.test(txt), `no Infinity (${label})`);
  };
  async function addService(category, label, qty, price) {
    await p.click(`[data-action=add-service][data-category=${category}]`);
    const row = p.locator(`#items-${category} .line-item`).last();
    await row.locator('select').selectOption({ label });
    const r = p.locator(`#items-${category} .line-item`).last();
    if (qty !== undefined) await r.locator('[data-field=quantity]').fill(String(qty));
    if (price !== undefined) await r.locator('[data-field=price]').fill(String(price));
    return r;
  }

  // ---------- 1. Page load ----------
  await p.goto(FILE);
  ok(await p.isVisible('#page-builder'), '1. page load: builder visible');
  ok(await v('#estimateNumber') === 'EST-2026-1001', '1. page load: estimate # EST-2026-1001');
  ok((await p.locator('#mainNav button').allTextContents()).join('|') === 'Estimate Builder|Saved Estimates|Services|CRM|Invoices|Signatures|Settings', '1. navigation has 7 pages (incl. Invoices, Signatures)');
  ok((await services()).length === 22, '1. default services seeded (7+7+8)');
  ok(await p.locator('.category-card h2').allTextContents().then(x => x.join(',')) === 'DRYWALL,STUCCO,PAINTING', '1. 3 main categories');
  ok(await p.isVisible('[data-action=add-category]'), '1. + Add Category available');
  const appText = await visibleText();
  ok(!/sq ?ft|gallon|linear ft|\bsheet\b|bucket|\bhours?\b|\beach\b|coverage|coats|material/i.test(appText), '1. no unit/calculator words in UI');
  ok(await p.locator('#items-drywall .line-item').count() === 0, '1. builder starts empty');

  // ---------- 14a. Save validation ----------
  await p.click('#btnSaveEstimate');
  ok(lastDialog().includes('Client Name or a Project Address'), '14. save blocked without client/address');
  ok((await estimates()).length === 0, '14. nothing saved when invalid');

  // ---------- 2–9. Create estimate & line items ----------
  await p.fill('#clientName', 'Maria <b>Lopez</b>');
  await p.fill('#clientEmail', 'maria@example.com');
  await p.fill('#clientPhone', '555-1000');
  await p.fill('#projectAddress', '42 Elm St, Pasadena, CA');
  await p.fill('#estMarkup', '10'); await p.fill('#estTaxRate', '8');
  ok(true, '2. create estimate: client fields entered');

  await addService('drywall', 'Drywall Repair', 500, 4);
  ok(await t('#catTotal-drywall') === '$2,000.00', '3. add Drywall service: 500 × $4 = $2,000.00');
  await addService('stucco', 'Stucco Repair', 10, 150);
  ok(await t('#catTotal-stucco') === '$1,500.00', '4. add Stucco service: 10 × $150 = $1,500.00');
  await addService('painting', 'Interior Painting', 1200, 2.5);
  ok(await t('#catTotal-painting') === '$3,000.00', '5. add Painting service: 1200 × $2.50 = $3,000.00');
  await addService('drywall', 'Drywall Patching', 3, 75);
  ok(await p.locator('#items-drywall .line-item').count() === 2 && await t('#catTotal-drywall') === '$2,225.00', '6. multiple services in one category');

  const repairRow = p.locator('#items-drywall .line-item').first();
  await repairRow.locator('[data-field=quantity]').fill('600');
  ok(await repairRow.locator('[data-total]').textContent() === '$2,400.00', '7. change quantity → line total updates');
  await repairRow.locator('[data-field=price]').fill('4.5');
  ok(await repairRow.locator('[data-total]').textContent() === '$2,700.00', '8. change price → line total updates');
  ok((await services()).find(s => s.name === 'Drywall Repair').defaultPrice === 0, '8. estimate price does not change default service price');

  await p.locator('#items-drywall .line-item').nth(1).locator('[data-action=delete-item]').click();
  ok(await p.locator('#items-drywall .line-item').count() === 1 && await t('#catTotal-drywall') === '$2,700.00', '9. delete service line');

  // subtotal 2700+1500+3000 = 7200; markup 10% 720; tax 8% of 7920 = 633.60; total 8553.60
  ok(await t('#sumSubtotal') === '$7,200.00' && await t('#sumMarkup') === '$720.00' && await t('#sumTax') === '$633.60' && await t('#sumTotal') === '$8,553.60',
    'calc: subtotal/markup/tax/total = 7,200 / 720 / 633.60 / 8,553.60');

  // ---------- 10–11. Custom service ----------
  const svcCount = (await services()).length;
  await p.click('[data-action=custom-service][data-category=painting]');
  ok(await v('#csCategory') === 'painting', '10. custom service: category preselected');
  await p.fill('#csName', 'Accent Wall Mural'); await p.fill('#csPrice', '400'); await p.fill('#csDescription', 'Hand-painted mural');
  await p.click('#customServiceForm button[type=submit]');
  ok(await t('#catTotal-painting') === '$3,400.00' && (await services()).length === svcCount, '10. custom service (not saved) used only in this estimate');
  ok((await p.locator('#items-painting select').last().locator('option:checked').textContent()).includes('(custom)'), '10. custom line labelled (custom)');

  await p.click('[data-action=custom-service][data-category=stucco]');
  await p.fill('#csName', 'Stucco Waterproofing'); await p.fill('#csPrice', '300'); await p.check('#csSave');
  await p.click('#customServiceForm button[type=submit]');
  const wp = (await services()).find(s => s.name === 'Stucco Waterproofing');
  ok(wp && wp.category === 'stucco' && wp.defaultPrice === 300 && await t('#catTotal-stucco') === '$1,800.00', '11. custom service saved to service list and added');

  // subtotal 2700+1800+3400 = 7900; markup 790; tax 8% of 8690 = 695.20; total 9385.20
  ok(await t('#sumTotal') === '$9,385.20', 'calc: total after custom services $9,385.20');

  // ---------- 12–13. Services management ----------
  await nav('services');
  ok(await p.locator('#servicesBody tr').count() === 23, 'services page lists 23 services');
  ok(!/unit/i.test(await t('#page-services thead')), 'services table has no Unit column');
  await p.fill('#serviceSearch', 'waterproof');
  ok(await p.locator('#servicesBody tr').count() === 1, 'services search');
  await p.fill('#serviceSearch', '');
  await p.selectOption('#serviceCategoryFilter', 'painting');
  ok(await p.locator('#servicesBody tr').count() === 8, 'services category filter (painting = 8)');
  await p.selectOption('#serviceCategoryFilter', 'all');

  await p.locator('#servicesBody tr', { hasText: 'Stucco Waterproofing' }).locator('[data-action=edit]').click();
  await p.fill('#svcPrice', '350'); await p.fill('#svcDescription', 'Elastomeric coating');
  await p.click('#serviceForm button[type=submit]');
  const wp2 = (await services()).find(s => s.name === 'Stucco Waterproofing');
  ok(wp2.defaultPrice === 350 && wp2.description === 'Elastomeric coating' && wp2.updatedAt >= wp2.createdAt, '12. edit service');

  await p.click('#btnAddService');
  await p.fill('#svcName', 'Popcorn Ceiling Removal'); await p.selectOption('#svcCategory', 'drywall'); await p.fill('#svcPrice', '2.25');
  await p.click('#serviceForm button[type=submit]');
  ok((await services()).some(s => s.name === 'Popcorn Ceiling Removal' && s.defaultPrice === 2.25), 'add service from Services page');

  await p.locator('#servicesBody tr', { hasText: 'Fence Painting' }).locator('[data-action=toggle]').click();
  ok((await services()).find(s => s.name === 'Fence Painting').active === false, 'disable service');
  await nav('builder');
  ok(!(await p.locator('#items-painting select').first().innerText()).includes('Fence Painting'), 'disabled service hidden from builder');
  await nav('services');
  await p.locator('#servicesBody tr', { hasText: 'Fence Painting' }).locator('[data-action=toggle]').click();
  ok((await services()).find(s => s.name === 'Fence Painting').active === true, 'enable service');

  nextConfirm = false;
  await p.locator('#servicesBody tr', { hasText: 'Drywall Texture' }).locator('[data-action=delete]').click();
  ok((await services()).some(s => s.name === 'Drywall Texture'), '13. delete service: cancel keeps it');
  await p.locator('#servicesBody tr', { hasText: 'Drywall Texture' }).locator('[data-action=delete]').click();
  ok(!(await services()).some(s => s.name === 'Drywall Texture'), '13. delete service: confirmed delete');
  await nav('builder');
  ok(await t('#sumTotal') === '$9,385.20' && await p.locator('#items-stucco [data-field=price]').last().inputValue() === '300',
    '12. editing a service does not change prices already in the estimate');

  // ---------- 14. Save ----------
  await p.click('[data-action=add-service][data-category=drywall]');
  await p.click('#btnSaveEstimate');
  ok(lastDialog().includes('choose a service for every line'), '14. save blocked with an empty line');
  await p.locator('#items-drywall .line-item').last().locator('[data-action=delete-item]').click();

  await p.click('#btnSaveEstimate');
  let est = await estimates();
  const fields = ['id', 'estimateNumber', 'date', 'clientName', 'clientEmail', 'clientPhone', 'address', 'items', 'drywallTotal', 'stuccoTotal', 'paintingTotal', 'subtotal', 'markup', 'markupAmount', 'taxRate', 'taxAmount', 'customerTotal', 'status', 'crmProjectId', 'createdAt', 'updatedAt'];
  ok(est.length === 1 && fields.every(f => f in est[0]), '14. save estimate: record has all required fields');
  const e1 = est[0];
  ok(e1.estimateNumber === 'EST-2026-1001' && e1.status === 'draft' && e1.customerTotal === 9385.2 && e1.items.length === 5, '14. saved: EST-2026-1001, draft, total 9,385.20, 5 items');
  ok(e1.drywallTotal === 2700 && e1.stuccoTotal === 1800 && e1.paintingTotal === 3400 && e1.subtotal === 7900 && e1.markupAmount === 790 && e1.taxAmount === 695.2, '14. saved category totals and amounts');
  ok(e1.items.every(it => !('unit' in it)), '14. items have no unit field');
  ok((await t('#builderBadge')).trim() === 'Draft', '14. builder badge shows Draft');

  // ---------- 15. Edit ----------
  await p.waitForTimeout(15);
  await p.locator('#items-painting .line-item').first().locator('[data-field=quantity]').fill('1000');
  await p.click('#btnSaveEstimate');
  est = await estimates();
  ok(est.length === 1 && est[0].id === e1.id && est[0].paintingTotal === 2900 && est[0].createdAt === e1.createdAt && est[0].updatedAt > e1.updatedAt, '15. edit estimate updates same record, keeps createdAt');

  // ---------- 16. Duplicate ----------
  await nav('estimates');
  await p.locator('#estimatesBody tr').first().locator('[data-action=duplicate]').click();
  est = await estimates();
  const dup = est.find(e => e.id !== e1.id);
  ok(est.length === 2 && dup.estimateNumber === 'EST-2026-1002' && dup.status === 'draft' && dup.crmProjectId === null, '16. duplicate: new id, EST-2026-1002, draft');
  ok(dup.customerTotal === est.find(e => e.id === e1.id).customerTotal && dup.items.length === 5 && dup.items[0].id !== e1.items[0].id, '16. duplicate preserves data');

  // ---------- 17. Search & status ----------
  await p.fill('#estimateSearch', 'elm st'); ok(await p.locator('#estimatesBody tr').count() === 2, '17. search by address');
  await p.fill('#estimateSearch', '1002'); ok(await p.locator('#estimatesBody tr').count() === 1, '17. search by estimate #');
  await p.fill('#estimateSearch', 'maria'); ok(await p.locator('#estimatesBody tr').count() === 2, '17. search by client');
  await p.fill('#estimateSearch', 'nobody'); ok(await p.isVisible('#estimatesEmpty'), '17. search: empty state');
  await p.fill('#estimateSearch', '');
  ok((await p.innerHTML('#estimatesBody')).includes('Maria &lt;b&gt;Lopez&lt;/b&gt;'), 'security: client name escaped in list');
  await p.locator('#estimatesBody tr', { hasText: 'EST-2026-1001' }).locator('select[data-action=status]').selectOption('sent');
  ok((await estimates()).find(e => e.id === e1.id).status === 'sent', 'status: change to sent');
  await p.selectOption('#estimateStatusFilter', 'sent'); ok(await p.locator('#estimatesBody tr').count() === 1, 'status filter');
  await p.selectOption('#estimateStatusFilter', 'all');
  for (const s of ['accepted', 'rejected', 'completed', 'draft']) {
    await p.locator('#estimatesBody tr', { hasText: 'EST-2026-1002' }).locator('select[data-action=status]').selectOption(s);
    ok((await estimates()).find(e => e.id === dup.id).status === s, `status: change to ${s}`);
  }

  // ---------- 18–19. Reload & open ----------
  await p.reload();
  ok((await estimates()).length === 2, '18. reload: estimates persist');
  ok(await p.isVisible('#page-estimates'), '18. reload: stays on current page');
  await nav('builder');
  ok(await v('#estimateNumber') === 'EST-2026-1003', '18. reload: next estimate # EST-2026-1003');
  await nav('estimates');
  await p.locator('#estimatesBody tr', { hasText: 'EST-2026-1001' }).locator('[data-action=open]').click();
  ok(await p.isVisible('#page-builder') && await v('#clientName') === 'Maria <b>Lopez</b>' && await v('#clientPhone') === '555-1000' && await v('#estimateNumber') === 'EST-2026-1001', '19. open saved estimate: client fields restored');
  ok(await p.locator('.line-item').count() === 5 && await v('#estMarkup') === '10' && await v('#estTaxRate') === '8', '19. open: 5 items, markup & tax restored');
  ok(await t('#sumTotal') === money((await estimates()).find(e => e.id === e1.id).customerTotal), '19. open: recalculated total equals saved total');
  ok((await t('#builderBadge')).trim() === 'Sent', '19. open: status badge Sent');

  // ---------- 20. Print ----------
  await printAndWait();
  ok(await p.evaluate(() => window.__prints) === 1, '20. print called');
  const pv = await p.innerText('#printView');
  ok(/EverCraft Home Improvement/.test(pv) && /EST-2026-1001/.test(pv) && /Maria <b>Lopez<\/b>/.test(pv) && /42 Elm St/.test(pv), '20. print: company, estimate #, client, address');
  ok(/DRYWALL/.test(pv) && /STUCCO/.test(pv) && /PAINTING/.test(pv) && /Drywall Repair/.test(pv) && /TOTAL/.test(pv) && /All taxes included/.test(pv), '20. print: 3 sections, services, total, "All taxes included"');
  ok(!/Subtotal|Markup|Sales Tax/.test(pv), '20. print: the client does not see subtotal, markup or a tax line');
  const client = await p.evaluate(() => { const d = getEstimateData(); const l = clientPricedLines(d.items, d.grandTotal); const dr = l.find(i => i.name === 'Drywall Repair'), base = d.items.find(i => i.name === 'Drywall Repair');
    return { sum: Math.round(l.reduce((s, i) => s + i.total, 0) * 100), total: Math.round(d.grandTotal * 100), dr: dr.total, expected: Math.round(base.total * d.grandTotal / d.subtotal * 100) / 100, line: `Drywall Repair: Qty 600 x ${clientUnitPrice(dr)} = ${money(dr.total)}`, inPrint: document.getElementById('printView').textContent.includes(money(dr.total)) }; });
  ok(client.sum === client.total && Math.abs(client.dr - client.expected) <= 0.01 && client.inPrint, '20. print: line prices include markup and tax, and add up exactly to the total (' + client.line + ')');
  ok(await p.locator('#printView button, #printView input, #printView select').count() === 0, '20. print: no buttons/inputs');
  ok(!(await p.innerHTML('#printView')).includes('<b>Lopez</b>'), 'security: print view escapes client name');
  await p.emulateMedia({ media: 'print' });
  ok(!(await p.isVisible('.app')) && await p.isVisible('#printView'), '20. print media: only the estimate document is shown');
  await p.emulateMedia({ media: 'screen' });

  // ---------- 21. Email ----------
  const body = await p.evaluate(() => buildEmailBody(getEstimateData()));
  ok(['Maria <b>Lopez</b>', '42 Elm St', 'EST-2026-1001', client.line, 'TOTAL:', '(all taxes included)', 'EverCraft Home Improvement'].every(s => body.includes(s)), '21. email body: client, project, #, services qty×price (client prices), total, company');
  ok(!/Subtotal|Markup|Sales Tax|\$4\.50/.test(body), '21. email body: no subtotal, markup, tax line or internal prices');
  await p.evaluate(() => { window.__opened = []; window.__aclick = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function(){ window.__opened.push(this.href); }; });
  const mailto = await p.evaluate(() => new Promise(resolve => {
    const orig = window.emailEstimate;
    let captured = null;
    const desc = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
    try { Object.defineProperty(window.location, 'href', { set: v => { captured = v; }, configurable: true }); } catch (e) {}
    document.getElementById('btnEmail').click();
    resolve(captured);
  }));
  const opened = await p.evaluate(() => { HTMLAnchorElement.prototype.click = window.__aclick; return window.__opened; });
  ok(mailto === null && opened.length === 1 && opened[0].startsWith('https://mail.google.com/mail/?authuser=EverCraft.pro%40gmail.com&view=cm&fs=1&to=maria%40example.com'), '21. Email Client button opens Gmail as the company address');
  await p.fill('#clientEmail', '');
  await p.click('#btnEmail');
  ok(lastDialog().includes("client's email"), '21. email requires client email');
  await p.fill('#clientEmail', 'maria@example.com');

  // ---------- 22–23. CRM from saved estimate ----------
  await nav('estimates');
  await p.locator('#estimatesBody tr', { hasText: 'EST-2026-1001' }).locator('[data-action=crm]').click();
  let prj = await projects();
  ok(prj.length === 1 && prj[0].estimateId === e1.id && prj[0].estimateNumber === 'EST-2026-1001' && prj[0].estimateTotal === 8791.2, '22. create CRM project from estimate (linked, total from estimate)');
  ok(prj[0].stage === 'prospect' && prj[0].prospectStatus === 'quote_sent', '22. sent estimate → Prospects / Quote sent');
  ok((await estimates()).find(e => e.id === e1.id).crmProjectId === prj[0].id, '22. estimate stores crmProjectId');
  ok(await p.isVisible('#page-crm') && await p.isVisible('#projectModal'), '23. CRM project opened');
  ok(await v('#pmClientName') === 'Maria <b>Lopez</b>' && (await t('#pmEstimate')).includes('EST-2026-1001'), '23. project modal shows client & estimate');
  await p.click('#projectModal [data-close=projectModal]');

  await nav('estimates');
  ok((await p.locator('#estimatesBody tr', { hasText: 'EST-2026-1001' }).locator('[data-action=crm]').textContent()) === 'Open CRM Project', '36. button changes to Open CRM Project');
  await p.locator('#estimatesBody tr', { hasText: 'EST-2026-1001' }).locator('[data-action=crm]').click();
  ok((await projects()).length === 1 && await p.isVisible('#projectModal'), '36. second click opens existing project (no duplicate)');
  await p.click('#projectModal [data-close=projectModal]');

  // ---------- New lead → estimate from CRM ----------
  await p.click('#btnNewLead');
  await p.fill('#pmClientName', 'Tom Brown'); await p.fill('#pmClientEmail', 'tom@example.com');
  await p.fill('#pmClientPhone', '555-2000'); await p.fill('#pmAddress', '9 Oak Ave, Glendale, CA');
  await p.click('#projectForm button[type=submit]');
  prj = await projects();
  const tom = prj.find(x => x.clientName === 'Tom Brown');
  ok(tom && tom.stage === 'lead' && tom.estimateId === null, 'CRM: new lead created');
  const tomCard = () => p.locator('.kcard', { hasText: 'Tom Brown' });
  ok(/tom@example.com/.test(await tomCard().innerText()) && /555-2000/.test(await tomCard().innerText()) && /Created/.test(await tomCard().innerText()), 'Leads card shows email, phone, created date');

  await tomCard().locator('[data-action=estimate]').click();
  ok(await p.isVisible('#page-builder') && await v('#clientName') === 'Tom Brown' && await v('#clientEmail') === 'tom@example.com' && await v('#clientPhone') === '555-2000' && await v('#projectAddress') === '9 Oak Ave, Glendale, CA',
    'CRM → Create Estimate auto-fills client name, email, phone, address');
  ok((await t('#builderMeta')).includes('Linked to CRM project'), 'builder shows CRM link');
  await addService('painting', 'Exterior Painting', 2000, 3);
  await p.click('#btnSaveEstimate');
  est = await estimates();
  const tomEst = est.find(e => e.clientName === 'Tom Brown');
  prj = await projects();
  const tom2 = prj.find(x => x.id === tom.id);
  ok(tomEst && tomEst.estimateNumber === 'EST-2026-1003' && tomEst.crmProjectId === tom.id, 'estimate saved with crmProjectId and next number EST-2026-1003');
  ok(tom2.estimateId === tomEst.id && tom2.estimateNumber === 'EST-2026-1003' && tom2.estimateTotal === tomEst.customerTotal, 'CRM project updated with estimate # and total');
  ok(prj.length === 2, 'no duplicate CRM project created');

  // estimate is the source of truth: re-save with a new price updates the CRM total
  await p.locator('#items-painting [data-field=price]').fill('3.5');
  await p.click('#btnSaveEstimate');
  ok((await projects()).find(x => x.id === tom.id).estimateTotal === (await estimates()).find(e => e.id === tomEst.id).customerTotal, 'CRM total follows estimate pricing');

  // ---------- 24–33. Pipeline ----------
  await nav('crm');
  await tomCard().locator('[data-action=to-prospect]').click();
  ok((await projects()).find(x => x.id === tom.id).stage === 'prospect', '24. Lead → Prospect');
  await tomCard().locator('select[data-action=prospect-status]').selectOption('quote_accepted');
  ok((await projects()).find(x => x.id === tom.id).prospectStatus === 'quote_accepted', 'prospect status: Quote accepted');

  await tomCard().locator('[data-action=to-job]').click();
  ok((await projects()).find(x => x.id === tom.id).stage === 'job', '25. Prospect → Client / Job');
  await tomCard().locator('[data-action=schedule]').click();
  ok(await p.evaluate(() => document.activeElement.id) === 'pmScheduledDate', 'Schedule Job focuses scheduled date');
  await p.fill('#pmScheduledDate', '2026-10-20'); await p.fill('#pmTechnician', 'Alex Rivera'); await p.fill('#pmNotes', 'Gate code 1234');
  await p.click('#projectForm button[type=submit]');
  let tp = (await projects()).find(x => x.id === tom.id);
  ok(tp.scheduledDate === '2026-10-20' && tp.assignedTechnician === 'Alex Rivera' && tp.notes === 'Gate code 1234', 'Schedule Job / Assign Technician / Notes saved');
  await tomCard().locator('[data-action=assign]').click();
  ok(await p.evaluate(() => document.activeElement.id) === 'pmTechnician', 'Assign Technician focuses technician');
  await p.click('#projectModal [data-close=projectModal]');

  await tomCard().locator('[data-action=to-started]').click();
  ok((await projects()).find(x => x.id === tom.id).stage === 'started', '26. Client / Job → Start Project');
  ok(/0 \/ 8 completed/.test(await tomCard().innerText()), 'Start Project shows 0 / 8 completed');

  nextConfirm = false;
  await tomCard().locator('[data-action=to-completed]').click();
  ok((await projects()).find(x => x.id === tom.id).stage === 'started' && lastDialog().includes('0 of 8'), 'moving with unfinished tasks asks first (cancel keeps stage)');

  for (let i = 0; i < 8; i++) {
    await tomCard().locator('input[data-action=task]').nth(i).check();
  }
  tp = (await projects()).find(x => x.id === tom.id);
  ok(tp.tasks.filter(x => ['before', 'project'].includes(x.group)).every(x => x.done) && /8 \/ 8 completed/.test(await tomCard().innerText()), '27. complete project tasks: 8 / 8');

  await tomCard().locator('[data-action=to-completed]').click();
  ok((await projects()).find(x => x.id === tom.id).stage === 'completed', '28. Start Project → Completed');
  ok(/0 \/ 3 completed/.test(await tomCard().innerText()), 'Completed shows 0 / 3');
  const names = ['Acceptance form', 'Invoice', 'Ask for review'];
  for (let i = 0; i < 3; i++) {
    await tomCard().locator('label.check', { hasText: names[i] }).locator('input').check();
    tp = (await projects()).find(x => x.id === tom.id);
    ok(tp.tasks.find(x => x.label === names[i]).done && new RegExp(`${i + 1} / 3 completed`).test(await tomCard().innerText()), `${29 + i}. ${names[i]} checked (${i + 1} / 3)`);
  }

  await tomCard().locator('[data-action=to-followup]').click();
  ok((await projects()).find(x => x.id === tom.id).stage === 'followup', '32. Completed → Follow-up');
  await tomCard().locator('[data-action=open]').click();
  await p.fill('#pmFollowUpDate', '2026-11-20'); await p.selectOption('#pmFollowUpType', 'personal'); await p.fill('#pmFollowUpNotes', 'Ask about stucco next spring');
  await p.click('#projectForm button[type=submit]');
  tp = (await projects()).find(x => x.id === tom.id);
  ok(tp.followUpDate === '2026-11-20' && tp.followUpType === 'personal' && tp.followUpNotes === 'Ask about stucco next spring', 'follow-up date, type, notes saved');
  await tomCard().locator('[data-action=complete-followup]').click();
  ok((await projects()).find(x => x.id === tom.id).followUpCompleted === true, '33. Complete Follow-up');
  await tomCard().locator('[data-action=reopen-followup]').click();
  ok((await projects()).find(x => x.id === tom.id).followUpCompleted === false, 'Reopen follow-up');
  await tomCard().locator('[data-action=complete-followup]').click();

  // ---------- 34–35. Reload CRM ----------
  await p.reload();
  ok(await p.isVisible('#page-crm'), '34. reload CRM page');
  tp = (await projects()).find(x => x.id === tom.id);
  ok(tp.stage === 'followup' && tp.followUpCompleted && tp.tasks.every(x => x.done) && tp.assignedTechnician === 'Alex Rivera', '35. CRM data persists after reload');
  ok(await p.locator('.kanban-col[data-stage=followup] .kcard', { hasText: 'Tom Brown' }).count() === 1 && await p.locator('.kanban-col[data-stage=prospect] .kcard', { hasText: 'Maria' }).count() === 1, '35. cards in correct columns after reload');
  ok((await p.locator('.kanban-col .kanban-head span:first-child').allTextContents()).join('|') === 'Leads / Clients|Prospects|Client / Job|Start the Project|Project Completed|Follow-up', 'Kanban has the 6 pipeline columns');

  // Open estimate from CRM card
  await tomCard().locator('[data-action=open-estimate]').click();
  ok(await p.isVisible('#page-builder') && await v('#estimateNumber') === 'EST-2026-1003', 'CRM card opens linked estimate');

  // ---------- Estimate status ↔ prospect ----------
  await nav('estimates');
  await p.locator('#estimatesBody tr', { hasText: 'EST-2026-1001' }).locator('select[data-action=status]').selectOption('accepted');
  ok((await projects()).find(x => x.estimateId === e1.id).prospectStatus === 'quote_accepted', 'estimate Accepted → prospect status Quote accepted');

  // ---------- 36–37. Duplicates ----------
  prj = await projects();
  const ids = prj.map(x => x.estimateId).filter(Boolean);
  ok(new Set(ids).size === ids.length, '36. no duplicate CRM projects per estimate');
  await nav('builder');
  await p.click('#btnReset');
  await p.fill('#clientName', 'Dup Test'); await p.fill('#estimateNumber', 'EST-2026-1001');
  await p.click('#btnSaveEstimate');
  est = await estimates();
  const nums = est.map(e => e.estimateNumber);
  ok(new Set(nums).size === nums.length && est.find(e => e.clientName === 'Dup Test').estimateNumber === 'EST-2026-1004', '37. duplicate estimate # rejected → next free number used');

  // ---------- Delete estimate / CRM ----------
  await nav('estimates');
  await p.locator('#estimatesBody tr', { hasText: 'Dup Test' }).locator('[data-action=delete]').click();
  ok(!(await estimates()).some(e => e.clientName === 'Dup Test') && lastDialog().includes('Delete estimate'), 'delete estimate (with confirmation)');
  await p.locator('#estimatesBody tr', { hasText: 'EST-2026-1002' }).locator('[data-action=delete]').click();
  ok((await estimates()).length === 2, 'delete duplicate estimate');

  await nav('crm');
  await p.click('#btnNewLead'); await p.fill('#pmClientName', 'Lead To Delete'); await p.click('#projectForm button[type=submit]');
  await p.locator('.kcard', { hasText: 'Lead To Delete' }).locator('[data-action=delete]').click();
  ok(!(await projects()).some(x => x.clientName === 'Lead To Delete'), 'delete CRM lead');
  const mariaId = (await projects()).find(x => x.estimateId === e1.id).id;
  await p.locator('.kcard', { hasText: 'Maria' }).locator('[data-action=delete]').click();
  ok(!(await projects()).some(x => x.id === mariaId) && (await estimates()).find(e => e.id === e1.id).crmProjectId === null, 'deleting CRM project unlinks estimate (estimate kept)');

  // ---------- Settings ----------
  await nav('settings');
  await p.fill('#setCompanyName', 'EverCraft Pro'); await p.fill('#setMarkup', '15');
  await p.click('#settingsForm button[type=submit]');
  ok(await t('#brandName') === 'EverCraft Pro' && (await store('constructionEstimatorSettings')).markup === 15, 'settings saved (company name, default markup)');
  await nav('builder'); await p.click('#btnReset');
  ok(await v('#estMarkup') === '15', 'new estimate uses default markup from Settings');

  // ---------- 38–39. NaN / Infinity ----------
  await addService('drywall', 'Drywall Repair', '1e400', '1e400');
  await p.locator('#items-drywall [data-field=quantity]').fill('-5');
  for (const pg of ['builder', 'estimates', 'services', 'crm', 'settings']) { await nav(pg); await checkNumbers(pg); }
  await nav('builder');
  await p.locator('#items-drywall [data-field=quantity]').fill('99999999999999999999');
  await p.locator('#items-drywall [data-field=price]').fill('99999999999999999999');
  await checkNumbers('huge numbers');

  // ---------- Mobile layout ----------
  await p.setViewportSize({ width: 390, height: 844 });
  await nav('crm');
  const scroll = await p.evaluate(() => { const k = document.getElementById('crmBoard'); return k.scrollWidth > k.clientWidth; });
  const pageScroll = await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  ok(scroll && pageScroll, 'mobile: Kanban scrolls horizontally, page does not');
  await nav('builder');
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'mobile: builder has no horizontal page scroll');

  // ---------- 40. Console errors ----------
  ok(errors.length === 0, '40. zero console errors ' + JSON.stringify(errors));

  console.log(`\n${pass} passed, ${fail} failed`);
  await b.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
