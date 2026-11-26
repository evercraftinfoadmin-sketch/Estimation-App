"use strict";

/* Change orders: a change to the scope or price of a job after its estimate (the contract) was
   agreed. A change order is a saved estimate with changeOrderOf = the id of the original estimate
   and changeOrderSeq = 1, 2, 3… Its number is the original's number + "-CO1", "-CO2"…
   It holds only the work added (normal categories) and the work removed (the Credit category,
   subtracted), so its total can be negative. It is sent, emailed and signed like an estimate.
   Accepted (or signed) change orders add to the contract: the CRM project's total is the
   original estimate + its accepted change orders, and a new invoice for the job includes them.
   The CRM project stays linked to the original estimate. */

const CHANGE_ORDER_SIGN_TEXT = `CHANGE ORDER APPROVAL

By signing below, I approve Change Order {{estimateNumber}} to estimate {{originalNumber}} for the project at {{address}}.

This change order changes the contract price by {{changeTotal}}. Original contract: {{originalTotal}}. Previously approved change orders: {{previousTotal}}. New contract total: {{newTotal}} (all taxes included).

All other terms and conditions of the original agreement stay the same.

Client: {{client}} · Date: {{date}}`;

function isChangeOrder(est){ return !!(est && est.changeOrderOf); }

// The estimate a change order belongs to (null for a normal estimate or a deleted original).
function changeOrderParent(est){
  return isChangeOrder(est) ? getEstimate(est.changeOrderOf) : null;
}

// "Change Order 2"
function changeOrderLabel(est){
  return `Change Order ${est && est.changeOrderSeq ? est.changeOrderSeq : ""}`.trim();
}

function changeOrderNumber(parent, seq){
  return `${parent.estimateNumber}-CO${seq}`;
}

// The change orders of a job, oldest first. They may belong to any option of the job's offer.
function changeOrdersFor(est, list=loadEstimates()){
  if(!est) return [];
  const root=est.changeOrderOf ? list.find(e=>e.id===est.changeOrderOf) : est;
  if(!root) return [];
  const ids=new Set(root.optionGroup ? list.filter(e=>e.optionGroup===root.optionGroup).map(e=>e.id) : [root.id]);
  return list.filter(e=>e.changeOrderOf && ids.has(e.changeOrderOf))
    .sort((a,b)=>a.changeOrderSeq-b.changeOrderSeq || String(a.createdAt).localeCompare(String(b.createdAt)));
}

function changeOrderApproved(co){ return co.status==="accepted" || co.status==="completed"; }

function nextChangeOrderSeq(parent){
  return loadEstimates().filter(e=>e.changeOrderOf===parent.id).reduce((m,e)=>Math.max(m,e.changeOrderSeq),0)+1;
}

// The total of a change order from its lines (negative when it removes more than it adds).
function changeOrderTotal(co){
  return computeEstimateTotals({items:co.items,taxRate:co.taxRate}).grandTotal;
}

// The contract of a job, for the project, the builder and the change order documents.
//   original: the agreed estimate (several signed options: their sum)
//   approved: all accepted change orders · previous: the accepted ones other than `current`
//   contract: original + approved
function contractSummary(est, current){
  const list=loadEstimates();
  const root=est && est.changeOrderOf ? list.find(e=>e.id===est.changeOrderOf) : est;
  if(!root) return null;
  const original=round2(baseContractTotal(root));
  const cos=changeOrdersFor(root,list);
  const approved=round2(cos.filter(changeOrderApproved).reduce((t,c)=>t+changeOrderTotal(c),0));
  const previous=round2(cos.filter(c=>changeOrderApproved(c) && (!current || c.id!==current.id)).reduce((t,c)=>t+changeOrderTotal(c),0));
  return {root, original, approved, previous, contract:round2(original+approved), changeOrders:cos};
}

// Approved change orders of a CRM project (0 when none): for the Financials page.
function approvedChangeOrdersTotal(project){
  const est=project && project.estimateId ? getEstimate(project.estimateId) : null;
  const s=est ? contractSummary(est) : null;
  return s ? s.approved : 0;
}

// The CRM project of an estimate (or of its offer).
function projectForEstimate(est){
  if(!est) return null;
  const list=loadProjects();
  const ids=new Set(estimateOptions(est).map(e=>e.id));
  return list.find(p=>p.id===est.crmProjectId) || list.find(p=>p.estimateId && ids.has(p.estimateId)) || null;
}

