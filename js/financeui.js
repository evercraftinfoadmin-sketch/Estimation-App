"use strict";

/* Financials tab of the project window, the cost entry window and the team / rates settings.
   Every number comes from projectFinancials() (finance.js); nothing is calculated here. */

let FIN_PROJECT_ID = null;
let FIN_FILTER = {from:"",to:"",group:"",employee:"",status:""};
let FIN_ENTRY = null;     // the entry window: {id, projectId, type}
let FIN_SAVING = false;   // stops a double submit

const FIN_TIPS = {
  contract:"The signed estimate before sales tax (sales tax is not company income).",
  changeOrders:"Approved change orders add to the contract (coming in the next stage).",
  estimated:"Budget: the approved budget for all expected costs of this project.",
  actual:"Actual to date: approved costs only. Pending entries are shown separately.",
  pending:"Entries waiting for an owner or admin to approve them. Counted in the forecast.",
  forecast:"Forecast at completion: actual + pending + what is still expected (remaining budget, or remaining labor hours × forecast rate).",
  profit:"Forecast profit = adjusted contract revenue − forecast total cost. Not final.",
  margin:"Forecast profit ÷ adjusted contract revenue.",
  finalProfit:"Final actual profit of the closed project: revenue − approved actual costs (project gross profit, before company overhead).",
  finalMargin:"Final actual profit ÷ revenue."
};

/* ---------- the tab ---------- */

function setProjectTab(tab){
  const fin=tab==="financials";
  $("projectForm").classList.toggle("fin-mode",fin);
  document.querySelectorAll("#pmTabs [data-pm-tab]").forEach(b=>{
    b.classList.toggle("active",b.dataset.pmTab===tab);
    b.setAttribute("aria-selected",b.dataset.pmTab===tab ? "true" : "false");
  });
  $("pmFinancials").hidden=!fin;
  if(fin) renderFinancials();
}

// Called when the project window opens.
function prepareFinancialsTab(projectId){
  FIN_PROJECT_ID=projectId || null;
  FIN_FILTER={from:"",to:"",group:"",employee:"",status:""};
  $("pmTabs").hidden=!projectId || !finCanView();
  setProjectTab("project");
}

function kpiCard(label, value, kind, tip, sub=""){
  return `<div class="fin-kpi fin-kpi-${kind}" title="${escapeHtml(tip)}">
    <div class="fin-kpi-label">${escapeHtml(label)} <span class="fin-tip" aria-hidden="true">?</span></div>
    <div class="fin-kpi-value">${value}</div>
    ${sub?`<div class="fin-kpi-sub">${sub}</div>`:""}
  </div>`;
}

const varianceHtml=c=>c===null || c===undefined ? "—" : `<span class="${c<0?"fin-over":c>0?"fin-under":""}">${moneyCents(c)}</span>`;
const statusChip=state=>`<span class="fin-chip fin-chip-${state}">${escapeHtml(labelOf(APPROVAL_STATUSES,state))}</span>`;

