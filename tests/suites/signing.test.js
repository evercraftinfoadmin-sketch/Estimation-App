// Electronic signatures in the CRM: estimate → Send for Signature; job → Start the Project offers the
// Work Authorization; invoice email includes the Certificate of Completion; statuses on the cards;
// signed PDF. The signing and mail services are faked inside the page (no network).
const fs = require('fs');
const { launch, FILE, OUT, TEST_APP_ID, SIGNED_OUT_SDK } = require('../helpers');
let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m);};
const SIGN='https://sign.test.invalid', MAIL='https://mail.test.invalid';
const CONFIG={ base44AppId:TEST_APP_ID, base44AppBaseUrl:'https://preview--ci-test.base44.invalid', base44ServerUrl:'https://preview--ci-test.base44.invalid', signServiceUrl:SIGN, mailServiceUrl:'' };
const SIG_PNG='data:image/png;base64,'+Buffer.from('\x89PNG\r\n\x1a\nfake','latin1').toString('base64');

(async()=>{
  const b=await launch({config:CONFIG});
  const ctx=await b.newContext({viewport:{width:1400,height:1000},acceptDownloads:true});
  await ctx.addInitScript(SIGNED_OUT_SDK);
  await ctx.route('https://cdn.jsdelivr.net/npm/html2pdf.js@0.14.0/**',r=>r.fulfill({path:require.resolve('html2pdf.js/dist/html2pdf.bundle.min.js'),contentType:'application/javascript'}));
  const p=await ctx.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
  const dialogs=[]; p.on('dialog',d=>{dialogs.push(d.message()); d.accept();});

  // fake services
  const docs=new Map(); let n=0; const mails=[];
  await p.exposeFunction('__svc',(url,body,auth)=>{
    const b=JSON.parse(body||'{}');
    if(url===MAIL+'/status') return {status:200,body:{connected:true,sender:'evercraft.pro@gmail.com'}};
    if(url===MAIL+'/send'){ mails.push(b); return {status:200,body:{ok:true,from:'evercraft.pro@gmail.com',to:b.to}}; }
    if(auth!=='Bearer tok-ann') return {status:401,body:{error:'Sign in again.'}};
    if(url===SIGN+'/sign/create'){ n++; const id=String(n).padStart(64,'a'); const d={...b,id,status:'pending',createdAt:new Date().toISOString(),docHash:'f'.repeat(64)}; docs.set(id,d); return {status:200,body:{ok:true,id,url:`https://sign.test.invalid/s/token${n}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,createdAt:d.createdAt,docHash:d.docHash}}; }
    if(url===SIGN+'/sign/status') return {status:200,body:{items:b.ids.filter(i=>docs.has(i)).map(i=>{const d=docs.get(i);return {id:i,type:d.type,title:d.title,status:d.status,signedAt:d.signedAt||'',signerName:d.signerName||''};})}};
    if(url===SIGN+'/sign/get'){ const d=docs.get(b.id); return d?{status:200,body:d}:{status:404,body:{error:'Document not found.'}}; }
    return {status:404,body:{error:'?'}};
  });
  await p.addInitScript(([SIGN,MAIL])=>{ const real=window.fetch; window.fetch=function(url,opts={}){ url=String(url); if(!url.startsWith(SIGN)&&!url.startsWith(MAIL)) return real.apply(this,arguments);
    return window.__svc(url,opts.body||'',(opts.headers||{}).Authorization||'').then(r=>new Response(JSON.stringify(r.body),{status:r.status,headers:{'Content-Type':'application/json'}})); }; },[SIGN,MAIL]);
  await p.addInitScript(()=>{ window.__opened=[]; const orig=HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click=function(){ if(/^(mailto:|https:\/\/mail\.google\.com\/)/.test(this.href)) window.__opened.push(this.href); else orig.call(this); }; });
  await p.goto(FILE);
  await p.waitForFunction(()=>typeof CLOUD!=='undefined' && CLOUD.state!=='syncing');
  const opened=async()=>{ const l=await p.evaluate(()=>window.__opened.splice(0)); return l.map(u=>decodeURIComponent(u)); };

  // Settings: the three texts are there and editable
  await p.click('#mainNav [data-page=settings]');
  ok((await p.inputValue('#setSignWork')).includes('WORK AUTHORIZATION') && (await p.inputValue('#setSignCompletion')).includes('CERTIFICATE OF COMPLETION') && (await p.inputValue('#setSignEstimate')).includes('ACCEPTANCE'),'Settings shows the three signature document texts');
  await p.fill('#setSignWork',(await p.inputValue('#setSignWork'))+'\n\n6. Our custom clause for {{client}}.');
  await p.click('#signTextsCard button[type=submit]');
  ok((await p.evaluate(()=>loadSettings().signTextWork)).includes('Our custom clause'),'an edited text is saved');

  // estimate
  await p.click('#mainNav [data-page=builder]');
  ok(await p.isVisible('#btnSign'),'Estimate Builder has "Send for Signature"');
  await p.fill('#clientName','Ann Lee'); await p.fill('#clientEmail','ann@x.com'); await p.fill('#projectAddress','1 Main St');
  await p.click('[data-action=add-service][data-category=painting]');
  await p.locator('#items-painting select').selectOption({label:'Interior Painting'});
  await p.locator('#items-painting [data-field=quantity]').fill('1000'); await p.locator('#items-painting [data-field=price]').fill('3');
  await p.click('#btnSign'); await p.waitForTimeout(300);
  ok(dialogs.at(-1).includes('Sign in to the shared CRM'),'signed out: asks to sign in first');
  await p.evaluate(()=>{ CLOUD.role='member'; localStorage.setItem(CLOUD_TOKEN_KEY,'tok-ann'); });
  await p.click('#btnSign');
  await p.waitForFunction(()=>window.__opened.length===1,null,{timeout:10000});
  const estNo=await p.evaluate(()=>getEstimateData().estimateNumber);
  let d=[...docs.values()][0]||{};
  ok(dialogs.at(-1).includes('saved first') && d.type==='estimate' && d.clientEmail==='ann@x.com','the estimate is saved first, then a signing request is created');
  ok(d.html.includes('ESTIMATE') && d.html.includes('Interior Painting') && d.html.includes('ACCEPTANCE OF ESTIMATE') && d.html.includes(`Estimate ${estNo}`) && d.html.includes('$3,750.00') && !d.html.includes('{{'),'the signed document is the estimate plus the acceptance text, filled in');
  ok(/\.pv-doc/.test(d.css) && !/\.kcard/.test(d.css),'the print styles go with it (and nothing else)');
  let o=await opened();
  ok(o.length===1 && o[0].includes('ann@x.com') && o[0].includes('Please sign') && o[0].includes('https://sign.test.invalid/s/token1'),'the client is emailed the signing link (Gmail, while the CRM does not send email itself)');
  let est=await p.evaluate(()=>loadEstimates()[0]);
  ok(est.signatures.length===1 && est.signatures[0].status==='pending' && est.signatures[0].url.endsWith('token1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'),'the request is kept on the estimate');

  // CRM: Start the Project → Work Authorization
  await p.click('#mainNav [data-page=estimates]');
  await p.locator('#estimatesBody tr').first().locator('[data-action=crm]').click();
  await p.waitForTimeout(300); if(await p.isVisible('#projectModal')) await p.click('#projectModal [data-close=projectModal]');
  await p.click('#mainNav [data-page=crm]'); await p.waitForTimeout(200);
  const card=()=>p.locator('.kcard',{hasText:'Ann Lee'});
  ok((await card().locator('.sign-badge').textContent()).includes('Estimate: waiting'),'the card shows the estimate is waiting for a signature');
  await card().locator('[data-action=to-prospect]').click();
  await card().locator('[data-action=to-job]').click();
  await p.evaluate(()=>{ const pr=loadProjects()[0]; updateProject(pr.id,{scheduledDate:'2026-11-02',assignedTechnician:'Bob'}); renderCrmBoard(); });
  const before=docs.size;
  await card().locator('[data-action=to-started]').click();
  await p.waitForFunction(n=>window.__opened.length===1,before,{timeout:10000});
  d=[...docs.values()].at(-1);
  ok(dialogs.at(-1).includes('Send the Work Authorization to Ann Lee') && d.type==='work_authorization','moving to Start the Project offers the Work Authorization');
  ok(d.html.includes('WORK AUTHORIZATION') && d.html.includes('1 Main St') && d.html.includes('$3,750.00') && d.html.includes('Nov 2, 2026') && d.html.includes('Our custom clause for Ann Lee') && !d.html.includes('{{'),'Work Authorization: client, address, total, start date and the edited text');
  o=await opened(); ok(o[0].includes('Work Authorization') && o[0].includes('/s/token2'),'the Work Authorization link is emailed');
  ok((await card().locator('.sign-badge').allTextContents()).join('|').includes('Work Auth.: waiting'),'the card shows the Work Authorization is waiting');

  // the client signs → status refresh → signed PDF
  await p.evaluate(()=>{});
  for(const v of docs.values()) if(v.type==='work_authorization'){ Object.assign(v,{status:'signed',signedAt:new Date().toISOString(),signerName:'Ann Lee',signature:'SIGPNG',ip:'203.0.113.7',userAgent:'Test',consent:'I agree to sign electronically.'}); }
  await p.evaluate(()=>refreshSignatures(true)); await p.waitForTimeout(300);
  ok((await card().locator('.sign-badge').allTextContents()).join('|').includes('Work Auth.: signed ✓') && (await p.innerText('.toast')).includes('Ann Lee signed'),'when the client signs, the card shows it and the team is told');
  ok(await p.evaluate(()=>loadProjects()[0].signatures.find(s=>s.type==='work_authorization').signerName)==='Ann Lee','the signed status is saved on the project (and syncs to everyone)');
  for(const v of docs.values()) if(v.signature==='SIGPNG') v.signature=await p.evaluate(()=>{ const c=document.createElement('canvas'); c.width=200;c.height=60; const x=c.getContext('2d'); x.beginPath(); x.moveTo(10,40); x.lineTo(190,20); x.stroke(); return c.toDataURL('image/png'); });
  const dl=p.waitForEvent('download',{timeout:30000});
  await card().locator('.sign-done').click();
  const f=await dl; const pdf=fs.readFileSync(await f.path());
  ok(f.suggestedFilename().startsWith('Work Authorization') && f.suggestedFilename().endsWith('- signed.pdf') && pdf.slice(0,5).toString()==='%PDF-','clicking "signed ✓" downloads the signed PDF ('+f.suggestedFilename()+')');
  ok(await p.evaluate(()=>document.getElementById('printView').innerHTML.includes('ELECTRONIC SIGNATURE') && document.getElementById('printView').innerHTML.includes('203.0.113.7')),'the signed PDF has the signature and the audit trail');
  fs.writeFileSync(OUT+'/signed-work-authorization.pdf',pdf);
  await card().screenshot({path:OUT+'/sign-card.png'});

  // invoice email with the Certificate of Completion (CRM sends email itself)
  await p.evaluate(()=>{ window.EVERCRAFT_CONFIG.mailServiceUrl='https://mail.test.invalid'; });
  await card().locator('[data-action=to-completed]').click(); await p.waitForTimeout(200);
  await card().locator('[data-action=invoice]').click();
  await p.click('#invoiceModal [data-inv=email]');
  await p.waitForFunction(()=>document.getElementById('sendMailModal').classList.contains('open'));
  ok(await p.isVisible('#smSignRow') && await p.isChecked('#smSign') && (await p.textContent('#smSignLabel')).includes('Certificate of Completion'),'the invoice Send window offers the Certificate of Completion');
  await p.click('#smAttach');
  await p.click('#smSend');
  await p.waitForFunction(()=>!document.getElementById('sendMailModal').classList.contains('open'),null,{timeout:20000});
  d=[...docs.values()].at(-1); const invNo=await p.evaluate(()=>loadInvoices()[0].invoiceNumber);
  ok(d.type==='completion' && d.html.includes('CERTIFICATE OF COMPLETION') && d.html.includes(invNo) && d.html.includes('$3,750.00') && !d.html.includes('{{'),'Certificate of Completion: invoice number and balance filled in');
  ok(mails.length===1 && mails[0].text.includes('BALANCE DUE') && mails[0].text.includes('Certificate of Completion') && mails[0].text.includes('/s/token3'),'the invoice email carries the completion signing link');
  ok((await card().locator('.sign-badge').allTextContents()).join('|').includes('Completion: waiting'),'the card shows the completion certificate is waiting');

  // the estimate gets signed too → Saved Estimates, Builder and the Signatures page show it
  for(const v of docs.values()) if(v.type==='estimate'){ Object.assign(v,{status:'signed',signedAt:new Date().toISOString(),signerName:'Ann Lee',signature:[...docs.values()].find(x=>x.type==='work_authorization').signature,ip:'198.51.100.2',userAgent:'Test',consent:'I agree.'}); }
  await p.evaluate(()=>refreshSignatures(true)); await p.waitForTimeout(300);
  if(await p.isVisible('#invoiceModal')) await p.click('#invoiceModal [data-close=invoiceModal]');
  await p.click('#mainNav [data-page=estimates]');
  ok((await p.locator('#estimatesBody tr').first().locator('.sign-badge').textContent()).includes('Signature: signed ✓'),'Saved Estimates: the row shows the estimate is signed');
  let dl2=p.waitForEvent('download',{timeout:30000});
  await p.locator('#estimatesBody tr').first().locator('.sign-done').click();
  ok((await dl2).suggestedFilename().endsWith('- signed.pdf'),'Saved Estimates: clicking it downloads the signed PDF');
  await p.locator('#estimatesBody tr').first().locator('[data-action=open]').click();
  ok((await p.textContent('#builderMeta')).includes('Signature: signed ✓'),'Estimate Builder shows the signature status of the open estimate');
  await p.click('#mainNav [data-page=signatures]');
  const srows=await p.locator('#signBody tr').allTextContents();
  ok(srows.length===3 && srows.some(t=>t.includes('Estimate') && t.includes('signed ✓')) && srows.some(t=>t.includes('Work Authorization') && t.includes('signed ✓')) && srows.some(t=>t.includes('Certificate of Completion') && t.includes('waiting')),'Signatures page lists all three documents with their status');
  ok((await p.textContent('#signSummary')).includes('2 signed · 1 waiting'),'Signatures page summary: 2 signed, 1 waiting');
  await p.selectOption('#signFilter','pending');
  ok(await p.locator('#signBody tr').count()===1,'filter: waiting for the client');
  await p.selectOption('#signFilter','all');
  dl2=p.waitForEvent('download',{timeout:30000});
  await p.locator('#signBody tr',{hasText:'Work Authorization'}).locator('text=Download signed PDF').click();
  ok((await dl2).suggestedFilename().startsWith('Work Authorization'),'Signatures page: Download signed PDF');
  await p.screenshot({path:OUT+'/signatures-page.png'});

  // a card button sends it again; the estimate badge still waits
  ok(await card().locator('[data-action=sign-completion]').count()===1,'Project Completed cards have a "Completion Certificate" button');
  ok(errs.length===0,'no console errors '+JSON.stringify(errs));
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); process.exit(1); });
