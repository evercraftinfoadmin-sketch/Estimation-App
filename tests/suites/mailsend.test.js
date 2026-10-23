// Sending from the CRM through the mail service: the Send window, the PDF, the request, errors,
// the Gmail fallback, invoices. The mail service is faked inside the page (no network).
const { launch, FILE, OUT, TEST_APP_ID, SIGNED_OUT_SDK } = require('../helpers');
let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m);};
const MAIL='https://mail.test.invalid';
const CONFIG={ base44AppId:TEST_APP_ID, base44AppBaseUrl:'https://preview--ci-test.base44.invalid', base44ServerUrl:'https://preview--ci-test.base44.invalid', mailServiceUrl:MAIL };

(async()=>{
  const b=await launch({config:CONFIG});
  const ctx=await b.newContext({viewport:{width:1360,height:1000}});
  await ctx.addInitScript(SIGNED_OUT_SDK);
  await ctx.route('https://cdn.jsdelivr.net/npm/html2pdf.js@0.14.0/**',r=>r.fulfill({path:require.resolve('html2pdf.js/dist/html2pdf.bundle.min.js'),contentType:'application/javascript'}));
  const p=await ctx.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
  p.on('dialog',d=>d.accept());

  // fake mail service, answered inside the page
  const svc={connected:true, reply:{status:200,body:null}, sent:[]};
  await p.exposeFunction('__mail',(path,method,headers,body)=>{
    if(path==='/status') return {status:200,body:{connected:svc.connected,sender:'evercraft.pro@gmail.com'}};
    if(path==='/send'){ const req={headers,body:JSON.parse(body)}; svc.sent.push(req); return svc.reply.body ? svc.reply : {status:200,body:{ok:true,id:'m1',from:'evercraft.pro@gmail.com',to:req.body.to}}; }
    return {status:404,body:{}};
  });
  await p.addInitScript(MAIL=>{ const real=window.fetch; window.fetch=function(url,opts={}){ url=String(url); if(!url.startsWith(MAIL)) return real.apply(this,arguments);
    return window.__mail(url.slice(MAIL.length),opts.method||'GET',opts.headers||{},opts.body||'').then(r=>new Response(JSON.stringify(r.body),{status:r.status,headers:{'Content-Type':'application/json'}})); }; },MAIL);
  await p.addInitScript(()=>{ window.__opened=[]; window.__aclick=HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click=function(){ if(/^(mailto:|https:\/\/mail\.google\.com\/)/.test(this.href)) window.__opened.push(this.href); else window.__aclick.call(this); }; });
  await p.goto(FILE);
  await p.waitForFunction(()=>typeof CLOUD!=='undefined' && CLOUD.state!=='syncing');

  // an estimate
  await p.fill('#clientName','Ann Lee'); await p.fill('#clientEmail','ann@x.com'); await p.fill('#projectAddress','1 Main St');
  await p.click('[data-action=add-service][data-category=painting]');
  await p.locator('#items-painting select').selectOption({label:'Interior Painting'});
  await p.locator('#items-painting [data-field=quantity]').fill('1000'); await p.locator('#items-painting [data-field=price]').fill('3');
  await p.fill('#clientMessage','Thanks Ann!');

  // Download PDF: a real PDF file, without the print window
  const fs=require('fs');
  const pdfOf=async click=>{ const dl=p.waitForEvent('download',{timeout:30000}); await click(); const f=await dl; return {name:f.suggestedFilename(), data:fs.readFileSync(await f.path())}; };
  let got=await pdfOf(()=>p.click('#btnPdf'));
  const estNo=await p.evaluate(()=>getEstimateData().estimateNumber);
  ok(got.name===`EverCraft Home Improvement Estimate ${estNo}.pdf` && got.data.slice(0,5).toString()==='%PDF-' && got.data.length>20000,'Download PDF saves the estimate as a PDF file ('+got.name+', '+Math.round(got.data.length/1024)+' KB)');
  // signed out: the Email button opens Gmail as before
  await p.click('#btnEmail'); await p.waitForTimeout(300);
  ok(await p.isHidden('#sendMailModal') && (await p.evaluate(()=>window.__opened.length))===1,'signed out: Email opens Gmail (no Send window)');

  // signed in with CRM access
  await p.evaluate(()=>{ CLOUD.role='member'; localStorage.setItem(CLOUD_TOKEN_KEY,'tok-ann'); window.__opened=[]; });
  await p.click('#btnEmail');
  await p.waitForFunction(()=>$('smFrom').textContent.includes('evercraft.pro@gmail.com'));
  const est=await p.evaluate(()=>getEstimateData());
  ok(await p.isVisible('#sendMailModal') && await p.inputValue('#smTo')==='ann@x.com' && (await p.inputValue('#smSubject')).includes(est.estimateNumber),'signed in: Email opens the Send window, client address and subject filled in');
  ok((await p.inputValue('#smText')).includes('TOTAL: $3,000.00') && (await p.inputValue('#smText')).includes('PAYMENT SCHEDULE') && (await p.inputValue('#smText')).includes('Thanks Ann!'),'message has the estimate details, the client message and the full terms');
  ok((await p.textContent('#smFrom')).includes('From: evercraft.pro@gmail.com') && (await p.textContent('#smFile')).endsWith(`Estimate ${est.estimateNumber}.pdf`) && await p.isChecked('#smAttach'),'shows the company sender and the PDF file to attach');
  await p.locator('#sendMailModal .modal-box').screenshot({path:OUT+'/send-mail.png'});
  await p.fill('#smText',(await p.inputValue('#smText'))+'\nP.S. edited here');
  await p.click('#smSend');
  await p.waitForFunction(()=>!document.getElementById('sendMailModal').classList.contains('open'),null,{timeout:30000});
  const s=svc.sent[0]||{body:{},headers:{}};
  ok(svc.sent.length===1 && s.headers.Authorization==='Bearer tok-ann' && s.body.appId===CONFIG.base44AppId,'Send posts to the mail service with this person\'s CRM sign-in');
  ok(s.body.to==='ann@x.com' && s.body.subject.includes(est.estimateNumber) && s.body.text.endsWith('P.S. edited here') && s.body.fromName==='EverCraft Home Improvement','the edited message, subject and client address are sent');
  const pdf=Buffer.from((s.body.attachment||{}).base64||'','base64');
  ok(pdf.slice(0,5).toString()==='%PDF-' && pdf.length>20000 && pdf.length<5e6 && /Type\s*\/Page\b/.test(pdf.toString('latin1')) && s.body.attachment.filename.endsWith(`Estimate ${est.estimateNumber}.pdf`),'a real PDF of the estimate is attached ('+Math.round(pdf.length/1024)+' KB)');
  require('fs').writeFileSync(OUT+'/sent-estimate.pdf',pdf);
  ok((await p.innerText('.toast')).includes('Sent to ann@x.com from evercraft.pro@gmail.com'),'the person is told it was sent, from the company address');

  // the service refuses
  svc.reply={status:401,body:{error:'Sign in to the CRM again, then send.'}};
  await p.click('#btnEmail'); await p.waitForFunction(()=>$('smFrom').textContent.includes('evercraft'));
  await p.click('#smAttach'); await p.click('#smSend');
  await p.waitForFunction(()=>$('smStatus').textContent.includes('Sign in'));
  ok(await p.isVisible('#sendMailModal') && !(svc.sent[1].body.attachment),'a refused send keeps the window open with the reason; "Attach PDF" off sends no PDF');
  // fall back to Gmail from the window
  await p.click('#smGmail');
  const opened=await p.evaluate(()=>window.__opened);
  ok(await p.isHidden('#sendMailModal') && opened.length===1 && opened[0].startsWith('https://mail.google.com/'),'"Open in Gmail instead" opens Gmail as before');
  svc.reply={status:200,body:null};

  // not connected yet
  svc.connected=false;
  await p.click('#btnEmail'); await p.waitForFunction(()=>$('smStatus').textContent.includes('not connected'));
  ok(await p.isDisabled('#smSend'),'when the company Gmail is not connected, Send is off and the window says so');
  await p.click('[data-close=sendMailModal]');
  svc.connected=true;

  // invoices
  await p.click('#btnSaveEstimate');
  await p.click('#mainNav [data-page=estimates]');
  await p.locator('#estimatesBody tr').first().locator('[data-action=invoice]').click();
  await p.click('#invoiceModal [data-inv=email]');
  await p.waitForFunction(()=>$('smFrom').textContent.includes('evercraft'));
  const invNo=await p.evaluate(()=>EDITING_INVOICE.invoiceNumber);
  ok(await p.isVisible('#sendMailModal') && (await p.textContent('#smTitle'))===`Send invoice ${invNo}` && (await p.inputValue('#smText')).includes('BALANCE DUE'),'invoice Email opens the Send window with the invoice text');
  const before=svc.sent.length;
  await p.click('#smSend');
  await p.waitForFunction(()=>!document.getElementById('sendMailModal').classList.contains('open'),null,{timeout:30000});
  const si=svc.sent[before]||{body:{}};
  const ipdf=Buffer.from((si.body.attachment||{}).base64||'','base64');
  ok(ipdf.slice(0,5).toString()==='%PDF-' && si.body.attachment.filename.endsWith(`Invoice ${invNo}.pdf`),'invoice PDF attached');
  ok(await p.evaluate(()=>EDITING_INVOICE.status)==='sent','a sent invoice is marked Sent');
  await p.click('#sendMailModal [data-close=sendMailModal]').catch(()=>{});
  got=await pdfOf(()=>p.click('#invoiceModal [data-inv=pdf]'));
  ok(got.name===`EverCraft Home Improvement Invoice ${invNo}.pdf` && got.data.slice(0,5).toString()==='%PDF-','invoice Download PDF saves the invoice as a PDF file');
  await p.click('[data-close=invoiceModal]');
  await p.click('#mainNav [data-page=estimates]');
  got=await pdfOf(()=>p.locator('#estimatesBody tr').first().locator('[data-action=pdf]').click());
  ok(got.name.endsWith('.pdf') && got.data.slice(0,5).toString()==='%PDF-','Saved Estimates: the PDF button saves the estimate as a PDF file');

  ok(errs.length===0,'no console errors '+JSON.stringify(errs));
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); process.exit(1); });