// After a change order is saved, accepted, signed or deleted: the project's total follows.
function refreshProjectContract(projectId){
  const p=getProject(projectId);
  if(!p || !p.estimateId) return;
  const est=getEstimate(p.estimateId);
  if(!est) return;
  const total=projectTotalFor(est);
  if(round2(total)!==round2(p.estimateTotal)) updateProject(p.id,{estimateTotal:total});
}

/* ---------- Creating ---------- */

// Starts a new change order for an estimate (or for the original of a change order) in the builder.
function createChangeOrder(estimateId){
  let parent=getEstimate(estimateId);
  if(!parent) return false;
  if(parent.changeOrderOf){
    parent=changeOrderParent(parent);
    if(!parent){ alert("The original estimate of this change order was deleted."); return false; }
  }
  if(!["accepted","completed"].includes(parent.status) &&
    !confirm(`Estimate ${parent.estimateNumber} is not accepted yet. A change order is for a job the client already agreed to.\n\nCreate a change order anyway?`)) return false;
  if(!confirmDiscardChanges()) return false;
  const project=projectForEstimate(parent);
  const seq=nextChangeOrderSeq(parent);
  closeModal("projectModal");
  newEstimate({
    clientName:parent.clientName,
    clientEmail:parent.clientEmail,
    clientPhone:parent.clientPhone,
    address:parent.address,
    addressFields:normalizeAddressFields(parent),
    crmProjectId:project ? project.id : null,
    changeOrderOf:parent.id,
    changeOrderSeq:seq,
    estimateNumber:changeOrderNumber(parent,seq),
    taxRate:parent.taxRate
  });
  showPage("builder");
  showToast(`Change Order ${seq} for ${parent.estimateNumber}: add the extra work, and the work removed under Credit. Then Save.`);
  return true;
}

/* ---------- Documents ---------- */

function changeOrderSummaryRows(d){
  const s=contractSummary(d,d);
  if(!s) return [];
  return [
    ["Original contract",s.original],
    ["Previously approved change orders",s.previous],
    ["This change order",d.grandTotal],
    ["New contract total",round2(s.original+s.previous+d.grandTotal)]
  ];
}

// The contract table on the change order PDF.
function changeOrderPrintSummary(d){
  const rows=changeOrderSummaryRows(d);
  if(!rows.length) return "";
  return `<table class="pv-totals pv-co-summary">
    ${rows.map(([k,v],i)=>`<tr class="${i===rows.length-1?"pv-grand":""}"><td>${escapeHtml(k)}</td><td class="num">${money(v)}</td></tr>`).join("")}
    <tr><td colspan="2" class="pv-muted">All taxes included. Once approved, this change order is part of the agreement for estimate ${escapeHtml((changeOrderParent(d)||{}).estimateNumber || "")}.</td></tr>
  </table>`;
}

// Values for the change order approval text.
function changeOrderSignValues(d){
  const s=contractSummary(d,d) || {original:0,previous:0,root:{}};
  return {
    estimateNumber:d.estimateNumber,
    originalNumber:s.root.estimateNumber || "",
    address:d.address || "",
    client:d.clientName || "",
    changeTotal:money(d.grandTotal),
    originalTotal:money(s.original),
    previousTotal:money(s.previous),
    newTotal:money(round2(s.original+s.previous+d.grandTotal)),
    date:formatDate(localISODate())
  };
}

function buildChangeOrderEmail(d){
  const s=contractSummary(d,d);
  const lines=[`Hello ${d.clientName || "there"},`,"",
    `As discussed, here is ${changeOrderLabel(d).toLowerCase()} for your project${d.address ? ` at ${d.address}` : ""}`+
    (s ? ` (estimate ${s.root.estimateNumber}).` : "."),""];
  if(d.clientMessage) lines.push(d.clientMessage,"");
  lines.push(`Change Order #: ${d.estimateNumber} (${formatDate(d.date) || "N/A"})`);
  lines.push(`This change: ${money(d.grandTotal)} (all taxes included)`);
  if(s) lines.push(`New contract total: ${money(round2(s.original+s.previous+d.grandTotal))}`);
  lines.push("","The details of the change are in the attached PDF. Please confirm before we do the changed work.","",
    "If you have any questions, just reply to this email or give us a call.","",...emailSignature());
  return lines.join("\n");
}

/* ---------- Builder, CRM and list pieces ---------- */

