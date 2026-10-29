"use strict";

/* Project financials (job costing): the data and the ONE place where every financial number is
   calculated. The screens (financeui.js) and the reports only show what computeProjectFinancials()
   returns, so the same figure is never worked out in two slightly different ways.

   Money is kept in integer cents (no floating-point drift); quantities and hours may have decimals,
   and each line is rounded to whole cents once.

   Records (each list syncs to its own Base44 table, see CLOUD_LISTS in cloud.js):
     costs     CostEntry          one ledger for every cost: material, labor, expense
     approvals CostApproval       an owner's / admin's decision on an entry, with the approved cost
                                  (only managers can create these, so no one approves their own costs)
     employees Employee           the crew, including people without a CRM login
     rates     EmployeeRate       cost rates per employee, by date (owners/admins only)
     budgets   ProjectBudget      the approved budget of a project, its forecast inputs, closing
     finlog    FinancialAuditLog  who changed what, when, from what to what (append only)

   Counting rules (no double counting):
   - Actual cost to date = what managers approved, as approved (the approval keeps the amount). An
     entry changed after its approval keeps counting as approved until the change is approved; the
     difference shows as pending. Pending entries are part of the forecast; rejected and voided
     entries count nowhere (they stay visible).
   - A labor entry is either hourly (hours x the employee's cost rate on that day, frozen in the
     approval) or a fixed / subcontract amount, never both.
   - The project's quick Materials list (on the Project tab) counts as approved actual material
     cost; the Financials ledger is a separate list, so an item belongs in one of them.
   - Contract revenue is the signed estimate before sales tax (the tax is not company income). */

const COST_TYPES = [
  {key:"material", label:"Material"},
  {key:"labor", label:"Labor"},
  {key:"expense", label:"Expense"}
];

// Budget groups: the rows of Estimate vs. Actual.
const BUDGET_GROUPS = [
  {key:"materials", label:"Materials"},
  {key:"labor", label:"Labor"},
  {key:"fuel", label:"Fuel / Transportation"},
  {key:"equipment", label:"Equipment Rental"},
  {key:"subcontractors", label:"Subcontractors"},
  {key:"advertising", label:"Advertising Allocation"},
  {key:"other", label:"Other Expenses"}
];

const COST_CATEGORIES = [
  {key:"materials", label:"Materials", group:"materials"},
  {key:"labor", label:"Labor", group:"labor"},
  {key:"fuel", label:"Fuel / Gas", group:"fuel"},
  {key:"transport", label:"Transportation", group:"fuel"},
  {key:"parking", label:"Parking / Tolls", group:"fuel"},
  {key:"equipment", label:"Equipment Rental", group:"equipment"},
  {key:"subcontractor", label:"Subcontractors", group:"subcontractors"},
  {key:"advertising", label:"Advertising", group:"advertising"},
  {key:"permits", label:"Permits", group:"other"},
  {key:"waste", label:"Waste Disposal", group:"other"},
  {key:"delivery", label:"Delivery", group:"other"},
  {key:"repairs", label:"Repairs", group:"other"},
  {key:"other", label:"Other", group:"other"}
];
const EXPENSE_CATEGORIES = COST_CATEGORIES.filter(c=>!["materials","labor"].includes(c.key));

const COST_CLASSIFICATIONS = [
  {key:"direct", label:"Direct Project Cost"},
  {key:"overhead", label:"Company Overhead"},
  {key:"allocated", label:"Allocated Overhead"}
];

const MATERIAL_UNITS = [
  {key:"each", label:"Each"},
  {key:"gallon", label:"Gallon"},
  {key:"sqft", label:"Square foot"},
  {key:"lnft", label:"Linear foot"},
  {key:"box", label:"Box"},
  {key:"hour", label:"Hour"},
  {key:"other", label:"Other"}
];

const LABOR_METHODS = [
  {key:"hourly", label:"Hourly (hours × cost rate)"},
  {key:"fixed", label:"Fixed price"},
  {key:"subcontract", label:"Subcontractor"}
];

const PAY_TYPES = [
  {key:"hourly", label:"Hourly"},
  {key:"salary", label:"Salaried"},
  {key:"fixed", label:"Fixed price per job"},
  {key:"subcontractor", label:"Subcontractor"}
];

const APPROVAL_STATUSES = [
  {key:"pending", label:"Pending"},
  {key:"approved", label:"Approved"},
  {key:"rejected", label:"Rejected"},
  {key:"changed", label:"Changed, waiting"},
  {key:"void", label:"Void"}
];

const MAX_CENTS = 1e11;        // $1 billion
const MAX_ENTRY_HOURS = 24;    // one labor entry is one day's work

const labelOf=(list,key)=>(list.find(x=>x.key===key) || {}).label || "";
const costCategory=key=>COST_CATEGORIES.find(c=>c.key===key) || COST_CATEGORIES[COST_CATEGORIES.length-1];

/* ---------- money in cents ---------- */

