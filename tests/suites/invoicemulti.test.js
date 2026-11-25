// Invoices made from a specific signed estimate: Make Invoice / View Invoice on the Estimate page,
// one client with two signed estimates gets two separate invoices, editing never changes the
// estimate, payment status (Unpaid / Partially Paid / Paid in Full), payment terms, amount due now,
// scope of work, the client's and the project's invoice lists, PDF and email.
const { launch, FILE } = require('../helpers');
let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m);};
(async()=>{
  const b=await launch(); const p=await b.newPage({viewport:{width:1360,height:1000}});
  const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
  const dialogs=[]; let answer=true; p.on('dialog',d=>{dialogs.push(d.message()); if(d.type()==='confirm' && !answer){ answer=true; d.dismiss(); } else d.accept();});
  await p.addInitScript(()=>{ window.__prints=0; window.print=()=>{window.__prints++;}; });
  await p.goto(FILE);
  const invoices=()=>p.evaluate(()=>loadInvoices());
  const estJson=id=>p.evaluate(id=>JSON.stringify(getEstimate(id)),id);
  async function addLine(category,label,qty,price){
    await p.click(`[data-action=add-service][data-category=${category}]`);
    const row=p.locator(`#items-${category} .line-item`).last();
    await row.locator('select').selectOption({label});
    await row.locator('[data-field=quantity]').fill(String(qty));
    await row.locator('[data-field=price]').fill(String(price));
  }
  async function makeEstimate(address,category,label,qty,price){
    await p.evaluate(()=>{ newEstimate(); showPage('builder'); });
    await p.fill('#clientName','Ann Lee'); await p.fill('#clientEmail','ann@x.com'); await p.fill('#projectAddress',address);
    await p.fill('#estTaxRate','0');
    await addLine(category,label,qty,price);
    await p.click('#btnSaveEstimate');
    return p.evaluate(()=>getEstimate(BUILDER.id));
  }

  // One client, two estimates (two contracts at two properties).
  const e1=await makeEstimate('1 Main St','painting','Interior Painting',1000,3);   // $3,000
  ok(await p.isVisible('#btnInvoice') && (await p.textContent('#btnInvoice')).includes('Make Invoice'),'Estimate page: a saved estimate shows Make Invoice');
  await p.click('#btnInvoice');
  ok(dialogs.at(-1).includes('is not signed yet') && !(await p.isVisible('#invoiceModal')),'an unsigned (draft) estimate cannot be invoiced: the user is told why');
  const e2=await makeEstimate('9 Oak Ave','drywall','Drywall Repair',5,400);      // $2,000
  ok(e1.id!==e2.id && e1.clientName===e2.clientName,'two estimates for the same client');

  // Projects for both, linked to one client record.
  await p.evaluate(([a,b])=>{
    setEstimateStatus(a,'accepted'); setEstimateStatus(b,'accepted');
    createOrOpenCrmFromEstimate(a); closeModal('projectModal'); createOrOpenCrmFromEstimate(b); closeModal('projectModal');
    saveClientRecord(normalizeClient({id:'cl-ann',clientName:'Ann Lee',clientEmail:'ann@x.com'}));
    loadProjects().forEach(pr=>updateProject(pr.id,{client_id:'cl-ann'}));
    showPage('builder');
  },[e1.id,e2.id]);
  const e1Before=await estJson(e1.id);

  // Estimate #1 → Make Invoice: everything filled in from that estimate.
  await p.evaluate(id=>openEstimate(id),e1.id);
  await p.click('#btnInvoice');
  ok(await p.isVisible('#invoiceModal'),'signed estimate #1: Make Invoice opens a new invoice');
  ok(await p.inputValue('#invClientName')==='Ann Lee' && await p.inputValue('#invClientEmail')==='ann@x.com' && await p.inputValue('#invAddress')==='1 Main St','client and property address copied');
  ok(await p.locator('#invItems [data-f=name]').inputValue()==='Interior Painting' && (await p.innerText('#invTotals')).includes('$3,000.00'),'lines and total copied ($3,000)');
  ok((await p.inputValue('#invScope')).includes(e1.estimateNumber) && (await p.inputValue('#invScope')).includes('Painting'),'scope of work filled in from the estimate');
  ok((await p.inputValue('#invTerms')).includes('Payment is due within 7 days'),'payment terms filled in');
  ok((await p.innerText('#invEstimateLink')).includes(e1.estimateNumber) && (await p.innerText('#invEstimateLink')).includes('not changed'),'editor names the source estimate and says the estimate is not changed');
  ok(await p.inputValue('#invPayState')==='unpaid' && await p.textContent('#invStatus')==='Unpaid · Draft','new invoice: Unpaid');

  // Edit before sending: price, scope, terms, notes, amount due now.
  await p.locator('#invItems [data-f=price]').fill('3.5');
  await p.fill('#invScope','Interior painting, living room and halls.');
  await p.fill('#invTerms','50% now, the rest on completion.');
  await p.fill('#invNotes','Gate code 1234');
  await p.fill('#invAmountDue','1750');
  ok((await p.innerText('#invTotals')).includes('$3,500.00') && await p.textContent('#invDueNow')==='$1,750.00','edited: total $3,500, amount due now $1,750');
  await p.click('#invoiceForm button[type=submit]');
  let list=await invoices(); const inv1=list[0];
  ok(list.length===1 && inv1.estimateId===e1.id && inv1.total===3500 && inv1.scope.startsWith('Interior painting') && inv1.paymentTerms.startsWith('50%') && inv1.notes==='Gate code 1234' && inv1.amountDue===1750,'invoice #1 saved with its edits and its estimate link');
  ok(inv1.crmProjectId && inv1.client_id==='cl-ann' && inv1.address==='1 Main St','invoice #1 linked to its project, client and property');
  ok(await estJson(e1.id)===e1Before,'the signed estimate #1 is unchanged (still $3,000)');
  ok((await p.textContent('#btnInvoice')).includes('View Invoice '+inv1.invoiceNumber),'Estimate page now shows View Invoice');

  // Payment status: Partially Paid → enter the amount received; Paid in Full; Unpaid.
  await p.click('#btnInvoice');
  ok(await p.inputValue('#invNumber')===inv1.invoiceNumber,'View Invoice reopens the same invoice');
  await p.selectOption('#invPayState','partial');
  ok((await p.textContent('#invPayHint')).includes('Enter the amount received') && await p.evaluate(()=>document.activeElement.id)==='invPayAmount','Partially Paid asks for the amount received');
  await p.fill('#invPayAmount','1000'); await p.click('[data-inv=add-payment]');
  ok(await p.inputValue('#invPayState')==='partial' && await p.textContent('#invPaid')==='$1,000.00' && await p.textContent('#invBalance')==='$2,500.00' && await p.textContent('#invStatus')==='Partially Paid','partial: paid $1,000, remaining $2,500');
  await p.selectOption('#invPayState','paid');
  ok(await p.textContent('#invPaid')==='$3,500.00' && await p.textContent('#invBalance')==='$0.00' && await p.textContent('#invStatus')==='Paid in Full','Paid in Full: paid = total, balance $0');
  await p.selectOption('#invPayState','unpaid');
  ok(dialogs.at(-1).includes('Unpaid') && await p.textContent('#invPaid')==='$0.00' && await p.textContent('#invBalance')==='$3,500.00','Unpaid: payments removed, full amount due');
  answer=false; await p.selectOption('#invPayState','paid'); await p.selectOption('#invPayState','unpaid');
  ok(await p.inputValue('#invPayState')==='paid' && await p.textContent('#invBalance')==='$0.00','cancelling Unpaid keeps the payments');
  await p.selectOption('#invPayState','unpaid');
  await p.fill('#invPayAmount','1000'); await p.click('[data-inv=add-payment]');
  await p.click('#invoiceForm button[type=submit]');
  ok((await invoices())[0].paid===1000 && (await invoices())[0].balance===2500,'saved: paid $1,000, balance $2,500');

  // PDF and email carry the payment details.
  await p.click('#btnInvoice');
  await p.click('[data-inv=print]');
  const pv=await p.innerText('#printView');
  ok(pv.includes('SCOPE OF WORK') && pv.includes('Interior painting, living room') && pv.includes('PAYMENT TERMS') && pv.includes('50% now') && pv.includes('AMOUNT DUE NOW') && pv.includes('$1,750.00') && pv.includes('Partially Paid') && !pv.includes('Gate code'),'PDF: scope, payment terms, amount due now, payment status; internal notes not shown');
  const mail=await p.evaluate(()=>buildInvoiceEmailSummary(computeInvoice(normalizeInvoice(EDITING_INVOICE))));
  ok(mail.includes('AMOUNT DUE NOW: $1,750.00') && mail.includes('Payment terms: 50% now') && mail.includes('BALANCE DUE: $2,500.00') && !mail.includes('Gate code'),'email: balance, amount due now, payment terms; no internal notes');
  await p.evaluate(()=>closeModal('invoiceModal'));

  // Estimate #2 → its own invoice; invoice #1 is not touched.
  const inv1Before=JSON.stringify((await invoices())[0]);
  await p.evaluate(id=>openEstimate(id),e2.id);
  ok((await p.textContent('#btnInvoice')).includes('Make Invoice'),'estimate #2 has no invoice yet: Make Invoice');
  await p.click('#btnInvoice');
  ok(await p.inputValue('#invAddress')==='9 Oak Ave' && (await p.innerText('#invTotals')).includes('$2,000.00') && await p.locator('#invItems [data-f=name]').inputValue()==='Drywall Repair','invoice #2 from estimate #2: its address, lines and $2,000');
  await p.click('#invoiceForm button[type=submit]');
  list=await invoices();
  const inv2=list.find(i=>i.estimateId===e2.id);
  ok(list.length===2 && inv2 && inv2.invoiceNumber!==inv1.invoiceNumber && inv2.total===2000 && inv2.paid===0,'two separate invoices with their own numbers and payments');
  ok(JSON.stringify(list.find(i=>i.id===inv1.id))===inv1Before,'invoice #1 unchanged by invoice #2');

  // No duplicate from the same estimate, even if a second draft is started.
  await p.evaluate(id=>openInvoiceEditor(null,invoiceFromEstimate(getEstimate(id))),e1.id);
  await p.click('#invoiceForm button[type=submit]');
  ok(dialogs.at(-1).includes('already has invoice') && (await invoices()).length===2 && await p.inputValue('#invNumber')===inv1.invoiceNumber,'a second invoice from estimate #1 is refused; the existing one opens');
  await p.evaluate(()=>closeModal('invoiceModal'));

  // Saved Estimates, CRM cards and the project window each point at the right invoice.
  await p.click('#mainNav [data-page=estimates]');
  ok(await p.locator('#estimatesBody tr',{hasText:e2.estimateNumber}).locator('[data-action=invoice]').textContent()==='View Invoice','Saved Estimates: View Invoice');
  await p.click('#mainNav [data-page=crm]');
  const card2=p.locator('.kcard',{hasText:'9 Oak Ave'}).first();
  const pr2=await p.evaluate(id=>loadProjects().find(x=>x.estimateId===id),e2.id);
  await p.evaluate(id=>moveProject(id,'completed'),pr2.id);
  ok((await p.locator(`.kcard[data-id="${pr2.id}"] [data-action=invoice]`).textContent()).includes(inv2.invoiceNumber),'CRM card of job #2 shows invoice #2 (not #1)');
  await p.evaluate(id=>openProjectModal(id),pr2.id);
  ok((await p.innerText('#pmEstimate')).includes(inv2.invoiceNumber) && !(await p.innerText('#pmEstimate')).includes(inv1.invoiceNumber),'project window lists its own invoice only');
  await p.evaluate(()=>closeModal('projectModal'));

  // The client record lists both invoices, each with its estimate, property, total, status, balance.
  await p.evaluate(()=>{ showPage('clients'); openClientProfile('cl-ann'); });
  const cl=await p.innerText('#clInvoices');
  ok([inv1.invoiceNumber,inv2.invoiceNumber,e1.estimateNumber,e2.estimateNumber,'1 Main St','9 Oak Ave','$3,500.00','$2,000.00','Partially Paid','$2,500.00'].every(x=>cl.includes(x)),'client record: both invoices with estimate, property, total, status and balance');
  await p.locator('#clInvoices tr',{hasText:inv2.invoiceNumber}).locator('[data-cl-invoice]').click();
  ok(await p.isVisible('#invoiceModal') && await p.inputValue('#invNumber')===inv2.invoiceNumber,'Open from the client record opens that invoice');
  await p.evaluate(()=>closeModal('invoiceModal'));

  // Invoices page: status labels and the Unpaid filter.
  await p.click('#mainNav [data-page=invoices]');
  await p.selectOption('#invoiceStatusFilter','unpaid');
  ok(await p.locator('#invoicesBody tr').count()===1 && (await p.innerText('#invoicesBody')).includes(inv2.invoiceNumber),'Unpaid filter shows only the unpaid invoice');
  await p.selectOption('#invoiceStatusFilter','all');

  // A signed estimate (signature, status not changed yet) can be invoiced; a change order cannot have its own.
  const e3=await makeEstimate('5 Pine Rd','stucco','Stucco Repair',1,900);
  await p.evaluate(id=>updateEstimate(id,{signatures:[{id:'b'.repeat(64),type:'estimate',title:'x',status:'signed',url:'',sentTo:'',createdAt:nowISO(),signedAt:nowISO(),signerName:'Ann'}]}),e3.id);
  ok(await p.evaluate(id=>estimateIsAgreed(getEstimate(id)),e3.id),'an estimate with a client signature counts as signed');
  await p.evaluate(id=>createChangeOrder(id),e1.id);
  ok(await p.isHidden('#btnInvoice'),'a change order has no Make Invoice button (it goes on its estimate\'s invoice)');

  // Everything persists.
  await p.reload();
  list=await invoices();
  const r1=list.find(i=>i.id===inv1.id);
  ok(r1.scope.startsWith('Interior painting') && r1.paymentTerms.startsWith('50%') && r1.amountDue===1750 && r1.notes==='Gate code 1234' && r1.client_id==='cl-ann','after reload: scope, terms, amount due, notes and client kept');

  ok(errs.length===0,'no page errors'+(errs.length?': '+errs.join(' | '):''));
  console.log(`\n${pass} passed, ${fail} failed`);
  await b.close();
  process.exit(fail?1:0);
})().catch(e=>{console.error(e);console.log(`\n${pass} passed, ${fail+1} failed`);process.exit(1);});
