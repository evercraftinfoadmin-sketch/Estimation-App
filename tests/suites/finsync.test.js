// Project financials with shared data: sync between an owner and an employee, and the Base44
// access rules of the financial tables. The fake Base44 server below enforces the rules exactly
// as written in docs/base44-finance-entities.json (the file used to set up the tables), so the
// requests an app could never send are tested against the server, not only the buttons.
const fs = require('fs');
const path = require('path');
const { launch, FILE } = require('../helpers');
let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m);};

const APP='ci-fin-test-app-0000000000', APP2='ci-fin-other-company-00000';
const RULES=Object.fromEntries(JSON.parse(fs.readFileSync(path.join(__dirname,'../../docs/base44-finance-entities.json'),'utf8')).map(e=>[e.name,e]));
const USERS={
  'owner@test':{id:'u-o',email:'owner@test',role:'admin',crm_role:'owner'},
  'mgr@test':{id:'u-m',email:'mgr@test',role:'user',crm_role:'admin'},
  'yura@test':{id:'u-y',email:'yura@test',role:'user',crm_role:'member'},
  'out@test':{id:'u-x',email:'out@test',role:'user'}
};
const DBS={[APP]:{},[APP2]:{}}; let seq=0; const calls=[];
const FAIL={netOn:null, missing:new Set()};
function err(status){ const e=new Error('HTTP '+status); e.status=status; return e; }
const clone=x=>JSON.parse(JSON.stringify(x));

// Base44 row-level security: $or / $and, user_condition on the user, created_by_id = {{user.id}}.
function cond(c, u, rec){
  if(!c) return false;
  if(c.$or) return c.$or.some(x=>cond(x,u,rec));
  if(c.$and) return c.$and.every(x=>cond(x,u,rec));
  return Object.entries(c).every(([k,v])=>{
    if(k==='user_condition') return Object.entries(v).every(([p,val])=>(p==='data.crm_role' ? u.crm_role : u[p])===val);
    if(k==='created_by_id') return rec && rec.created_by_id===(v==='{{user.id}}' ? u.id : v);
    if(k.startsWith('data.')) return rec && rec[k.slice(5)]===v;
    return false;
  });
}
const MEMBER={$or:['owner','admin','member'].map(r=>({user_condition:{'data.crm_role':r}}))};
const ADMIN={$or:['owner','admin'].map(r=>({user_condition:{'data.crm_role':r}}))};
function rulesOf(entity){
  if(RULES[entity]) return RULES[entity];
  const base={rls:{read:MEMBER,create:MEMBER,update:MEMBER,delete:ADMIN},properties:{deletedAt:{rls:{write:ADMIN}}}};
  if(entity==='CompanySettings' || entity==='EstimateCounter') base.rls={...base.rls,create:ADMIN,update:entity==='CompanySettings' ? ADMIN : MEMBER};
  return base;
}
function fieldsAllowed(def, u, data){
  return Object.keys(data).every(k=>{ const p=def.properties && def.properties[k]; return !(p && p.rls && p.rls.write) || cond(p.rls.write,u,null); });
}
function serve(app, email, entity, op, args){
  calls.push({app,email,entity,op});
  if(FAIL.netOn && FAIL.netOn.email===email && FAIL.netOn.entity===entity && FAIL.netOn.op===op){ FAIL.netOn=null; throw err(0); }
  const u=USERS[email];
  if(entity==='auth' && op==='me'){ if(!u) throw err(401); return u; }
  if(entity==='auth') return u;
  if(entity==='User'){ if(!u || u.role!=='admin') throw err(403); return op==='filter' ? Object.values(USERS).map(clone) : {}; }
  if(!u) throw err(401);
  if(FAIL.missing.has(entity)) throw err(404);
  const db=DBS[app], t=db[entity]=db[entity]||[];
  const def=rulesOf(entity);
  switch(op){
    case 'filter': { const [q,,limit=50,skip=0]=args; return clone(t.filter(r=>cond(def.rls.read,u,r) && Object.entries(q||{}).every(([k,v])=>r[k]===v)).slice(skip,skip+limit)); }
    case 'get': { const r=t.find(x=>x.id===args[0]); if(!r || !cond(def.rls.read,u,r)) throw err(404); return clone(r); }
    case 'create': {
      const rec={...clone(args[0]),created_by:email,created_by_id:u.id};
      if(!cond(def.rls.create,u,rec) || !fieldsAllowed(def,u,Object.fromEntries(Object.entries(args[0]).filter(([,v])=>v!==null && v!==undefined)))) throw err(403);
      const r={...rec,id:'r'+(++seq),created_date:new Date(Date.now()+seq).toISOString()}; t.push(r); return clone(r);
    }
    case 'update': {
      const r=t.find(x=>x.id===args[0]); if(!r) throw err(404);
      if(!cond(def.rls.update,u,r) || !fieldsAllowed(def,u,args[1])) throw err(403);
      Object.assign(r,clone(args[1])); return clone(r);
    }
    case 'delete': { const i=t.findIndex(x=>x.id===args[0]); if(i<0) throw err(404); if(!cond(def.rls.delete,u,t[i])) throw err(403); t.splice(i,1); return {}; }
  }
  throw new Error('op '+op);
}
const SHIM=app=>`window.__EVERCRAFT_BASE44_SDK={createClient(){
  const call=(entity,op,args)=>window.__b44(entity,op,args).then(r=>{ if(r && r.__error!==undefined){ const e=new Error(r.__error ? 'HTTP '+r.__error : 'Network Error'); if(r.__error) e.status=r.__error; throw e;} return r; });
  const entities=new Proxy({},{get:(_,name)=>({filter:(...a)=>call(name,'filter',a), list:(...a)=>call(name,'filter',[{},...a]), get:id=>call(name,'get',[id]),
    create:d=>call(name,'create',[d]), update:(id,d)=>call(name,'update',[id,d]), delete:id=>call(name,'delete',[id]), subscribe:()=>()=>{}})});
  return {entities, auth:{me:()=>call('auth','me',[]), updateMe:d=>call('auth','updateMe',[d]), setToken(){}, redirectToLogin(){}, logout(){}}};
}};`;