// "12.345" / 12.345 → 1235 cents (half up, from the decimal digits, so 1.005 → 101 exactly);
// empty or invalid → null.
function toCents(value){
  if(value===null || value===undefined || String(value).trim()==="") return null;
  let t=String(value).replace(/[$,\s]/g,"");
  if(/e/i.test(t)){ const n=Number(t); if(!Number.isFinite(n)) return null; t=n.toFixed(6); }
  const m=t.match(/^(-?)(\d*)(?:\.(\d*))?$/);
  if(!m || (m[2]==="" && !m[3])) return null;
  const frac=(m[3] || "").padEnd(3,"0");
  let cents=Number(m[2] || "0")*100+Number(frac.slice(0,2));
  if(Number(frac[2])>=5) cents+=1;
  if(Math.abs(cents)>MAX_CENTS) return null;
  return m[1] ? -cents : cents;
}

const centsOrNull=v=>{
  if(v===null || v===undefined || v==="") return null;
  const n=Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(-MAX_CENTS,Math.min(MAX_CENTS,n)) : null;
};

function centsToInput(c){ return c===null || c===undefined ? "" : (c/100).toFixed(2); }

function moneyCents(c){
  if(c===null || c===undefined || !Number.isFinite(c)) return "—";
  return (c<0 ? "−" : "")+money(Math.abs(c)/100);
}

// Percentage or "—" (never Infinity / NaN).
function pctText(p, digits=1){
  return p===null || p===undefined || !Number.isFinite(p) ? "—" : `${p.toFixed(digits)}%`;
}

// a / b as a percentage, or null when b is 0 (zero revenue, zero budget).
function safePct(a, b){
  return b ? a/b*100 : null;
}

// qty × unit cents, rounded once to whole cents.
function lineCents(qty, unitCents){
  if(unitCents===null || unitCents===undefined) return null;
  return Math.round(num(qty)*unitCents);
}

/* ---------- time ---------- */

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMinutes=t=>{ const [h,m]=t.split(":").map(Number); return h*60+m; };

// Worked minutes of a labor entry: end − start − break (over midnight allowed), or the hours typed in.
// {minutes} or {error}.
function laborMinutes(e){
  if(e.costMethod && e.costMethod!=="hourly") return {minutes:e.hours!=="" && e.hours!=null ? Math.round(num(e.hours)*60) : 0};
  const brk=Math.round(num(e.breakMinutes));
  if(brk<0) return {error:"The break cannot be negative."};
  if(e.startTime || e.endTime){
    if(!TIME_RE.test(e.startTime || "") || !TIME_RE.test(e.endTime || "")) return {error:"Enter both a start and an end time (or the total hours)."};
    let span=toMinutes(e.endTime)-toMinutes(e.startTime);
    if(span<=0) span+=1440; // worked past midnight
    const minutes=span-brk;
    if(minutes<=0) return {error:"The break is longer than the time worked."};
    return {minutes};
  }
  if(e.hours===null || e.hours===undefined || e.hours==="") return {error:"Enter the hours worked, or the start and end time."};
  const h=Number(e.hours);
  if(!Number.isFinite(h) || h<0) return {error:"Hours cannot be negative."};
  return {minutes:Math.round(h*60)};
}

const hoursText=min=>min===null || min===undefined ? "—" : formatQty(Math.round(min/60*100)/100)+" h";

/* ---------- records ---------- */

function normalizeCostEntry(e){
  const type=COST_TYPES.some(t=>t.key===e.type) ? e.type : "expense";
  const category=type==="material" ? "materials" : type==="labor" ? (e.costMethod==="subcontract" ? "subcontractor" : "labor")
    : (EXPENSE_CATEGORIES.some(c=>c.key===e.category) ? e.category : "other");
  const str=(v,max=500)=>String(v ?? "").slice(0,max);
  return {
    id:String(e.id),
    projectId:str(e.projectId,100),
    type,
    category,
    classification:COST_CLASSIFICATIONS.some(c=>c.key===e.classification) ? e.classification : "direct",
    description:str(e.description,1000),
    vendor:str(e.vendor,200),
    date:/^\d{4}-\d{2}-\d{2}$/.test(e.date) ? e.date : "",
    // material
    quantity:e.quantity===null || e.quantity===undefined || e.quantity==="" ? null : amount(e.quantity),
    unit:MATERIAL_UNITS.some(u=>u.key===e.unit) ? e.unit : "each",
    unitOther:str(e.unitOther,40),
    estUnitCents:centsOrNull(e.estUnitCents),
    actUnitCents:centsOrNull(e.actUnitCents),
    // labor
    employeeId:str(e.employeeId,100),
    costMethod:LABOR_METHODS.some(m=>m.key===e.costMethod) ? e.costMethod : "hourly",
    startTime:TIME_RE.test(e.startTime || "") ? e.startTime : "",
    endTime:TIME_RE.test(e.endTime || "") ? e.endTime : "",
    breakMinutes:Math.max(0,Math.round(num(e.breakMinutes))),
    hours:e.hours===null || e.hours===undefined || e.hours==="" ? null : amount(e.hours),
    workCategory:str(e.workCategory,100),
    // expense / fixed / subcontract
    amountCents:centsOrNull(e.amountCents),
    status:e.status==="void" ? "void" : "active",
    voidReason:str(e.voidReason,500),
    receiptPhotoId:str(e.receiptPhotoId,100),
    notes:str(e.notes,2000),
    createdBy:str(e.createdBy,200),
    createdAt:e.createdAt || nowISO(),
    updatedAt:e.updatedAt || e.createdAt || nowISO()
  };
}