function renderFinancials(){
  const box=$("pmFinancials");
  const p=getProject(FIN_PROJECT_ID);
  if(!p){ box.innerHTML=`<p class="muted">Save the project first.</p>`; return; }
  if(!finCanView()){ box.innerHTML=`<p class="muted">Sign in with CRM access to see the financials.</p>`; return; }
  const f=projectFinancials(p.id);
  const budget=budgetFor(p.id);
  const mgr=finIsManager();
  const est=projectContractEstimate(p);

  const alerts=f.alerts.map(a=>`<div class="fin-alert fin-alert-${a.level}">${a.level==="critical"?"⛔":a.level==="warning"?"⚠":"ℹ"} ${escapeHtml(a.text)}</div>`).join("");
  const kpis=[
    kpiCard("Contract Amount",moneyCents(f.contract),"rev",FIN_TIPS.contract,est ? escapeHtml(est.estimateNumber+(est.optionLabel ? " · "+est.optionLabel : "")) : "No estimate linked"),
    kpiCard("Approved Change Orders",moneyCents(f.changeOrders),"rev",FIN_TIPS.changeOrders,`Adjusted revenue ${moneyCents(f.revenue)}`),
    kpiCard("Estimated Total Cost",moneyCents(f.estimatedTotalCost),"budget",FIN_TIPS.estimated,`<span class="fin-tag">Budget</span>${budget && budget.approvedAt ? " approved" : budget ? " draft" : " not set"}`),
    kpiCard("Actual Cost to Date",moneyCents(f.actualToDate),"actual",FIN_TIPS.actual,`<span class="fin-tag">Actual</span>${f.pending ? ` + ${moneyCents(f.pending)} pending` : ""}`),
    kpiCard("Forecast Total Cost",moneyCents(f.forecastTotalCost),"forecast",FIN_TIPS.forecast,`<span class="fin-tag">Forecast</span> at completion`),
    kpiCard("Forecast Profit",`<span class="${f.forecastProfit<0?"fin-over":""}">${moneyCents(f.forecastProfit)}</span>`,"forecast",FIN_TIPS.profit,`<span class="fin-tag">Forecast</span> not final`),
    kpiCard("Forecast Profit Margin",pctText(f.forecastMargin),"forecast",FIN_TIPS.margin,f.revenue ? "" : "No revenue yet")
  ];
  if(f.closed){
    kpis.push(kpiCard("Final Actual Profit",`<span class="${f.finalProfit<0?"fin-over":""}">${moneyCents(f.finalProfit)}</span>`,"final",FIN_TIPS.finalProfit,`<span class="fin-tag">Final</span> closed ${escapeHtml(formatDate(budget.closedAt.slice(0,10)))}`));
    kpis.push(kpiCard("Final Actual Margin",pctText(f.finalMargin),"final",FIN_TIPS.finalMargin,`<span class="fin-tag">Final</span>`));
  }

  const rows=f.groups.map(g=>`<tr data-fin-group="${g.key}" class="fin-row-link" title="Show the entries of ${escapeHtml(g.label)}">
      <td>${escapeHtml(g.label)}${g.pending?` <span class="small">(${moneyCents(g.pending)} pending)</span>`:""}</td>
      <td class="num">${moneyCents(g.original)}</td><td class="num">${moneyCents(g.adjustments)}</td><td class="num">${moneyCents(g.current)}</td>
      <td class="num">${moneyCents(g.actual)}</td><td class="num">${moneyCents(g.remaining)}</td><td class="num">${moneyCents(g.forecast)}</td>
      <td class="num">${varianceHtml(g.variance)}</td><td class="num">${pctText(g.variancePct)}</td></tr>`).join("");
  const t=f.totals;
  const eva=`<div class="table-wrap"><table class="table fin-table">
    <thead><tr><th>Cost Category</th><th class="num">Original Budget</th><th class="num">Approved Adjustments</th><th class="num">Current Budget</th>
      <th class="num">Actual to Date</th><th class="num">Remaining Forecast</th><th class="num">Forecast Total</th><th class="num" title="Current budget − forecast total. Positive = under budget.">Variance</th><th class="num">Variance %</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><th>Project total</th><th class="num">${moneyCents(t.original)}</th><th class="num">${moneyCents(t.adjustments)}</th><th class="num">${moneyCents(t.current)}</th>
      <th class="num">${moneyCents(t.actual)}</th><th class="num">${moneyCents(t.remaining)}</th><th class="num">${moneyCents(t.forecast)}</th>
      <th class="num">${varianceHtml(t.variance)}</th><th class="num">${pctText(t.variancePct)}</th></tr></tfoot>
  </table></div>
  <p class="small">Positive variance = under budget, negative = over budget. Remaining forecast: the budget not yet spent${f.labor.remainingMinutes!==null ? "; labor: remaining estimated hours × forecast rate" : ""}${f.closed ? " (closed: nothing remaining)" : ""}.</p>`;

  const L=f.labor;
  const labor=`<div class="fin-stats">
    <div><span>Estimated hours</span><b>${hoursText(L.estMinutes)}</b></div>
    <div><span>Actual hours</span><b>${hoursText(L.actualMinutes)}</b>${L.pendingMinutes?`<span class="small">+ ${hoursText(L.pendingMinutes)} pending</span>`:""}</div>
    <div><span>Remaining estimated hours</span><b>${hoursText(L.remainingMinutes)}</b></div>
    <div title="Estimated hours − actual and pending hours"><span>Hours variance</span><b class="${L.hoursVarianceMinutes<0?"fin-over":""}">${L.hoursVarianceMinutes===null ? "—" : hoursText(L.hoursVarianceMinutes)}</b></div>
    <div><span>Estimated labor cost</span><b>${moneyCents(L.estCost)}</b></div>
    <div><span>Actual labor cost</span><b>${moneyCents(L.actualCost)}</b>${L.pendingCost?`<span class="small">+ ${moneyCents(L.pendingCost)} pending</span>`:""}</div>
    <div title="Remaining estimated hours × forecast rate"><span>Forecast remaining labor cost</span><b>${moneyCents(L.remainingCost)}</b><span class="small">rate ${L.forecastRate ? moneyCents(L.forecastRate)+"/h" : "not set"}</span></div>
    <div><span>Forecast labor at completion</span><b>${moneyCents(L.forecastAtCompletion)}</b></div>
    <div><span>Labor budget variance</span><b>${varianceHtml(L.costVariance)}</b></div>
  </div>`;

  const unitText=e=>e.unit==="other" ? (e.unitOther || "other") : labelOf(MATERIAL_UNITS,e.unit).toLowerCase();
  const mats=f.materials.length ? `<div class="table-wrap"><table class="table fin-table">
    <thead><tr><th>Material</th><th>Qty</th><th class="num">Est. unit</th><th class="num">Actual unit</th><th class="num">Est. total</th><th class="num">Actual total</th><th class="num">Variance</th><th>Status</th></tr></thead>
    <tbody>${f.materials.map(m=>m.quick
      ? `<tr><td>${escapeHtml(m.quick.name || "Material")} <span class="small">· project Materials list${m.quick.store?" · "+escapeHtml(m.quick.store):""}</span></td><td>${formatQty(m.quick.qty)}</td><td class="num">—</td><td class="num">${moneyCents(toCents(m.quick.unitPrice))}</td><td class="num">—</td><td class="num">${moneyCents(m.act)}</td><td class="num">—</td><td><span class="fin-chip fin-chip-approved">Counted</span></td></tr>`
      : `<tr><td>${escapeHtml(m.entry.description)}${m.entry.vendor?` <span class="small">· ${escapeHtml(m.entry.vendor)}</span>`:""}</td><td>${formatQty(m.entry.quantity)} ${escapeHtml(unitText(m.entry))}</td>
          <td class="num">${moneyCents(m.entry.estUnitCents)}</td><td class="num">${moneyCents(m.entry.actUnitCents)}</td><td class="num">${moneyCents(m.est)}</td><td class="num">${moneyCents(m.act)}</td>
          <td class="num">${m.variance===null ? "—" : varianceHtml(m.variance)+(m.variance<0?` <span class="small fin-over">over</span>`:m.variance>0?` <span class="small fin-under">under</span>`:"")}</td><td>${statusChip(m.state)}</td></tr>`).join("")}</tbody>
  </table></div>` : `<p class="muted">No materials yet.</p>`;

  box.innerHTML=`
    ${alerts?`<div class="fin-alerts">${alerts}</div>`:""}
    <div class="fin-quick">
      <button type="button" class="btn btn-primary btn-sm" data-fin-add="material">+ Material</button>
      <button type="button" class="btn btn-primary btn-sm" data-fin-add="labor">+ Labor / Time</button>
      <button type="button" class="btn btn-primary btn-sm" data-fin-add="expense">+ Expense</button>
    </div>
    <h3>Financial Overview</h3>
    <div class="fin-kpis">${kpis.join("")}</div>
    <h3>Estimate vs. Actual</h3>
    ${eva}
    ${renderBudgetEditor(p,budget,f,mgr)}
    <h3>Labor &amp; Time <span class="small">· Remaining Labor Cost</span></h3>
    ${labor}
    <h3>Materials</h3>
    ${mats}
    <h3 id="finLedgerHead">All Entries</h3>
    ${renderLedger(p.id,f.states)}
    <details class="fin-log"><summary><b>Financial Activity Log</b></summary>${renderFinLog(p.id)}</details>`;
}

