// Several options for one client (Option A, B, C): made from the builder, sent together in one
// email (all PDFs), sent for signature together (one link each); when the client signs one, it is
// Accepted, the others Rejected, and the CRM project follows the chosen option.
// The signing and mail services are faked inside the page (no network).
const { launch, FILE, OUT, TEST_APP_ID, SIGNED_OUT_SDK } = require('../helpers');
let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m);};
const SIGN='https://sign.test.invalid', MAIL='https://mail.test.invalid';
const CONFIG={ base44AppId:TEST_APP_ID, base44AppBaseUrl:'https://preview--ci-test.base44.invalid', base44ServerUrl:'https://preview--ci-test.base44.invalid', signServiceUrl:SIGN, mailServiceUrl:MAIL };

(async()=>{
  const b=await launch({config:CONFIG});
  const ctx=await b.newContext({viewport:{width:1400,height:1000}});
  await ctx.addInitScript(SIGNED_OUT_SDK);
  await ctx.route('https://cdn.jsdelivr.net/npm/html2pdf.js@0.14.0/**',r=>r.fulfill({path:require.resolve('html2pdf.js/dist/html2pdf.bundle.min.js'),contentType:'application/javascript'}));
  const p=await ctx.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
  const dialogs=[]; p.on('dialog',d=>{dialogs.push(d.message()); d.accept();});

  // fake services (the signing service withdraws the other options when one is signed)
  const docs=new Map(); let n=0; const mails=[];
  await p.exposeFunction('__svc',(url,body,auth)=>{
    const q=JSON.parse(body||'{}');
    if(url===MAIL+'/status') return {status:200,body:{connected:true,sender:'evercraft.pro@gmail.com'}};
    if(url===MAIL+'/send'){ mails.push(q); return {status:200,body:{ok:true,from:'evercraft.pro@gmail.com',to:q.to}}; }
    if(auth!=='Bearer tok-ann') return {status:401,body:{error:'Sign in again.'}};
    if(url===SIGN+'/sign/create'){ n++; const id=String(n).padStart(64,'b'); docs.set(id,{...q,id,status:'pending',createdAt:new Date().toISOString()}); return {status:200,body:{ok:true,id,url:`${SIGN}/s/token${n}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,createdAt:new Date().toISOString(),docHash:'f'.repeat(64)}}; }
    if(url===SIGN+'/sign/status') return {status:200,body:{items:q.ids.filter(i=>docs.has(i)).map(i=>{const d=docs.get(i);return {id:i,type:d.type,title:d.title,status:d.status,signedAt:d.signedAt||'',signerName:d.signerName||'',group:d.group||'',option:d.option||'',chosenOption:d.chosenOption||''};})}};
    return {status:404,body:{error:'?'}};
  });
  await p.addInitScript(([SIGN,MAIL])=>{ const real=window.fetch; window.fetch=function(url,opts={}){ url=String(url); if(!url.startsWith(SIGN)&&!url.startsWith(MAIL)) return real.apply(this,arguments);
    return window.__svc(url,opts.body||'',(opts.headers||{}).Authorization||'').then(r=>new Response(JSON.stringify(r.body),{status:r.status,headers:{'Content-Type':'application/json'}})); }; },[SIGN,MAIL]);
  await p.addInitScript(()=>{ window.__opened=[]; const orig=HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click=function(){ if(/^(mailto:|https:\/\/mail\.google\.com\/)/.test(this.href)) window.__opened.push(this.href); else orig.call(this); }; });
  await p.goto(FILE);
  await p.waitForFunction(()=>typeof CLOUD!=='undefined' && CLOUD.state!=='syncing');
  await p.evaluate(()=>{ CLOUD.role='member'; localStorage.setItem(CLOUD_TOKEN_KEY,'tok-ann'); });
  const ests=()=>p.evaluate(()=>loadEstimates());
  const price=async v=>{ await p.locator('#items-painting [data-field=price]').fill(v); };

  // Option A: an estimate with a CRM project
  await p.fill('#clientName','Jackie'); await p.fill('#clientEmail','jackie@x.com'); await p.fill('#projectAddress','5354 Lindley Ave');
  await p.click('[data-action=add-service][data-category=painting]');
  await p.locator('#items-painting select').selectOption({label:'Interior Painting'});
  await p.locator('#items-painting [data-field=quantity]').fill('1000'); await price('3');
  await p.click('#btnSaveEstimate');
  await p.click('#builderMeta [data-action=create-crm]');
  await p.evaluate(()=>document.querySelectorAll('.modal.open').forEach(m=>closeModal(m.id)));
  await p.click('#mainNav [data-page=builder]');
  ok((await p.innerText('#builderMeta')).includes('+ Add Option B'),'a saved estimate offers "+ Add Option B"');
  ok(await p.isVisible('#btnAddOption') && (await p.textContent('#btnAddOption')).startsWith('+ Add Option B'),'a big "+ Add Option B" button sits under Save Estimate');

  // Option B and C
  await p.click('#builderMeta [data-action=add-option]');
  let list=await ests();
  const A=list.find(e=>e.optionLabel==='Option A'), B=list.find(e=>e.optionLabel==='Option B');
  ok(list.length===2 && A && B && A.optionGroup && A.optionGroup===B.optionGroup && A.estimateNumber!==B.estimateNumber,'Option B is a copy with its own estimate number, in the same offer as Option A');
  ok(await p.evaluate(()=>BUILDER.optionLabel)==='Option B' && await p.locator('#builderMeta .opt-pill').count()===2 && (await p.textContent('#builderMeta .opt-pill.on')).startsWith('Option B'),'the builder opens Option B and shows the option buttons');
  await price('4'); await p.click('#btnSaveEstimate');
  ok((await p.textContent('#btnAddOption'))==='+ Add Option C','with two options the button offers Option C');
  await p.click('#btnAddOption');
  await price('5'); await p.click('#btnSaveEstimate');
  list=await ests();
  const C=list.find(e=>e.optionLabel==='Option C');
  ok(list.length===3 && C && [A,B,C].map(o=>list.find(e=>e.id===o.id).customerTotal).join()==='3000,4000,5000','three options with different prices: $3,000 / $4,000 / $5,000');
  const project=await p.evaluate(()=>loadProjects()[0]);
  ok(project.estimateId===A.id && list.every(e=>e.crmProjectId===project.id),'all options belong to the same CRM project; it keeps showing Option A until the client chooses');
  await p.click('#builderMeta .opt-pill >> nth=0');
  ok(await p.evaluate(()=>BUILDER.optionLabel)==='Option A' && await p.inputValue('#items-painting [data-field=price]')==='3','clicking an option button opens that option');

  // Saved Estimates and the PDF show the option
  await p.click('#mainNav [data-page=estimates]');
  ok((await p.locator('#estimatesBody .opt-badge').allTextContents()).sort().join()==='Option A,Option B,Option C','Saved Estimates marks each option');
  await p.click('#mainNav [data-page=builder]');
  await p.evaluate(()=>renderPrintView(getEstimateData()));
  ok((await p.innerText('#printView .pv-meta')).includes('Option A'),'the PDF says which option it is');

  // Email: all options in one email, all PDFs attached
  await p.click('#btnEmail');
  await p.waitForFunction(()=>$('smFrom').textContent.includes('evercraft'));
  const text=await p.inputValue('#smText');
  ok((await p.textContent('#smTitle')).startsWith('Send 3 options') && (await p.textContent('#smFile')).split(' · ').length===3,'Email sends all 3 options: the window lists 3 PDFs');
  ok(text.includes('We prepared 3 options') && text.includes(`Option A - Estimate ${A.estimateNumber}: $3,000.00 (deposit 10%: $300.00)`) && text.includes('Option C - Estimate') && text.includes('$5,000.00') && !text.includes('Interior Painting'),'the email lists each option with its total and deposit; details are in the PDFs');
  await p.click('#smAttach');
  ok((await p.inputValue('#smText')).includes('Interior Painting') && (await p.inputValue('#smText')).includes('TERMS AND CONDITIONS'),'without PDFs, the email has every option in full and the terms once');
  await p.click('#smAttach');
  await p.click('#smSend');
  await p.waitForFunction(()=>!document.getElementById('sendMailModal').classList.contains('open'),null,{timeout:60000});
  const m1=mails[0]||{};
  ok(m1.to==='jackie@x.com' && Array.isArray(m1.attachments) && m1.attachments.length===3 && m1.attachments.every(a=>Buffer.from(a.base64,'base64').slice(0,5).toString()==='%PDF-') && m1.attachments.map(a=>a.filename).every((f,i)=>f.endsWith(`Option ${'ABC'[i]}.pdf`)),'one email goes out with 3 real PDFs, named Option A, B, C');

  // Send for signature: one link per option, one email
  await p.click('#btnSign');
  await p.waitForFunction(()=>document.getElementById('sendMailModal').classList.contains('open'),null,{timeout:30000});
  const created=[...docs.values()];
  const stext=await p.inputValue('#smText');
  ok(created.length===3 && created.every(d=>d.group===A.optionGroup && d.type==='estimate') && created.map(d=>d.option).join()==='Option A,Option B,Option C','Send for Signature makes one signing link per option, all in the same offer');
  ok(created.every((d,i)=>stext.includes(`Review & sign Option ${'ABC'[i]}: ${SIGN}/s/token${i+1}`)) && stext.includes('the others are closed automatically'),'the email has a "Review & sign" link for each option and explains the choice');
  await p.click('#smSend');
  await p.waitForFunction(()=>!document.getElementById('sendMailModal').classList.contains('open'),null,{timeout:60000});
  ok(mails.length===2 && mails[1].attachments.length===3,'it is sent as one email with the 3 PDFs');
  ok((await ests()).every(e=>e.signatures.length===1 && e.signatures[0].status==='pending'),'each option waits for its signature');

  // the client signs Option B → B accepted, A and C rejected, the CRM project shows B
  await p.evaluate(()=>updateProject(loadProjects()[0].id,{stage:'prospect'}));
  const byOpt=o=>[...docs.values()].find(d=>d.option===o);
  Object.assign(byOpt('Option B'),{status:'signed',signedAt:new Date().toISOString(),signerName:'Jackie'});
  for(const o of ['Option A','Option C']) Object.assign(byOpt(o),{status:'cancelled',chosenOption:'Option B'});
  await p.evaluate(()=>refreshSignatures(true));
  list=await ests();
  const st=Object.fromEntries(list.map(e=>[e.optionLabel,e.status]));
  ok(st['Option B']==='accepted' && st['Option A']==='rejected' && st['Option C']==='rejected','after the client signs Option B: B is Accepted, A and C Rejected');
  const proj=await p.evaluate(()=>loadProjects()[0]);
  ok(proj.estimateId===B.id && proj.estimateTotal===4000 && proj.prospectStatus==='quote_accepted','the CRM project (in Prospects) now shows Option B ($4,000) as quote accepted');
  await p.click('#mainNav [data-page=estimates]');
  const rowA=p.locator('#estimatesBody tr',{hasText:A.estimateNumber});
  ok((await rowA.innerText()).includes('not chosen (client signed Option B)'),'the other options say they were not chosen');

  // a duplicate is a separate estimate, not another option
  await rowA.locator('[data-action=duplicate]').click();
  const dup=(await ests()).find(e=>![A.id,B.id,C.id].includes(e.id));
  ok(dup && !dup.optionGroup && !dup.optionLabel,'Duplicate makes an independent estimate (not part of the options)');

  // a new, unsaved estimate also shows the button; clicking it saves first
  await p.click('#mainNav [data-page=builder]');
  await p.evaluate(()=>newEstimate());
  ok(await p.isVisible('#btnAddOption') && (await p.textContent('#btnAddOption')).startsWith('+ Add Option B'),'a new estimate (not saved yet) also shows "+ Add Option B"');
  await p.fill('#clientName','New Client');
  await p.click('[data-action=add-service][data-category=painting]');
  await p.locator('#items-painting select').selectOption({label:'Interior Painting'});
  await p.click('#btnAddOption');
  ok(await p.evaluate(()=>BUILDER.optionLabel)==='Option B' && (await ests()).filter(e=>e.clientName==='New Client').map(e=>e.optionLabel).sort().join()==='Option A,Option B','clicking it on an unsaved estimate saves it as Option A and makes Option B');

  ok(errs.length===0,'no console errors '+JSON.stringify(errs));
  console.log(`\n${pass} passed, ${fail} failed`); await b.close(); process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(2);});