// A manager's decision on an entry. contentHash: the entry as it was decided on; costCents and
// minutes: what it counts for (the hourly rate is frozen in rateCents).
function normalizeApproval(a){
  return {
    id:String(a.id),
    costId:String(a.costId ?? ""),
    projectId:String(a.projectId ?? ""),
    decision:a.decision==="rejected" ? "rejected" : "approved",
    contentHash:String(a.contentHash ?? ""),
    costCents:Math.round(num(a.costCents)),
    estCents:a.estCents===null || a.estCents===undefined || a.estCents==="" ? null : Math.round(num(a.estCents)),
    minutes:Math.max(0,Math.round(num(a.minutes))),
    group:BUDGET_GROUPS.some(g=>g.key===a.group) ? a.group : "other",
    rateCents:centsOrNull(a.rateCents),
    reason:String(a.reason ?? "").slice(0,500),
    by:String(a.by ?? ""),
    at:String(a.at || nowISO())
  };
}

function normalizeEmployee(e){
  return {
    id:String(e.id),
    name:String(e.name ?? "").slice(0,120),
    payType:PAY_TYPES.some(t=>t.key===e.payType) ? e.payType : "hourly",
    userEmail:String(e.userEmail ?? "").trim().toLowerCase().slice(0,200),
    active:e.active!==false,
    createdAt:e.createdAt || nowISO(),
    updatedAt:e.updatedAt || e.createdAt || nowISO()
  };
}

function normalizeRate(r){
  return {
    id:String(r.id),
    employeeId:String(r.employeeId ?? ""),
    rateCents:Math.max(0,centsOrNull(r.rateCents) || 0),
    burdenPercent:Math.min(200,amount(r.burdenPercent)),
    effectiveFrom:/^\d{4}-\d{2}-\d{2}$/.test(r.effectiveFrom) ? r.effectiveFrom : "2000-01-01",
    createdBy:String(r.createdBy ?? ""),
    createdAt:r.createdAt || nowISO()
  };
}

function normalizeBudget(b){
  const lines={};
  for(const g of BUDGET_GROUPS){
    const v=b.lines && b.lines[g.key];
    lines[g.key]=v===null || v===undefined || v==="" ? 0 : Math.max(0,centsOrNull(v) || 0);
  }
  return {
    id:String(b.id),
    projectId:String(b.projectId ?? ""),
    lines,
    estLaborHours:b.estLaborHours===null || b.estLaborHours===undefined || b.estLaborHours==="" ? null : amount(b.estLaborHours),
    forecastRateCents:centsOrNull(b.forecastRateCents),
    approvedAt:String(b.approvedAt ?? ""),
    approvedBy:String(b.approvedBy ?? ""),
    closedAt:String(b.closedAt ?? ""),
    closedBy:String(b.closedBy ?? ""),
    createdAt:b.createdAt || nowISO(),
    updatedAt:b.updatedAt || b.createdAt || nowISO()
  };
}

function normalizeLogEntry(l){
  return {
    id:String(l.id),
    at:String(l.at || nowISO()),
    actor:String(l.actor ?? ""),
    projectId:String(l.projectId ?? ""),
    recordType:String(l.recordType ?? ""),
    recordId:String(l.recordId ?? ""),
    action:String(l.action ?? ""),
    before:String(l.before ?? ""),
    after:String(l.after ?? ""),
    reason:String(l.reason ?? "")
  };
}

const finList=(key,norm)=>{ const l=readStore(key,[]); return Array.isArray(l) ? l.filter(r=>r && r.id).map(norm) : []; };
function loadCostEntries(){ return finList(STORAGE_KEYS.costs,normalizeCostEntry); }
function loadApprovals(){ return finList(STORAGE_KEYS.approvals,normalizeApproval); }
function loadEmployees(){ return finList(STORAGE_KEYS.employees,normalizeEmployee); }
function loadRates(){ return finList(STORAGE_KEYS.rates,normalizeRate); }
function loadBudgets(){ return finList(STORAGE_KEYS.budgets,normalizeBudget); }
function loadFinLog(){ return finList(STORAGE_KEYS.finlog,normalizeLogEntry); }

function budgetFor(projectId){
  return loadBudgets().find(b=>b.projectId===projectId) || null;
}

/* ---------- who may do what ---------- */
// Mirrors the Base44 rules (docs/base44-finance-entities.json), which are what really protects the
// data; the app only hides what the server would refuse. Without shared data: everything.

function finRole(){
  if(!(typeof cloudActive==="function" && cloudActive())) return "owner";
  return CLOUD.role || "";
}
function finIsManager(){ return ["owner","admin"].includes(finRole()); }
function finCanView(){ return ["owner","admin","member"].includes(finRole()); }
function finActor(){
  return (typeof CLOUD!=="undefined" && CLOUD.user && CLOUD.user.email) ? String(CLOUD.user.email).toLowerCase() : "this device";
}
// Members change only their own entries that are not approved; managers change any (with a
// reason once approved). The approval records keep the numbers safe either way.
function finCanEdit(e, approvals=loadApprovals()){
  if(e.status==="void") return false;
  if(finIsManager()) return true;
  return finCanView() && e.createdBy===finActor() && entryState(e,approvals).state!=="approved";
}