function renderBudgetEditor(p, budget, f, mgr){
  if(!mgr){
    return budget ? "" : `<p class="small">No budget yet: an owner or admin sets it.</p>`;
  }
  const locked=!!(budget && budget.approvedAt);
  const lines=BUDGET_GROUPS.map(g=>`<div class="field"><label for="finBud-${g.key}">${escapeHtml(g.label)} ($)</label>
    <input id="finBud-${g.key}" data-fin-budget="${g.key}" type="number" min="0" step="0.01" inputmode="decimal" value="${budget ? centsToInput(budget.lines[g.key]) : ""}" ${locked?"disabled":""}></div>`).join("");
  return `<details class="fin-budget" ${budget ? "" : "open"}><summary><b>Budget</b> ${locked ? `<span class="fin-chip fin-chip-approved">Approved ${escapeHtml(formatDate(budget.approvedAt.slice(0,10)))}</span>` : budget ? `<span class="fin-chip fin-chip-pending">Draft</span>` : `<span class="small">not set</span>`}${f.closed?` <span class="fin-chip fin-chip-void">Closed</span>`:""}</summary>
    <div class="fin-budget-grid">${lines}
      <div class="field"><label for="finEstHours">Estimated labor hours</label><input id="finEstHours" type="number" min="0" step="0.25" inputmode="decimal" value="${budget && budget.estLaborHours!==null ? budget.estLaborHours : ""}"></div>
      <div class="field"><label for="finForecastRate" title="Company cost of one labor hour for the forecast (not the price billed to the client). Empty = the default in Settings.">Forecast labor rate ($/h)</label><input id="finForecastRate" type="number" min="0" step="0.01" inputmode="decimal" value="${budget ? centsToInput(budget.forecastRateCents) : ""}" placeholder="${SETTINGS.finLaborRate ? "default "+escapeHtml(SETTINGS.finLaborRate) : "not set"}"></div>
    </div>
    ${locked ? `<div class="field"><label for="finBudgetReason">Reason for changing the forecast (required once approved)</label><input id="finBudgetReason" type="text" maxlength="300"></div>
      <p class="small">The approved budget lines stay as approved; budget adjustments come in the next stage.</p>` : ""}
    <div class="btn-row">
      <button type="button" class="btn btn-light btn-sm" data-fin-action="save-budget">Save ${locked ? "forecast" : "budget"}</button>
      ${!locked ? `<button type="button" class="btn btn-light btn-sm" data-fin-action="approve-budget">Approve budget</button>` : ""}
      ${f.closed ? `<button type="button" class="btn btn-light btn-sm" data-fin-action="reopen">Reopen financials</button>` : `<button type="button" class="btn btn-light btn-sm" data-fin-action="close">Close project financials</button>`}
    </div>
  </details>`;
}