async function person(browser, email, app=APP){
  const config={base44AppId:app,base44AppBaseUrl:`https://preview--${app}.base44.app`,base44ServerUrl:`https://preview--${app}.base44.app`};
  const ctx=await browser.newContext({viewport:{width:1300,height:900}});
  const p=await ctx.newPage();
  p.errs=[]; p.on('pageerror',e=>p.errs.push(e.message)); p.on('console',m=>{ if(m.type()==='error') p.errs.push(m.text()); });
  p.on('dialog',d=>d.accept());
  await p.exposeFunction('__b44',(entity,op,args)=>{ try{ return serve(app,email,entity,op,args); }catch(e){ return {__error:e.status===0 ? 0 : (e.status||500)}; } });
  await p.addInitScript(`Object.defineProperty(window,'EVERCRAFT_CONFIG',{configurable:true,set(v){this.__c={...v,...${JSON.stringify(config)}}},get(){return this.__c}});`);
  await p.addInitScript(`if(!localStorage.getItem('base44_access_token@${app}')) localStorage.setItem('base44_access_token@${app}','tok:${email}');`);
  await p.addInitScript(SHIM(app));
  await p.goto(FILE+'#crm');
  await p.waitForFunction(()=>typeof CLOUD!=='undefined' && CLOUD.role && CLOUD.state!=='syncing',null,{timeout:20000});
  return p;
}
const sync=p=>p.evaluate(()=>cloudSync().then(()=>({state:CLOUD.state,message:CLOUD.message})));
const rows=(entity,app=APP)=>(DBS[app][entity]||[]).filter(r=>!r.deletedAt);
// A request straight to the server, as a person (what a modified app or a script could send).
const api=(email,entity,op,...args)=>{ try{ return {ok:true,res:serve(APP,email,entity,op,args)}; }catch(e){ return {ok:false,status:e.status}; } };