/* ---------- labor cost rates ---------- */

// The employee's cost rate on a date (latest rate effective that day), with the labor burden
// (payroll taxes, benefits) only when one is configured. Null when no rate is set.
function laborRateOn(employeeId, date, rates=loadRates()){
  const list=rates.filter(r=>r.employeeId===employeeId && r.effectiveFrom<=(date || "9999-12-31"))
    .sort((a,b)=>a.effectiveFrom.localeCompare(b.effectiveFrom) || a.createdAt.localeCompare(b.createdAt));
  const r=list[list.length-1];
  if(!r) return null;
  const burden=r.burdenPercent || amount(SETTINGS.finBurdenPercent);
  return Math.round(r.rateCents*(100+burden)/100);
}

/* ---------- one entry ---------- */

// The cost of one entry: {estCents, actCents, minutes, rateMissing, actMissing}.
// rateFor(employeeId, date) gives a rate for hourly entries not approved yet (managers only).
function entryCost(e, rateFor){
  if(e.type==="material"){
    const est=lineCents(e.quantity,e.estUnitCents);
    const act=lineCents(e.quantity,e.actUnitCents);
    return {estCents:est, actCents:act===null ? 0 : act, actMissing:act===null, minutes:null};
  }
  if(e.type==="labor"){
    const lm=laborMinutes(e);
    const minutes=lm.error ? 0 : lm.minutes;
    if(e.costMethod!=="hourly") return {estCents:null, actCents:e.amountCents || 0, actMissing:e.amountCents===null, minutes};
    const rate=rateFor ? rateFor(e.employeeId,e.date) : null;
    // No rate: managers are told to set one; for others the cost shows once a manager approves.
    if(rate===null || rate===undefined) return {estCents:null, actCents:0, rateMissing:!!rateFor, costHidden:!rateFor, minutes};
    return {estCents:null, actCents:Math.round(minutes*rate/60), minutes};
  }
  return {estCents:null, actCents:e.amountCents || 0, actMissing:e.amountCents===null, minutes:null};
}

// The money fields of an entry: an approval is for exactly these.
function entryContentHash(e){
  const {id, createdBy, createdAt, updatedAt, notes, vendor, description, workCategory, receiptPhotoId, voidReason, unitOther, ...money}=e;
  return calendarHash(money);
}

// What an entry counts for now, from its latest approval:
//   {state: pending | approved | rejected | changed | void, actual, pending, minutesActual,
//    minutesPending, group, approval}
// changed: edited (or voided) after it was approved; the approved amount still counts as actual
// and the difference waits for approval.
function entryState(e, approvals, rateFor){
  const mine=approvals.filter(a=>a.costId===e.id).sort((a,b)=>a.at.localeCompare(b.at));
  const last=mine[mine.length-1] || null;
  const group=costCategory(e.category).group;
  const cur=entryCost(e,rateFor);
  const live=e.status!=="void";
  const curCost=live ? cur.actCents : 0, curMin=live ? (cur.minutes || 0) : 0;
  const hourly=e.type==="labor" && e.costMethod==="hourly";
  const base={group, approval:last, cost:cur, actual:0, pending:0, minutesActual:0, minutesPending:0};
  const same=last && last.contentHash===entryContentHash(e);
  if(!last) return live ? {...base, state:"pending", pending:curCost, minutesPending:hourly ? curMin : 0} : {...base, state:"void"};
  if(same){
    if(last.decision==="rejected") return {...base, state:live ? "rejected" : "void"};
    return live ? {...base, state:"approved", actual:last.costCents, minutesActual:last.minutes} : {...base, state:"void"};
  }
  if(last.decision==="rejected") return live ? {...base, state:"pending", pending:curCost, minutesPending:hourly ? curMin : 0} : {...base, state:"void"};
  // Changed after approval: the approved amount stays actual until the change is approved.
  const unknown=hourly && live && cur.costHidden;
  return {...base, state:"changed", actual:last.costCents, minutesActual:last.minutes,
    pending:unknown ? 0 : curCost-last.costCents, minutesPending:(hourly ? curMin : 0)-last.minutes, group:last.group};
}