function entryAmountText(e, st){
  const c=st.cost;
  if(st.state==="approved") return moneyCents(st.actual);
  if(st.state==="changed") return `${moneyCents(st.actual)}<div class="small">change ${st.pending>=0?"+":""}${moneyCents(st.pending)} waiting</div>`;
  if(c.costHidden) return `<span class="small">after approval</span>`;
  if(c.rateMissing) return `<span class="small fin-over">no rate</span>`;
  if(c.actMissing && e.type==="material") return `<span class="small">est. ${moneyCents(c.estCents)}</span>`;
  return moneyCents(c.actCents);
}

function entryDetailText(e){
  if(e.type==="material") return `${formatQty(e.quantity)} ${e.unit==="other" ? (e.unitOther || "") : labelOf(MATERIAL_UNITS,e.unit).toLowerCase()}`;
  if(e.type==="labor"){
    const lm=laborMinutes(e);
    const time=e.startTime ? `${e.startTime}–${e.endTime}${e.breakMinutes?`, ${e.breakMinutes} min break`:""}` : "";
    return `${escapeHtml(employeeName(e.employeeId))} · ${e.costMethod==="hourly" ? hoursText(lm.minutes || 0) : escapeHtml(labelOf(LABOR_METHODS,e.costMethod))}${time?` · ${time}`:""}`;
  }
  return escapeHtml(labelOf(COST_CLASSIFICATIONS,e.classification));
}