(async()=>{
  const b=await launch({config:{base44AppId:APP}});
  const owner=await person(b,'owner@test');
  ok(await owner.evaluate(()=>CLOUD.role)==='owner','the owner is signed in with shared data');

  // ---------- the owner sets up the team, a project, a budget and costs ----------
  const ids=await owner.evaluate(()=>{
    const pr=newProjectRecord({clientName:'TEST Margo Winnetka',stage:'started'}); saveProjects([...loadProjects(),pr]);
    const yura=saveEmployee({name:'Yura',payType:'hourly',userEmail:'yura@test'});
    addEmployeeRate(yura.id,toCents('30'),'', '2026-01-01');
    saveBudget(pr.id,{lines:{materials:toCents('1000'),labor:toCents('2000')},estLaborHours:60});
    const m=addCostEntry({projectId:pr.id,type:'material',description:'TEST primer',quantity:2,estUnitCents:toCents('40'),actUnitCents:toCents('42.5'),date:'2026-10-05'});
    const l=addCostEntry({projectId:pr.id,type:'labor',employeeId:yura.id,costMethod:'hourly',hours:8,date:'2026-10-05'});
    return {project:pr.id,yura:yura.id,material:m.id,labor:l.id};
  });
  let s=await sync(owner);
  ok(s.state==='synced','20. the owner\'s financial records sync without errors');
  ok(rows('Employee').length===1 && rows('EmployeeRate').length===1 && rows('ProjectBudget').length===1 && rows('CostEntry').length===2 && rows('CostApproval').length===2,
    '20. employees, rates, the budget, entries and their approvals are saved in their Base44 tables');
  const mRow=rows('CostEntry').find(r=>r.legacy_id===ids.material);
  ok(mRow.estUnitCents===4000 && mRow.actUnitCents===4250 && Number.isInteger(rows('CostApproval')[0].costCents),'amounts are stored as whole cents');
  ok(rows('FinancialAuditLog').length>=5 && rows('FinancialAuditLog').every(r=>r.created_by==='owner@test'),'the audit log is saved too (Base44 also records who created each row)');

  // ---------- an employee (member) ----------
  const yura=await person(b,'yura@test');
  ok(await yura.evaluate(()=>CLOUD.role)==='member','an employee signs in as a member');
  ok(await yura.evaluate(()=>loadCostEntries().length)===2 && await yura.evaluate(()=>loadApprovals().length)===2 && await yura.evaluate(id=>!!budgetFor(id),ids.project),
    '18. the member gets the project\'s entries, approvals and budget (full project financials, as chosen)');
  ok(await yura.evaluate(()=>loadRates().length)===0 && !calls.some(c=>c.email==='yura@test' && c.entity==='EmployeeRate'),'18. the member never receives the cost rates (the app does not even ask)');
  const yf=await yura.evaluate(id=>{ const f=projectFinancials(id); return {actual:f.actualToDate,labor:f.labor.actualCost}; },ids.project);
  ok(yf.labor===24000 && yf.actual===24000+8500,'the member sees the same approved figures as the owner (from the approvals, without the rates)');
  // the member records hours
  const yEntry=await yura.evaluate(({project,yura})=>addCostEntry({projectId:project,type:'labor',employeeId:yura,costMethod:'hourly',hours:6,date:'2026-10-06'}).id,ids);
  s=await sync(yura);
  const yRow=rows('CostEntry').find(r=>r.legacy_id===yEntry);
  ok(s.state==='synced' && yRow && yRow.created_by==='yura@test' && !rows('CostApproval').some(a=>a.costId===yEntry),'the member\'s entry is saved (created by them) and has no approval');

  // ---------- 18. what the server refuses, whatever the app does ----------
  const ownerEntryRid=rows('CostEntry').find(r=>r.legacy_id===ids.material).id;
  const yRid=yRow.id;
  ok(api('yura@test','CostApproval','create',[{legacy_id:'appr-self',costId:yEntry,decision:'approved',costCents:999999}].flat()[0]).status===403,'18. server: a member cannot create an approval (no approving own costs)');
  ok(api('yura@test','CostEntry','update',ownerEntryRid,{actUnitCents:1}).status===403,'18. server: a member cannot change someone else\'s entry');
  ok(api('yura@test','CostEntry','update',yRid,{hours:7,version:(yRow.version||1)+1}).ok,'18. server: a member can change their own entry');
  ok(api('yura@test','CostEntry','update',yRid,{deletedAt:'2026-10-10'}).status===403 && api('yura@test','CostEntry','delete',yRid).status===403,'18. server: a member cannot delete entries (not even their own)');
  ok(api('yura@test','EmployeeRate','filter',{}).res.length===0 && api('yura@test','EmployeeRate','create',{legacy_id:'r-x',employeeId:ids.yura,rateCents:1,effectiveFrom:'2026-01-01'}).status===403,'18. server: a member can neither read nor set cost rates');
  ok(api('yura@test','ProjectBudget','update',rows('ProjectBudget')[0].id,{lines:{labor:1}}).status===403,'18. server: a member cannot change a budget');
  ok(api('yura@test','Employee','create',{legacy_id:'e-x',name:'Fake'}).status===403,'18. server: a member cannot add people to the team');
  const logRid=rows('FinancialAuditLog')[0].id;
  ok(api('yura@test','FinancialAuditLog','update',logRid,{action:'nothing'}).status===403 && api('mgr@test','FinancialAuditLog','update',logRid,{action:'nothing'}).status===403 && api('mgr@test','FinancialAuditLog','delete',logRid).status===403,
    '11. server: no one but the owner can change or delete the audit log (members and admins are refused)');
  ok(api('mgr@test','CostApproval','update',rows('CostApproval')[0].id,{costCents:1}).status===403,'server: approvals are never changed afterwards (an admin is refused too)');
  ok(api('mgr@test','CostApproval','create',{legacy_id:'appr-m',costId:yEntry,decision:'approved',costCents:1}).ok,'server: an admin can approve');
  DBS[APP].CostApproval=DBS[APP].CostApproval.filter(a=>a.legacy_id!=='appr-m');
  ok(api('out@test','CostEntry','filter',{}).res.length===0 && api('out@test','CostEntry','create',{legacy_id:'c-x',projectId:'x',type:'expense',date:'2026-10-01'}).status===403,'19. server: an account without CRM access sees no financial records and cannot add any');

  // ---------- approval round trip ----------
  s=await sync(owner);
  let st=await owner.evaluate(id=>projectFinancials(loadCostEntries().find(e=>e.id===id).projectId).states.get(id),yEntry);
  ok(st.state==='pending' && st.pending===7*3000,'the owner gets the member\'s entry (7 h after their own change) as pending, priced with the rate');
  await owner.evaluate(id=>setEntryApproval(id,'approved'),yEntry);
  await sync(owner); await sync(yura);
  st=await yura.evaluate(id=>projectFinancials(loadCostEntries().find(e=>e.id===id).projectId).states.get(id),yEntry);
  ok(st.state==='approved' && st.actual===21000,'20. approved by the owner → the member sees it approved ($210)');
  // the member changes it afterwards straight on the server (allowed for own entries): numbers stay
  api('yura@test','CostEntry','update',yRid,{hours:12,version:(rows('CostEntry').find(r=>r.id===yRid).version||1)+1});
  await sync(owner);
  st=await owner.evaluate(id=>projectFinancials(loadCostEntries().find(e=>e.id===id).projectId).states.get(id),yEntry);
  ok(st.state==='changed' && st.actual===21000 && st.pending===5*3000,'a member\'s change to an approved entry does not change the actual cost: $210 stays, +$150 waits for approval');

  // ---------- 21. a failed request is retried without duplicates ----------
  const before=rows('CostEntry').length;
  const e2=await yura.evaluate(({project})=>addCostEntry({projectId:project,type:'expense',category:'fuel',description:'TEST gas',amountCents:4500,date:'2026-10-07'}).id,ids);
  FAIL.netOn={email:'yura@test',entity:'CostEntry',op:'create'};
  s=await sync(yura);
  ok(s.state==='error' && rows('CostEntry').length===before && await yura.evaluate(id=>loadCostEntries().some(e=>e.id===id),e2),'21. the network fails while saving: the entry stays on the device');
  s=await sync(yura);
  ok(s.state==='synced' && rows('CostEntry').filter(r=>r.legacy_id===e2).length===1,'21. the next sync saves it once (no duplicate)');

  // ---------- a table not set up yet does not stop the rest ----------
  FAIL.missing.add('CostApproval');
  await owner.evaluate(id=>updateProject(id,{notes:'TEST synced while a table is missing'}),ids.project);
  s=await sync(owner);
  ok(s.state==='synced' && /CostApproval/.test(s.message) && rows('CrmProject').find(r=>r.legacy_id===ids.project).notes==='TEST synced while a table is missing','a financial table missing in Base44: the CRM still syncs, the note names the table');
  FAIL.missing.clear();

  // ---------- never overwrite newer data ----------
  await sync(owner); await sync(yura);
  await owner.evaluate(id=>updateCostEntry(id,{description:'Gas (owner)'},'typo'),e2);
  await yura.evaluate(id=>updateCostEntry(id,{description:'Gas (yura)'}),e2);
  await sync(owner);
  s=await sync(yura);
  const server=rows('CostEntry').find(r=>r.legacy_id===e2);
  ok(server.description==='Gas (owner)' && await yura.evaluate(id=>loadCostEntries().find(e=>e.id===id).description,e2)==='Gas (owner)' && await yura.evaluate(()=>(readStore(CLOUD_CONFLICTS_KEY,[])||[]).some(c=>c.entity==='CostEntry')),
    '20. changed in two places: the newer saved version is kept, the other is kept as a conflict copy (not lost)');

  // ---------- 19. another company (another Base44 app) ----------
  const other=await person(b,'owner@test',APP2);
  ok(await other.evaluate(()=>loadCostEntries().length+loadEmployees().length+loadBudgets().length)===0 && !(DBS[APP2].CostEntry||[]).length,'19. another company\'s CRM (its own Base44 app) sees none of these financial records');
  ok(await other.evaluate(()=>STORAGE_KEYS.costs.endsWith('@ci-fin-other-company-00000')),'19. each company\'s data is kept apart on the device too');

  const errs=[...owner.errs,...yura.errs,...other.errs].filter(e=>!/HTTP 4\d\d|Network Error/.test(e));
  ok(errs.length===0,'no page errors '+JSON.stringify(errs));
  console.log(`\n${pass} passed, ${fail} failed`); await b.close(); process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(2);});
