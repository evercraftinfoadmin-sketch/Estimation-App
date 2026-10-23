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
  const short=await p.inputValue('#smText');
  ok(short.includes('TOTAL: $3,000.00 (all taxes included)') && short.includes('Required deposit (10%): $300.00') && short.includes('Thanks Ann!') && short.includes('attached PDF') && short.includes('Best regards,') && !short.includes('PAYMENT SCHEDULE') && !short.includes('Interior Painting'),'the email with the PDF has only the basics: total, the deposit from the Terms (10%), the client message; services and terms are in the PDF');
  await p.click('#smAttach');
  const full=await p.inputValue('#smText');
  ok(full.includes('Interior Painting') && full.includes('PAYMENT SCHEDULE') && full.includes('TOTAL: $3,000.00'),'without the PDF ("Attach PDF" unticked) the email has the full estimate and terms');
  await p.click('#smAttach');
  ok(await p.inputValue('#smText')===short && await p.isChecked('#smAttach'),'ticking it again brings back the short email');
  ok((await p.textContent('#smFrom')).includes('From: evercraft.pro@gmail.com') && (await p.textContent('#smFile')).endsWith(`Estimate ${est.estimateNumber}.pdf`) && await p.isChecked('#smAttach'),'shows the company sender and the PDF file to attach');
  await p.locator('#sendMailModal .modal-box').screenshot({path:OUT+'/send-mail.png'});
  await p.fill('#smText',(await p.inputValue('#smText'))+'\nP.S. edited here');
  await p.click('#smAttach'); await p.click('#smAttach');
  ok((await p.inputValue('#smText')).endsWith('P.S. edited here'),'a message the person edited is never replaced when "Attach PDF" is toggled');
  await p.click('#smSend');
  await p.waitForFunction(()=>!document.getElementById('sendMailModal').classList.contains('open'),null,{timeout:30000});
  const s=svc.sent[0]||{body:{},headers:{}};
  ok(svc.sent.length===1 && s.headers.Authorization==='Bearer tok-ann' && s.body.appId===CONFIG.base44AppId,'Send posts to the mail service with this person\'s CRM sign-in');
  ok(s.body.to==='ann@x.com' && s.body.subject.includes(est.estimateNumber) && s.body.text.endsWith('P.S. edited here') && s.body.fromName==='EverCraft Home Improvement','the edited message, subject and client address are sent');
  const pdf=Buffer.from((s.body.attachment||{}).base64||'','base64');
  ok(pdf.slice(0,5).toString()==='%PDF-' && pdf.length>20000 && pdf.length<5e6 && /Type\s*\/Page\b/.test(pdf.toString('latin1')) && s.body.attachment.filename.endsWith(`Estimate ${est.estimateNumber}.pdf`),'a real PDF of the estimate is attached ('+Math.round(pdf.length/1024)+' KB)');
  require('fs').writeFileSync(OUT+'/sent-estimate.pdf',pdf);
  const pdfText=pdf.toString('latin1');
  ok(pdfText.trimEnd().endsWith('%%EOF') && pdfText.includes(`/Title (EverCraft Home Improvement Estimate ${est.estimateNumber})`) && pdfText.includes('/Author (EverCraft Home Improvement)'),'the attached PDF is complete (ends properly) and carries a title and author, which phone viewers show');
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
  const invText=await p.inputValue('#smText');
  ok(invText.includes(`Invoice #: ${invNo}`) && invText.includes('TOTAL: $3,000.00') && invText.includes('BALANCE DUE: $3,000.00') && invText.includes('attached PDF') && !invText.includes('Interior Painting') && !invText.includes('TERMS AND CONDITIONS'),'the invoice email has only the basics (number, total, balance); the lines and terms are in the PDF');
  ok(await p.evaluate(()=>{ const keep=SETTINGS.terms; const r=[termsDepositPercent()]; SETTINGS.terms='Payment: 25% deposit, rest on completion.'; r.push(termsDepositPercent()); SETTINGS.terms='Pay on completion.'; r.push(termsDepositPercent()); SETTINGS.terms=keep; return r.join(','); })==='10,25,','the deposit % is read from the Terms (10% in the default terms; none when the terms name no deposit)');
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

  // ---------- Safe PDF making (phones) ----------
  const pageCount=b64=>(Buffer.from(b64,'base64').toString('latin1').match(/\/Type \/Page\b/g)||[]).length;
  const lim=await p.evaluate(()=>({short:pdfCanvasScale(720,1200), tall:pdfCanvasScale(720,12000), huge:pdfCanvasScale(720,60000)}));
  ok(lim.short===2 && lim.tall<2 && 720*lim.tall*12000*lim.tall<=12e6+1 && 60000*lim.huge<=16000+1,'a long document is drawn at a lower resolution so phones can make it ('+lim.tall.toFixed(2)+'x for 12,000 px)');
  ok(await p.evaluate(()=>{ const c=document.createElement('canvas'); c.width=1440; c.height=2000; const x=c.getContext('2d'); x.fillStyle='#fff'; x.fillRect(0,0,1440,2000); const blank=pdfCanvasHasInk(c); x.fillStyle='#111'; x.font='28px sans-serif'; x.fillText('ESTIMATE',40,60); return !blank && pdfCanvasHasInk(c) && !pdfCanvasHasInk(c,200,1800); }),'a blank picture (what a phone gives when it runs out of room) is detected');
  const retry=await p.evaluate(async()=>{ const real=renderPdf, realInk=pdfCanvasHasInk, scales=[]; let first=true;
    window.renderPdf=(el,sc,t)=>{ scales.push(sc); return real(el,sc,t); };
    window.pdfCanvasHasInk=(...a)=>{ if(first && a.length===1){ first=false; return false; } return realInk(...a); };
    try{ const b64=await makePdfBase64(()=>renderPrintView(getEstimateData()),'Retry test'); return {scales, ok:isValidPdfBase64(b64)}; } finally{ window.renderPdf=real; window.pdfCanvasHasInk=realInk; } });
  ok(retry.ok && retry.scales.join(',')==='2,1','if the picture comes out blank, the PDF is made again at a lower resolution ('+retry.scales.join(' then ')+')');
  // the device can't draw it at all → no broken PDF is sent, the person is told
  const n0=svc.sent.length;
  await p.evaluate(()=>{ window.__realInk=pdfCanvasHasInk; window.pdfCanvasHasInk=()=>false; });
  await p.click('#mainNav [data-page=builder]'); await p.click('#btnEmail'); await p.waitForFunction(()=>$('smFrom').textContent.includes('evercraft'));
  await p.click('#smSend'); await p.waitForFunction(()=>$('smStatus').textContent.includes('PDF could not be made'));
  ok(svc.sent.length===n0 && await p.isVisible('#sendMailModal') && !(await p.isDisabled('#smSend')),'when the PDF cannot be made, nothing broken is sent and the window says why');
  await p.evaluate(()=>{ window.pdfCanvasHasInk=window.__realInk; closeModal('sendMailModal'); });
  // a document that ends just past a page gets no extra empty page; real content on a second page is kept
  const pages=await p.evaluate(async()=>{
    const mk=(h,bottomText)=>makePdfBase64(()=>{ $('printView').innerHTML=`<div class="pv" style="height:${h}px;position:relative"><b>Top</b>${bottomText?'<b style="position:absolute;bottom:0">Bottom</b>':''}</div>`; },'Pages test');
    return {justOver:await mk(961,false), twoPages:await mk(1200,true)};
  });
  ok(pageCount(pages.justOver)===1 && pageCount(pages.twoPages)===2,'no nearly-empty extra page at the end; a real second page is kept');

  // ---------- Download on a phone: the share sheet (Save to Files, Mail, …) ----------
  const mctx=await b.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,deviceScaleFactor:3,acceptDownloads:true});
  await mctx.route('https://cdn.jsdelivr.net/npm/html2pdf.js@0.14.0/**',r=>r.fulfill({path:require.resolve('html2pdf.js/dist/html2pdf.bundle.min.js'),contentType:'application/javascript'}));
  await mctx.addInitScript(SIGNED_OUT_SDK);
  await mctx.addInitScript(()=>{ window.__shared=[]; window.__shareMode='ok';
    navigator.canShare=d=>!!(d && d.files && d.files.length);
    navigator.share=async d=>{ if(window.__shareMode==='denied') throw new DOMException('no gesture','NotAllowedError'); const f=d.files[0]; const head=new Uint8Array(await f.slice(0,5).arrayBuffer()); window.__shared.push({name:f.name,type:f.type,size:f.size,head:String.fromCharCode(...head)}); }; });
  const m=await mctx.newPage();
  const merrs=[]; m.on('pageerror',e=>merrs.push(e.message));
  await m.goto(FILE);
  await m.evaluate(()=>{ $('clientName').value='Phone Client'; BUILDER.items=[{id:'m1',category:'painting',name:'Interior Painting',quantity:500,price:3}]; renderBuilderItems(); });
  ok(await m.evaluate(()=>matchMedia('(pointer:coarse)').matches),'(phone emulation: touch screen)');
  await m.evaluate(()=>window.scrollTo(0,0)); await m.locator('#btnPdf').scrollIntoViewIfNeeded(); await m.tap('#btnPdf');
  await m.waitForFunction(()=>window.__shared.length===1,null,{timeout:30000});
  const sh=(await m.evaluate(()=>window.__shared))[0];
  ok(sh.type==='application/pdf' && sh.head==='%PDF-' && sh.size>20000 && sh.name.endsWith('.pdf'),'on a phone, Download PDF opens the share sheet with a real PDF file ('+sh.name+', '+Math.round(sh.size/1024)+' KB)');
  await m.evaluate(()=>{ window.__shareMode='denied'; });
  const mdl=m.waitForEvent('download',{timeout:30000}); await m.tap('#btnPdf'); const mf=await mdl;
  ok(require('fs').readFileSync(await mf.path()).slice(0,5).toString()==='%PDF-' && mf.suggestedFilename().endsWith('.pdf'),'if the phone browser refuses the share sheet, the PDF is downloaded instead');
  ok(merrs.length===0,'phone: no page errors '+JSON.stringify(merrs));

  ok(errs.length===0,'no console errors '+JSON.stringify(errs));
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); process.exit(1); });