// Problems that stop an entry from being saved. [] when fine.
function validateCostEntry(e){
  const errs=[];
  if(!e.date) errs.push("Enter the date.");
  if(e.type==="material"){
    if(!e.description.trim()) errs.push("Enter the material name.");
    if(e.quantity===null || !(e.quantity>0)) errs.push("Enter a quantity above 0.");
    if(e.estUnitCents===null && e.actUnitCents===null) errs.push("Enter the estimated or the actual unit cost.");
    if((e.estUnitCents || 0)<0 || (e.actUnitCents || 0)<0) errs.push("Unit costs cannot be negative.");
  }else if(e.type==="labor"){
    if(!e.employeeId) errs.push("Choose who worked.");
    if(e.costMethod==="hourly"){
      const lm=laborMinutes(e);
      if(lm.error) errs.push(lm.error);
      else if(lm.minutes===0) errs.push("Enter the hours worked.");
      else if(lm.minutes>MAX_ENTRY_HOURS*60) errs.push(`One entry is at most ${MAX_ENTRY_HOURS} hours (one day).`);
    }else if(e.amountCents===null || e.amountCents<=0) errs.push("Enter the amount for this work.");
  }else{
    if(!e.description.trim()) errs.push("Enter a description.");
    if(e.amountCents===null || e.amountCents<=0) errs.push("Enter an amount above $0.");
  }
  if(e.date && e.date>addDays(localISODate(),1)) errs.push("The date is in the future.");
  return errs;
}

// Another active entry that looks like the same one (a double submit or the same receipt twice),
// or a labor entry whose hours overlap another one of the same person that day. null when none.
function findDuplicateEntry(e, entries=loadCostEntries()){
  for(const o of entries){
    if(o.id===e.id || o.status==="void" || o.projectId!==e.projectId || o.type!==e.type || o.date!==e.date) continue;
    if(e.type==="labor"){
      if(o.employeeId!==e.employeeId) continue;
      if(e.startTime && o.startTime && e.endTime && o.endTime){
        const a1=toMinutes(e.startTime), a2=toMinutes(e.endTime)+(e.endTime<=e.startTime ? 1440 : 0);
        const b1=toMinutes(o.startTime), b2=toMinutes(o.endTime)+(o.endTime<=o.startTime ? 1440 : 0);
        if(a1<b2 && b1<a2) return {entry:o, reason:`overlaps ${o.startTime}–${o.endTime} already recorded for this person`};
      }else if(laborMinutes(o).minutes===laborMinutes(e).minutes && o.costMethod===e.costMethod && o.amountCents===e.amountCents){
        return {entry:o, reason:"the same hours are already recorded for this person on this day"};
      }
    }else{
      const sameMoney=e.type==="material"
        ? o.quantity===e.quantity && o.actUnitCents===e.actUnitCents && o.estUnitCents===e.estUnitCents
        : o.amountCents===e.amountCents;
      if(sameMoney && o.description.trim().toLowerCase()===e.description.trim().toLowerCase()) return {entry:o, reason:"the same item and amount are already recorded on this day"};
    }
  }
  return null;
}

/* ---------- the project: revenue ---------- */

// The contract: the signed estimate (of its options, the accepted one), before sales tax.
function projectContractEstimate(p){
  const est=p.estimateId ? getEstimate(p.estimateId) : null;
  if(!est) return null;
  if(est.optionGroup){
    const accepted=loadEstimates().find(e=>e.optionGroup===est.optionGroup && e.status==="accepted");
    if(accepted) return accepted;
  }
  return est;
}

function contractCentsOf(est){
  if(!est) return 0;
  return Math.max(0,toCents(num(est.customerTotal)-num(est.taxAmount)) || 0);
}

/* ---------- the project: all figures ---------- */

