// Mail service (worker/src/index.js) without network: Google, Gmail and Base44 are faked,
// KV is kept in memory.
const path = require('path');
const { pathToFileURL } = require('url');
let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m);};

const PROD='6aceadfed0aa786c7c2934ff', DEV='6acd6d429d6ed1576d7696b7';
const ORIGIN='https://evercraftinfoadmin-sketch.github.io';
const W='https://evercraft-mail.example.workers.dev';
const PDF=Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');

function kv(){ const m=new Map(); return { m, async get(k){ return m.has(k)?m.get(k):null; }, async put(k,v){ m.set(k,String(v)); }, async delete(k){ m.delete(k); } }; }
const env=()=>({ MAIL_KV:kv(), ALLOWED_SENDER:'EverCraft.pro@gmail.com', SENDER_NAME:'EverCraft Home Improvement',
  ALLOWED_ORIGINS:ORIGIN+',https://raw.githack.com', DAILY_LIMIT:'3',
  BASE44_APPS:JSON.stringify({[PROD]:'https://base44.app',[DEV]:'https://preview--dev.base44.app'}),
  GOOGLE_CLIENT_ID:'cid', GOOGLE_CLIENT_SECRET:'csecret', MAIL_SETUP_KEY:'setup-key-123' });

// fake network
const USERS={ 'tok-member':{id:'u1',email:'m@x.com',crm_role:'member'}, 'tok-none':{id:'u2',email:'n@x.com',crm_role:'none'}, 'tok-data':{id:'u3',email:'d@x.com',data:{crm_role:'admin'}} };
let calls=[], gmailStatus=200, googleIdEmail='EverCraft.pro@gmail.com', refreshOk=true, grantedScope='openid email https://www.googleapis.com/auth/gmail.send';
const idToken=email=>'h.'+Buffer.from(JSON.stringify({email,email_verified:true})).toString('base64url')+'.s';
global.fetch=async(url,opts={})=>{
  url=String(url); calls.push({url,opts});
  const res=(status,body)=>new Response(typeof body==='string'?body:JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
  const m=url.match(/^(https:\/\/[^/]+)\/api\/apps\/([^/]+)\/entities\/User\/me$/);
  if(m){ const u=USERS[(opts.headers.Authorization||'').replace('Bearer ','')]; return u ? res(200,u) : res(401,{message:'no'}); }
  if(url==='https://oauth2.googleapis.com/token'){
    const p=new URLSearchParams(opts.body);
    if(p.get('grant_type')==='authorization_code') return res(200,{access_token:'a1',refresh_token:'r1',expires_in:3600,scope:grantedScope,id_token:idToken(googleIdEmail)});
    return refreshOk ? res(200,{access_token:'a2',expires_in:3600}) : res(400,{error:'invalid_grant'});
  }
  if(url.startsWith('https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send')) return gmailStatus===200 ? res(200,{id:'msg1'}) : res(gmailStatus,{error:{message:gmailStatus===403?'Request had insufficient authentication scopes.':'Backend Error'}});
  throw new Error('unexpected fetch '+url);
};

(async()=>{
  const mod=await import(pathToFileURL(path.resolve(__dirname,'../../worker/src/index.js')).href);
  const worker=mod.default;
  const E=env();
  const call=(p,init={})=>worker.fetch(new Request(W+p,init),E);
  const sendReq=(body,{token='tok-member',origin=ORIGIN}={})=>call('/send',{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{}),...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
  const good={appId:PROD,to:'client@example.com',subject:'EverCraft Estimate EST-2026-1001 - 42 Elm St',text:'Hello Ann,\nYour estimate — total $1,000.',attachment:{filename:'EST-2026-1001.pdf',base64:PDF}};

  // status before connecting
  let r=await call('/status'); let j=await r.json();
  ok(r.status===200 && j.connected===false && j.sender==='EverCraft.pro@gmail.com','status: not connected yet, shows the sender');
  r=await sendReq(good); j=await r.json();
  ok(r.status===503 && /not connected/.test(j.error),'send before Gmail is connected is refused with a clear message');

  // connect: setup key required
  r=await call('/oauth/start?key=wrong',{redirect:'manual'});
  ok(r.status===403,'connect link without the right setup key is refused');
  r=await call('/oauth/start?key=setup-key-123',{redirect:'manual'});
  const loc=new URL(r.headers.get('Location')||'https://x/');
  ok(r.status===302 && loc.origin==='https://accounts.google.com' && loc.searchParams.get('scope').includes('gmail.send') && loc.searchParams.get('access_type')==='offline' && loc.searchParams.get('redirect_uri')===W+'/oauth/callback' && loc.searchParams.get('login_hint')==='EverCraft.pro@gmail.com','connect link sends to Google: Gmail send permission, lasting, back to this service');
  const state=loc.searchParams.get('state');
  r=await call('/oauth/callback?code=c&state=forged');
  ok(r.status===400 && !(await E.MAIL_KV.get('gmail')),'callback with a forged state is refused');
  // wrong Google account
  googleIdEmail='someone.personal@gmail.com';
  r=await call('/oauth/callback?code=c&state='+state);
  ok(r.status===403 && (await r.text()).includes('Wrong account') && !(await E.MAIL_KV.get('gmail')),'signing in with another Google account is refused (only EverCraft.pro@gmail.com)');
  // right account, but "Send email on your behalf" left unticked
  googleIdEmail='evercraft.pro@gmail.com'; grantedScope='openid email';
  r=await call('/oauth/start?key=setup-key-123',{redirect:'manual'});
  r=await call('/oauth/callback?code=c&state='+new URL(r.headers.get('Location')).searchParams.get('state'));
  ok(r.status===400 && (await r.text()).includes('Send email on your behalf') && !(await E.MAIL_KV.get('gmail')),'connecting without the send permission is refused and says which box to tick');
  grantedScope='openid email https://www.googleapis.com/auth/gmail.send';
  // right account (new state)
  r=await call('/oauth/start?key=setup-key-123',{redirect:'manual'});
  const state2=new URL(r.headers.get('Location')).searchParams.get('state');
  r=await call('/oauth/callback?code=c&state='+state2);
  const saved=JSON.parse(await E.MAIL_KV.get('gmail')||'{}');
  ok(r.status===200 && (await r.text()).includes('Connected') && saved.refresh_token==='r1' && saved.email==='evercraft.pro@gmail.com','signing in as the company account connects it; the permission is stored on the service only');
  r=await call('/oauth/callback?code=c&state='+state2);
  ok(r.status===400,'a connect link works only once');
  j=await (await call('/status')).json();
  ok(j.connected===true && !JSON.stringify(j).includes('r1'),'status: connected, without revealing the permission');

  // who may send
  r=await sendReq(good,{token:''}); ok(r.status===401,'send without a CRM sign-in is refused');
  r=await sendReq(good,{token:'tok-bad'}); ok(r.status===401,'send with an invalid sign-in is refused');
  r=await sendReq(good,{token:'tok-none'}); ok(r.status===403,'a signed-in user without CRM access cannot send');
  r=await sendReq({...good,appId:'some-other-app'}); ok(r.status===401,'only the EverCraft Base44 apps are accepted');
  r=await sendReq(good,{origin:'https://evil.example'}); ok(r.status===403 && !r.headers.get('Access-Control-Allow-Origin'),'another website cannot use the service');
  r=await call('/send',{method:'OPTIONS',headers:{Origin:ORIGIN}});
  ok(r.status===204 && r.headers.get('Access-Control-Allow-Origin')===ORIGIN && /Authorization/.test(r.headers.get('Access-Control-Allow-Headers')),'the CRM address passes the browser CORS check');

  // input checks
  r=await sendReq({...good,to:'not-an-email'}); ok(r.status===400,'bad client address is refused');
  r=await sendReq({...good,to:'a@x.com\r\nBcc: b@y.com'}); ok(r.status===400,'header injection in the address is refused');
  r=await sendReq({...good,attachment:{filename:'x.pdf',base64:Buffer.from('hello').toString('base64')}}); ok(r.status===400,'a non-PDF attachment is refused');

  // a real send
  calls=[];
  r=await sendReq(good); j=await r.json();
  const g=calls.find(c=>c.url.includes('gmail.googleapis.com'));
  const raw=g ? g.opts.body : '';
  ok(r.status===200 && j.ok && j.from==='evercraft.pro@gmail.com' && j.to==='client@example.com','member sends: Gmail accepts, the reply names sender and client');
  ok(g && g.opts.headers.Authorization==='Bearer a2' && g.opts.headers['Content-Type']==='message/rfc822','Gmail is called with the company account permission');
  ok(/^From: EverCraft Home Improvement <evercraft\.pro@gmail\.com>\r\n/m.test(raw) && /^To: <client@example\.com>\r\n/m.test(raw) && raw.includes('Subject: EverCraft Estimate EST-2026-1001 - 42 Elm St'),'email headers: from the company, to the client, subject');
  const textB64=(raw.split('Content-Transfer-Encoding: base64\r\n\r\n')[1]||'').split('\r\n--')[0].replace(/\r\n/g,'');
  ok(Buffer.from(textB64,'base64').toString('utf8')==='Hello Ann,\nYour estimate — total $1,000.','text is sent unchanged (UTF-8)');
  ok(raw.includes('Content-Type: application/pdf;\r\n name="EST-2026-1001.pdf"') && raw.includes('Content-Disposition: attachment;\r\n filename="EST-2026-1001.pdf"') && raw.includes(PDF.slice(0,40)),'the PDF is attached with its file name');
  const pdfB64=(raw.split('filename="EST-2026-1001.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n')[1]||'').split('\r\n--')[0].replace(/\r\n/g,'');
  ok(pdfB64===PDF,'the attachment decodes back to exactly the PDF the CRM made (byte for byte)');
  // several PDFs in one email (estimate options A, B, C)
  calls=[];
  r=await sendReq({...good,attachment:undefined,attachments:['A','B','C'].map(o=>({filename:`EST-2026-1001 Option ${o}.pdf`,base64:PDF}))},{token:'tok-data'});
  const graw=(calls.find(c=>c.url.includes('gmail.googleapis.com'))||{opts:{}}).opts.body||'';
  const parts=['A','B','C'].map(o=>(graw.split(`filename="EST-2026-1001 Option ${o}.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n`)[1]||'').split('\r\n--')[0].replace(/\r\n/g,''));
  ok(r.status===200 && (graw.match(/Content-Type: application\/pdf;/g)||[]).length===3 && parts.every(x=>x===PDF) && graw.split('\r\n').every(l=>l.length<=78),'three PDFs go out in one email, each intact, with its own file name');
  r=await sendReq({...good,attachment:undefined,attachments:Array.from({length:6},(_,i)=>({filename:`x${i}.pdf`,base64:PDF}))},{token:'tok-data'});
  ok(r.status===400 && (await r.json()).error.includes('At most 5'),'more than 5 PDFs in one email is refused');
  r=await sendReq({...good,attachment:undefined,attachments:[{filename:'a.pdf',base64:PDF},{filename:'b.pdf',base64:Buffer.from('hello world!').toString('base64')}]},{token:'tok-data'});
  ok(r.status===400 && (await r.json()).error.includes('not a PDF'),'every attachment must be a PDF');
  ok(raw.split('\r\n').every(l=>l.length<=78) && !/[^\r]\n/.test(raw),'every line of the email is at most 78 characters and ends in CRLF (what strict mail apps expect)');
  // reply-to and a non-ASCII subject
  calls=[];
  r=await sendReq({...good,subject:'Смета № 5 — EverCraft',replyTo:'office@example.com',attachment:null});
  const raw2=(calls.find(c=>c.url.includes('gmail'))||{opts:{}}).opts.body||'';
  ok(r.status===200 && raw2.includes('Reply-To: <office@example.com>') && /Subject: =\?UTF-8\?B\?/.test(raw2) && !raw2.includes('multipart'),'non-English subject is encoded; reply-to set; email without a PDF works');
  // admin role stored under data
  r=await sendReq(good,{token:'tok-data'}); ok(r.status===200,'a role stored under user.data (admin) can send');

  // daily limit (3 in this test; member has sent 2)
  r=await sendReq(good); ok(r.status===200,'third email of the day goes out');
  r=await sendReq(good); ok(r.status===429,'a daily limit per user stops runaway sending');

  // Gmail errors
  gmailStatus=500; r=await sendReq(good,{token:'tok-data'}); j=await r.json();
  ok(r.status===502 && /did not send/.test(j.error) && j.error.includes('Backend Error'),'a Gmail failure is reported with Google\'s reason, not hidden');
  gmailStatus=403; r=await sendReq(good,{token:'tok-data'}); j=await r.json();
  ok(r.status===502 && j.error.includes('insufficient authentication scopes') && j.error.includes('Send email on your behalf'),'a missing send permission (403) says to connect the Gmail again and allow sending');
  gmailStatus=200;
  const E2=env(); await E2.MAIL_KV.put('gmail',JSON.stringify({refresh_token:'old',email:'evercraft.pro@gmail.com'}));
  refreshOk=false;
  const mod2=await import(pathToFileURL(path.resolve(__dirname,'../../worker/src/index.js')).href+'?fresh');
  r=await mod2.default.fetch(new Request(W+'/send',{method:'POST',headers:{'Content-Type':'application/json',Origin:ORIGIN,Authorization:'Bearer tok-member'},body:JSON.stringify(good)}),E2);
  j=await r.json();
  ok(r.status===503 && /connect it again/.test(j.error),'a revoked Gmail permission asks an admin to reconnect');

  // header encoding helper
  ok(mod.encodeHeader('Plain subject')==='Plain subject' && mod.encodeHeader('Ж'.repeat(40)).split('\r\n ').length>1,'long non-English headers are split into several encoded parts');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); process.exit(1); });