// Under the builder title: which job this change order belongs to.
function changeOrderMetaHtml(est){
  if(isChangeOrder(est)){
    const parent=changeOrderParent(est);
    return `<span class="co-badge">🔁 ${escapeHtml(changeOrderLabel(est))}</span> of
      ${parent ? `<button class="btn btn-link" data-action="open-option" data-id="${escapeHtml(parent.id)}">estimate ${escapeHtml(parent.estimateNumber)}</button>` : `<span class="muted">a deleted estimate</span>`} `;
  }
  return "";
}

// Change orders of a saved estimate, as buttons, plus "+ Change Order".
function changeOrdersBarHtml(est){
  if(!est || isChangeOrder(est) || est.legacy) return "";
  const cos=changeOrdersFor(est);
  const agreed=["accepted","completed"].includes(est.status) || cos.length;
  if(!agreed) return "";
  const pills=cos.map(c=>`<button type="button" class="opt-pill co-pill" data-action="open-option" data-id="${escapeHtml(c.id)}">${escapeHtml(changeOrderLabel(c))} · ${money(c.customerTotal)} · ${escapeHtml(capitalize(c.status))}</button>`).join("");
  return `<div class="opt-bar">${cos.length?`<span class="small">Change orders:</span> ${pills}`:""}
    <button class="btn btn-link" data-action="create-co" title="Extra work or work removed after the client agreed to this estimate">+ Change Order</button></div>`;
}

// The builder side panel: the contract with this change order.
function renderBuilderContract(d){
  const box=$("sumContract");
  if(!box) return;
  const rows=isChangeOrder(d) ? changeOrderSummaryRows(d) : [];
  box.hidden=!rows.length;
  box.innerHTML=rows.map(([k,v],i)=>`<div class="sum-row${i===rows.length-1?" sum-strong":""}"><span>${escapeHtml(k)}</span><span>${money(v)}</span></div>`).join("");
}

// The project window: the estimate, its change orders and the contract total.
function projectEstimateHtml(p, est, canCreate){
  const s=contractSummary(est);
  const cos=s ? s.changeOrders : [];
  const coRows=cos.map(c=>`<div class="pm-co-row"><span><b>${escapeHtml(changeOrderLabel(c))}</b> · ${escapeHtml(c.estimateNumber)} · ${money(c.customerTotal)}
      <span class="status-badge status-${c.status}">${capitalize(c.status)}</span></span>
      <button class="btn btn-light btn-sm" data-pm-action="open-co" data-id="${escapeHtml(c.id)}">Open</button></div>`).join("");
  return `<div><b>${escapeHtml(est.estimateNumber)}</b> · ${money(est.customerTotal)} · <span class="status-badge status-${est.status}">${capitalize(est.status)}</span></div>
    ${coRows ? `<div class="pm-cos">${coRows}</div>` : ""}
    ${cos.length ? `<div class="pm-contract">Contract total <b>${money(s.contract)}</b> <span class="small">(original ${money(s.original)} + approved change orders ${money(s.approved)})</span></div>` : ""}
    <div class="btn-row"><button class="btn btn-light btn-sm" data-pm-action="open-estimate">Open Estimate</button>
    ${canCreate ? `<button class="btn btn-light btn-sm" data-pm-action="create-co">+ Change Order</button>` : ""}</div>`;
}

// A line on the CRM card: "🔁 2 change orders · 1 approved".
function changeOrdersCardLine(est){
  const cos=est ? changeOrdersFor(est) : [];
  if(!cos.length) return "";
  const approved=cos.filter(changeOrderApproved).length;
  return `<div class="kcard-line">🔁 ${cos.length} change order${cos.length===1?"":"s"}${approved?` · ${approved} approved`:""}</div>`;
}

// Invoice lines for the approved change orders of an estimate ("Change Order 1 · Credit: …").
function changeOrderInvoiceItems(est){
  return changeOrdersFor(est).filter(changeOrderApproved).flatMap(c=>c.items.map(it=>({
    ...it, id:uid("li"),
    name:`${changeOrderLabel(c)} · ${it.category===CREDIT_CATEGORY?"Credit: ":""}${it.name}`,
    categoryName:it.categoryName || categoryLabel(it.category)
  })));
}

// A change order that the client signed is accepted.
function settleChangeOrder(est, signatures){
  if(!isChangeOrder(est)) return;
  const s=latestSignature(signatures,"estimate");
  if(!s || s.status!=="signed" || changeOrderApproved(est)) return;
  updateEstimate(est.id,{status:"accepted",updatedAt:nowISO()});
  if(BUILDER.id===est.id) BUILDER.status="accepted";
  if(est.crmProjectId) refreshProjectContract(est.crmProjectId);
}