// Everything the Financials tab and the reports show for one project, from its records.
//   input: {project, estimate, entries, approvals, budget, quickMaterials, settings, rateFor}
function computeProjectFinancials(input){
  const {entries, budget, settings}=input;
  const approvals=input.approvals || [];
  const rateFor=input.rateFor || null;
  const closed=!!(budget && budget.closedAt);
  const contract=contractCentsOf(input.estimate);
  const changeOrders=0; // approved change orders: stage 2
  const revenue=contract+changeOrders;

  const groups={};
  for(const g of BUDGET_GROUPS){
    const original=budget ? budget.lines[g.key] || 0 : 0;
    groups[g.key]={key:g.key,label:g.label,original,adjustments:0,current:original,actual:0,pending:0,remaining:0,forecast:0,variance:0,variancePct:null,
      entries:[],rateMissing:0,actMissing:0,costHidden:0};
  }
  let actualMinutes=0, pendingMinutes=0, waiting=0;
  const materials=[];
  const states=new Map();
  for(const e of entries){
    const st=entryState(e,approvals,rateFor);
    states.set(e.id,st);
    const g=groups[st.group];
    g.entries.push(e);
    g.actual+=st.actual;
    g.pending+=st.pending;
    actualMinutes+=st.minutesActual;
    pendingMinutes+=st.minutesPending;
    if(st.state==="pending" || st.state==="changed") waiting++;
    const c=st.cost;
    const counts=e.status!=="void" && st.state!=="rejected";
    if(counts && c.rateMissing && st.state!=="approved") g.rateMissing++;
    if(counts && c.actMissing) g.actMissing++;
    if(counts && c.costHidden && st.state!=="approved") g.costHidden++;
    if(e.type==="material") materials.push({entry:e,state:st.state,est:c.estCents,act:c.actMissing ? null : c.actCents,
      variance:c.estCents!==null && !c.actMissing ? c.estCents-c.actCents : null});
  }
  // The project's quick Materials list (Project tab): approved actual material costs.
  for(const m of input.quickMaterials || []){
    const act=Math.round(num(m.qty)*(toCents(m.unitPrice) || 0));
    groups.materials.actual+=act;
    materials.push({quick:m,est:null,act,variance:null});
  }

  // What is still to come. Labor: remaining estimated hours × the forecast rate. Other groups (and
  // labor without an hours estimate): the part of the current budget not spent or pending yet.
  const estMinutes=budget && budget.estLaborHours!==null ? Math.round(budget.estLaborHours*60) : null;
  const forecastRate=budget && budget.forecastRateCents!==null ? budget.forecastRateCents : toCents(settings.finLaborRate);
  const remainingMinutes=estMinutes===null ? null : Math.max(0,estMinutes-actualMinutes-pendingMinutes);
  for(const g of Object.values(groups)){
    if(closed) g.remaining=0;
    else if(g.key==="labor" && remainingMinutes!==null && forecastRate) g.remaining=Math.round(remainingMinutes*forecastRate/60);
    else g.remaining=Math.max(0,g.current-g.actual-g.pending);
    g.forecast=g.actual+g.pending+g.remaining;
    g.variance=g.current-g.forecast;
    g.variancePct=safePct(g.variance,g.current);
  }
  const sum=k=>Object.values(groups).reduce((t,g)=>t+g[k],0);
  const totals={original:sum("original"),adjustments:sum("adjustments"),current:sum("current"),actual:sum("actual"),pending:sum("pending"),
    remaining:sum("remaining"),forecast:sum("forecast")};
  totals.variance=totals.current-totals.forecast;
  totals.variancePct=safePct(totals.variance,totals.current);

  const forecastProfit=revenue-totals.forecast;
  const labor=groups.labor;
  const out={
    closed,
    contract, changeOrders, revenue,
    estimatedTotalCost:totals.current,
    actualToDate:totals.actual,
    pending:totals.pending,
    forecastTotalCost:totals.forecast,
    forecastProfit,
    forecastMargin:safePct(forecastProfit,revenue),
    finalProfit:closed ? revenue-totals.actual : null,
    finalMargin:closed ? safePct(revenue-totals.actual,revenue) : null,
    groups:BUDGET_GROUPS.map(g=>groups[g.key]),
    totals,
    states,
    waiting,
    materials,
    labor:{
      estMinutes, actualMinutes, pendingMinutes, remainingMinutes,
      hoursVarianceMinutes:estMinutes===null ? null : estMinutes-actualMinutes-pendingMinutes,
      estCost:labor.current, actualCost:labor.actual, pendingCost:labor.pending,
      forecastRate, remainingCost:labor.remaining, forecastAtCompletion:labor.forecast, costVariance:labor.variance,
      rateMissing:labor.rateMissing, costHidden:labor.costHidden
    }
  };
  out.alerts=financialAlerts(out,settings);
  return out;
}

// The few things worth attention, most important first.
function financialAlerts(f, settings){
  const alerts=[];
  const warn=amount(settings.finWarnPct) || 90, crit=amount(settings.finCritPct) || 100;
  if(f.estimatedTotalCost>0){
    const used=f.forecastTotalCost/f.estimatedTotalCost*100;
    if(used>crit) alerts.push({level:"critical",text:`Forecast cost ${moneyCents(f.forecastTotalCost)} is over the budget of ${moneyCents(f.estimatedTotalCost)} (${pctText(used,0)}).`});
    else if(used>=warn) alerts.push({level:"warning",text:`Forecast cost is at ${pctText(used,0)} of the budget.`});
  }else if(f.actualToDate+f.pending>0 && !f.closed){
    alerts.push({level:"info",text:"No budget set yet: forecasts and variances need an approved budget."});
  }
  if(f.labor.estMinutes!==null && f.labor.actualMinutes+f.labor.pendingMinutes>f.labor.estMinutes){
    alerts.push({level:"warning",text:`Labor hours (${hoursText(f.labor.actualMinutes+f.labor.pendingMinutes)}) exceed the estimate of ${hoursText(f.labor.estMinutes)}.`});
  }
  const pending=f.waiting;
  if(pending) alerts.push({level:f.closed ? "warning" : "info",text:`${pending} entr${pending===1?"y needs":"ies need"} approval${f.closed ? " (the project is closed)" : ""}.`});
  if(f.labor.rateMissing) alerts.push({level:"warning",text:`${f.labor.rateMissing} labor entr${f.labor.rateMissing===1?"y has":"ies have"} no cost rate yet (set it in Settings → Team & Labor Cost Rates).`});
  if(f.labor.costHidden) alerts.push({level:"info",text:`${f.labor.costHidden} pending labor entr${f.labor.costHidden===1?"y is":"ies are"} counted in hours only; the cost shows once approved.`});
  const missing=f.groups.reduce((t,g)=>t+g.actMissing,0);
  if(missing) alerts.push({level:"info",text:`${missing} entr${missing===1?"y has":"ies have"} no actual cost yet.`});
  return alerts;
}