function filteredEntries(projectId, states){
  const F=FIN_FILTER;
  return loadCostEntries().filter(e=>e.projectId===projectId)
    .filter(e=>!F.from || e.date>=F.from).filter(e=>!F.to || e.date<=F.to)
    .filter(e=>!F.group || costCategory(e.category).group===F.group)
    .filter(e=>!F.employee || e.employeeId===F.employee)
    .filter(e=>!F.status || (states.get(e.id) || {}).state===F.status)
    .sort((a,b)=>b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
}

function renderLedger(projectId, states){
  const F=FIN_FILTER;
  const people=loadEmployees();
  const approvals=loadApprovals();
  const list=filteredEntries(projectId,states);
  const mgr=finIsManager();
  const opt=(list,val)=>list.map(x=>`<option value="${escapeHtml(x.key)}" ${x.key===val?"selected":""}>${escapeHtml(x.label)}</option>`).join("");
  const filters=`<div class="fin-filters">
    <label>From <input type="date" data-fin-filter="from" value="${F.from}"></label>
    <label>To <input type="date" data-fin-filter="to" value="${F.to}"></label>
    <label>Category <select data-fin-filter="group"><option value="">All</option>${opt(BUDGET_GROUPS,F.group)}</select></label>
    <label>Employee <select data-fin-filter="employee"><option value="">All</option>${opt(people.map(p=>({key:p.id,label:p.name})),F.employee)}</select></label>
    <label>Status <select data-fin-filter="status"><option value="">All</option>${opt(APPROVAL_STATUSES,F.status)}</select></label>
    ${Object.values(F).some(Boolean)?`<button type="button" class="btn-link" data-fin-action="clear-filters">Clear</button>`:""}
  </div>`;
  const rows=list.map(e=>{
    const st=states.get(e.id);
    const actions=[];
    if(mgr && ["pending","rejected","changed"].includes(st.state)) actions.push(`<button type="button" class="btn btn-light btn-sm" data-fin-entry="approve" data-id="${e.id}">Approve${st.state==="changed"?" change":""}</button>`);
    if(mgr && st.state==="pending") actions.push(`<button type="button" class="btn btn-light btn-sm" data-fin-entry="reject" data-id="${e.id}">Reject</button>`);
    if(finCanEdit(e,approvals)) actions.push(`<button type="button" class="btn btn-light btn-sm" data-fin-entry="edit" data-id="${e.id}">Edit</button>`,
      `<button type="button" class="btn btn-light btn-sm" data-fin-entry="void" data-id="${e.id}">Void</button>`);
    return `<tr class="${st.state==="void" || st.state==="rejected" ? "fin-row-out" : ""}" data-entry="${e.id}" data-state="${st.state}">
      <td>${escapeHtml(formatDate(e.date))}</td>
      <td><b>${escapeHtml(e.description || labelOf(COST_TYPES,e.type))}</b><div class="small">${entryDetailText(e)}${e.vendor?` · ${escapeHtml(e.vendor)}`:""}${e.voidReason?` · voided: ${escapeHtml(e.voidReason)}`:""}</div></td>
      <td>${escapeHtml(costCategory(e.category).label)}</td>
      <td class="num">${entryAmountText(e,st)}</td>
      <td>${statusChip(st.state)}<div class="small">${escapeHtml(e.createdBy)}</div>${st.approval?`<div class="small">${st.approval.decision} by ${escapeHtml(st.approval.by)}</div>`:""}</td>
      <td class="fin-actions">${actions.join("")}</td>
    </tr>`;
  }).join("");
  return filters+(list.length ? `<div class="table-wrap"><table class="table fin-table fin-ledger"><thead><tr><th>Date</th><th>Entry</th><th>Category</th><th class="num">Cost</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<p class="muted">No entries${Object.values(F).some(Boolean) ? " match the filters" : " yet: use the buttons above"}.</p>`);
}

function renderFinLog(projectId){
  const list=loadFinLog().filter(l=>l.projectId===projectId).sort((a,b)=>b.at.localeCompare(a.at)).slice(0,100);
  if(!list.length) return `<p class="muted">No financial changes yet.</p>`;
  const show=s=>{ try{ const o=JSON.parse(s || "{}"); return Object.entries(o).map(([k,v])=>`${k}: ${typeof v==="object" ? JSON.stringify(v) : v}`).join(", "); }catch(e){ return s; } };
  return `<ul class="fin-log-list">${list.map(l=>`<li><span class="small">${escapeHtml(formatDateTime(l.at))} · ${escapeHtml(l.actor)}</span><br>
    <b>${escapeHtml(l.recordType)} ${escapeHtml(l.action)}</b>${l.reason?` · reason: ${escapeHtml(l.reason)}`:""}
    ${l.before?`<div class="small">before: ${escapeHtml(show(l.before))}</div>`:""}${l.after?`<div class="small">after: ${escapeHtml(show(l.after))}</div>`:""}</li>`).join("")}</ul>
    <p class="small">Kept on every device and in Base44, where no one can change or delete it from the CRM.</p>`;
}

function finToast(res, ok){
  if(res && res.error){ alert(res.error); return false; }
  showToast(ok);
  renderFinancials();
  return true;
}

function readBudgetForm(){
  const lines={};
  document.querySelectorAll("#pmFinancials [data-fin-budget]").forEach(i=>{ lines[i.dataset.finBudget]=toCents(i.value) || 0; });
  const hours=$("finEstHours").value;
  return {lines,estLaborHours:hours==="" ? null : amount(hours),forecastRateCents:toCents($("finForecastRate").value)};
}

function handleFinancialsClick(event){
  const el=event.target.closest("[data-fin-add],[data-fin-action],[data-fin-entry],[data-fin-group]");
  if(!el || !FIN_PROJECT_ID) return;
  if(el.dataset.finAdd){ openCostEntry({type:el.dataset.finAdd,projectId:FIN_PROJECT_ID}); return; }
  if(el.dataset.finGroup){
    FIN_FILTER.group=el.dataset.finGroup;
    renderFinancials();
    $("finLedgerHead").scrollIntoView({behavior:"smooth",block:"start"});
    return;
  }
  const action=el.dataset.finAction;
  const budget=budgetFor(FIN_PROJECT_ID);
  const reason=()=>($("finBudgetReason") ? $("finBudgetReason").value : "");
  if(action==="clear-filters"){ FIN_FILTER={from:"",to:"",group:"",employee:"",status:""}; renderFinancials(); return; }
  if(action==="save-budget"){
    const data=readBudgetForm();
    if(budget && budget.approvedAt) delete data.lines;
    finToast(saveBudget(FIN_PROJECT_ID,data,reason()),"Budget saved.");
    return;
  }
  if(action==="approve-budget"){
    const data=readBudgetForm();
    if(!Object.values(data.lines).some(v=>v>0)){ alert("Enter the budget amounts first."); return; }
    if(!confirm("Approve this budget? The approved amounts are then kept as the original budget.")) return;
    finToast(saveBudget(FIN_PROJECT_ID,{...data,approvedAt:nowISO(),approvedBy:finActor()}),"Budget approved.");
    return;
  }
  if(action==="close"){
    const pending=projectFinancials(FIN_PROJECT_ID).waiting;
    if(!confirm(`Close the financials of this project? Final profit is then shown from the approved costs.${pending ? `\n\n${pending} entr${pending===1?"y is":"ies are"} still pending and will not count in the final result.` : ""}`)) return;
    const why=prompt("Reason / note for closing (optional):","Project completed") ?? "";
    finToast(saveBudget(FIN_PROJECT_ID,{closedAt:nowISO(),closedBy:finActor()},budget && budget.approvedAt ? (why || "Project completed") : why),"Project financials closed.");
    return;
  }
  if(action==="reopen"){
    const why=prompt("Why reopen the financials? (required)");
    if(!why || !why.trim()) return;
    finToast(saveBudget(FIN_PROJECT_ID,{closedAt:"",closedBy:""},why),"Financials reopened.");
    return;
  }
  const id=el.dataset.id;
  const kind=el.dataset.finEntry;
  if(kind==="edit"){ openCostEntry({id}); return; }
  if(kind==="approve") finToast(setEntryApproval(id,"approved"),"Entry approved.");
  else if(kind==="reject"){
    const why=prompt("Reason for rejecting (kept with the entry):");
    if(why===null) return;
    finToast(setEntryApproval(id,"rejected",why),"Entry rejected. It stays visible but does not count.");
  }else if(kind==="void"){
    const why=prompt("Void this entry? It stays visible but stops counting.\n\nReason (required):");
    if(why===null) return;
    finToast(voidCostEntry(id,why),"Entry voided.");
  }
}

function handleFinancialsChange(event){
  const el=event.target.closest("[data-fin-filter]");
  if(!el) return;
  FIN_FILTER[el.dataset.finFilter]=el.value;
  const ledger=$("finLedgerHead");
  renderFinancials();
  if(ledger) $("finLedgerHead").scrollIntoView({block:"nearest"});
}

/* ---------- the entry window ---------- */

function fillOptions(sel, list, val){
  $(sel).innerHTML=list.map(x=>`<option value="${escapeHtml(x.key)}" ${x.key===val?"selected":""}>${escapeHtml(x.label)}</option>`).join("");
}

function openCostEntry({id, type, projectId}){
  const e=id ? loadCostEntries().find(x=>x.id===id) : normalizeCostEntry({id:"new",type,projectId,date:localISODate()});
  if(!e) return;
  const st=id ? entryState(e,loadApprovals()) : {state:"pending"};
  FIN_ENTRY={id:id || null,projectId:e.projectId,approved:["approved","changed"].includes(st.state)};
  FIN_SAVING=false;
  $("ceTitle").textContent=(id ? "Edit " : "Add ")+labelOf(COST_TYPES,e.type).toLowerCase()+(e.type==="labor" ? " / time" : "");
  fillOptions("ceType",COST_TYPES,e.type);
  $("ceType").disabled=!!id;
  $("ceDate").value=e.date;
  $("ceDescription").value=e.description;
  $("ceVendor").value=e.vendor;
  $("ceNotes").value=e.notes;
  $("ceQty").value=e.quantity ?? "";
  fillOptions("ceUnit",MATERIAL_UNITS,e.unit);
  $("ceUnitOther").value=e.unitOther;
  $("ceEstUnit").value=centsToInput(e.estUnitCents);
  $("ceActUnit").value=centsToInput(e.actUnitCents);
  const people=loadEmployees().filter(p=>p.active || p.id===e.employeeId);
  $("ceEmployee").innerHTML=`<option value="">Choose…</option>`+people.map(p=>`<option value="${escapeHtml(p.id)}" ${p.id===e.employeeId?"selected":""}>${escapeHtml(p.name)}</option>`).join("");
  $("ceNoPeople").hidden=people.length>0;
  fillOptions("ceMethod",LABOR_METHODS,e.costMethod);
  $("ceStart").value=e.startTime;
  $("ceEnd").value=e.endTime;
  $("ceBreak").value=e.breakMinutes || "";
  $("ceHours").value=e.hours ?? "";
  $("ceWork").value=e.workCategory;
  $("ceAmount").value=centsToInput(e.amountCents);
  fillOptions("ceCategory",EXPENSE_CATEGORIES,e.type==="expense" ? e.category : "fuel");
  fillOptions("ceClass",COST_CLASSIFICATIONS.filter(c=>c.key!=="overhead"),e.classification==="overhead" ? "direct" : e.classification);
  $("ceReasonRow").hidden=!FIN_ENTRY.approved;
  $("ceReason").value="";
  $("ceStatus").textContent="";
  $("ceStatus").className="small";
  $("ceSave").disabled=false;
  $("ceReceiptRow").hidden=!id;
  if(id) setPhotoGalleryOwner($("ceReceipts"),"cost",id,"");
  updateCostEntryForm();
  openModal("costEntryModal");
  $("ceType").disabled ? $("ceDate").focus() : $("ceType").focus();
}

function readCostEntryForm(){
  const type=$("ceType").value;
  return {
    type,
    projectId:FIN_ENTRY.projectId,
    date:$("ceDate").value,
    description:$("ceDescription").value.trim(),
    vendor:$("ceVendor").value.trim(),
    notes:$("ceNotes").value.trim(),
    quantity:$("ceQty").value,
    unit:$("ceUnit").value,
    unitOther:$("ceUnitOther").value.trim(),
    estUnitCents:toCents($("ceEstUnit").value),
    actUnitCents:toCents($("ceActUnit").value),
    employeeId:$("ceEmployee").value,
    costMethod:$("ceMethod").value,
    startTime:$("ceStart").value,
    endTime:$("ceEnd").value,
    breakMinutes:$("ceBreak").value,
    hours:$("ceHours").value,
    workCategory:$("ceWork").value.trim(),
    amountCents:toCents($("ceAmount").value),
    category:type==="expense" ? $("ceCategory").value : type==="material" ? "materials" : "labor",
    classification:type==="expense" ? $("ceClass").value : "direct"
  };
}

// Shows the fields of the chosen type and the live total.
function updateCostEntryForm(){
  const type=$("ceType").value;
  const method=$("ceMethod").value;
  document.querySelectorAll("#costEntryForm [data-ce-for]").forEach(el=>{
    const kinds=el.dataset.ceFor.split(" ");
    el.hidden=!(kinds.includes(type) || (type==="labor" && kinds.includes("labor-"+method)));
  });
  $("ceUnitOther").hidden=$("ceUnit").value!=="other";
  $("ceDescLabel").textContent=type==="material" ? "Material name" : type==="labor" ? "Description (optional)" : "Description";
  const e=normalizeCostEntry({...readCostEntryForm(),id:"preview",quantity:$("ceQty").value===""?null:$("ceQty").value,hours:$("ceHours").value===""?null:$("ceHours").value});
  let text="";
  if(type==="material"){
    const c=entryCost(e,null);
    text=`Estimated total ${moneyCents(c.estCents)} · Actual total ${c.actMissing ? "—" : moneyCents(c.actCents)}${c.estCents!==null && !c.actMissing ? ` · Variance ${moneyCents(c.estCents-c.actCents)}` : ""}`;
  }else if(type==="labor"){
    const lm=laborMinutes(e);
    if(method==="hourly"){
      $("ceHours").disabled=!!(e.startTime || e.endTime);
      if(lm.error) text=e.startTime || e.endTime || e.hours!==null ? lm.error : "";
      else{
        const rate=finIsManager() ? laborRateOn(e.employeeId,e.date) : null;
        text=`Net hours ${hoursText(lm.minutes)}`+(finIsManager() ? (rate===null ? (e.employeeId ? " · no cost rate set for this person" : "") : ` · labor cost ${moneyCents(Math.round(lm.minutes*rate/60))}`) : "");
      }
    }else text=`Amount ${moneyCents(e.amountCents)}`;
  }else text=`Amount ${moneyCents(e.amountCents)}`;
  $("cePreview").textContent=text;
}

function submitCostEntry(){
  // A second click while saving, or after the window has closed, saves nothing.
  if(FIN_SAVING || !FIN_ENTRY || !$("costEntryModal").classList.contains("open")) return;
  const data=readCostEntryForm();
  const draft=normalizeCostEntry({...data,id:FIN_ENTRY.id || "new"});
  const errs=validateCostEntry(draft);
  if(errs.length){ $("ceStatus").textContent=errs.join(" "); $("ceStatus").className="small fin-over"; return; }
  const dup=findDuplicateEntry(draft);
  if(dup && !confirm(`This looks like a duplicate: ${dup.reason}.\n\nSave it anyway?`)) return;
  FIN_SAVING=true;
  $("ceSave").disabled=true;
  $("ceStatus").textContent="Saving…";
  $("ceStatus").className="small";
  let res;
  try{
    res=FIN_ENTRY.id ? updateCostEntry(FIN_ENTRY.id,data,$("ceReason").value) : addCostEntry(data);
  }finally{
    FIN_SAVING=false;
    $("ceSave").disabled=false;
  }
  if(res.error){ $("ceStatus").textContent=res.error; $("ceStatus").className="small fin-over"; return; }
  const edited=!!FIN_ENTRY.id;
  FIN_ENTRY=null;
  closeModal("costEntryModal");
  showToast(edited ? (finIsManager() ? "Entry saved." : "Entry saved. Changes wait for approval by an owner or admin.")
    : res.state==="approved" ? "Entry added." : "Entry added. It waits for approval by an owner or admin.");
  if(FIN_PROJECT_ID) renderFinancials();
}

/* ---------- Settings: financial defaults, team and cost rates ---------- */

function renderFinanceSettings(){
  const card=$("financeCard");
  const mgr=finIsManager();
  card.hidden=!mgr;
  if(!mgr) return;
  $("setFinLaborRate").value=SETTINGS.finLaborRate;
  $("setFinBurden").value=SETTINGS.finBurdenPercent;
  $("setFinWarn").value=SETTINGS.finWarnPct;
  $("setFinCrit").value=SETTINGS.finCritPct;
  $("setFinAutoApprove").checked=SETTINGS.finAutoApprove!=="no";
  const rates=loadRates();
  const people=loadEmployees().sort((a,b)=>Number(b.active)-Number(a.active) || a.name.localeCompare(b.name));
  $("finTeamBody").innerHTML=people.map(p=>{
    const r=rates.filter(x=>x.employeeId===p.id).sort((a,b)=>a.effectiveFrom.localeCompare(b.effectiveFrom)).pop();
    return `<tr data-emp="${escapeHtml(p.id)}" class="${p.active?"":"fin-row-out"}">
      <td>${escapeHtml(p.name)}${p.userEmail?`<div class="small">${escapeHtml(p.userEmail)}</div>`:""}</td>
      <td>${escapeHtml(labelOf(PAY_TYPES,p.payType))}</td>
      <td class="num">${r ? moneyCents(r.rateCents)+"/h"+(r.burdenPercent?` + ${r.burdenPercent}%`:"")+`<div class="small">from ${escapeHtml(formatDate(r.effectiveFrom))}</div>` : `<span class="small">not set</span>`}</td>
      <td class="fin-actions"><button type="button" class="btn btn-light btn-sm" data-emp-action="rate">Set rate</button>
        <button type="button" class="btn btn-light btn-sm" data-emp-action="toggle">${p.active?"Deactivate":"Activate"}</button></td>
    </tr>`;
  }).join("") || `<tr><td colspan="4" class="muted">No one yet. Add the people who work on jobs, also those without a CRM login.</td></tr>`;
}

function readFinanceSettings(){
  if(!finIsManager() || $("financeCard").hidden) return;
  const n=v=>String(v).trim()==="" ? "" : String(amount(v));
  SETTINGS.finLaborRate=n($("setFinLaborRate").value);
  SETTINGS.finBurdenPercent=n($("setFinBurden").value);
  SETTINGS.finWarnPct=n($("setFinWarn").value) || "90";
  SETTINGS.finCritPct=n($("setFinCrit").value) || "100";
  SETTINGS.finAutoApprove=$("setFinAutoApprove").checked ? "" : "no";
}

function handleTeamCardClick(event){
  const btn=event.target.closest("[data-emp-action],#btnFinAddPerson");
  if(!btn) return;
  if(btn.id==="btnFinAddPerson"){
    const name=$("finNewName").value.trim();
    const res=saveEmployee({name,payType:$("finNewPay").value,userEmail:$("finNewEmail").value.trim()});
    if(res.error){ alert(res.error); return; }
    const rate=toCents($("finNewRate").value);
    if(rate!==null){
      const r=addEmployeeRate(res.id,rate,$("finNewBurden").value,localISODate());
      if(r.error){ alert(r.error); }
    }
    ["finNewName","finNewEmail","finNewRate","finNewBurden"].forEach(i=>{ $(i).value=""; });
    renderFinanceSettings();
    showToast(`${res.name} added to the team.`);
    return;
  }
  const id=btn.closest("tr").dataset.emp;
  const emp=loadEmployees().find(x=>x.id===id);
  if(!emp) return;
  if(btn.dataset.empAction==="toggle"){
    const res=saveEmployee({...emp,active:!emp.active});
    if(res.error) alert(res.error); else renderFinanceSettings();
    return;
  }
  const rate=prompt(`Hourly labor COST rate for ${emp.name} in $ (what the hour costs the company, not the price to the client):`);
  if(rate===null) return;
  const from=prompt("Valid from (YYYY-MM-DD). Entries already approved keep their rate:",localISODate());
  if(from===null) return;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(from)){ alert("Enter the date as YYYY-MM-DD."); return; }
  const burden=prompt("Labor burden % (payroll taxes, insurance, benefits). Leave empty if none or unknown:","");
  if(burden===null) return;
  const res=addEmployeeRate(id,toCents(rate),burden,from);
  if(res.error) alert(res.error); else{ renderFinanceSettings(); showToast(`Rate for ${emp.name} saved.`); }
}

function wireFinanceEvents(){
  $("pmTabs").addEventListener("click",e=>{ const b=e.target.closest("[data-pm-tab]"); if(b) setProjectTab(b.dataset.pmTab); });
  $("pmFinancials").addEventListener("click",handleFinancialsClick);
  $("pmFinancials").addEventListener("change",handleFinancialsChange);
  // Enter in a budget field must not save the project form around it.
  $("pmFinancials").addEventListener("keydown",e=>{ if(e.key==="Enter" && e.target.tagName==="INPUT") e.preventDefault(); });
  $("costEntryForm").addEventListener("submit",e=>{ e.preventDefault(); submitCostEntry(); });
  $("costEntryForm").addEventListener("input",updateCostEntryForm);
  $("costEntryForm").addEventListener("change",updateCostEntryForm);
  $("financeCard").addEventListener("click",handleTeamCardClick);
}
