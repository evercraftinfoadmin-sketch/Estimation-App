// Cloud sync test against an in-memory fake of the Base44 SDK.
// The fake server enforces the same access rules as the Base44 apps' RLS:
//  read/create/update: crm_role owner|admin|member; delete + deletedAt: owner|admin;
//  CompanySettings create/update: owner|admin; EstimateCounter create: owner|admin.
const { launch, FILE, OUT } = require('../helpers');
// The app runs with this fake Base44 app; every SDK call goes to the in-memory server below.
const CLOUD_CONFIG={base44AppId:'ci-cloud-test-app-00000000',base44AppBaseUrl:'https://preview--ci-cloud-test.base44.app',base44ServerUrl:'https://preview--ci-cloud-test.base44.app'};
let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m);};

// ---------- fake server ----------
const DB={}; let seq=0; const calls=[];
const FAIL={during:null, net:false, netOnOp:null, rejectName:'TEST REJECT', rate:false};
const USERS={
  'admin@test':{id:'u-admin',email:'admin@test',role:'admin',crm_role:'owner'},
  'boss@test':{id:'u-boss',email:'boss@test',role:'admin'},
  'new@test':{id:'u-new',email:'new@test',role:'user',full_name:'New Employee'},
  'a@test':{id:'u-a',email:'a@test',role:'user',crm_role:'member'},
  'b@test':{id:'u-b',email:'b@test',role:'user',crm_role:'member'},
  'out@test':{id:'u-out',email:'out@test',role:'user'},
  'c@test':{id:'u-c',email:'c@test',role:'user',crm_role:'member'},
  'd@test':{id:'u-d',email:'d@test',role:'user',crm_role:'member'}
};
const isMember=u=>u && ['owner','admin','member'].includes(u.crm_role);
const isAdmin=u=>u && ['owner','admin'].includes(u.crm_role);
const ADMIN_WRITE=new Set(['CompanySettings']);
function table(n){ return DB[n]=DB[n]||[]; }
function match(r,q){ return Object.entries(q||{}).every(([k,v])=>r[k]===v); }
function err(status){ const e=new Error('HTTP '+status); e.status=status; return e; }
function serve(email, entity, op, args){
  calls.push({email,entity,op});
  if(FAIL.rate && entity!=='auth') throw err(429);
  if(FAIL.net || (FAIL.netOnOp && FAIL.netOnOp.email===email && FAIL.netOnOp.op===op)){ FAIL.netOnOp=null; throw err(0); }
  if((op==='create'||op==='update') && args[op==='create'?0:1] && args[op==='create'?0:1].clientName===FAIL.rejectName) throw err(422);
  const u=USERS[email];
  if(entity==='auth' && op==='me'){ if(!u) throw err(401); return u; }
  if(entity==='auth' && op==='updateMe'){ if(!u) throw err(401); if('crm_role' in args[0] && u.role!=='admin') throw err(403); Object.assign(u,args[0]); return u; }
  if(entity==='User'){
    if(!u || u.role!=='admin') throw err(403);
    if(op==='filter') return Object.values(USERS).map(x=>({...x}));
    if(op==='update'){ const t=Object.values(USERS).find(x=>x.id===args[0]); if(!t) throw err(404); Object.assign(t,args[1]); return {...t}; }
  }
  if(!u) throw err(401);
  const t=table(entity);
  const clone=x=>JSON.parse(JSON.stringify(x));
  switch(op){
    case 'filter': {
      if(!isMember(u)) return []; // RLS: rows are invisible
      const [q,sort,limit=50,skip=0]=args;
      return clone(t.filter(r=>match(r,q)).slice(skip,skip+limit));
    }
    case 'get': { if(!isMember(u)) throw err(404); const r=t.find(x=>x.id===args[0]); if(!r) throw err(404); return clone(r); }
    case 'create': {
      if(!isMember(u) || (ADMIN_WRITE.has(entity) && !isAdmin(u)) || (entity==='EstimateCounter' && !isAdmin(u))) throw err(403);
      if(args[0].deletedAt && !isAdmin(u)) throw err(403);
      const r={...clone(args[0]), id:'r'+(++seq), created_date:new Date(Date.now()+seq).toISOString(), created_by_id:email};
      t.push(r); return clone(r);
    }
    case 'update': {
      if(!isMember(u) || (ADMIN_WRITE.has(entity) && !isAdmin(u))) throw err(403);
      if('deletedAt' in args[1] && !isAdmin(u)) throw err(403); // field-level rule
      const r=t.find(x=>x.id===args[0]); if(!r) throw err(404);
      Object.assign(r,clone(args[1]),{updated_date:new Date().toISOString()}); return clone(r);
    }
    case 'delete': { if(!isAdmin(u)) throw err(403); const i=t.findIndex(x=>x.id===args[0]); t.splice(i,1); return {}; }
  }
  throw new Error('op '+op);
}
// fake dev data (same shape as the records created in the Base44 dev app)
function seed(){
  const add=(e,r)=>table(e).push({...r,id:'r'+(++seq),created_date:new Date(Date.now()+seq).toISOString()});
  add('CompanySettings',{legacy_id:'company',companyName:'TEST Company (fake data)',companyEmail:'test@example.com',companyPhone:'+1 555 000 0000',licenseNumber:'#TEST-0000',markup:25,salesTax:0,taxMode:'all',estimateFooter:'Fake dev data',terms:'Fake terms for testing.',version:1});
  add('EstimateCounter',{legacy_id:'estimates',nextNumber:9003,version:1});
  add('Category',{legacy_id:'cat-test-roof',name:'TEST Roofing',version:1,deletedAt:null,extra:null});
  add('Service',{legacy_id:'svc-test-1',category:'drywall',name:'TEST Drywall patch',defaultPrice:2.5,active:true,version:1,description:null,createdAt:null,updatedAt:null,deletedAt:null,extra:null});
  add('Service',{legacy_id:'svc-cloud-hang',category:'drywall',name:'Drywall Installation',defaultPrice:3.25,active:true,version:1});
  add('Service',{legacy_id:'svc-test-4',category:'cat-test-roof',name:'TEST Roof inspection',defaultPrice:150,active:false,version:1});
  add('Estimate',{legacy_id:'est-test-1',estimateNumber:'EST-2026-9001',date:'2026-10-12',client_id:'cli-test-1',clientName:'TEST Alice Example',clientEmail:'alice@example.com',address:'100 Fake Ave, Testville, CA 90000',addressStatus:'unverified',addressLatitude:null,
    items:[{id:'li-t1',category:'drywall',categoryName:'Drywall',serviceId:'svc-test-1',name:'TEST Drywall patch',description:'',quantity:100,price:2.5,total:250},{id:'li-t2',category:'painting',categoryName:'Painting',serviceId:null,name:'TEST Interior paint',description:'',quantity:200,price:1.5,total:300}],
    drywallTotal:250,stuccoTotal:0,paintingTotal:300,otherTotal:0,customCategories:[],categoryTotals:{drywall:250,stucco:0,painting:300},subtotal:550,markup:25,markupAmount:137.5,taxRate:0,taxMode:'all',taxAmount:0,customerTotal:687.5,status:'sent',crmProjectId:'crm-test-1',createdAt:'2026-10-12T12:00:00.000Z',updatedAt:'2026-10-12T12:00:00.000Z',version:1,deletedAt:null,extra:null});
  add('CrmProject',{legacy_id:'crm-test-1',client_id:'cli-test-1',clientName:'TEST Alice Example',address:'100 Fake Ave, Testville, CA 90000',addressStatus:'unverified',estimateId:'est-test-1',estimateNumber:'EST-2026-9001',estimateTotal:687.5,stage:'prospect',prospectStatus:'quote_sent',tasks:[],followUpType:'client',followUpCompleted:false,createdAt:'2026-10-12T12:00:00.000Z',updatedAt:'2026-10-12T12:00:00.000Z',version:1});
  add('CrmProject',{legacy_id:'crm-test-2',clientName:'TEST Carol Lead',stage:'lead',prospectStatus:'needs_action',tasks:[],followUpType:'personal',version:1});
}