// computeProjectFinancials() for a project as stored here.
function projectFinancials(projectId){
  const p=getProject(projectId);
  if(!p) return null;
  const rates=finIsManager() ? loadRates() : [];
  return computeProjectFinancials({
    project:p,
    estimate:projectContractEstimate(p),
    entries:loadCostEntries().filter(e=>e.projectId===projectId),
    approvals:loadApprovals().filter(a=>a.projectId===projectId),
    budget:budgetFor(projectId),
    quickMaterials:p.materials || [],
    settings:SETTINGS,
    rateFor:finIsManager() ? (emp,date)=>laborRateOn(emp,date,rates) : null
  });
}

/* ---------- saving (always with the audit log) ---------- */

const LOG_SKIP = new Set(["updatedAt","createdAt"]);

// Only the fields that changed, as JSON text (for the log).
function finDiff(before, after){
  const b={}, a={};
  for(const k of new Set([...Object.keys(before || {}),...Object.keys(after || {})])){
    if(LOG_SKIP.has(k)) continue;
    const x=before ? before[k] : undefined, y=after ? after[k] : undefined;
    if(JSON.stringify(x)!==JSON.stringify(y)){ if(before) b[k]=x ?? null; if(after) a[k]=y ?? null; }
  }
  return {before:before ? JSON.stringify(b) : "", after:after ? JSON.stringify(a) : ""};
}

function finLog(action, recordType, before, after, reason=""){
  const rec=after || before || {};
  const d=finDiff(before,after);
  const list=readStore(STORAGE_KEYS.finlog,[]);
  const log=Array.isArray(list) ? list : [];
  log.push(normalizeLogEntry({id:uid("flog"),at:nowISO(),actor:finActor(),projectId:rec.projectId || "",recordType,recordId:rec.id || "",
    action,before:d.before,after:d.after,reason}));
  return writeStore(STORAGE_KEYS.finlog,log);
}

function saveFinRecord(key, norm, rec){
  const list=finList(key,norm);
  const i=list.findIndex(x=>x.id===rec.id);
  if(i>=0) list[i]=rec; else list.push(rec);
  return writeStore(key,list);
}

// New entry: managers' entries are approved at once (with the auto-approve setting); members'
// entries wait for approval. Returns the saved entry or {error}.
function addCostEntry(data){
  const e=normalizeCostEntry({...data,id:uid("cost"),createdBy:finActor(),createdAt:nowISO(),updatedAt:nowISO(),status:"active"});
  const errs=validateCostEntry(e);
  if(errs.length) return {error:errs.join(" ")};
  const auto=finIsManager() && SETTINGS.finAutoApprove!=="no";
  const approval=auto ? makeApproval(e,"approved","") : null;
  if(approval && approval.error) return approval;
  if(!saveFinRecord(STORAGE_KEYS.costs,normalizeCostEntry,e)) return {error:"Could not save on this device."};
  finLog("created","CostEntry",null,e);
  if(approval) saveApproval(approval,e);
  return {...e,state:approval ? "approved" : "pending"};
}

// A manager's decision on the entry as it is now. Hourly labor gets the employee's cost rate of
// that day (frozen here). Returns the approval or {error}.
function makeApproval(e, decision, reason){
  if(!finIsManager()) return {error:"Only an owner or admin can approve or reject."};
  const rates=loadRates();
  let rate=null;
  if(decision==="approved" && e.status!=="void" && e.type==="labor" && e.costMethod==="hourly"){
    rate=laborRateOn(e.employeeId,e.date,rates);
    if(rate===null){
      const emp=loadEmployees().find(x=>x.id===e.employeeId);
      return {error:`${emp ? emp.name : "This person"} has no labor cost rate for ${formatDate(e.date)}. Set it in Settings → Team & Labor Cost Rates first.`};
    }
  }
  const c=entryCost(e,(emp,date)=>laborRateOn(emp,date,rates));
  const live=e.status!=="void";
  return normalizeApproval({id:uid("appr"),costId:e.id,projectId:e.projectId,decision,contentHash:entryContentHash(e),
    costCents:live && decision==="approved" ? c.actCents : 0,estCents:c.estCents,
    minutes:live && e.type==="labor" && e.costMethod==="hourly" ? c.minutes || 0 : 0,
    group:costCategory(e.category).group,rateCents:rate,reason,by:finActor(),at:nowISO()});
}

function saveApproval(a, entry){
  const list=loadApprovals();
  list.push(a);
  if(!writeStore(STORAGE_KEYS.approvals,list)) return false;
  finLog(a.decision==="approved" ? (entry.status==="void" ? "void approved" : "approved") : "rejected","CostEntry",null,
    {id:entry.id,projectId:entry.projectId,decision:a.decision,costCents:a.costCents,rateCents:a.rateCents},a.reason);
  return true;
}

