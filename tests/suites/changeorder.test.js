// Change orders: extra work and work removed after the client agreed to an estimate.
// Numbering (EST-…-CO1), credit lines, the contract total on the CRM project, PDF, email,
// invoice, duplicate, delete, and a signed change order becoming accepted.
const { launch, FILE } = require('../helpers');
let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m);};
(async()=>{
  const b=await launch(); const p=await b.newPage({viewport:{width:1360,height:1000}});
  const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
  const dialogs=[]; p.on('dialog',d=>{dialogs.push(d.message()); d.accept();});
  await p.addInitScript(()=>{ window.__prints=0; window.print=()=>{window.__prints++;}; });
  await p.goto(FILE);
  const ests=()=>p.evaluate(()=>loadEstimates());
  const proj=()=>p.evaluate(()=>loadProjects()[0]);
  async function addLine(category,label,qty,price){
    await p.click(`[data-action=add-service][data-category=${category}]`);
    const row=p.locator(`#items-${category} .line-item`).last();
    await row.locator('select').selectOption({label});
    await row.locator('[data-field=quantity]').fill(String(qty));
    await row.locator('[data-field=price]').fill(String(price));
  }

  // The original estimate: painting 1000 × $3 = $3,000, no tax; accepted, with a CRM project.
  await p.fill('#clientName','Ann Lee'); await p.fill('#clientEmail','ann@x.com'); await p.fill('#projectAddress','1 Main St');
  await p.fill('#estTaxRate','0');
  await addLine('painting','Interior Painting',1000,3);
  await p.click('#btnSaveEstimate');
  let [orig]=await ests();
  ok(orig.customerTotal===3000 && !orig.changeOrderOf,'original estimate saved: $3,000');
  ok(!(await p.innerText('#builderMeta')).includes('Change Order'),'a draft estimate does not offer a change order yet');
  await p.click('#mainNav [data-page=estimates]');
  await p.locator('#estimatesBody tr').first().locator('[data-action=status]').selectOption('accepted');
  ok(await p.locator('#estimatesBody tr').first().locator('[data-action=change-order]').count()===1,'Saved Estimates: an accepted estimate offers + Change Order');
  await p.locator('#estimatesBody tr').first().locator('[data-action=crm]').click();
  await p.click('#projectModal .modal-close, #projectModal [data-close]').catch(()=>{});
  await p.evaluate(()=>closeModal('projectModal'));
  let pr=await proj();
  ok(pr && pr.estimateId===orig.id && pr.estimateTotal===3000,'CRM project linked to the estimate: $3,000');

  // Change Order 1 from the CRM project window: +$800 drywall, -$500 painting removed → +$300.
  await p.click('#mainNav [data-page=crm]');
  await p.evaluate(id=>openProjectModal(id),pr.id);
  ok(await p.locator('#pmEstimate [data-pm-action=create-co]').count()===1,'project window offers + Change Order');
  await p.click('#pmEstimate [data-pm-action=create-co]');
  ok(await p.isVisible('#page-builder') && !(await p.isVisible('#projectModal')),'the builder opens with a new change order');
  ok(await p.inputValue('#estimateNumber')===orig.estimateNumber+'-CO1','change order number: original + -CO1');
  ok(await p.inputValue('#clientName')==='Ann Lee' && await p.inputValue('#clientEmail')==='ann@x.com' && await p.inputValue('#estTaxRate')==='0','client, email and tax rate copied from the original');
  ok(await p.locator('.category-card[data-category=credit]').count()===1 && (await p.innerText('.category-card[data-category=credit] h2')).includes('CREDIT'),'change order has a Credit (work removed) section');
  ok(await p.textContent('#sumTitle')==='Change Order Total' && await p.isHidden('#btnAddOption') && await p.textContent('#btnSaveEstimate')==='Save Change Order','side panel: Change Order Total, Save Change Order; no + Add Option');
  ok((await p.innerText('#builderMeta')).includes('Change Order 1') && (await p.innerText('#builderMeta')).includes(orig.estimateNumber),'header: Change Order 1 of the original estimate');
  await addLine('drywall','Drywall Repair',4,200);
  await addLine('credit','Interior Painting',1,500);
  ok(await p.textContent('#sumTotal')==='$300.00','total = $800 added − $500 removed = $300');
  ok((await p.textContent('.category-card[data-category=credit] [data-total]'))==='-$500.00','credit line shows -$500.00');
  const side=await p.innerText('#sumContract');
  ok(side.includes('Original contract') && side.includes('$3,000.00') && side.includes('New contract total') && side.includes('$3,300.00'),'side panel: original $3,000 → new contract total $3,300');
  ok(await p.evaluate(()=>{ const s=[...document.querySelectorAll('#builderSections select')].find(x=>x.closest('[data-category=credit]')); return [...s.options].some(o=>o.text==='Drywall Repair') && [...s.options].some(o=>o.text==='Interior Painting'); }),'credit lines can use any service');
  await p.click('#btnSaveEstimate');
  let list=await ests(); let co1=list.find(e=>e.changeOrderOf===orig.id);
  ok(list.length===2 && co1 && co1.changeOrderSeq===1 && co1.customerTotal===300 && co1.crmProjectId===pr.id && co1.status==='draft','change order saved: CO1, $300, draft, same CRM project');
  pr=await proj();
  ok(pr.estimateId===orig.id && pr.estimateTotal===3000,'project still on the original estimate; a draft change order does not change the total');

  // PDF and email
  const n0=await p.evaluate(()=>window.__prints);
  await p.click('#btnPrint');
  const pv=await p.innerText('#printView');
  ok(await p.evaluate(()=>window.__prints)===n0+1 && pv.includes('CHANGE ORDER') && pv.includes('Original Estimate #') && pv.includes(orig.estimateNumber),'PDF: CHANGE ORDER, its number and the original estimate #');
  ok(pv.includes('CREDIT (WORK REMOVED)') && pv.includes('-$500.00') && pv.includes('CHANGE ORDER TOTAL') && pv.includes('$300.00') && pv.includes('New contract total') && pv.includes('$3,300.00'),'PDF: credit section, change order total and new contract total');
  const mail=await p.evaluate(()=>buildEmailSummary(getEstimateData()));
  ok(mail.includes(`Change Order #: ${orig.estimateNumber}-CO1`) && mail.includes('This change: $300.00') && mail.includes('New contract total: $3,300.00') && !/deposit/i.test(mail),'email: change order #, the change and the new contract total (no deposit line)');
  ok(await p.evaluate(()=>estimatePdfName(getEstimateData())).then(n=>n.includes('Change Order')),'PDF file name says Change Order');

  // Accepting it: the project total follows; the card and the project window show it.
  await p.click('#mainNav [data-page=estimates]');
  const coRow=p.locator('#estimatesBody tr',{hasText:orig.estimateNumber+'-CO1'});
  ok((await coRow.innerText()).includes('Change Order 1') && await coRow.locator('[data-action=invoice]').count()===0,'Saved Estimates: change order badge; no own invoice button');
  await coRow.locator('[data-action=status]').selectOption('accepted');
  pr=await proj();
  ok(pr.estimateTotal===3300,'accepted change order: project total $3,300');
  await p.click('#mainNav [data-page=crm]');
  const card=p.locator('.kcard').first();
  ok((await card.innerText()).includes('$3,300.00') && (await card.innerText()).includes('1 change order · 1 approved'),'CRM card: $3,300 and "1 change order · 1 approved"');
  await p.evaluate(id=>openProjectModal(id),pr.id);
  const pm=await p.innerText('#pmEstimate');
  ok(pm.includes('Change Order 1') && pm.includes('Contract total') && pm.includes('$3,300.00'),'project window lists the change order and the contract total');
  await p.evaluate(()=>closeModal('projectModal'));

  // Change Order 2: removes more than it adds → negative ($-200), and its contract math uses CO1.
  await p.evaluate(id=>createChangeOrder(id),orig.id);
  ok(await p.inputValue('#estimateNumber')===orig.estimateNumber+'-CO2','second change order: -CO2');
  await addLine('credit','Interior Painting',1,200);
  await p.click('#btnSaveEstimate');
  list=await ests(); const co2=list.find(e=>e.changeOrderSeq===2);
  ok(co2 && co2.customerTotal===-200,'a credit-only change order is negative: -$200');
  ok((await p.innerText('#sumContract')).includes('Previously approved change orders') && (await p.innerText('#sumContract')).includes('$300.00') && (await p.innerText('#sumContract')).includes('$3,100.00'),'CO2 contract: previous $300, new total $3,100');
  await p.evaluate(id=>setEstimateStatus(id,'accepted'),co2.id);
  pr=await proj();
  ok(pr.estimateTotal===3100,'two accepted change orders: project total $3,100');
  ok(await p.evaluate(()=>approvedChangeOrdersTotal(loadProjects()[0]))===100,'approvedChangeOrdersTotal: +$100 (for Financials)');

  // Reloading keeps everything (negative totals and credit lines survive storage).
  await p.reload();
  list=await ests();
  const co2r=list.find(e=>e.changeOrderSeq===2);
  ok(co2r.customerTotal===-200 && co2r.items[0].category==='credit' && co2r.items[0].total===-200,'after reload: negative total and credit line kept');

  // Invoice for the job: original lines + accepted change orders.
  await p.evaluate(id=>createOrOpenInvoiceForProject(id),pr.id);
  const names=await p.locator('#invItems [data-f=name]').evaluateAll(xs=>xs.map(x=>x.value));
  ok(names.length===4 && names.includes('Change Order 1 · Drywall Repair') && names.includes('Change Order 1 · Credit: Interior Painting') && names.includes('Change Order 2 · Credit: Interior Painting'),'invoice: original line + all change order lines, credits marked');
  ok((await p.innerText('#invTotals')).includes('$3,100.00'),'invoice total = contract total $3,100');
  await p.evaluate(()=>closeModal('invoiceModal'));

  // Opening the original shows its change orders; duplicate of a change order = the next one.
  await p.evaluate(id=>openEstimate(id),orig.id);
  ok((await p.innerText('#builderMeta')).includes('Change orders:') && await p.locator('#builderMeta .co-pill').count()===2,'original estimate shows its 2 change orders');
  await p.evaluate(id=>duplicateEstimate(id),co1.id);
  list=await ests();
  const co3=list.find(e=>e.changeOrderSeq===3);
  ok(co3 && co3.changeOrderOf===orig.id && co3.estimateNumber===orig.estimateNumber+'-CO3' && co3.status==='draft','Duplicate of a change order makes Change Order 3 (draft)');
  ok((await proj()).estimateTotal===3100,'a draft copy does not change the total');

  // "Open CRM Project" on a change order opens the job, never relinks it.
  await p.evaluate(id=>createOrOpenCrmFromEstimate(id),co1.id);
  ok(await p.isVisible('#projectModal') && (await proj()).estimateId===orig.id,'Open CRM Project from a change order opens the job; project stays on the original');
  await p.evaluate(()=>closeModal('projectModal'));

  // Deleting a change order lowers the total.
  await p.evaluate(id=>deleteEstimate(id),co2.id);
  ok((await proj()).estimateTotal===3300 && (await ests()).length===3,'deleting accepted CO2: project total back to $3,300');

  // A signed change order becomes accepted.
  await p.evaluate(id=>{ const e=getEstimate(id); const s=[{id:'a'.repeat(64),type:'estimate',title:'x',status:'signed',url:'',sentTo:'',createdAt:nowISO(),signedAt:nowISO(),signerName:'Ann'}]; updateEstimate(id,{signatures:s}); settleChangeOrder(getEstimate(id),s); },co3.id);
  ok((await ests()).find(e=>e.id===co3.id).status==='accepted' && (await proj()).estimateTotal===3600,'signed change order: accepted, project total $3,600');

  // Normal estimates are unchanged: money format and estimate numbering.
  ok(await p.evaluate(()=>money(-5)+'|'+money(1234.5))==='-$5.00|$1,234.50','money(): -$5.00 and $1,234.50');
  await p.evaluate(()=>newEstimate());
  ok(!(await p.inputValue('#estimateNumber')).includes('CO') && await p.locator('.category-card[data-category=credit]').count()===0,'a new estimate has a normal number and no Credit section');

  ok(errs.length===0,'no page errors'+(errs.length?': '+errs.join(' | '):''));
  console.log(`\n${pass} passed, ${fail} failed`);
  await b.close();
  process.exit(fail?1:0);
})().catch(e=>{console.error(e);console.log(`\n${pass} passed, ${fail+1} failed`);process.exit(1);});
