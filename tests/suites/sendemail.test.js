// Base44 function base44/functions/sendEmail.js without network: Base44 (auth, Gmail connector)
// and Google are faked.
const path = require('path');
const { pathToFileURL } = require('url');
let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m);};

const PDF=Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');
let gmailEmail='EverCraft.pro@gmail.com', gmailStatus=200, connected=true, calls=[];
global.fetch=async(url,opts={})=>{
  url=String(url); calls.push({url,opts});
  const res=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
  if(url==='https://www.googleapis.com/oauth2/v3/userinfo') return opts.headers.Authorization==='Bearer gtok' ? res(200,{email:gmailEmail,email_verified:true}) : res(401,{});
  if(url.startsWith('https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send')) return gmailStatus===200 ? res(200,{id:'msg1'}) : res(gmailStatus,{});
  throw new Error('unexpected fetch '+url);
};
const base44=user=>({
  auth:{ me: async()=>{ if(!user) throw Object.assign(new Error('401'),{status:401}); return user; } },
  asServiceRole:{ connectors:{ getAccessToken: async type=>{ if(type!=='gmail' || !connected) throw new Error('not connected'); return 'gtok'; } } }
});
const MEMBER={id:'u1',email:'m@x.com',crm_role:'member'};
const req=body=>new Request('https://fn.test/sendEmail',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});

(async()=>{
  const { handle, encodeHeader }=await import(pathToFileURL(path.resolve(__dirname,'../../base44/functions/sendEmail.js')).href);
  const call=async(body,user=MEMBER)=>{ const r=await handle(req(body),base44(user)); return {status:r.status, j:await r.json()}; };
  const good={action:'send',to:'client@example.com',subject:'EverCraft Estimate EST-2026-1001 - 42 Elm St',text:'Hello Ann,\nYour estimate — total $1,000.',fromName:'EverCraft Home Improvement',attachment:{filename:'EverCraft Estimate EST-2026-1001.pdf',base64:PDF}};

  // who may call
  let r=await call({action:'status'},null); ok(r.status===401,'signed out: refused');
  r=await call({action:'status'},{id:'u2',crm_role:'none'}); ok(r.status===403,'signed in without CRM access: refused');
  r=await call({action:'status'},{id:'u3',data:{crm_role:'admin'}}); ok(r.status===200,'a role stored under user.data (admin) is accepted');
  r=await handle(new Request('https://fn.test/sendEmail'),base44(MEMBER)); ok(r.status===405,'only POST');

  // status
  r=await call({action:'status'}); ok(r.status===200 && r.j.connected===true && r.j.sender==='evercraft.pro@gmail.com','status: connected as the company Gmail');
  connected=false;
  r=await call({action:'status'}); ok(r.j.connected===false,'status: not connected');
  r=await call(good); ok(r.status===503 && /not connected/.test(r.j.error),'send while Gmail is not connected: clear message');
  connected=true;
  gmailEmail='someone.personal@gmail.com';
  r=await call({action:'status'}); ok(r.j.connected===false && r.j.sender==='someone.personal@gmail.com','status: another Gmail account connected is not treated as connected');
  calls=[]; r=await call(good);
  ok(r.status===503 && /not evercraft\.pro@gmail\.com/.test(r.j.error) && !calls.some(c=>c.url.includes('gmail.googleapis')),'a wrong connected account never sends');
  gmailEmail='EverCraft.pro@gmail.com';

  // input checks
  r=await call({...good,to:'not-an-email'}); ok(r.status===400,'bad client address refused');
  r=await call({...good,to:'a@x.com\r\nBcc: b@y.com'}); ok(r.status===400,'header injection in the address refused');
  r=await call({...good,subject:''}); ok(r.status===400,'empty subject refused');
  r=await call({...good,attachment:{filename:'x.pdf',base64:Buffer.from('hello').toString('base64')}}); ok(r.status===400,'a non-PDF attachment refused');
  r=await call({action:'other'}); ok(r.status===400,'unknown action refused');

  // a real send
  calls=[]; r=await call(good);
  const g=calls.find(c=>c.url.includes('gmail.googleapis.com')); const raw=g?g.opts.body:'';
  ok(r.status===200 && r.j.ok && r.j.from==='evercraft.pro@gmail.com' && r.j.to==='client@example.com','member sends: Gmail accepts, the answer names sender and client');
  ok(g && g.opts.headers.Authorization==='Bearer gtok' && g.opts.headers['Content-Type']==='message/rfc822','Gmail is called with the connected company account');
  ok(/^From: EverCraft Home Improvement <evercraft\.pro@gmail\.com>\r\n/m.test(raw) && /^To: <client@example\.com>\r\n/m.test(raw) && raw.includes('Subject: EverCraft Estimate EST-2026-1001 - 42 Elm St'),'headers: from the company, to the client, subject');
  const textB64=(raw.split('Content-Transfer-Encoding: base64\r\n\r\n')[1]||'').split('\r\n--')[0].replace(/\r\n/g,'');
  ok(Buffer.from(textB64,'base64').toString('utf8')==='Hello Ann,\nYour estimate — total $1,000.','text sent unchanged (UTF-8)');
  ok(raw.includes('Content-Type: application/pdf; name="EverCraft Estimate EST-2026-1001.pdf"') && raw.includes('filename="EverCraft Estimate EST-2026-1001.pdf"') && raw.includes(PDF.slice(0,40)),'PDF attached with its file name');
  calls=[]; r=await call({...good,subject:'Смета № 5 — EverCraft',attachment:null});
  const raw2=(calls.find(c=>c.url.includes('gmail'))||{opts:{}}).opts.body||'';
  ok(r.status===200 && /Subject: =\?UTF-8\?B\?/.test(raw2) && !raw2.includes('multipart'),'non-English subject encoded; email without PDF works');
  gmailStatus=500; r=await call(good); ok(r.status===502 && /did not send/.test(r.j.error),'a Gmail failure is reported, not hidden');
  gmailStatus=200;
  ok(encodeHeader('Plain')==='Plain' && encodeHeader('Ж'.repeat(40)).split('\r\n ').length>1,'long non-English headers split into parts');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); process.exit(1); });
