// Signing service (worker/src/sign.js) without network: Base44 and Gmail are faked, KV is in memory.
// The client's signing page is opened in a real browser.
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');
const fs = require('fs');
let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m);};

const PROD='6aceadfed0aa786c7c2934ff', ORIGIN='https://evercraftinfoadmin-sketch.github.io', W='https://evercraft-mail.example.workers.dev';
function kv(){ const m=new Map(); return { m, async get(k){ return m.has(k)?m.get(k):null; }, async put(k,v){ m.set(k,String(v)); }, async delete(k){ m.delete(k); } }; }
const E={ MAIL_KV:kv(), ALLOWED_SENDER:'EverCraft.pro@gmail.com', SENDER_NAME:'EverCraft Home Improvement', ALLOWED_ORIGINS:ORIGIN,
  BASE44_APPS:JSON.stringify({[PROD]:'https://base44.app'}), DAILY_LIMIT:'300', GOOGLE_CLIENT_ID:'c', GOOGLE_CLIENT_SECRET:'s', MAIL_SETUP_KEY:'k' };
const USERS={ 'tok-member':{id:'u1',email:'m@x.com',crm_role:'member'}, 'tok-none':{id:'u2',crm_role:'none'} };
let mails=[];
global.fetch=async(url,opts={})=>{
  url=String(url);
  const res=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
  if(/\/entities\/User\/me$/.test(url)){ const u=USERS[(opts.headers.Authorization||'').replace('Bearer ','')]; return u?res(200,u):res(401,{}); }
  if(url==='https://oauth2.googleapis.com/token') return res(200,{access_token:'a',expires_in:3600});
  if(url.includes('gmail.googleapis.com')){ mails.push(opts.body); return res(200,{id:'g'+mails.length}); }
  throw new Error('unexpected fetch '+url);
};

