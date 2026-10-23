const { launch, FILE, OUT, FIXTURES, MODE } = require('../helpers');
const fs=require('fs'); const XLSX=require('xlsx');
let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m);};
const DIR=OUT;
(async()=>{
  const b=await launch();
  const ctx=await b.newContext({viewport:{width:1360,height:1000},acceptDownloads:true});
  await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/xlsx/**',r=>r.fulfill({path:require.resolve('xlsx/dist/xlsx.full.min.js'),contentType:'application/javascript'}));
  const p=await ctx.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
  const dialogs=[]; p.on('dialog',d=>{dialogs.push(d.message()); d.accept();});
  const est=()=>p.evaluate(()=>JSON.parse(localStorage.getItem(storageKey('constructionEstimatorSavedEstimates'))||'[]'));
  const crm=()=>p.evaluate(()=>JSON.parse(localStorage.getItem(storageKey('constructionEstimatorCRM'))||'[]'));
  await p.goto(FILE+'#crm');

  ok(await p.isVisible('#btnImportCrm'),'CRM page has ⬆ Import');
  await p.click('#btnImportCrm');
  await p.setInputFiles('#importFile',FIXTURES+'/old.csv');
  await p.waitForSelector('#importStep2',{state:'visible'});
  const map=await p.evaluate(()=>Object.fromEntries([...document.querySelectorAll('[data-map]')].map(s=>[s.dataset.map,s.options[s.selectedIndex].text])));
  ok(map.clientName==='Customer' && map.clientEmail==='E-mail' && map.clientPhone==='Cell Phone' && map.address==='Job Address' && map.estimateNumber==='Quote #' && map.date==='Quote Date','columns auto-matched (client, email, phone, address, quote #, date)');
  ok(map.category==='Trade' && map.service==='Description' && map.quantity==='Qty' && map.price==='Unit Price' && map.total==='Amount' && map.status==='Status' && map.notes==='Notes' && map.stage==='— not in file —','columns auto-matched (trade, description, qty, price, amount, status, notes)');
  const summary=await p.innerText('#importSummary');
  ok(/4 estimate/.test(summary) && /5 CRM lead/.test(summary) && /1 skipped/.test(summary),'preview: 4 estimates, 5 leads, 1 skipped ('+summary.replace(/\n/g,' ')+')');
  const preview=await p.innerText('#importPreviewBody');
  ok(/Smith, John/.test(preview) && /\$5,000\.00/.test(preview) && /Lead only/.test(preview) && /No client name/.test(preview),'preview rows: grouped total $5,000, lead-only, skip reason');
  await p.uncheck('#importCreateLeads');
  ok(/4 estimate/.test(await p.innerText('#importSummary')) && /2 skipped/.test(await p.innerText('#importSummary')),'without CRM leads: lead-only row is skipped');
  await p.check('#importCreateLeads');
  await p.click('#btnRunImport');
  ok(dialogs.at(-1).includes('Estimates created: 4') && dialogs.at(-1).includes('CRM leads created: 5') && dialogs.at(-1).includes('Skipped: 1'),'import result message');

  const E=await est(), C=await crm();
  const q501=E.find(e=>e.estimateNumber==='Q-501');
  ok(q501 && q501.items.length===2 && q501.customerTotal===5000 && q501.drywallTotal===2000 && q501.paintingTotal===3000 && q501.status==='sent' && q501.date==='2026-09-15','Q-501: 2 lines, drywall 2000 + painting 3000, sent, date');
  ok(q501.clientName==='Smith, John' && q501.clientPhone==='(818) 555-0101' && q501.address==='123 Main St, Los Angeles, CA','Q-501 client data incl. commas');
  const q502=E.find(e=>e.estimateNumber==='Q-502');
  ok(q502.customerTotal===4800 && q502.stuccoTotal===4800 && q502.status==='accepted' && q502.date==='2026-09-20','Q-502: total-only line → stucco (inferred), approved→accepted, 9/20/26');
  const q503=E.find(e=>e.estimateNumber==='Q-503');
  const cats=await p.evaluate(()=>JSON.parse(localStorage.getItem(storageKey('constructionEstimatorCategories'))||'[]'));
  ok(q503.customerTotal===900 && q503.status==='rejected' && cats.some(c=>c.name==='Roofing') && q503.items[0].categoryName==='Roofing','Q-503: new custom category "Roofing", lost→rejected');
  ok(E.find(e=>e.estimateNumber==='Q-504') && E.find(e=>e.estimateNumber==='Q-504').items[0].categoryName==='Other Services','Q-504: unknown trade → "Other Services"');
  ok(E.every(e=>e.markup===0 && e.taxRate===0),'imported estimates keep their totals (no markup, 0% tax)');
  const john=C.find(x=>x.clientName==='Smith, John'), mary=C.find(x=>x.clientName==='Mary Lee'), tom=C.find(x=>x.clientName==='Tom Brown');
  ok(john.stage==='prospect' && john.prospectStatus==='quote_sent' && john.estimateId===q501.id && q501.crmProjectId===john.id,'John → Prospects (quote sent), linked both ways');
  ok(mary.prospectStatus==='quote_accepted' && tom.stage==='lead' && !tom.estimateId && tom.notes==='Called about a quote','Mary quote accepted; Tom lead-only with notes');
  ok(mary.notes==='Wants "elastomeric" finish','quoted text with "" parsed');

  // folder: imported leads go to "Old CRM leads", kept apart from current leads
  ok(C.filter(x=>['Smith, John','Mary Lee','Tom Brown'].includes(x.clientName)).every(x=>x.folder==='old-crm'),'imported leads are in the folder "Old CRM leads"');
  ok(await p.inputValue('#crmFolder')==='old-crm' && await p.locator('.kcard',{hasText:'Tom Brown'}).count()===1,'after the import the board shows the Old CRM leads folder');
  await p.selectOption('#crmFolder','');
  ok(await p.locator('.kcard',{hasText:'Tom Brown'}).count()===0,'"Current leads" does not show the old leads');
  ok(/Old CRM leads \(5\)/.test(await p.innerText('#crmFolder')),'folder list shows the count of old leads');
  await p.selectOption('#crmFolder','all');
  ok(await p.locator('.kcard',{hasText:'Tom Brown'}).count()===1,'"All leads" shows everything');
  await p.locator('.kcard',{hasText:'Tom Brown'}).locator('[data-action=open]').first().click();
  ok(await p.inputValue('#pmFolder')==='old-crm','lead form shows its folder');
  await p.selectOption('#pmFolder',''); await p.click('#projectForm button[type=submit]'); await p.waitForTimeout(300);
  ok((await crm()).find(x=>x.clientName==='Tom Brown').folder==='','a lead can be moved to Current leads');
  await p.selectOption('#crmFolder','');

  // re-import same file → no duplicates
  await p.click('#btnImportCrm'); await p.setInputFiles('#importFile',FIXTURES+'/old.csv'); await p.waitForSelector('#importStep2',{state:'visible'});
  ok(/already exists/.test(await p.innerText('#importPreviewBody')),'re-import preview: existing estimate numbers marked');
  await p.click('#btnRunImport');
  ok((await est()).length===4 && (await crm()).length===5,'re-import creates no duplicate estimates or leads');

  // app pages show imported data
  await p.click('#mainNav [data-page=estimates]');
  ok(await p.locator('#estimatesBody tr').count()===4,'Saved Estimates lists imported estimates');
  await p.locator('#estimatesBody tr',{hasText:'Q-501'}).locator('[data-action=open]').click();
  ok(await p.textContent('#sumTotal')==='$5,000.00','imported estimate opens in builder with same total');
  await p.click('#mainNav [data-page=crm]');
  await p.selectOption('#crmFolder','all');
  ok(await p.locator('.kcard').count()===5,'CRM board shows 5 imported clients (all folders)');

  // Excel file (sheet with different headers, numbers as numbers, real dates)
  const ws=XLSX.utils.aoa_to_sheet([['Name','Phone','Address','Estimate Number','Date','Service','Quantity','Price','Stage'],
    ['Excel Client','818-555-0199','1 Sheet St','X-900',new Date(2026,8,30),'Drywall Patching',3,85,'Scheduled']],{cellDates:true});
  const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,ws,'Sheet1'); XLSX.writeFile(wb,DIR+'/old.xlsx');
  await p.click('#btnImportCrm'); await p.setInputFiles('#importFile',DIR+'/old.xlsx'); await p.waitForSelector('#importStep2',{state:'visible'});
  await p.click('#btnRunImport');
  const x=(await est()).find(e=>e.estimateNumber==='X-900'), xc=(await crm()).find(c=>c.clientName==='Excel Client');
  ok(x && x.customerTotal===255 && x.drywallTotal===255 && x.date==='2026-09-30','Excel import: X-900, 3 × $85 = $255, date');
  ok(xc && xc.stage==='job','Excel import: "Scheduled" → Client / Job stage');

  // manual column change
  fs.writeFileSync(DIR+'/odd.csv','Who;Where;Money\nZed;10 Z St;"1.234"\n');
  await p.click('#btnImportCrm'); await p.setInputFiles('#importFile',DIR+'/odd.csv'); await p.waitForSelector('#importStep2',{state:'visible'});
  ok(/0 estimate/.test(await p.innerText('#importSummary')),'unknown headers: nothing matched yet');
  await p.selectOption('[data-map=clientName]',{label:'Who'}); await p.selectOption('[data-map=address]',{label:'Where'}); await p.selectOption('[data-map=total]',{label:'Money'});
  ok(/1 estimate/.test(await p.innerText('#importSummary')),'semicolon CSV + manual matching works');
  await p.click('#btnImportBack');
  ok(await p.isVisible('#importStep1'),'back to file choice');
  fs.writeFileSync(DIR+'/empty.csv','Name\n');
  await p.setInputFiles('#importFile',DIR+'/empty.csv');
  await p.waitForFunction(()=>document.getElementById('importError').textContent.includes('no data rows'));
  ok(true,'empty file shows a clear error');
  await p.click('#importModal [data-close=importModal]');

  // backup + restore
  await p.click('#mainNav [data-page=settings]');
  const [dl]=await Promise.all([p.waitForEvent('download'),p.click('#btnExportBackup')]);
  const backupPath=DIR+'/backup.json'; await dl.saveAs(backupPath);
  const bk=JSON.parse(fs.readFileSync(backupPath,'utf8'));
  ok(bk.app==='EverCraftEstimator' && bk.data.estimates.length===5 && bk.data.crm.length===6 && bk.data.settings.terms,'backup contains estimates, CRM, settings');
  await p.evaluate(()=>{localStorage.clear();});
  await p.reload();
  ok((await est()).length===0,'data cleared');
  await p.click('#mainNav [data-page=settings]'); await p.click('#btnRestoreBackup');
  await Promise.all([p.waitForEvent('load'),p.setInputFiles('#importFile',backupPath)]);
  ok((await est()).length===5 && (await crm()).length===6 && dialogs.some(d=>d.includes('ALL current data')),'backup restored after confirmation');
  const [tpl]=await Promise.all([p.waitForEvent('download'),p.click('#mainNav [data-page=settings]').then(()=>p.click('#btnImportTemplate'))]);
  await tpl.saveAs(DIR+'/template.csv');
  ok(fs.readFileSync(DIR+'/template.csv','utf8').includes('Client Name,Email,Phone,Address,Estimate #'),'template CSV downloads');
  ok(errs.length===0,'no console errors '+JSON.stringify(errs));
  console.log(`\n${pass} passed, ${fail} failed`); await b.close();
})().catch(e=>{console.error(e);process.exit(2);});
