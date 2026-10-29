// Project financials (js/finance.js + js/financeui.js): the calculations, approvals, the audit
// log, the Financials tab and the cost entry window. Realistic fixtures, this browser only.
const { launch, FILE, OUT, MODE } = require('../helpers');
let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m);};

(async()=>{
  const b=await launch(); const p=await b.newPage({viewport:{width:1360,height:1000}});
  const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
  let answer=true; const dialogs=[]; let promptValue=null;
  p.on('dialog',d=>{ dialogs.push(d.message()); if(d.type()==='prompt') promptValue===null ? d.dismiss() : d.accept(promptValue); else answer ? d.accept() : d.dismiss(); });
  await p.goto(FILE);
  if(MODE==='shared') await p.evaluate(()=>{ CLOUD.role='owner'; CLOUD.user={email:'owner@evercraft.test'}; });
  const ev=(fn,arg)=>p.evaluate(fn,arg);

  // ---------- 1. money and calculations (pure) ----------
  ok(await ev(()=>[toCents('1.005'),toCents('19.99'),toCents('$1,234.56'),toCents('0.1'),toCents(''),toCents('abc')].join())==='101,1999,123456,10,,',
    'money is converted to whole cents exactly (1.005 → 101, $1,234.56 → 123456, empty / invalid → none)');
  ok(await ev(()=>{ const t=[0.1,0.2].map(v=>toCents(v)).reduce((a,b)=>a+b,0); return t===30 && moneyCents(t)==='$0.30'; }),'no floating-point drift: $0.10 + $0.20 = $0.30');
  const mat=await ev(()=>{ const e=normalizeCostEntry({id:'x',type:'material',quantity:3,estUnitCents:4999,actUnitCents:5250,date:'2026-10-01',description:'Paint'}); return entryCost(e,null); });
  ok(mat.estCents===14997 && mat.actCents===15750,'1. material: estimated total = qty × est. unit ($149.97), actual = qty × actual unit ($157.50)');
  ok(await ev(()=>lineCents(2.5,1999)===4998 && lineCents(1/3,100)===33),'material lines with decimal quantities round once to whole cents');
  const lab=await ev(()=>{
    const m=x=>laborMinutes(normalizeCostEntry({id:'l',type:'labor',costMethod:'hourly',...x}));
    return {a:m({startTime:'07:30',endTime:'16:00',breakMinutes:30}).minutes, night:m({startTime:'22:00',endTime:'02:00'}).minutes, manual:m({hours:7.5}).minutes,
      bigBreak:m({startTime:'08:00',endTime:'09:00',breakMinutes:90}).error, half:m({startTime:'08:00'}).error, none:m({}).error,
      neg:laborMinutes({costMethod:'hourly',hours:-2}).error};
  });
  ok(lab.a===480 && lab.manual===450,'2./3. labor: 7:30–16:00 with a 30 min break = 8 h; typed 7.5 h = 450 min');
  ok(lab.night===240,'3. a shift past midnight (22:00–02:00) = 4 h');
  ok(/longer than the time worked/.test(lab.bigBreak) && /both a start and an end/.test(lab.half) && /Enter the hours/.test(lab.none) && /negative/.test(lab.neg),'3. a break longer than the shift, half a time range, no hours or negative hours are refused');
  ok(await ev(()=>entryCost(normalizeCostEntry({id:'l',type:'labor',costMethod:'hourly',startTime:'07:30',endTime:'16:00',breakMinutes:30}),()=>2800).actCents===22400),
    '2. labor cost = net hours × cost rate (8 h × $28 = $224)');
  ok(await ev(()=>safePct(5,0)===null && pctText(safePct(5,0))==='—' && pctText(safePct(1,3))==='33.3%'),'9./10. a percentage of zero is "—" (never Infinity or NaN)');

  // ---------- fixtures: an estimate, a project, a team ----------
  const ids=await ev(()=>{
    const est={id:'est-fin-1',estimateNumber:'EST-2026-7001',date:'2026-10-01',clientName:'Margo Winnetka',items:[],status:'accepted',
      subtotal:10000,taxAmount:800,customerTotal:10800,categoryTotals:{painting:10000},crmProjectId:'crm-fin-1'};
    saveEstimates([...loadEstimates(),est]);
    const pr=newProjectRecord({clientName:'Margo Winnetka',address:'19802 Bassett St, Winnetka, CA',stage:'started',estimateId:'est-fin-1',estimateNumber:'EST-2026-7001',estimateTotal:10800,
      materials:[{id:'m1',name:'Masking tape',store:'Home Depot',qty:4,unitPrice:6.25}]});
    pr.id='crm-fin-1'; saveProjects([...loadProjects(),pr]);
    const yura=saveEmployee({name:'Yura',payType:'hourly'});
    const kirill=saveEmployee({name:'Kirill',payType:'hourly'});
    const sub=saveEmployee({name:'Stucco Pros LLC',payType:'subcontractor'});
    addEmployeeRate(yura.id,toCents('28'),'', '2026-01-01');
    addEmployeeRate(kirill.id,toCents('22'),'10','2026-01-01');
    return {yura:yura.id,kirill:kirill.id,sub:sub.id,project:'crm-fin-1'};
  });
  const F=()=>ev(id=>{ const f=projectFinancials(id); delete f.states; return f; },ids.project);
  let f=await F();
  ok(f.contract===1000000 && f.revenue===1000000,'the contract is the signed estimate before sales tax ($10,800 − $800 tax = $10,000)');
  ok(f.changeOrders===0 && f.revenue===f.contract+f.changeOrders,'13. adjusted revenue = contract + approved change orders (none yet)');
  ok(f.actualToDate===2500 && f.groups[0].actual===2500,'the project\'s quick Materials list counts as actual material cost (4 × $6.25 = $25)');
  ok(f.forecastMargin!==null && f.estimatedTotalCost===0 && f.alerts.some(a=>/No budget set/.test(a.text)),'without a budget: a clear note instead of variances');

  // budget
  let r=await ev(id=>saveBudget(id,{lines:{materials:toCents('1500'),labor:toCents('3000'),fuel:toCents('200'),other:toCents('300')},estLaborHours:100,forecastRateCents:toCents('30')}),ids.project);
  ok(!r.error && (await F()).estimatedTotalCost===500000,'a budget by category: estimated total cost = $5,000');
  r=await ev(id=>saveBudget(id,{approvedAt:nowISO(),approvedBy:'owner'}),ids.project);
  r=await ev(id=>saveBudget(id,{lines:{materials:toCents('9999')}}),ids.project);
  ok(r.error && /approved budget is kept/.test(r.error),'17. the approved budget cannot be rewritten (changes are adjustments)');
  r=await ev(id=>saveBudget(id,{estLaborHours:120}),ids.project);
  ok(r.error && /reason/.test(r.error),'17. changing the forecast of an approved budget needs a reason');
  r=await ev(id=>saveBudget(id,{estLaborHours:40},'Scope smaller after walkthrough'),ids.project);
  ok(!r.error && r.estLaborHours===40 && r.lines.materials===150000,'17. with a reason the forecast changes; the approved lines stay');
  const blog=await ev(id=>loadFinLog().filter(l=>l.projectId===id && l.recordType==='ProjectBudget').map(l=>l.action+'|'+l.reason),ids.project);
  ok(blog.includes('budget created|') && blog.includes('budget approved|') && blog.includes('budget changed|Scope smaller after walkthrough'),'17. budget history: created, approved and changed (with the reason) are in the log');

  // entries (as owner: approved at once)
  r=await ev(({project,yura})=>addCostEntry({projectId:project,type:'labor',employeeId:yura,costMethod:'hourly',date:'2026-10-05',startTime:'07:30',endTime:'16:00',breakMinutes:30,workCategory:'Prep'}),ids);
  ok(!r.error && r.state==='approved','an owner\'s labor entry is approved at once');
  const appr=await ev(id=>loadApprovals().find(a=>a.costId===id),r.id);
  ok(appr && appr.costCents===22400 && appr.rateCents===2800 && appr.minutes===480 && appr.by,'the approval freezes the cost ($224), the rate ($28/h) and the hours');
  // Kirill: 10% burden → $24.20/h
  await ev(({project,kirill})=>addCostEntry({projectId:project,type:'labor',employeeId:kirill,costMethod:'hourly',date:'2026-10-05',hours:4}),ids);
  await ev(({project})=>addCostEntry({projectId:project,type:'material',description:'SW Duration 5 gal',quantity:3,unit:'gallon',estUnitCents:toCents('80'),actUnitCents:toCents('78.50'),vendor:'Sherwin-Williams',date:'2026-10-04'}),ids);
  await ev(({project})=>addCostEntry({projectId:project,type:'expense',category:'fuel',description:'Gas for the truck',amountCents:toCents('64.20'),date:'2026-10-05'}),ids);
  f=await F();
  ok(f.labor.actualMinutes===720 && f.labor.actualCost===22400+9680,'2. labor: 12 h approved; Kirill\'s rate includes the configured 10% burden ($22 → $24.20/h)');
  ok(f.groups.find(g=>g.key==='materials').actual===2500+23550 && f.groups.find(g=>g.key==='fuel').actual===6420,'5. materials ($25 + $235.50) and fuel ($64.20) add up by category');
  // remaining labor: 40 h − 12 h = 28 h × $30 = $840
  ok(f.labor.remainingMinutes===28*60 && f.labor.remainingCost===84000 && f.labor.forecastAtCompletion===22400+9680+84000,'4. remaining labor: max(0, 40 h − 12 h) × $30 forecast rate = $840; at completion = actual + remaining');
  const sumForecast=f.groups.reduce((t,g)=>t+g.actual+g.pending+g.remaining,0);
  ok(f.forecastTotalCost===sumForecast && f.forecastProfit===f.revenue-f.forecastTotalCost,'7./8. forecast total cost = actual + pending + remaining (all groups); forecast profit = revenue − forecast cost');
  ok(Math.abs(f.forecastMargin-(f.forecastProfit/f.revenue*100))<1e-9,'8. forecast margin = forecast profit ÷ revenue');
  const g=f.groups.find(x=>x.key==='materials');
  ok(g.variance===g.current-g.forecast && Math.abs(g.variancePct-(g.variance/g.current*100))<1e-9,'Estimate vs Actual: variance = current budget − forecast total; % of the current budget');
  const eq=f.groups.find(x=>x.key==='equipment');
  ok(eq.current===0 && eq.variancePct===null,'10. a category with no budget: variance % is "—"');

  // ---------- approvals: pending, rejected, changed after approval ----------
  await ev(()=>{ SETTINGS.finAutoApprove='no'; });
  const pend=await ev(({project})=>addCostEntry({projectId:project,type:'expense',category:'equipment',description:'Scaffold rental',amountCents:toCents('150'),date:'2026-10-06'}),ids);
  const rej=await ev(({project})=>addCostEntry({projectId:project,type:'expense',category:'parking',description:'Parking ticket',amountCents:toCents('75'),date:'2026-10-06'}),ids);
  await ev(()=>{ SETTINGS.finAutoApprove=''; });
  f=await F();
  ok(pend.state==='pending' && f.pending===15000+7500 && f.groups.find(x=>x.key==='equipment').actual===0,'11. pending entries are not actual cost; they show as pending and count in the forecast');
  await ev(id=>setEntryApproval(id,'rejected','Personal ticket, not a job cost'),rej.id);
  f=await F();
  ok(f.pending===15000 && f.groups.find(x=>x.key==='fuel').actual===6420,'12. a rejected entry counts nowhere');
  ok(await ev(id=>loadCostEntries().some(e=>e.id===id),rej.id),'12. a rejected entry stays visible (never deleted)');
  await ev(id=>setEntryApproval(id,'approved'),pend.id);
  f=await F();
  ok(f.groups.find(x=>x.key==='equipment').actual===15000 && f.pending===0,'11. once approved it becomes actual cost');

  // rate changes later do not change approved entries
  await ev(({yura})=>addEmployeeRate(yura,toCents('35'),'', '2026-10-01'),ids);
  f=await F();
  ok(f.labor.actualCost===22400+9680,'a new cost rate does not change entries already approved');

  // ---------- duplicates ----------
  const dup=await ev(({project,yura})=>findDuplicateEntry(normalizeCostEntry({id:'new',projectId:project,type:'labor',employeeId:yura,costMethod:'hourly',date:'2026-10-05',startTime:'15:00',endTime:'18:00'})),ids);
  ok(dup && /overlaps 07:30–16:00/.test(dup.reason),'14. a labor entry overlapping hours already recorded for the same person is caught');
  const dup2=await ev(({project})=>findDuplicateEntry(normalizeCostEntry({id:'new',projectId:project,type:'expense',category:'fuel',description:'gas for the truck',amountCents:6420,date:'2026-10-05'})),ids);
  ok(dup2 && /same item and amount/.test(dup2.reason),'14. the same expense twice on the same day is caught');
  const nodup=await ev(({project})=>findDuplicateEntry(normalizeCostEntry({id:'new',projectId:project,type:'expense',category:'fuel',description:'Gas for the truck',amountCents:6420,date:'2026-10-07'})),ids);
  ok(nodup===null,'14. the same expense on another day is fine');

  // ---------- audit log ----------
  const log=await ev(id=>loadFinLog().filter(l=>l.projectId===id),ids.project);
  ok(log.some(l=>l.action==='created' && l.recordType==='CostEntry') && log.some(l=>l.action==='rejected' && l.reason==='Personal ticket, not a job cost') && log.some(l=>l.action==='approved'),'audit log: created, approved and rejected (with the reason)');
  ok(log.every(l=>l.actor && l.at && l.recordId),'audit log: every change has who, when and which record');

  // ---------- the Financials tab ----------
  await ev(()=>showPage('crm'));
  await p.click('#btnNewLead');
  ok(await p.isHidden('#pmTabs'),'a new lead (not saved yet) has no Financials tab');
  await p.click('[data-close=projectModal]');
  await ev(id=>openProjectModal(id),ids.project);
  ok(await p.isVisible('#pmTabs') && await p.isVisible('#pmClientName'),'a saved project opens on its Project tab, with a Financials tab');
  await p.click('[data-pm-tab=financials]');
  ok(await p.isVisible('#pmFinancials') && await p.isHidden('#pmClientName') && await p.isHidden('#projectForm button[type=submit]'),'Financials tab: the project form (and its Save) is hidden; entries save by themselves');
  const kpi=await p.innerText('#pmFinancials .fin-kpis');
  f=await F();
  ok(kpi.includes('$10,000.00') && kpi.includes('EST-2026-7001') && kpi.includes(await ev(c=>moneyCents(c),f.forecastProfit)) && kpi.includes(await ev(m=>pctText(m),f.forecastMargin)),'Financial Overview shows contract, forecast profit and margin from the same calculation');
  ok(kpi.includes('Budget') && kpi.includes('Actual') && kpi.includes('Forecast') && !kpi.includes('Final Actual Profit'),'Budget, Actual and Forecast are labeled apart; no "final" figures while the project is open');
  ok((await p.getAttribute('.fin-kpi-forecast','title')).includes('Forecast'),'each figure has an explanation (tooltip)');
  ok((await p.innerText('#pmFinancials .fin-table tfoot')).includes(await ev(c=>moneyCents(c),f.forecastTotalCost)),'Estimate vs. Actual has the project total');
  await p.screenshot({path:OUT+'/financials.png',fullPage:false});
  // open a category
  await p.click('#pmFinancials tr[data-fin-group=fuel]');
  let rows=await p.locator('#pmFinancials .fin-ledger tbody tr').count();
  ok(rows===2 && (await p.inputValue('[data-fin-filter=group]'))==='fuel','clicking a category shows its entries (fuel + the rejected parking ticket)');
  await p.selectOption('[data-fin-filter=status]','rejected');
  rows=await p.locator('#pmFinancials .fin-ledger tbody tr').count();
  ok(rows===1 && (await p.innerText('#pmFinancials .fin-ledger')).includes('Parking ticket'),'filter by approval status');
  await p.click('[data-fin-action=clear-filters]');
  await p.selectOption('[data-fin-filter=employee]',ids.kirill);
  ok(await p.locator('#pmFinancials .fin-ledger tbody tr').count()===1,'filter by employee');
  await p.fill('[data-fin-filter=from]','2026-10-06'); await p.dispatchEvent('[data-fin-filter=from]','change');
  ok(await p.locator('#pmFinancials .fin-ledger tbody tr').count()===0 && (await p.innerText('#pmFinancials')).includes('match the filters'),'filter by date');
  await p.click('[data-fin-action=clear-filters]');

  // quick add: material, with the live total
  await p.click('[data-fin-add=material]');
  await p.fill('#ceDescription','Drywall mud'); await p.fill('#ceQty','2'); await p.fill('#ceEstUnit','18'); await p.fill('#ceActUnit','21.49');
  ok((await p.textContent('#cePreview')).includes('Estimated total $36.00') && (await p.textContent('#cePreview')).includes('Actual total $42.98') && (await p.textContent('#cePreview')).includes('Variance −$6.98'),'the material window shows estimated, actual and variance while typing');
  await p.click('#ceSave');
  await p.waitForFunction(()=>!$('costEntryModal').classList.contains('open'));
  ok((await p.innerText('#pmFinancials')).includes('Drywall mud') && (await p.innerText('#pmFinancials')).includes('over'),'the material appears at once, marked over budget');
  // validation
  await p.click('[data-fin-add=expense]');
  await p.click('#ceSave');
  ok(await p.isVisible('#costEntryModal') && /description/.test(await p.textContent('#ceStatus')) && /amount/.test(await p.textContent('#ceStatus')),'an empty expense is refused with what is missing');
  // duplicate warning (declined)
  await p.selectOption('#ceCategory','fuel'); await p.fill('#ceDescription','Gas for the truck'); await p.fill('#ceAmount','64.20'); await p.fill('#ceDate','2026-10-05');
  const before=await ev(()=>loadCostEntries().length);
  answer=false; await p.click('#ceSave'); answer=true;
  ok(dialogs.at(-1).includes('duplicate') && await ev(()=>loadCostEntries().length)===before && await p.isVisible('#costEntryModal'),'14. saving a duplicate asks first; "No" saves nothing');
  // double submit
  await p.fill('#ceDate','2026-10-07');
  await ev(()=>{ $('ceSave').click(); $('ceSave').click(); $('costEntryForm').requestSubmit(); });
  await p.waitForTimeout(200);
  ok(await ev(()=>loadCostEntries().length)===before+1,'14. clicking Save several times quickly saves one entry');
  // labor window: start/end/break
  await p.click('[data-fin-add=labor]');
  await p.selectOption('#ceEmployee',ids.kirill); await p.fill('#ceDate','2026-10-07'); await p.fill('#ceStart','08:00'); await p.fill('#ceEnd','12:30'); await p.fill('#ceBreak','30');
  ok((await p.textContent('#cePreview')).includes('Net hours 4 h') && (await p.textContent('#cePreview')).includes('$96.80') && await p.isDisabled('#ceHours'),'the labor window: net hours from start / end / break, the cost with the rate (managers only)');
  await p.click('#ceSave'); await p.waitForFunction(()=>!$('costEntryModal').classList.contains('open'));
  // approved entry edit needs a reason
  const labId=await ev(()=>loadCostEntries().find(e=>e.startTime==='08:00' && e.endTime==='12:30').id);
  await p.click(`tr[data-entry="${labId}"] [data-fin-entry=edit]`);
  ok(await p.isVisible('#ceReasonRow'),'editing an approved entry asks for a reason');
  await p.fill('#ceEnd','13:00'); await p.click('#ceSave');
  ok(/reason/.test(await p.textContent('#ceStatus')),'… and refuses without one');
  await p.fill('#ceReason','Left later than written'); await p.click('#ceSave'); await p.waitForFunction(()=>!$('costEntryModal').classList.contains('open'));
  const ed=await ev(id=>{ const a=loadApprovals().filter(x=>x.costId===id); return {n:a.length,last:a.at(-1).costCents}; },labId);
  ok(ed.n===2 && ed.last===Math.round(270*2420/60),'with a reason the owner\'s change is approved again with the new hours (logged)');
  // void
  promptValue='Entered on the wrong job';
  await p.click(`tr[data-entry="${labId}"] [data-fin-entry=void]`);
  promptValue=null;
  const vs=await ev(id=>{ const f=projectFinancials('crm-fin-1'); return f.states.get(id).state; },labId);
  ok(vs==='void' && (await p.locator(`tr[data-entry="${labId}"].fin-row-out`).count())===1,'voiding keeps the entry (crossed out) and stops it counting');

  // ---------- member: own entries wait; approval snapshot keeps the numbers ----------
  if(MODE==='shared'){
    await ev(()=>{ CLOUD.role='member'; CLOUD.user={email:'yura@evercraft.test'}; });
    await ev(id=>openProjectModal(id),ids.project);
    await p.click('[data-pm-tab=financials]');
    ok(await p.locator('[data-fin-entry=approve]').count()===0 && await p.locator('.fin-budget').count()===0,'18. a member sees the financials but no Approve buttons and no budget editor');
    const memberCost=await ev(()=>projectFinancials('crm-fin-1').labor.actualCost);
    ok(memberCost>0,'18. a member sees approved labor cost (they have full project financials, as chosen)');
    await p.click('[data-fin-add=labor]');
    await p.selectOption('#ceEmployee',ids.yura); await p.fill('#ceDate','2026-10-08'); await p.fill('#ceHours','6');
    ok(!(await p.textContent('#cePreview')).includes('$'),'18. a member is not shown cost rates in the labor window');
    await p.click('#ceSave'); await p.waitForFunction(()=>!$('costEntryModal').classList.contains('open'));
    const mine=await ev(()=>loadCostEntries().find(e=>e.createdBy==='yura@evercraft.test'));
    let st=await ev(id=>projectFinancials('crm-fin-1').states.get(id),mine.id);
    ok(st.state==='pending' && (await p.innerText(`tr[data-entry="${mine.id}"]`)).includes('after approval'),'18. a member\'s entry waits for approval; its cost shows after approval');
    ok(await ev(()=>!$('financeCard') || (showPage('settings'),$('financeCard').hidden)),'18. a member does not see Team & Labor Cost Rates in Settings');
    ok(await ev(id=>setEntryApproval(id,'approved').error || '',mine.id)!=='' ,'18. a member cannot approve (even through the app\'s functions)');
    // owner approves; member then edits own approved entry? not allowed in the app
    await ev(()=>{ CLOUD.role='owner'; CLOUD.user={email:'owner@evercraft.test'}; });
    await ev(id=>setEntryApproval(id,'approved'),mine.id);
    const approvedCost=await ev(id=>projectFinancials('crm-fin-1').states.get(id).actual,mine.id);
    ok(approvedCost===6*60*3500/60,'after approval the member\'s 6 h count with the rate of that day ($35)');
    // someone changes the approved entry outside the rules (e.g. directly in Base44): the approved amount stays
    await ev(id=>{ const l=JSON.parse(localStorage.getItem(STORAGE_KEYS.costs)); l.find(e=>e.id===id).hours=10; localStorage.setItem(STORAGE_KEYS.costs,JSON.stringify(l)); },mine.id);
    st=await ev(id=>projectFinancials('crm-fin-1').states.get(id),mine.id);
    ok(st.state==='changed' && st.actual===approvedCost && st.pending===4*3500,'a change after approval does not change the actual cost: the approved $210 stays, +$140 waits for approval');
    await ev(()=>{ CLOUD.role=''; CLOUD.user=null; });
    await p.click('[data-close=projectModal]');
    await ev(()=>{ CLOUD.role='owner'; CLOUD.user={email:'owner@evercraft.test'}; });
  }

  // ---------- closing: final figures ----------
  promptValue='Project completed';
  await ev(()=>showPage('crm'));
  await ev(id=>openProjectModal(id),ids.project);
  await p.click('[data-pm-tab=financials]');
  await p.click('.fin-budget summary');
  await p.click('[data-fin-action=close]');
  promptValue=null;
  f=await F();
  ok(f.closed && f.groups.every(x=>x.remaining===0) && f.finalProfit===f.revenue-f.actualToDate && Math.abs(f.finalMargin-f.finalProfit/f.revenue*100)<1e-9,'closed: nothing remaining; final profit = revenue − approved actual costs; final margin');
  const kpi2=await p.innerText('#pmFinancials .fin-kpis');
  ok(kpi2.includes('Final Actual Profit') && kpi2.includes('Final Actual Margin') && kpi2.includes('Forecast Profit'),'closed: Final Actual figures are shown, apart from the forecast');
  ok((await ev(()=>{ const f=computeProjectFinancials({estimate:null,entries:[],approvals:[],budget:{lines:{},closedAt:nowISO(),estLaborHours:null,forecastRateCents:null},settings:SETTINGS}); return [f.revenue,f.finalProfit,f.finalMargin,f.forecastMargin]; })).join()==='0,0,,','9. zero revenue: margins are empty, never NaN or Infinity');

  // ---------- the log on screen, phone ----------
  await p.click('.fin-log summary');
  const logText=await p.innerText('.fin-log');
  ok(logText.includes('project closed') && logText.includes('Personal ticket') && logText.includes('before:'),'the Financial Activity Log shows the changes with before / after and reasons');
  await p.setViewportSize({width:390,height:844});
  await p.waitForTimeout(200);
  ok(await ev(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'phone: the Financials tab fits the screen (wide tables scroll inside their box)');
  await p.screenshot({path:OUT+'/financials-phone.png'});
  await p.setViewportSize({width:1360,height:1000});
  await p.click('[data-close=projectModal]');

  // ---------- Settings: team and rates ----------
  await ev(()=>showPage('settings'));
  ok(await p.isVisible('#financeCard') && (await p.innerText('#finTeamBody')).includes('Yura') && (await p.innerText('#finTeamBody')).includes('$35.00/h'),'Settings: the team with the latest cost rate');
  await p.fill('#finNewName','Nikita'); await p.fill('#finNewRate','26'); await p.click('#btnFinAddPerson');
  ok(await ev(()=>{ const e=loadEmployees().find(x=>x.name==='Nikita'); return !!e && laborRateOn(e.id,localISODate())===2600; }),'adding a person with a rate');
  await p.fill('#finNewName','nikita'); await p.click('#btnFinAddPerson');
  ok(dialogs.at(-1).includes('already on the team'),'the same name twice is refused');
  await p.fill('#setFinWarn','85'); await p.click('#financeCard button[type=submit]');
  ok(await ev(()=>SETTINGS.finWarnPct==='85' && CLOUD_SETTINGS_EXTRA.includes('finWarnPct')),'the warning threshold is a setting (shared with the team)');

  ok(errs.length===0,'no page errors '+JSON.stringify(errs));
  console.log(`\n${pass} passed, ${fail} failed`); await b.close(); process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(2);});