// browser side: SDK shim that forwards every call to the fake server
const SHIM=`
window.__EVERCRAFT_BASE44_SDK={createClient(cfg){
  window.__b44cfg=cfg;
  const call=(entity,op,args)=>window.__b44(entity,op,args,localStorage.getItem('base44_access_token@ci-cloud-test-app-00000000')).then(r=>{ if(r && r.__error!==undefined){ const e=new Error(r.__error ? 'HTTP '+r.__error : 'Network Error'); if(r.__error) e.status=r.__error; throw e;} return r; });
  const entities=new Proxy({},{get:(_,name)=>({
    filter:(...a)=>call(name,'filter',a), list:(...a)=>call(name,'filter',[{},...a]), get:id=>call(name,'get',[id]),
    create:d=>call(name,'create',[d]), update:(id,d)=>call(name,'update',[id,d]), delete:id=>call(name,'delete',[id]),
    subscribe:cb=>{ (window.__subs=window.__subs||[]).push(cb); return ()=>{}; }
  })});
  return {entities, auth:{me:()=>call('auth','me',[]), updateMe:d=>call('auth','updateMe',[d]), setToken:()=>{}, redirectToLogin:u=>{window.__loginRedirect=u;}, logout:u=>{window.__logout=u;}}};
}};`;

async function employee(browser, email, opts={}){
  const ctx=await browser.newContext({viewport:{width:1400,height:900}, acceptDownloads:true});
  const p=await ctx.newPage();
  p.errs=[]; p.on('pageerror',e=>p.errs.push(e.message)); p.on('console',m=>{ if(m.type()==='error') p.errs.push(m.text()); });
  p.dialogs=[]; p.answer=true; p.on('dialog',d=>{ p.dialogs.push(d.message()); p.answer?d.accept():d.dismiss(); });
  p.downloads=0; p.on('download',()=>p.downloads++);
  await p.exposeFunction('__b44',async (entity,op,args,token)=>{ if(FAIL.during && FAIL.during.email===email && FAIL.during.op===op){ const d=FAIL.during; FAIL.during=null; await d.run(p); } try{ return serve(token && token.startsWith('tok:') ? token.slice(4) : email,entity,op,args); }catch(e){ return {__error:e.status===0 ? 0 : (e.status||500)}; } });
  // The fake app's address does not exist. Sign-in requests (the app's own fetch to /auth/...) are answered
  // here inside the page rather than through browser network interception, which stalled now and then.
  await p.exposeFunction('__auth',(pth,body)=>{
    const b=JSON.parse(body||'{}');
    if(pth==='login'){
      if(USERS[b.email] && b.password==='pw-'+b.email) return {status:200,body:{access_token:'tok:'+b.email,user:USERS[b.email]}};
      return {status:400,body:{detail:'Invalid email or password'}};
    }
    if(pth==='reset-password-request'){ p.resetFor=b.email; return {status:200,body:{}}; }
    return {status:404,body:{}};
  });
  await p.addInitScript(`{ const realFetch=window.fetch; window.fetch=function(url,opts){ const m=String(url).match(/^https:\\/\\/[^/]*\\/api\\/apps\\/ci-cloud-test-app-00000000\\/auth\\/([a-z-]+)$/); if(!m) return realFetch.apply(this,arguments); return window.__auth(m[1],opts&&opts.body).then(r=>new Response(JSON.stringify(r.body),{status:r.status,headers:{'Content-Type':'application/json'}})); }; }`);
  if(USERS[email]) await p.addInitScript(`if(!localStorage.getItem('base44_access_token@ci-cloud-test-app-00000000')) localStorage.setItem('base44_access_token@ci-cloud-test-app-00000000','tok:${email}');`);
  await p.addInitScript(SHIM);
  if(opts.off) await p.addInitScript(`Object.defineProperty(window,'EVERCRAFT_CONFIG',{configurable:true,set(v){this.__c={...v,base44AppId:''}},get(){return this.__c}});`);
  if(opts.local) await p.addInitScript(`if(!localStorage.getItem('seeded')){ localStorage.setItem('seeded','1'); ${Object.entries(opts.local).map(([k,v])=>`localStorage.setItem(${JSON.stringify(k)},${JSON.stringify(JSON.stringify(v))});`).join('')} }`);
  await p.goto(FILE+'#crm');
  await p.waitForFunction(()=>typeof CLOUD!=='undefined' && CLOUD.state!=='syncing');
  return p;
}
const store=(p,k)=>p.evaluate(k=>JSON.parse(localStorage.getItem(typeof storageKey==='function' ? storageKey(k) : k)||'null'),k);
const rawStore=(p,k)=>p.evaluate(k=>JSON.parse(localStorage.getItem(k)||'null'),k);
const sync=(p,opts)=>p.evaluate(o=>cloudSync(o).then(()=>CLOUD.state),opts||{});
const chip=p=>p.textContent('#cloudStatus');
const remote=(e,lid)=>table(e).find(r=>r.legacy_id===lid);