(async()=>{
  const worker=(await import(pathToFileURL(path.resolve(__dirname,'../../worker/src/index.js')).href)).default;
  const call=(p,init={})=>worker.fetch(new Request(W+p,init),E);
  const team=(p,body,token='tok-member',origin=ORIGIN)=>call(p,{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{}),...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify({appId:PROD,...body})});
  const DOC={type:'work_authorization',title:'Work Authorization - EST-2026-1001',clientName:'Ann Lee',clientEmail:'ann@x.com',
    html:'<div class="pv"><h2 class="pv-doc">WORK AUTHORIZATION</h2><p>Ann Lee authorizes the work at 1 Main St.</p><script>alert(1)</script><img src=x onerror="alert(2)"></div>',
    css:'.pv-doc{color:#2563eb} @import url(http://evil); body{background:url(http://evil/x.png)}', ref:{projectId:'crm-1',estimateNumber:'EST-2026-1001'}};

  // who may create
  let r=await team('/sign/create',DOC,''); ok(r.status===401,'creating a signing request needs a CRM sign-in');
  r=await team('/sign/create',DOC,'tok-none'); ok(r.status===403,'a user without CRM access cannot create one');
  r=await team('/sign/create',DOC,'tok-member','https://evil.example'); ok(r.status===403,'another website cannot create one');
  r=await team('/sign/create',{...DOC,type:'other'}); ok(r.status===400,'unknown document type refused');
  r=await team('/sign/create',{...DOC,clientEmail:'bad'}); ok(r.status===400,'bad client email refused');

  r=await team('/sign/create',DOC); const c=await r.json();
  ok(r.status===200 && c.ok && /^[0-9a-f]{64}$/.test(c.id) && c.url.startsWith(W+'/s/') && /^[0-9a-f]{64}$/.test(c.docHash),'team member creates a request: id, signing link, document fingerprint');
  const token=c.url.split('/s/')[1];
  const stored=JSON.parse(await E.MAIL_KV.get('sig:'+c.id));
  ok(!stored.html.includes('<script') && !/onerror/i.test(stored.html) && !/@import|url\(/i.test(stored.css),'scripts, event handlers, imports and external images are removed from the stored document');
  ok(!JSON.stringify(stored).includes(token) && c.id!==token,'the link token itself is not stored (only its fingerprint)');

  // status for the CRM
  r=await team('/sign/status',{ids:[c.id,'0'.repeat(64)]}); let j=await r.json();
  ok(j.items.length===1 && j.items[0].status==='pending' && j.items[0].type==='work_authorization','status: pending');

  // the signing page in a real browser
  const browser=await chromium.launch({executablePath:fs.existsSync('/opt/pw-browsers/chromium')?'/opt/pw-browsers/chromium':undefined});
  const ctx=await browser.newContext({viewport:{width:900,height:1000}});
  const page=await ctx.newPage();
  const cspErrors=[]; page.on('console',m=>{ if(m.type()==='error') cspErrors.push(m.text()); });
  await ctx.route(W+'/**',async route=>{
    const req=route.request();
    const resp=await worker.fetch(new Request(req.url(),{method:req.method(),headers:{...req.headers(),'CF-Connecting-IP':'203.0.113.7'},body:req.method()==='POST'?req.postData():undefined}),E);
    route.fulfill({status:resp.status,headers:Object.fromEntries(resp.headers),body:Buffer.from(await resp.arrayBuffer())});
  });
  await page.goto(c.url);
  ok((await page.title())==='Please sign: Work Authorization - EST-2026-1001' && (await page.textContent('.doc')).includes('Ann Lee authorizes the work'),'client opens the link and sees the document');
  ok(await page.inputValue('#name')==='Ann Lee' && await page.isDisabled('#sign'),'name filled in; Sign is off until a signature is drawn and the box is ticked');
  ok(!(await page.evaluate(()=>window.__alerted)),'no script from the document runs');
  const box=await page.locator('#pad').boundingBox();
  await page.mouse.move(box.x+40,box.y+120); await page.mouse.down();
  for(let i=1;i<=12;i++) await page.mouse.move(box.x+40+i*30,box.y+120-Math.sin(i)*40);
  await page.mouse.up();
  ok(await page.isDisabled('#sign'),'still off before agreeing to sign electronically');
  await page.check('#agree');
  await page.screenshot({path:path.join(__dirname,'..','output','sign-page.png'),fullPage:true}).catch(()=>{});
  await page.click('#sign');
  await page.waitForSelector('.ok',{timeout:10000});
  ok((await page.textContent('.ok')).includes('Signed by Ann Lee') && await page.isVisible('.sigimg'),'after signing the page shows the signed copy with the signature');
  ok((await page.textContent('.audit')).includes('203.0.113.7') && (await page.textContent('.audit')).includes(c.docHash),'audit trail: IP address and document fingerprint');
  await page.screenshot({path:path.join(__dirname,'..','output','signed-page.png'),fullPage:true}).catch(()=>{});

  const rec=JSON.parse(await E.MAIL_KV.get('sig:'+c.id));
  ok(rec.status==='signed' && rec.signerName==='Ann Lee' && rec.signature.startsWith('data:image/png;base64,') && rec.ip==='203.0.113.7' && rec.userAgent.length>10 && rec.consent.includes('electronically'),'stored: signer, drawn signature, time, IP, browser, consent');
  ok(mails.length===0,'no emails when Gmail is not connected (the signature is saved anyway)');

  // second attempt refused
  r=await call('/s/'+token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'X Y',agree:true,signature:rec.signature})});
  ok(r.status===409,'a signed document cannot be signed again');

  // CRM sees it signed and can fetch the full record
  j=await (await team('/sign/status',{ids:[c.id]})).json();
  ok(j.items[0].status==='signed' && j.items[0].signerName==='Ann Lee' && j.items[0].signedAt,'status: signed, with signer and time');
  j=await (await team('/sign/get',{id:c.id})).json();
  ok(j.signature && j.docHash===c.docHash && j.html.includes('WORK AUTHORIZATION'),'the CRM gets the signed document for the signed PDF');
  r=await team('/sign/get',{id:c.id},'tok-none'); ok(r.status===403,'outsiders cannot read signed documents');

  // notifications when Gmail is connected; withdraw; bad input
  await E.MAIL_KV.put('gmail',JSON.stringify({refresh_token:'r',email:'evercraft.pro@gmail.com'}));
  r=await team('/sign/create',{...DOC,type:'completion',title:'Certificate of Completion - INV-2026-1001'}); const c2=await r.json();
  const t2=c2.url.split('/s/')[1];
  r=await call('/s/'+t2,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Ann Lee',agree:false,signature:rec.signature})});
  ok(r.status===400,'signing without agreeing is refused');
  r=await call('/s/'+t2,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Ann Lee',agree:true,signature:'data:image/png;base64,aGVsbG8='})});
  ok(r.status===400,'a fake signature image is refused');
  r=await call('/s/'+t2,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Ann Lee',agree:true,signature:rec.signature})});
  const dec=raw=>Buffer.from(((raw.split('Content-Transfer-Encoding: base64\r\n\r\n')[1])||'').split('\r\n--')[0].replace(/\r\n/g,''),'base64').toString('utf8');
  ok(r.status===200 && mails.length===2 && /To: <evercraft\.pro@gmail\.com>/.test(mails[0]) && /To: <ann@x\.com>/.test(mails[1]) && dec(mails[1]).includes('/s/'+t2),'after signing, the company is notified and the client gets a link to the signed copy');
  r=await team('/sign/create',DOC); const c3=await r.json();
  r=await team('/sign/cancel',{id:c3.id}); ok(r.status===200,'a pending document can be withdrawn');
  await page.goto(c3.url); ok((await page.textContent('h1')).includes('withdrawn'),'a withdrawn link says so');
  r=await team('/sign/cancel',{id:c.id}); ok(r.status===409,'a signed document cannot be withdrawn');
  await page.goto(W+'/s/'+'A'.repeat(43)); ok((await page.textContent('h1')).includes('not valid'),'an unknown link says it is not valid');
  // options: Option A, B, C of one offer; the client signs one, the others are withdrawn
  const opt=async(o,group='grp-offer-1')=>(await (await team('/sign/create',{...DOC,type:'estimate',title:'Estimate EST-2026-1010 - '+o,group,option:o})).json());
  const A=await opt('Option A'), B=await opt('Option B'), C=await opt('Option C');
  j=await (await team('/sign/status',{ids:[A.id,B.id,C.id]})).json();
  ok(j.items.every(i=>i.group==='grp-offer-1' && i.status==='pending') && j.items.map(i=>i.option).join()==='Option A,Option B,Option C','options are stored as one offer (group and option name)');
  const tokB=B.url.split('/s/')[1];
  r=await call('/s/'+tokB,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Ann Lee',agree:true,signature:rec.signature})});
  j=await (await team('/sign/status',{ids:[A.id,B.id,C.id]})).json();
  const st=Object.fromEntries(j.items.map(i=>[i.option,i]));
  ok(r.status===200 && st['Option B'].status==='signed' && st['Option A'].status==='cancelled' && st['Option C'].status==='cancelled' && st['Option A'].chosenOption==='Option B','signing Option B withdraws Options A and C at once');
  r=await call('/s/'+C.url.split('/s/')[1],{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Ann Lee',agree:true,signature:rec.signature})});
  ok(r.status===410,'a withdrawn option can no longer be signed');
  await page.goto(A.url);
  ok((await page.textContent('h1')).includes('Option A is no longer available') && (await page.textContent('.card')).includes('Option B'),'opening another option\'s link says which option was chosen');
  // two options signed at nearly the same moment: the second is refused
  const X=await opt('Option A','grp-offer-2'), Y=await opt('Option B','grp-offer-2');
  const xr=JSON.parse(await E.MAIL_KV.get('sig:'+X.id)); xr.status='signed'; await E.MAIL_KV.put('sig:'+X.id,JSON.stringify(xr));
  r=await call('/s/'+Y.url.split('/s/')[1],{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Ann Lee',agree:true,signature:rec.signature})});
  ok(r.status===409 && (await r.json()).error.includes('Option A was already chosen'),'if another option is already signed, this one is refused (never two signed options)');
  r=await team('/sign/create',{...DOC,group:'bad group!',option:'Option A'}); j=await r.json();
  ok(r.status===200 && !(await (await team('/sign/status',{ids:[j.id]})).json()).items[0].group,'an invalid group name is ignored (a normal single document)');

  ok(cspErrors.every(e=>/Content Security Policy|Refused/i.test(e)),'no page errors besides blocked content '+JSON.stringify(cspErrors).slice(0,200));

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); process.exit(1); });
