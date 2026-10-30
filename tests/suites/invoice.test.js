// Invoices: from a saved estimate and from a completed CRM job, payments, balance, status, print, email, numbering.
const { launch, FILE, OUT, pacificDate } = require('../helpers');
let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m);};
(async()=>{
  const b=await launch(); const p=await b.newPage({viewport:{width:1360,height:1000}});
  const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
  const dialogs=[]; p.on('dialog',d=>{dialogs.push(d.message()); d.accept();});
  await p.addInitScript(()=>{ window.__prints=0; window.print=()=>{window.__prints++;}; });
  await p.goto(FILE);
  const year=Number(pacificDate().slice(0,4));
  const invoices=()=>p.evaluate(()=>loadInvoices());

  // an estimate: 1000 sq ft painting at $3 → $3,000 (no markup)
  await p.fill('#clientName','Ann Lee'); await p.fill('#clientEmail','ann@x.com'); await p.fill('#projectAddress','1 Main St');
  await p.click('[data-action=add-service][data-category=painting]');
  await p.locator('#items-painting select').selectOption({label:'Interior Painting'});
  await p.locator('#items-painting [data-field=quantity]').fill('1000'); await p.locator('#items-painting [data-field=price]').fill('3');
  await p.fill('#clientMessage','Thanks Ann!');
  await p.click('#btnSaveEstimate');
  const est=await p.evaluate(()=>loadEstimates()[0]);
  ok(est.customerTotal===3000 && est.markup===0 && est.markupAmount===0,'estimate saved: total $3,000 (no markup)');

  // Saved Estimates → Create Invoice
  await p.click('#mainNav [data-page=invoices]');
  ok(await p.isVisible('#page-invoices') && (await p.innerText('#invoicesEmpty')).includes('No invoices yet'),'Invoices page exists and starts empty');
  await p.click('#mainNav [data-page=estimates]');
  const invBtn=p.locator('#estimatesBody tr',{hasText:est.estimateNumber}).locator('[data-action=invoice]');
  ok((await invBtn.textContent())==='Create Invoice','saved estimate offers Create Invoice');
  await invBtn.click();
  ok(await p.isVisible('#invoiceModal'),'invoice editor opens');
  ok(await p.inputValue('#invNumber')===`INV-${year}-1001` && await p.inputValue('#invClientName')==='Ann Lee' && await p.inputValue('#invAddress')==='1 Main St','invoice # INV-YEAR-1001, client and address copied');
  ok(await p.locator('#invItems tr[data-id]').count()===1 && await p.locator('#invItems [data-f=name]').inputValue()==='Interior Painting','estimate lines copied');
  ok((await p.innerText('#invTotals')).includes('$3,000.00') && await p.textContent('#invBalance')==='$3,000.00','invoice total equals the estimate total ($3,000), balance due $3,000');
  ok(!(await p.innerText('#invoiceModal')).includes('Markup') && await p.locator('#invMarkup').count()===0,'invoice editor has no markup field or markup line');
  ok(await p.inputValue('#invMessage')==='Thanks Ann!' && (await p.innerText('#invEstimateLink')).includes(est.estimateNumber),'client message and estimate link copied');
  ok(await p.inputValue('#invDueDate')>await p.inputValue('#invDate'),'due date after the invoice date');

  // extra work line
  await p.click('[data-inv=add-line]');
  const last=p.locator('#invItems tr[data-id]').last();
  await last.locator('[data-f=name]').fill('Extra: patch ceiling'); await last.locator('[data-f=quantity]').fill('1'); await last.locator('[data-f=price]').fill('200');
  ok((await p.innerText('#invTotals')).includes('$3,200.00'),'added line (+$200) → total $3,200');

  // payments: deposit 10%, then the full balance
  await p.click('[data-inv=pay-fill][data-share="10"]');
  ok(await p.inputValue('#invPayAmount')==='320','Deposit 10% fills $320');
  await p.selectOption('#invPayMethod','Zelle'); await p.click('[data-inv=add-payment]');
  ok(await p.textContent('#invBalance')==='$2,880.00' && await p.textContent('#invStatus')==='Partially paid','after the deposit: balance $2,880, Partially paid');
  await p.click('#invoiceForm button[type=submit]');
  ok(!(await p.isVisible('#invoiceModal')),'Save Invoice closes the editor');
  let list=await invoices();
  ok(list.length===1 && list[0].total===3200 && list[0].paid===320 && list[0].balance===2880 && list[0].estimateId===est.id && list[0].payments[0].method==='Zelle','saved: total, paid, balance, payment method, link to estimate');

  // Invoices page row; reopen via saved estimate shows the same invoice
  await p.click('#mainNav [data-page=invoices]');
  const row=p.locator('#invoicesBody tr',{hasText:`INV-${year}-1001`});
  ok(await row.count()===1 && (await row.innerText()).includes('Partially paid') && (await p.innerText('#invoicesSummary')).includes('$2,880.00'),'Invoices list: row with status and outstanding $2,880');
  await p.click('#mainNav [data-page=estimates]');
  ok((await invBtn.textContent())==='Open Invoice','saved estimate now offers Open Invoice');
  await invBtn.click();
  ok(await p.inputValue('#invNumber')===`INV-${year}-1001`,'Open Invoice opens the existing invoice (no duplicate)');
  await p.click('[data-inv=pay-fill][data-share="0"]');
  ok(await p.inputValue('#invPayAmount')==='2880','Full balance fills $2,880');
  await p.click('[data-inv=add-payment]');
  ok(await p.textContent('#invBalance')==='$0.00' && await p.textContent('#invStatus')==='Paid','fully paid: balance $0, Paid');

  // print and email
  const n0=await p.evaluate(()=>window.__prints);
  await p.click('[data-inv=print]');
  const pv=await p.innerText('#printView');
  ok(await p.evaluate(()=>{ const i=document.querySelector('#printView .pv-header .pv-logo'); return !!i && i.complete && i.naturalWidth>0; }),'PDF: company logo at the top');
  ok(await p.evaluate(()=>window.__prints)===n0+1 && pv.includes('INVOICE') && pv.includes(`INV-${year}-1001`) && pv.includes('Extra: patch ceiling') && pv.includes('BALANCE DUE') && pv.includes('Zelle') && pv.includes('Thanks Ann!') && pv.includes('TERMS AND CONDITIONS'),'PDF: INVOICE, number, lines, payments, balance, message, terms');
  const body=await p.evaluate(()=>buildInvoiceEmailSummary(computeInvoice(normalizeInvoice(EDITING_INVOICE))));
  ok(body.includes(`Invoice #: INV-${year}-1001`) && body.includes('TOTAL: $3,200.00') && body.includes('BALANCE DUE: $0.00') && body.includes('Thanks Ann!') && body.includes('attached PDF'),'email body: number, total, balance, message; details in the attached PDF');
  const sums=await p.evaluate(()=>{ const inv=computeInvoice(normalizeInvoice(EDITING_INVOICE)); return Math.round(clientPricedLines(inv.items,inv.total).reduce((t,i)=>t+i.total,0)*100)===Math.round(inv.total*100); });
  ok(!/Subtotal|Markup|Sales Tax/.test(pv) && !/Subtotal|Markup|Sales Tax/.test(body) && pv.includes('All taxes included') && body.includes('(all taxes included)') && sums,'invoice for the client: no subtotal, markup or tax line; prices add up to the total, all taxes included');
  await p.click('#invoiceForm button[type=submit]');
  list=await invoices();
  ok(list.length===1 && list[0].balance===0 && list[0].paid===3200,'still one invoice; paid in full');

  // CRM: completed job → invoice button
  await p.click('#mainNav [data-page=crm]'); await p.click('#btnNewLead'); await p.fill('#pmClientName','Bob Job');
  await p.selectOption('#pmStage','completed'); await p.click('#projectForm button[type=submit]'); await p.waitForTimeout(200);
  const card=p.locator('.kcard',{hasText:'Bob Job'});
  ok((await card.locator('[data-action=invoice]').textContent())==='Create Invoice','completed job card shows Create Invoice');
  await card.locator('[data-action=invoice]').click();
  ok(await p.inputValue('#invNumber')===`INV-${year}-1002` && await p.inputValue('#invClientName')==='Bob Job' && await p.locator('#invItems tr[data-id]').count()===0,'job without estimate: invoice INV-YEAR-1002 with client, no lines');
  await p.click('[data-inv=add-line]');
  await p.locator('#invItems tr[data-id] [data-f=name]').fill('Drywall repair'); await p.locator('#invItems tr[data-id] [data-f=price]').fill('500');
  await p.click('#invoiceForm button[type=submit]');
  ok((await card.locator('[data-action=invoice]').textContent()).includes(`INV-${year}-1002`),'card shows the invoice number and status after saving');

  // number conflict, void, delete
  await card.locator('[data-action=invoice]').click();
  await p.fill('#invNumber',`INV-${year}-1001`); await p.click('#invoiceForm button[type=submit]');
  ok(dialogs.at(-1).includes('already used') && (await invoices()).find(i=>i.clientName==='Bob Job').invoiceNumber===`INV-${year}-1003`,'duplicate invoice # is refused and replaced with the next free number');
  await card.locator('[data-action=invoice]').click();
  await p.click('#invVoid');
  ok(await p.textContent('#invStatus')==='Void' && await p.textContent('#invBalance')==='$0.00','Void: status Void, nothing owed');
  await p.click('#invoiceForm button[type=submit]');
  await p.click('#mainNav [data-page=invoices]'); await p.selectOption('#invoiceStatusFilter','void');
  ok(await p.locator('#invoicesBody tr').count()===1,'filter shows the void invoice');
  await p.locator('#invoicesBody [data-action=open]').click(); await p.click('#invDelete');
  ok((await invoices()).length===1,'delete removes the invoice');

  // persistence and mobile
  await p.reload();
  ok((await invoices())[0].balance===0,'invoices persist after reload');
  await p.setViewportSize({width:390,height:844}); await p.click('#mainNav [data-page=invoices]'); await p.selectOption('#invoiceStatusFilter','all');
  await p.locator('#invoicesBody [data-action=open]').click();
  ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'mobile: invoice editor has no horizontal page scroll');
  await p.screenshot({path:OUT+'/invoice-mobile.png'});
  await p.setViewportSize({width:1360,height:1000});
  await p.locator('#invoiceModal .modal-box').screenshot({path:OUT+'/invoice-editor.png'});
  await p.click('[data-inv=print]'); await p.emulateMedia({media:'print'}); await p.locator('#printView').screenshot({path:OUT+'/invoice-pdf.png'}); await p.emulateMedia({media:'screen'});
  // Older records saved WITH a 25% markup: recalculated without it when opened and saved again
  await p.evaluate(()=>{
    const items=[{id:'old-li',category:'painting',name:'Old job',quantity:100,price:10,total:1000}];
    const list=loadEstimates(); list.push(normalizeEstimate({id:'est-old-mk',estimateNumber:'EST-2020-0001',date:'2020-01-01',clientName:'Old Markup',items,subtotal:1000,markup:25,markupAmount:250,taxRate:0,taxAmount:0,customerTotal:1250,status:'sent'})); saveEstimates(list);
    const inv=loadInvoices(); inv.push(normalizeInvoice({id:'inv-old-mk',invoiceNumber:'INV-2020-0001',date:'2020-01-01',clientName:'Old Markup',items,markup:25,taxRate:0,subtotal:1000,markupAmount:250,total:1250,balance:1250,payments:[]})); saveInvoices(inv);
  });
  ok((await p.evaluate(()=>getEstimate('est-old-mk').customerTotal))===1250,'an older estimate keeps its saved total until someone opens and saves it (no bulk change)');
  await p.evaluate(()=>{ document.querySelectorAll('.modal.open').forEach(m=>closeModal(m.id)); openEstimate('est-old-mk'); });
  ok(await p.textContent('#sumTotal')==='$1,000.00','older estimate with 25% markup opens without the markup: $1,000 (was $1,250)');
  await p.click('#btnSaveEstimate');
  const oldEst=await p.evaluate(()=>getEstimate('est-old-mk'));
  ok(oldEst.customerTotal===1000 && oldEst.markup===0 && oldEst.markupAmount===0,'saving it stores the total without markup');
  await p.evaluate(()=>openInvoiceEditor('inv-old-mk'));
  ok((await p.innerText('#invTotals')).includes('$1,000.00') && !(await p.innerText('#invTotals')).includes('$1,250.00'),'older invoice with 25% markup opens without the markup: $1,000');
  await p.click('#invoiceForm button[type=submit]');
  ok((await p.evaluate(()=>getInvoice('inv-old-mk'))).total===1000,'saving it stores the invoice total without markup');

  ok(errs.length===0,'no console errors '+JSON.stringify(errs));
  console.log(`\n${pass} passed, ${fail} failed`); await b.close();
})().catch(e=>{console.error(e);process.exit(2);});
