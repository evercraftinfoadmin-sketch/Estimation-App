// Estimate options signed independently: 5 options sent to a test client; the client signs Option 1,
// the others stay open; then signs Option 3: both are signed, each with its own status, time and
// signed copy; the CRM project shows both and their total. Re-signing a signed option needs an
// owner / admin. The signing and mail services are faked inside the page; the fake signing service
// behaves like the real one now does (signing one option never closes the others).
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
  const dialogs=[]; let answer=true; p.on('dialog',d=>{dialogs.push(d.message()); answer ? d.accept() : d.dismiss();});

  const docs=new Map(); let n=0; const mails=[];
  await p.exposeFunction('__svc',(url,body,auth)=>{
    const q=JSON.parse(body||'{}');
    if(url===MAIL+'/status') return {status:200,body:{connected:true,sender:'evercraft.pro@gmail.com'}};
    if(url===MAIL+'/send'){ mails.push(q); return {status:200,body:{ok:true,from:'evercraft.pro@gmail.com',to:q.to}}; }
    if(auth!=='Bearer tok-ann') return {status:401,body:{error:'Sign in again.'}};
    if(url===SIGN+'/sign/create'){ n++; const id=String(n).padStart(64,'c'); docs.set(id,{...q,id,status:'pending',createdAt:new Date().toISOString()}); return {status:200,body:{ok:true,id,url:`${SIGN}/s/token${n}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,createdAt:new Date().toISOString(),docHash:'f'.repeat(64)}}; }
    if(url===SIGN+'/sign/status') return {status:200,body:{items:q.ids.filter(i=>docs.has(i)).map(i=>{const d=docs.get(i);return {id:i,type:d.type,title:d.title,status:d.status,signedAt:d.signedAt||'',signerName:d.signerName||'',group:d.group||'',option:d.option||'',chosenOption:''};})}};
    if(url===SIGN+'/sign/get'){ const d=docs.get(q.id); return d ? {status:200,body:{...d,signature:'data:image/png;base64,AAAA',docHash:'f'.repeat(64),consent:'I agree.'}} : {status:404,body:{error:'?'}}; }
    return {status:404,body:{error:'?'}};
  });
  await p.addInitScript(([SIGN,MAIL])=>{ const real=window.fetch; window.fetch=function(url,opts={}){ url=String(url); if(!url.startsWith(SIGN)&&!url.startsWith(MAIL)) return real.apply(this,arguments);
    return window.__svc(url,opts.body||'',(opts.headers||{}).Authorization||'').then(r=>new Response(JSON.stringify(r.body),{status:r.status,headers:{'Content-Type':'application/json'}})); }; },[SIGN,MAIL]);
  await p.goto(FILE);
  await p.waitForFunction(()=>typeof CLOUD!=='undefined' && CLOUD.state!=='syncing');
  await p.evaluate(()=>{ CLOUD.role='admin'; localStorage.setItem(CLOUD_TOKEN_KEY,'tok-ann'); });
  const ests=()=>p.evaluate(()=>loadEstimates().filter(e=>e.optionGroup).sort((a,b)=>a.optionLabel.localeCompare(b.optionLabel)));
  const clientSigns=async(label,when)=>{ for(const d of docs.values()) if(d.option===label && d.status==='pending') Object.assign(d,{status:'signed',signedAt:when,signerName:'TEST Client'}); await p.evaluate(()=>refreshSignatures(true)); };

  // 1. five options for a test client, with a CRM project
  await p.fill('#clientName','TEST Multi Option Client'); await p.fill('#clientEmail','test.client@example.com'); await p.fill('#projectAddress','1 Test Way, Los Angeles, CA');
  await p.click('[data-action=add-service][data-category=painting]');
  await p.locator('#items-painting select').selectOption({label:'Interior Painting'});
  await p.locator('#items-painting [data-field=quantity]').fill('100'); await p.locator('#items-painting [data-field=price]').fill('10');
  await p.click('#btnSaveEstimate');
  await p.click('#builderMeta [data-action=create-crm]');
  await p.evaluate(()=>document.querySelectorAll('.modal.open').forEach(m=>closeModal(m.id)));
  await p.click('#mainNav [data-page=builder]');
  for(const price of ['20','30','40','50']){ await p.click('#btnAddOption'); await p.locator('#items-painting [data-field=price]').fill(price); await p.click('#btnSaveEstimate'); }
  let list=await ests();
  ok(list.length===5 && list.map(e=>e.optionLabel).join()==='Option A,Option B,Option C,Option D,Option E' && list.map(e=>e.customerTotal).join()==='1000,2000,3000,4000,5000','five options of one offer ($1,000 … $5,000)');
  await p.click('#btnAddOption');
  ok((await ests()).length===6 && (await p.evaluate(()=>BUILDER.optionLabel))==='Option F','more than five options are possible (no limit of 5)');
  await p.evaluate(()=>deleteEstimate(BUILDER.id)); // back to five for the scenario
  list=await ests();
  const [o1,o2,o3,o4,o5]=list;

  // send all five for signature: one email, five links, five PDFs
  await p.evaluate(id=>openEstimate(id),o1.id);
  await p.click('#btnSign'); await p.waitForSelector('#optionPickModal.open');
  ok(await p.locator('#optPickList input:checked').count()===5,'Send for Signature offers all 5 options, all ticked');
  await p.click('#optPickSend');
  await p.waitForFunction(()=>document.getElementById('sendMailModal').classList.contains('open'),null,{timeout:30000});
  const text=await p.inputValue('#smText');
  ok(docs.size===5 && text.includes('sign the ones you want, one or several') && !text.includes('closed automatically'),'five signing links; the email says the client may sign several (nothing about closing the others)');
  await p.click('#smSend');
  await p.waitForFunction(()=>!document.getElementById('sendMailModal').classList.contains('open'),null,{timeout:90000});
  ok(mails.length===1 && mails[0].attachments.length===5,'one email with the 5 PDFs');

  // 2./3. the client signs Option A (= option 1): the others stay available
  await clientSigns('Option A','2026-11-05T17:00:00.000Z');
  list=await ests();
  const st=()=>Object.fromEntries(list.map(e=>[e.optionLabel,e.status]));
  ok(st()['Option A']==='accepted' && ['Option B','Option C','Option D','Option E'].every(o=>!['accepted','rejected'].includes(st()[o])),'2./3. Option A signed → Accepted; Options B–E are not rejected or closed');
  ok(list.slice(1).every(e=>{ const s=e.signatures.at(-1); return s && s.status==='pending'; }),'3. Options B–E keep their pending signing links');
  // 4./5. later the client signs Option C (= option 3)
  await clientSigns('Option C','2026-11-06T18:30:00.000Z');
  list=await ests();
  ok(st()['Option A']==='accepted' && st()['Option C']==='accepted','4./5. Option C can be signed too: Options A and C are both Accepted');
  ok(['Option B','Option D','Option E'].every(o=>!['accepted','rejected'].includes(st()[o]) && list.find(e=>e.optionLabel===o).signatures.at(-1).status==='pending'),'6. Options B, D and E are still open (their links wait for a signature)');
  const sig=l=>list.find(e=>e.optionLabel===l).signatures.at(-1);
  ok(sig('Option A').status==='signed' && sig('Option A').signedAt==='2026-11-05T17:00:00.000Z' && sig('Option C').signedAt==='2026-11-06T18:30:00.000Z','each signed option keeps its own signing date and time');

  // 7. the client's CRM record: both signed options, their total, a signed copy each
  const proj=await p.evaluate(()=>loadProjects()[0]);
  ok([o1.id,o3.id].includes(proj.estimateId) && proj.estimateTotal===1000+3000,'7. the CRM project counts both signed options: $1,000 + $3,000 = $4,000');
  await p.click('#mainNav [data-page=crm]');
  const card=p.locator(`.kcard[data-id="${proj.id}"]`);
  const cardText=await card.innerText();
  ok(cardText.includes('Option A: signed ✓') && cardText.includes('Option C: signed ✓') && cardText.includes('Option B: waiting') && cardText.includes('Option E: waiting'),'7./8. the project card shows each option\'s own status (A and C signed with their dates, B, D, E waiting)');
  const dl=p.waitForEvent('download',{timeout:60000});
  await card.locator('.sign-badge.sign-done',{hasText:'Option C'}).click();
  ok((await dl).suggestedFilename().includes('Option C') ,'7. the signed copy of each option can be downloaded from the client\'s CRM record');
  // the Signatures page lists every option separately
  await p.click('#mainNav [data-page=signatures]');
  const rows=await p.locator('#signBody tr').allInnerTexts();
  ok(rows.filter(r=>/Signed/i.test(r)).length===2 && rows.length===5,'8. the Signatures page lists the 5 options separately: 2 signed, 3 waiting');

  // no duplicate signing: a signed option is unticked when sending again; re-signing needs an admin
  await p.click('#mainNav [data-page=builder]');
  await p.evaluate(id=>openEstimate(id),o1.id);
  await p.click('#btnSign'); await p.waitForSelector('#optionPickModal.open');
  const ticked=await p.locator('#optPickList input:checked').evaluateAll(l=>l.map(i=>i.value));
  ok(ticked.length===3 && !ticked.includes(o1.id) && !ticked.includes(o3.id) && (await p.innerText('#optPickList')).includes('signed ✓'),'sending again: the signed options (A, C) are shown as signed and left unticked');
  await p.click('#optPickCancel');
  await p.evaluate(()=>{ CLOUD.role='member'; });
  const before=docs.size;
  await p.evaluate(o=>sendOptionsForSignature([estimateDataFromRecord(getEstimate(o))]),o1.id);
  ok(docs.size===before && dialogs.at(-1).includes('Only an owner or admin can send a signed option for signature again'),'a member cannot send a signed option for signature again');
  await p.evaluate(()=>{ CLOUD.role='admin'; });
  answer=false;
  await p.evaluate(o=>sendOptionsForSignature([estimateDataFromRecord(getEstimate(o))]),o1.id);
  answer=true;
  ok(docs.size===before && dialogs.at(-1).includes('re-signing or amendment'),'an admin is asked first (re-signing / amendment); "Cancel" sends nothing');
  ok((await ests()).find(e=>e.id===o1.id).signatures.filter(s=>s.status==='signed').length===1,'the signing history of Option A keeps its signed copy');

  ok(errs.length===0,'no page errors '+JSON.stringify(errs));
  console.log(`\n${pass} passed, ${fail} failed`); await b.close(); process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(2);});