// Change an entry. An approved entry needs a reason (kept in the log). Returns the entry or {error}.
// Change an entry. A manager changing an approved entry gives a reason and approves the new
// amounts at once; anyone else's change waits for approval (the approved amount keeps counting).
function updateCostEntry(id, changes, reason=""){
  const before=loadCostEntries().find(x=>x.id===id);
  if(!before) return {error:"The entry was not found."};
  const approvals=loadApprovals();
  if(!finCanEdit(before,approvals)) return {error:"You cannot change this entry."};
  const wasApproved=["approved","changed"].includes(entryState(before,approvals).state);
  if(wasApproved && !reason.trim()) return {error:"Give a reason for changing an approved entry."};
  const after=normalizeCostEntry({...before,...changes,id,updatedAt:nowISO()});
  const errs=validateCostEntry(after);
  if(errs.length) return {error:errs.join(" ")};
  const approval=wasApproved && finIsManager() ? makeApproval(after,"approved",reason) : null;
  if(approval && approval.error) return approval;
  if(!saveFinRecord(STORAGE_KEYS.costs,normalizeCostEntry,after)) return {error:"Could not save on this device."};
  finLog("edited","CostEntry",before,after,reason);
  if(approval) saveApproval(approval,after);
  return after;
}

function setEntryApproval(id, decision, reason=""){
  const e=loadCostEntries().find(x=>x.id===id);
  if(!e) return {error:"The entry was not found."};
  const a=makeApproval(e,decision==="approved" ? "approved" : "rejected",reason);
  if(a.error) return a;
  if(!saveApproval(a,e)) return {error:"Could not save on this device."};
  return a;
}

// Entries are never deleted: voiding keeps them (and the reason) but stops them counting. A
// manager's void takes effect at once; a member's void of an approved entry waits for approval.
function voidCostEntry(id, reason){
  const before=loadCostEntries().find(x=>x.id===id);
  if(!before) return {error:"The entry was not found."};
  const approvals=loadApprovals();
  if(!finCanEdit(before,approvals)) return {error:"You cannot void this entry."};
  if(!String(reason || "").trim()) return {error:"Give a reason for voiding the entry."};
  const wasApproved=["approved","changed"].includes(entryState(before,approvals).state);
  const after=normalizeCostEntry({...before,status:"void",voidReason:reason.trim(),updatedAt:nowISO()});
  if(!saveFinRecord(STORAGE_KEYS.costs,normalizeCostEntry,after)) return {error:"Could not save on this device."};
  finLog("voided","CostEntry",before,after,reason);
  if(wasApproved && finIsManager()){
    const a=makeApproval(after,"approved",reason);
    if(!a.error) saveApproval(a,after);
  }
  return after;
}

// The budget: managers only. Once approved, the original lines stay as they are (later changes
// are budget adjustments, stage 2); the hours estimate and forecast rate can still be tuned with a reason.
function saveBudget(projectId, changes, reason=""){
  if(!finIsManager()) return {error:"Only an owner or admin can change the budget."};
  const before=budgetFor(projectId);
  if(before && before.approvedAt && changes.lines && JSON.stringify(normalizeBudget({...before,lines:changes.lines}).lines)!==JSON.stringify(before.lines)){
    return {error:"The approved budget is kept as it is. Record a budget adjustment instead."};
  }
  if(before && before.approvedAt && !reason.trim()) return {error:"Give a reason for changing the forecast of an approved budget."};
  const after=normalizeBudget({...(before || {id:"bud-"+projectId,projectId,createdAt:nowISO()}),...changes,updatedAt:nowISO()});
  if(!saveFinRecord(STORAGE_KEYS.budgets,normalizeBudget,after)) return {error:"Could not save on this device."};
  finLog(before ? (changes.approvedAt && !before.approvedAt ? "budget approved" : changes.closedAt!==undefined && changes.closedAt!==before.closedAt ? (changes.closedAt ? "project closed" : "project reopened") : "budget changed") : "budget created",
    "ProjectBudget",before,after,reason);
  return after;
}

/* ---------- team and rates (managers) ---------- */

function saveEmployee(data){
  if(!finIsManager()) return {error:"Only an owner or admin can change the team."};
  const list=loadEmployees();
  const before=data.id ? list.find(x=>x.id===data.id) : null;
  const after=normalizeEmployee({...(before || {id:uid("emp"),createdAt:nowISO()}),...data,updatedAt:nowISO()});
  if(!after.name.trim()) return {error:"Enter the name."};
  if(list.some(x=>x.id!==after.id && x.name.trim().toLowerCase()===after.name.trim().toLowerCase())) return {error:`${after.name} is already on the team.`};
  if(!saveFinRecord(STORAGE_KEYS.employees,normalizeEmployee,after)) return {error:"Could not save on this device."};
  finLog(before ? "edited" : "created","Employee",before,after);
  return after;
}

// A new rate from a date on. Earlier rates are kept, so approved entries never change.
function addEmployeeRate(employeeId, rateCents, burdenPercent, effectiveFrom){
  if(!finIsManager()) return {error:"Only an owner or admin can set cost rates."};
  if(rateCents===null || rateCents<0) return {error:"Enter the hourly cost rate."};
  const r=normalizeRate({id:uid("rate"),employeeId,rateCents,burdenPercent,effectiveFrom:effectiveFrom || localISODate(),createdBy:finActor(),createdAt:nowISO()});
  if(!saveFinRecord(STORAGE_KEYS.rates,normalizeRate,r)) return {error:"Could not save on this device."};
  finLog("rate set","EmployeeRate",null,r);
  return r;
}

function employeeName(id){
  const e=loadEmployees().find(x=>x.id===id);
  return e ? e.name : "Unknown person";
}