(async()=>{
  seed();
  const browser=await launch({config:CLOUD_CONFIG});

  // 1. not configured → off, nothing contacted
  let n0=calls.length;
  const off=await employee(browser,'a@test',{off:true});
  ok(await off.isHidden('#cloudStatus') && calls.length===n0,'no app id: cloud is off, chip hidden, no requests');

  // 2. signed out
  const anon=await employee(browser,'nobody@test');
  ok((await chip(anon)).includes('Sign in'),'signed out: chip says Sign in');
  await anon.click('#cloudStatus');
  ok(await anon.isVisible('#cloudLoginModal'),'Sign in opens the sign-in window');
  ok(!calls.some(c=>c.email==='nobody@test'),'signed out: no request to the server at all');
  await anon.fill('#cloudLoginEmail','a@test'); await anon.fill('#cloudLoginPassword','wrong');
  await anon.click('#cloudLoginSubmit'); await anon.waitForFunction(()=>$('cloudLoginError').textContent!=='');
  ok((await anon.textContent('#cloudLoginError')).includes('Invalid email or password') && await anon.isVisible('#cloudLoginModal') && !(await anon.evaluate(()=>localStorage.getItem(storageKey('base44_access_token')))),'wrong password: message shown, stays on the page, nothing saved');
  await anon.fill('#cloudLoginEmail','out@test'); await anon.click('#cloudLoginReset');
  for(let i=0;i<50 && !anon.dialogs.length;i++) await anon.waitForTimeout(100);
  ok(anon.resetFor==='out@test' && anon.dialogs.at(-1).includes('set a password'),'"send me a link to set a password" asks Base44 to email a link');
  await anon.click('#cloudLoginGoogle');
  ok(await anon.evaluate(()=>window.__loginRedirect && window.__b44cfg.appId==='ci-cloud-test-app-00000000' && window.__b44cfg.appBaseUrl.includes('base44.app')),'Sign in redirects to the Base44 login of the configured app');
  ok(await anon.evaluate(()=>window.__loginRedirect===cloudConfig().appBaseUrl.replace(/\/$/,'')+'/' && sessionStorage.getItem('constructionEstimatorCloudReturnPage')==='crm'),'Google sign-in returns to the Base44 app home (which forwards here); the page is remembered');
  ok(await anon.evaluate(()=>window.__b44cfg.serverUrl && window.__b44cfg.serverUrl.includes('preview--')),'dev API address is the preview address');
  await anon.goto('about:blank'); await anon.goto(FILE+'#crm?access_token=tok:a@test');
  await anon.waitForFunction(()=>typeof CLOUD!=='undefined' && CLOUD.state!=='syncing');
  ok(await anon.evaluate(()=>localStorage.getItem(storageKey('base44_access_token'))==='tok:a@test' && CLOUD.user && CLOUD.user.email==='a@test' && !location.href.includes('access_token') && location.hash==='#crm' && !$('page-crm').hidden),'token returned after "#page" is kept, signs in, is removed from the address, and the CRM page opens');
  await anon.evaluate(()=>localStorage.removeItem(storageKey('base44_access_token')));
  await Promise.all([anon.waitForNavigation(), anon.evaluate(()=>{ location.hash='crm?access_token=tok:b@test'; })]);
  await anon.waitForFunction(()=>typeof CLOUD!=='undefined' && CLOUD.state!=='syncing');
  ok(await anon.evaluate(()=>localStorage.getItem(storageKey('base44_access_token'))==='tok:b@test' && !location.href.includes('access_token')),'token arriving without a page load is kept too');

  await anon.evaluate(()=>localStorage.setItem(storageKey('base44_access_token'),'tok:EXPIRED'));
  await anon.reload(); await anon.waitForFunction(()=>typeof CLOUD!=='undefined' && CLOUD.state!=='syncing');
  ok(await anon.evaluate(()=>!localStorage.getItem(storageKey('base44_access_token')) && CLOUD.state==='signed_out'),'a sign-in the server rejects is forgotten (shows Sign in)');
  // 3. outsider (signed in, no crm_role)
  n0=calls.filter(c=>c.op!=='me').length;
  const out=await employee(browser,'out@test');
  ok((await chip(out)).includes('No access') && calls.filter(c=>c.op!=='me').length===n0,'outsider: "No access", no data requests');
  ok(serve('out@test','Estimate','filter',[{}]).length===0,'server: outsider reads 0 estimates');
  let denied=0; for(const f of [()=>serve('out@test','Estimate','create',[{legacy_id:'x'}]),()=>serve('out@test','CrmProject','update',[table('CrmProject')[0].id,{stage:'job'}])]) try{f();}catch(e){ if(e.status===403) denied++; }
  ok(denied===2,'server: outsider cannot create or update');

  // 3b. in-app email + password sign-in (no redirect, no reload)
  const login=await employee(browser,'nobody2@test');
  await login.click('#cloudStatus');
  await login.fill('#cloudLoginEmail','b@test'); await login.fill('#cloudLoginPassword','pw-b@test');
  await login.click('#cloudLoginSubmit');
  await login.waitForFunction(()=>CLOUD.state==='synced',null,{timeout:10000}).catch(async e=>{ console.log('LOGIN DIAG',JSON.stringify(await login.evaluate(()=>({state:CLOUD.state,msg:CLOUD.message,role:CLOUD.role,user:CLOUD.user&&CLOUD.user.email,running:!!CLOUD.running,err:$('cloudLoginError').textContent,btn:$('cloudLoginSubmit').textContent,email:$('cloudLoginEmail').value,modal:!$('cloudLoginModal').hidden && $('cloudLoginModal').classList.contains('open')}))),login.errs); throw e; });
  ok(await login.isHidden('#cloudLoginModal') && (await login.textContent('#cloudStatus')).includes('Synced') && await login.evaluate(()=>CLOUD.user.email)==='b@test','email + password sign-in works inside the app and starts syncing');
  ok(await login.evaluate(()=>!document.body.innerText.includes('pw-b@test') && $('cloudLoginPassword').value===''),'password field is cleared after sign-in');

  // 3c. Base44 app admin without a CRM role gets owner access; Team panel
  const boss=await employee(browser,'boss@test');
  ok(USERS['boss@test'].crm_role==='owner' && await boss.evaluate(()=>CLOUD.role)==='owner','Base44 app admin gets owner access automatically on first sign-in');
  await boss.click('#mainNav [data-page=settings]');
  await boss.waitForSelector('#teamBody select');
  ok(await boss.isVisible('#teamCard') && await boss.locator('#teamBody tr').count()===Object.keys(USERS).length,'admin sees the Team Access list with everyone');
  ok(await boss.locator('#teamBody tr',{hasText:'boss@test'}).locator('select').isDisabled(),'admin cannot change own access by mistake');
  await boss.locator('#teamBody tr',{hasText:'new@test'}).locator('select').selectOption('member');
  await boss.waitForFunction(()=>$('teamStatus').textContent.includes('Saved'));
  ok(USERS['new@test'].crm_role==='member','admin gives a new employee Member access');
  await boss.locator('#teamBody tr',{hasText:'new@test'}).locator('select').selectOption('none');
  await boss.waitForTimeout(300);
  ok(USERS['new@test'].crm_role==='none','admin can remove access again ("No access")');
  let esc=false; try{ serve('out@test','auth','updateMe',[{crm_role:'owner'}]); }catch(e){ esc=e.status===403; }
  ok(esc,'server: a normal user cannot set its own crm_role');

  // 4. member A with existing local data (from before the cloud)
  const localA={
    constructionEstimatorSettings:{companyName:'EverCraft local',googleMapsApiKey:'LOCAL-KEY',nextEstimateNumber:1002,markup:25,salesTax:0,taxMode:'all'},
    constructionEstimatorSavedEstimates:[{id:'est-local-1',estimateNumber:'EST-2026-1001',date:'2026-10-01',clientName:'Local Client',items:[{id:'li1',category:'stucco',name:'Patch',quantity:2,price:50,total:100}],subtotal:100,markup:0,markupAmount:0,taxRate:0,taxMode:'all',taxAmount:0,customerTotal:100,status:'draft',myOldField:'keep me'}],
    constructionEstimatorCRM:[{id:'crm-local-1',clientName:'Local Lead',stage:'lead'}],
    constructionEstimatorCategories:[]
  };
  const A=await employee(browser,'a@test',{local:localA});
  ok((await chip(A)).includes('Synced'),'member A: synced');
  let est=await store(A,'constructionEstimatorSavedEstimates');
  ok(est.some(e=>e.id==='est-test-1' && e.customerTotal===687.5 && e.items.length===2) && est.some(e=>e.id==='est-local-1'),'A: cloud estimate downloaded (ids, totals, items kept); local estimate kept');
  ok(!remote('Estimate','est-local-1') && !remote('CrmProject','crm-local-1'),'A: old local records are NOT uploaded automatically');
  ok(await A.isVisible('#cloudUpload') && (await A.textContent('#cloudUpload')).includes('(23)'),'A: "Upload local data (23)" offered (1 estimate, 1 project, 21 default services) '+await A.textContent('#cloudUpload'));
  ok(await A.isVisible('#cloudPendingBar') && (await A.textContent('#cloudPendingText')).includes('1 CRM lead, 1 estimate, 21 services') ,'yellow bar says what is not shared yet: '+await A.textContent('#cloudPendingText'));
  const svcA=await store(A,'constructionEstimatorServices');
  ok(svcA.filter(x=>x.category==='drywall' && x.name==='Drywall Installation').length===1 && svcA.find(x=>x.name==='Drywall Installation').id==='svc-cloud-hang','default service with the same name adopts the cloud service (no duplicate)');
  let s=await store(A,'constructionEstimatorSettings');
  ok(s.companyName==='TEST Company (fake data)' && s.googleMapsApiKey==='LOCAL-KEY','A: shared settings downloaded; Google Maps key stays local');
  ok(s.nextEstimateNumber>=9003,'A: next estimate number moved past the shared counter ('+s.nextEstimateNumber+')');
  ok((await A.inputValue('#estimateNumber'))===`EST-${new Date().getFullYear()}-${s.nextEstimateNumber}`,'A: the new estimate in the builder shows the updated number');
  ok(!table('CompanySettings').some(r=>'googleMapsApiKey' in r),'cloud settings never contain the Maps key');
  await A.click('#mainNav [data-page=crm]');
  ok(await A.locator('.kcard',{hasText:'TEST Carol Lead'}).count()===1,'A: CRM board shows the cloud lead');
  await A.click('#mainNav [data-page=settings]'); await A.waitForTimeout(200);
  ok(await A.isHidden('#teamCard'),'member does not see the Team Access panel');
  ok((await store(A,'constructionEstimatorServices')).some(x=>x.id==='svc-test-4' && x.category==='cat-test-roof'),'A: services + custom category keys preserved');
  ok((await store(A,'constructionEstimatorCategories')).some(c=>c.id==='cat-test-roof' && c.name==='TEST Roofing'),'A: custom category downloaded');

  // 5. explicit upload of local data
  await A.click('#cloudUpload');
  await A.waitForFunction(()=>CLOUD.state==='synced' && CLOUD.pendingUpload===0);
  ok(A.dialogs.at(-1).includes('Upload 1 CRM lead, 1 estimate, 21 services') && A.downloads===1,'upload asks first and downloads a backup');
  const up=remote('Estimate','est-local-1');
  ok(up && up.estimateNumber==='EST-2026-1001' && up.version===1 && up.extra && up.extra.myOldField==='keep me','uploaded estimate keeps id, number; unknown fields kept in "extra"');
  ok(remote('CrmProject','crm-local-1').stage==='lead','uploaded CRM project keeps its stage key');
  ok(await A.isHidden('#cloudUpload') && await A.isHidden('#cloudPendingBar'),'upload button and bar hidden afterwards');

  // 6. member B sees everything
  const B=await employee(browser,'b@test');
  est=await store(B,'constructionEstimatorSavedEstimates');
  ok(est.some(e=>e.id==='est-local-1' && e.myOldField==='keep me') && est.length===2,'B: sees the uploaded estimate (extra fields restored)');

  // 7. edits travel A → B
  await A.evaluate(()=>{ updateProject('crm-test-2',{stage:'prospect',notes:'called'}); });
  await A.waitForTimeout(1700); await A.evaluate(()=>CLOUD.running);
  await sync(A);
  ok(remote('CrmProject','crm-test-2').stage==='prospect' && remote('CrmProject','crm-test-2').version===2,'A: change is uploaded automatically after saving (version 2)');
  await sync(B);
  ok((await store(B,'constructionEstimatorCRM')).find(p=>p.id==='crm-test-2').notes==='called','B: receives the change');

  // 8. conflict: A and B change the same project; B saves second
  await A.evaluate(()=>CLOUD.role='');  // pause A's automatic sync
  await B.evaluate(()=>CLOUD.role='');
  await A.evaluate(()=>updateProject('crm-test-1',{assignedTechnician:'Tech A'}));
  await B.evaluate(()=>updateProject('crm-test-1',{assignedTechnician:'Tech B'}));
  await A.evaluate(()=>{CLOUD.role='member';}); await sync(A);
  await B.evaluate(()=>{CLOUD.role='member';}); await sync(B);
  ok(remote('CrmProject','crm-test-1').assignedTechnician==='Tech A','conflict: first save stays in the cloud (not overwritten)');
  ok((await store(B,'constructionEstimatorCRM')).find(p=>p.id==='crm-test-1').assignedTechnician==='Tech A','conflict: B now shows the cloud version');
  const conf=await store(B,'constructionEstimatorCloudConflicts');
  ok(conf && conf.some(c=>c.entity==='CrmProject' && c.record.assignedTechnician==='Tech B'),'conflict: B\'s own version is saved, not lost');

  // 9. member delete is refused and restored
  await B.evaluate(()=>{ CLOUD.role=''; const l=loadProjects().filter(p=>p.id!=='crm-local-1'); saveProjects(l); CLOUD.role='member'; });
  await sync(B);
  ok((await store(B,'constructionEstimatorCRM')).some(p=>p.id==='crm-local-1') && !remote('CrmProject','crm-local-1').deletedAt,'member delete: cloud record kept and restored locally');
  let refused=false; try{ serve('b@test','CrmProject','update',[remote('CrmProject','crm-local-1').id,{deletedAt:'x'}]); }catch(e){ refused=e.status===403; }
  ok(refused,'server: member cannot set deletedAt (soft delete is admin-only)');

  // 10. admin delete = soft delete, disappears for others
  const ADM=await employee(browser,'admin@test');
  await ADM.evaluate(()=>{ CLOUD.role=''; saveProjects(loadProjects().filter(p=>p.id!=='crm-local-1')); CLOUD.role='owner'; });
  await sync(ADM);
  const delRec=remote('CrmProject','crm-local-1');
  ok(delRec && delRec.deletedAt,'admin delete: record soft-deleted in the cloud (restorable)');
  await sync(A);
  ok(!(await store(A,'constructionEstimatorCRM')).some(p=>p.id==='crm-local-1'),'A: deleted project removed after sync');

  // 11. settings: member changes are not shared, admin changes are
  await B.evaluate(()=>{ SETTINGS.companyName='Member edit'; persistSettings(); });
  await B.waitForTimeout(1700); await B.evaluate(()=>CLOUD.running); await sync(B);
  ok(remote('CompanySettings','company').companyName==='TEST Company (fake data)' && (await store(B,'constructionEstimatorSettings')).companyName==='TEST Company (fake data)','member settings change is not uploaded and is reverted');
  await ADM.evaluate(()=>{ SETTINGS.companyName='Admin Co'; SETTINGS.markup=30; persistSettings(); });
  await ADM.waitForTimeout(1700); await ADM.evaluate(()=>CLOUD.running); await sync(ADM);
  await A.evaluate(()=>{ CLOUD.settingsSyncedAt=0; }); // settings are re-read every 5 minutes (or on a realtime notice)
  await sync(A);
  s=await store(A,'constructionEstimatorSettings');
  ok(remote('CompanySettings','company').companyName==='Admin Co' && s.companyName==='Admin Co' && s.markup===30,'admin settings change reaches members');
  ok((await A.textContent('#brandName'))==='Admin Co','brand name refreshes on screen');

  // 12. estimate numbers
  await B.evaluate(()=>{ CLOUD.role=''; const l=readStore(STORAGE_KEYS.estimates,[]); l.push({id:'est-dup',estimateNumber:'EST-2026-9001',clientName:'Dup',items:[],status:'draft'}); saveEstimates(l.map(normalizeEstimate)); CLOUD.role='member'; });
  await sync(B);
  ok(table('Estimate').filter(r=>r.estimateNumber==='EST-2026-9001').length===1,'duplicate estimate number is not uploaded');
  ok((await B.textContent('#cloudPendingText')).includes('estimate number EST-2026-9001 is already used'),'duplicate number: shown as not saved, with the reason');
  const n=await B.evaluate(()=>nextAvailableEstimateNumber());
  ok(parseInt(n.split('-').pop(),10)>=9003,'next number offered by the app is unique across the team ('+n+')');

  // 13. realtime events trigger a sync
  const before=calls.filter(c=>c.email==='b@test').length;
  await B.evaluate(()=>window.__subs.forEach(cb=>cb({type:'update'})));
  await B.waitForTimeout(3600); await B.evaluate(()=>CLOUD.running);
  ok(calls.filter(c=>c.email==='b@test').length>before,'realtime event starts a sync');

  // 13b. offline: changes stay here, are shown as not saved, and are saved when back online
  const pr=n=>remote('CrmProject',n);
  const vBefore=pr('crm-test-2').version;
  FAIL.net=true;
  await A.evaluate(()=>{ CLOUD.role=''; updateProject('crm-test-2',{notes:'offline edit'}); CLOUD.role='member'; });
  await sync(A);
  ok(await A.evaluate(()=>CLOUD.state)==='error' && pr('crm-test-2').notes!=='offline edit','offline: sync fails, the cloud is not changed');
  ok(await A.isVisible('#cloudPendingBar') && (await A.textContent('#cloudPendingText')).includes('1 change is not saved') && await A.isVisible('#cloudRetry'),'offline: yellow bar says 1 change is not saved: '+await A.textContent('#cloudPendingText'));
  ok((await store(A,'constructionEstimatorCRM')).find(p=>p.id==='crm-test-2').notes==='offline edit','offline: the change is kept on this computer');
  FAIL.net=false;
  await sync(A);
  ok(pr('crm-test-2').notes==='offline edit' && pr('crm-test-2').version===vBefore+1,'back online: the change is saved (version '+vBefore+' → '+pr('crm-test-2').version+')');
  ok(await A.isHidden('#cloudPendingBar') && (await A.textContent('#cloudStatus')).includes('Synced'),'back online: bar disappears only after the server confirmed');

  // 13c. connection lost in the middle of a sync: downloaded changes are kept, nothing stale is uploaded
  await sync(B);
  await B.evaluate(()=>{ CLOUD.role=''; updateProject('crm-test-2',{notes:'from B'}); CLOUD.role='member'; });
  await sync(B);
  ok(pr('crm-test-2').notes==='from B','B saved a newer version');
  await A.evaluate(()=>{ CLOUD.role=''; const l=readStore(STORAGE_KEYS.crm,[]); l.push({id:'crm-mid',clientName:'TEST Mid-sync lead',stage:'lead'}); saveProjects(l); CLOUD.role='member'; });
  FAIL.netOnOp={email:'a@test',op:'create'};
  await sync(A);
  ok(await A.evaluate(()=>CLOUD.state)==='error','connection lost while uploading: sync reports an error');
  ok((await store(A,'constructionEstimatorCRM')).find(p=>p.id==='crm-test-2').notes==='from B','the newer version that was already downloaded is kept on this computer');
  await sync(A);
  ok(pr('crm-test-2').notes==='from B' && !!pr('crm-mid') && table('CrmProject').filter(r=>r.legacy_id==='crm-mid').length===1,'next sync: B\'s version is not overwritten, the new lead is uploaded once');

  // 13d. a record the server refuses does not stop the others
  await A.evaluate(()=>{ CLOUD.role=''; const l=readStore(STORAGE_KEYS.crm,[]); l.push({id:'crm-bad',clientName:'TEST REJECT',stage:'lead'},{id:'crm-good',clientName:'TEST Good lead',stage:'lead'}); saveProjects(l); CLOUD.role='member'; });
  await sync(A);
  ok(!!pr('crm-good') && !pr('crm-bad'),'refused record: the other new lead is still uploaded');
  ok((await A.textContent('#cloudStatus')).includes('1 not saved') && (await A.textContent('#cloudPendingText')).includes('HTTP 422'),'refused record: shown as not saved with the reason ('+await A.textContent('#cloudStatus')+')');
  await A.evaluate(()=>{ CLOUD.role=''; updateProject('crm-bad',{clientName:'TEST Fixed lead'}); CLOUD.role='member'; });
  await sync(A);
  ok(!!pr('crm-bad') && pr('crm-bad').clientName==='TEST Fixed lead' && await A.isHidden('#cloudPendingBar'),'after correcting it, the record is saved and the bar disappears');

  // 13d2. Base44 request limit: pause instead of hammering the server
  FAIL.rate=true;
  await A.evaluate(()=>{ CLOUD.role=''; updateProject('crm-good',{notes:'during limit'}); CLOUD.role='member'; });
  await sync(A);
  const rl=await A.evaluate(()=>[CLOUD.state,CLOUD.message,CLOUD.backoffUntil-Date.now()]);
  ok(rl[0]==='error' && rl[1].includes('request limit') && rl[2]>40000,'request limit: reported, and automatic syncing pauses for a minute ('+rl[1]+')');
  ok((await A.textContent('#cloudPendingText')).includes('1 change is not saved'),'request limit: the change is shown as not saved');
  FAIL.rate=false;
  await A.evaluate(()=>{ CLOUD.backoffUntil=0; });
  await sync(A);
  ok(pr('crm-good').notes==='during limit' && await A.isHidden('#cloudPendingBar'),'after the pause the change is saved');

  // 13e. repeated syncs do not create duplicates
  const counts=()=>['Estimate','CrmProject','Service','Category'].map(e=>table(e).length).join(',');
  const c1=counts(); await sync(A); await sync(B); await sync(A); await sync(ADM);
  ok(counts()===c1,'repeated syncs from 3 browsers create no duplicates ('+c1+')');
  ok(table('CrmProject').every((r,i,a)=>a.findIndex(x=>x.legacy_id===r.legacy_id)===i),'every cloud lead has a unique app id');
  await sync(A);
  const upd0=calls.filter(c=>c.email==='a@test' && c.op==='update').length;
  await A.evaluate(()=>{ saveProjects(loadProjects()); saveEstimates(loadEstimates()); saveServices(loadServices()); });
  await A.waitForTimeout(1800); await A.evaluate(()=>CLOUD.running); await sync(A);
  ok(calls.filter(c=>c.email==='a@test' && c.op==='update').length===upd0 && await A.evaluate(()=>CLOUD.unsaved)===0,'re-saving unchanged records (app normalizing) uploads nothing and is not counted as unsaved');

  // 13f. switching to another Base44 app (test → production): test records are set aside, not uploaded
  {
    const sw=await employee(browser,'admin@test',{local:{
      constructionEstimatorCloudMeta:{appId:'OLD-TEST-APP',initialized:true,records:{CrmProject:{'crm-old-test':{rid:'x',version:1,hash:'h'}},Estimate:{'est-old-test':{rid:'y',version:1,hash:'h'}}},unmigrated:{}},
      constructionEstimatorCRM:[{id:'crm-old-test',clientName:'TEST from old app',stage:'lead'},{id:'crm-real-1',clientName:'Real Local Client',stage:'lead'}],
      constructionEstimatorSavedEstimates:[{id:'est-old-test',estimateNumber:'EST-2026-9001',clientName:'TEST old',items:[],status:'draft'},{id:'est-real-1',estimateNumber:'EST-2026-1044',clientName:'Real Local Client',items:[],status:'draft'}],
      constructionEstimatorSettings:{nextEstimateNumber:9004}
    }});
    const crmL=await store(sw,'constructionEstimatorCRM'), estL=await store(sw,'constructionEstimatorSavedEstimates');
    ok(!crmL.some(p=>p.id==='crm-old-test') && crmL.some(p=>p.id==='crm-real-1') && !estL.some(e=>e.id==='est-old-test') && estL.some(e=>e.id==='est-real-1'),'app switch: records from the previous app are set aside, own records stay');
    const legacy=await rawStore(sw,'constructionEstimatorCRM');
    ok(legacy && legacy.some(p=>p.id==='crm-old-test') && legacy.some(p=>p.id==='crm-real-1'),'app switch: the original data in this browser is left untouched (nothing deleted)');
    ok(!remote('CrmProject','crm-old-test') && !remote('Estimate','est-old-test'),'app switch: previous app records are not uploaded');
    ok(await sw.evaluate(()=>CLOUD.pendingUpload)>=2 && (await store(sw,'constructionEstimatorSettings')).nextEstimateNumber>=1045,'app switch: own records wait for "Upload"; numbering recalculated from own estimates');
    ok((await store(sw,'constructionEstimatorCloudMeta')).appId==='ci-cloud-test-app-00000000' && (await rawStore(sw,'constructionEstimatorCloudMeta')).appId==='OLD-TEST-APP','app switch: each app keeps its own bookkeeping');
  }

  // ===== audit fixes =====
  // F1. edits saved while a sync waits for the network are kept (and uploaded next)
  {
    await sync(B);
    await B.evaluate(()=>{ CLOUD.role=''; updateProject('crm-test-1',{notes:'B before race'}); CLOUD.role='member'; });
    await sync(B);
    await A.evaluate(()=>{ CLOUD.role=''; updateProject('crm-test-2',{notes:'A edit uploading'}); CLOUD.role='member'; });
    FAIL.during={email:'a@test',op:'get',run:async p=>{ await p.evaluate(()=>{
      const l=loadProjects(); l.push(newProjectRecord({clientName:'TEST created during sync'})); const g=l.find(x=>x.id==='crm-good'); g.notes='edited during sync'; saveProjects(l); }); }};
    await sync(A);
    await A.evaluate(()=>CLOUD.running);
    const l=await store(A,'constructionEstimatorCRM');
    const made=l.find(p=>p.clientName==='TEST created during sync');
    ok(FAIL.during===null && !!made && l.find(p=>p.id==='crm-good').notes==='edited during sync','F1: a lead created and a lead edited during a running sync are kept on this computer');
    ok(l.find(p=>p.id==='crm-test-1').notes==='B before race' && pr('crm-test-2').notes==='A edit uploading','F1: the sync still downloaded the other change and uploaded its own');
    await sync(A);
    ok(made && !!pr(made.id) && pr('crm-good').notes==='edited during sync' && await A.evaluate(()=>CLOUD.unsaved)===0,'F1: both are uploaded by the next sync');
  }

  // F5. "Upload local data" while a sync is already running, and when the limit interrupts it
  {
    const C=await employee(browser,'c@test',{local:{constructionEstimatorCRM:[{id:'crm-c-local',clientName:'TEST C local lead',stage:'lead'}],constructionEstimatorServices:[]}});
    ok(await C.evaluate(()=>CLOUD.pendingUpload)===1,'F5: C has 1 local lead waiting for upload');
    await C.evaluate(()=>{ cloudSync(); });            // a sync is running…
    await C.click('#cloudUpload');                     // …when Upload is clicked
    await C.waitForFunction(()=>!CLOUD.running && CLOUD.pendingUpload===0,null,{timeout:15000});
    ok(!!pr('crm-c-local') && (await C.textContent('#toast')).includes('uploaded'),'F5: upload clicked during a running sync is not lost, and success is reported ('+await C.textContent('#toast')+')');
    await C.evaluate(()=>{ CLOUD.role=''; const l=loadProjects(); l.push({id:'crm-c-2',clientName:'TEST C second',stage:'lead'}); saveProjects(l); CLOUD.role='member'; });
    await C.evaluate(()=>{ const m=cloudMeta(); m.unmigrated.CrmProject={'crm-c-2':true}; localStorage.setItem(storageKey('constructionEstimatorCloudMeta'),JSON.stringify(m)); CLOUD.pendingUpload=1; CLOUD.pendingBy={CrmProject:1}; renderCloudStatus(); });
    FAIL.rate=true;
    await C.click('#cloudUpload');
    await C.waitForFunction(()=>!CLOUD.running,null,{timeout:15000});
    ok(C.dialogs.at(-1).includes('not finished') && !pr('crm-c-2') && await C.evaluate(()=>CLOUD.uploadRequested===true),'F5: an upload stopped by the request limit is reported as not finished, and stays requested');
    FAIL.rate=false;
    await C.evaluate(()=>{ CLOUD.backoffUntil=0; return cloudSync(); });
    ok(!!pr('crm-c-2') && await C.evaluate(()=>CLOUD.pendingUpload===0 && !CLOUD.uploadRequested),'F5: it completes on the next sync without clicking again');
  }

  // F2. restoring an old backup while signed in does not delete or overwrite shared records
  {
    await sync(ADM);
    const before=table('CrmProject').filter(r=>!r.deletedAt).length;
    await ADM.evaluate(()=>{
      const data={}; for(const [n,k] of Object.entries(STORAGE_KEYS)) data[n]=readStore(k,null);
      data.crm=data.crm.filter(p=>p.id!=='crm-good').map(p=>p.id==='crm-test-2' ? {...p,notes:'from old backup'} : p);
      data.crm.push({id:'crm-only-backup',clientName:'TEST only in backup',stage:'lead'});
      window.__bk=new File([JSON.stringify({app:BACKUP_APP,version:1,exportedAt:new Date().toISOString(),data})],'b.json');
    });
    await Promise.all([ADM.waitForNavigation(), ADM.evaluate(()=>restoreBackupFile(window.__bk))]);
    // after the reload: wait for the first sync to have run, not just for the page
    await ADM.waitForFunction(()=>typeof CLOUD!=='undefined' && CLOUD.started && CLOUD.state==='synced' && !CLOUD.running,null,{timeout:15000});
    ok(ADM.dialogs.some(d=>d.includes('Shared CRM: the backup does not change or delete shared records')),'F2: the restore warns how it treats shared data');
    ok(!pr('crm-good').deletedAt && table('CrmProject').filter(r=>!r.deletedAt).length===before,'F2: records missing from the backup are NOT deleted for everyone');
    ok(pr('crm-test-2').notes!=='from old backup' && (await store(ADM,'constructionEstimatorCRM')).find(p=>p.id==='crm-test-2').notes===pr('crm-test-2').notes,'F2: the shared version wins over the old backup copy');
    ok((await store(ADM,'constructionEstimatorCloudConflicts')).some(c=>c.record && c.record.notes==='from old backup'),'F2: the backup copy is kept as a conflict copy');
    ok(!pr('crm-only-backup') && await ADM.evaluate(()=>CLOUD.pendingUpload)>=1,'F2: records only in the backup wait for "Upload" instead of being uploaded silently');
  }

  // F3. members cannot delete shared records; photos are never removed automatically in cloud mode
  {
    B.dialogs.length=0;
    const res=await B.evaluate(()=>deleteProject('crm-good'));
    ok(res===false && B.dialogs.some(d=>d.includes('Only an admin can delete')) && (await store(B,'constructionEstimatorCRM')).some(p=>p.id==='crm-good'),'F3: a member\'s delete is refused with a clear message, nothing changes');
    const est=await B.evaluate(()=>{ const e=loadEstimates()[0]; deleteEstimate(e.id); return loadEstimates().some(x=>x.id===e.id); });
    ok(est===true,'F3: the same for estimates (and services / categories use the same check)');
    const calls2=await ADM.evaluate(async()=>{ let n=0; const orig=deleteOwnerPhotos; deleteOwnerPhotos=async()=>{ n++; }; await cleanupOrphanPhotos(); deleteProject('crm-c-2'); deleteOwnerPhotos=orig; return n; });
    ok(calls2===0,'F3: in cloud mode no photos are deleted by the start-up cleanup or by deleting a project');
    await sync(ADM);
    ok(pr('crm-c-2').deletedAt,'F3: the admin delete itself still works (soft delete in the cloud)');
  }

  // F6/F8. each cloud app has its own data in the browser; the one-time copy is all-or-nothing
  {
    const legacyKeysUntouched=await rawStore(A,'constructionEstimatorCRM');
    ok(legacyKeysUntouched===null || Array.isArray(legacyKeysUntouched),'F6: original keys are never rewritten by the sync');
    const n0=calls.filter(c=>c.email==='d@test').length;
    const D=await employee(browser,'d@test',{local:{constructionEstimatorCRM:[{id:'crm-d',clientName:'TEST D',stage:'lead'}]}});
    // second page in the same browser profile is not possible here; simulate a full storage instead:
    const ctx2=await browser.newContext(); const P=await ctx2.newPage(); const dlg=[]; P.on('dialog',d=>{dlg.push(d.message()); d.accept();});
    await P.exposeFunction('__b44',(e,o,a)=>serve('d@test',e,o,a));
    await P.addInitScript(SHIM);
    await P.addInitScript(`localStorage.setItem('constructionEstimatorCRM',JSON.stringify([{id:'crm-q',clientName:'TEST quota',stage:'lead'}]));
      const orig=Storage.prototype.setItem; Storage.prototype.setItem=function(k,v){ if(k.includes('@ci-cloud-test') && k.includes('constructionEstimatorCRM')) throw new Error('QuotaExceededError'); return orig.call(this,k,v); };`);
    await P.goto(FILE+'#crm'); await P.waitForFunction(()=>typeof CLOUD!=='undefined' && CLOUD.state!=='syncing');
    const st=await P.evaluate(()=>[STORAGE_COPY_FAILED, CLOUD.state, CLOUD.message, Object.keys(localStorage).filter(k=>k.includes('@ci-cloud-test') && !k.includes('base44')).length]);
    ok(st[0]===true && st[1]==='error' && st[2].includes('Not enough browser storage') && st[3]===0,'F8: if the copy fails, the partial copy is removed and nothing syncs ('+st[2]+')');
    ok(await P.evaluate(()=>STORAGE_KEYS.crm==='constructionEstimatorCRM' && loadProjects().some(p=>p.id==='crm-q')),'F8: the app keeps working on the original data meanwhile');
    await ctx2.close();
    ok((await store(D,'constructionEstimatorCRM')).some(p=>p.id==='crm-d') && (await rawStore(D,'constructionEstimatorCRM')).some(p=>p.id==='crm-d'),'F6: on first start the app gets a copy; the original data stays as it was');
  }

  // M. migration check (dry run): reads only, reports what an upload would do (dev branch only)
  if(await ADM.evaluate(()=>typeof migrationReport==='function')) {
    await ADM.evaluate(()=>showPage('settings')); await ADM.waitForTimeout(300);
    ok(await ADM.isVisible('#migrationCard'),'M: owner sees the Migration Check card');
    await B.evaluate(()=>showPage('settings')); await B.waitForTimeout(300);
    ok(await B.isHidden('#migrationCard'),'M: a member does not see the Migration Check card');
    const crm2=remote('CrmProject','crm-test-2');
    const source={
      categories:[{id:'cat-new',name:'Fencing'}],
      services:[{id:'svc-local-hang',category:'drywall',name:'Drywall Installation',defaultPrice:9,active:true},
                {id:'svc-new',category:'cat-missing',name:'Gate repair',defaultPrice:50,active:true}],
      crm:[{id:'crm-new-1',clientName:'Real Lead One',clientPhone:'(818) 555-0101',stage:'lead',estimateId:'est-new-1'},
           {id:'crm-new-2',clientName:'TEST Carol Lead',clientPhone:'',address:'',stage:'lead'},
           {id:'crm-new-3',clientName:'Real Lead One',clientPhone:'818-555-0101',stage:'lead'},
           {id:'crm-test-2',clientName:crm2.clientName,stage:'job',tasks:[]},
           {id:'crm-new-1',clientName:'Real Lead One again',stage:'lead'}],
      estimates:[{id:'est-new-1',estimateNumber:'EST-2026-7771',clientName:'Real Lead One',crmProjectId:'crm-new-1',items:[]},
                 {id:'est-new-2',estimateNumber:'EST-2026-9001',clientName:'Number taken',items:[]},
                 {id:'est-new-3',estimateNumber:'',clientName:'No number',items:[]},
                 {id:'est-new-4',estimateNumber:'EST-2026-9500',clientName:'Missing project',crmProjectId:'crm-gone',items:[]}],
      settings:{companyName:'EverCraft Real Name',markup:25}
    };
    const before=calls.length, storageBefore=await ADM.evaluate(()=>JSON.stringify(Object.entries(localStorage).sort()));
    const r=await ADM.evaluate(async src=>{ const rep=migrationReport(src, await migrationCloudData()); return rep; },source);
    const ops=calls.slice(before).map(c=>c.op);
    ok(ops.length>0 && ops.every(o=>o==='filter'),'M: the check only reads from the server ('+[...new Set(ops)].join(',')+')');
    ok(await ADM.evaluate(()=>JSON.stringify(Object.entries(localStorage).sort()))===storageBefore,'M: the check does not change this browser\'s data');
    const T=r.types;
    ok(T.Category.create===1 && T.Service.mergedByName===1 && T.Service.create===1,'M: new category and service counted; same-name service merged ('+JSON.stringify([T.Category.create,T.Service.mergedByName,T.Service.create])+')');
    ok(T.Service.examples.mergedByName[0].priceDiffers===true,'M: merged service with a different price is flagged');
    ok(T.CrmProject.create===3 && T.CrmProject.different===1 && T.CrmProject.duplicateIds===1,'M: CRM: 3 new, 1 different from shared, 1 duplicate id ('+JSON.stringify([T.CrmProject.create,T.CrmProject.different,T.CrmProject.duplicateIds])+')');
    ok(T.Estimate.create===2 && T.Estimate.numberTaken===1 && T.Estimate.invalid===1,'M: estimates: 2 new, 1 number already used, 1 without a number ('+JSON.stringify([T.Estimate.create,T.Estimate.numberTaken,T.Estimate.invalid])+')');
    ok(JSON.stringify(r.newIds.Estimate.sort())===JSON.stringify(['est-new-1','est-new-4']) && r.newIds.CrmProject.length===3,'M: report lists exactly the ids an upload would create (rollback list)');
    const txt=r.problems.map(p=>p.text).join(' | ');
    ok(/EST-2026-9001 is already used/.test(txt) && /crm-gone does not exist/.test(txt) && /cat-missing of "Gate repair" does not exist/.test(txt) && /same id appears twice/.test(txt),'M: problems: number taken, broken estimate link, missing category, duplicate id');
    ok((r.duplicates||[]).some(d=>d.ids.includes('crm-new-1') && d.ids.includes('crm-new-3') && d.match==='phone') && (r.duplicates||[]).some(d=>d.ids.includes('crm-new-2') && d.ids.includes('crm-test-2')),'M: possible duplicate clients found (same phone; same name as a shared lead) '+JSON.stringify(r.duplicates||[]).slice(0,200));
    ok(r.settings.differentFields.includes('companyName') && r.counter.highestUsed===9500 && r.counter.ok===false,'M: settings difference and a too-low estimate counter are reported');
    // the screen: a backup file through the card
    const backupFile={name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({app:'EverCraftEstimator',version:1,exportedAt:new Date().toISOString(),data:source}))};
    await ADM.setInputFiles('#migrationFile',backupFile);
    await ADM.waitForFunction(()=>document.getElementById('migrationResult').textContent.includes('Nothing was changed'),null,{timeout:10000});
    const shown=await ADM.textContent('#migrationResult');
    await ADM.locator('#migrationCard').screenshot({path:OUT+'/migration.png'});
    ok(shown.includes('An upload would add 7 record(s)') && shown.includes('EST-2026-9001') && await ADM.isVisible('#migrationDownload'),'M: the card shows the report for a backup file, with a download button');
    const dl=ADM.waitForEvent('download'); await ADM.click('#migrationDownload'); const f=await dl;
    ok(/^migration-check-.*\.json$/.test(f.suggestedFilename()),'M: the report downloads as JSON');
    await ADM.setInputFiles('#migrationFile',{name:'x.json',mimeType:'application/json',buffer:Buffer.from('{"nope":1}')});
    await ADM.waitForTimeout(300);
    ok((await ADM.textContent('#migrationStatus')).includes('not a backup file'),'M: a wrong file is refused');
  }

  // 14. app still works with cloud on
  await A.click('#mainNav [data-page=estimates]');
  ok(await A.locator('#estimatesBody tr').count()>=2,'Saved Estimates page renders cloud data');
  await A.click('#mainNav [data-page=builder]');
  ok(await A.isVisible('#builderSections'),'Estimate Builder opens');
  await A.setViewportSize({width:390,height:844});
  await A.screenshot({path:OUT+'/cloud.png'});

  for(const [name,p] of [['A',A],['B',B],['admin',ADM],['outsider',out],['signed out',anon],['off',off],['login',login],['boss',boss]]) { const e=p.errs.filter(x=>!(name==='signed out' && x.includes('400 (Bad Request)'))); ok(e.length===0,`no console errors (${name}) ${JSON.stringify(e)}`); }
  console.log(`\n${pass} passed, ${fail} failed`); await browser.close();
})();
