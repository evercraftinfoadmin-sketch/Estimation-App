"use strict";

/* Invoices: created after the job from one signed estimate ("Make Invoice"). The estimate's
   client, address, lines and tax are copied into a separate invoice record that keeps a link to
   it (estimateId) but never changes it: the signed estimate stays the contract. A client with
   several signed estimates gets one invoice per estimate. Payments received are recorded on the
   invoice; Amount paid / Remaining balance and the payment status (Unpaid, Partially Paid,
   Paid in Full) follow from them. Numbers: INV-<year>-<NNNN>, a separate sequence from estimates. */

const INVOICE_PAYMENT_METHODS = ["Cash","Check","Card","Zelle","Bank transfer","Other"];
const INVOICE_DUE_DAYS = 7;
const INVOICE_PAY_STATES = [
  {key:"unpaid", label:"Unpaid"},
  {key:"partial", label:"Partially Paid"},
  {key:"paid", label:"Paid in Full"}
];
const DEFAULT_INVOICE_TERMS = `Payment is due within ${INVOICE_DUE_DAYS} days of the invoice date.`;
let EDITING_INVOICE = null; // the invoice open in the editor (a working copy)
let INV_PAY_PENDING = "";    // "partial" while the user enters the amount received

/* ---------- Data ---------- */

function normalizeInvoice(i){
  const items=(Array.isArray(i.items) ? i.items : []).filter(it=>it).map(it=>({
    id:String(it.id || uid("li")),
    category:String(it.category || "invoice"),
    categoryName:String(it.categoryName ?? ""),
    name:String(it.name ?? ""),
    description:String(it.description ?? ""),
    quantity:amount(it.quantity),
    price:amount(it.price),
    total:round2(it.category===CREDIT_CATEGORY ? -amount(Math.abs(num(it.total))) : amount(it.total))
  }));
  const payments=(Array.isArray(i.payments) ? i.payments : []).filter(p=>p).map(p=>({
    id:String(p.id || uid("pay")),
    date:String(p.date ?? ""),
    amount:round2(amount(p.amount)),
    method:INVOICE_PAYMENT_METHODS.includes(p.method) ? p.method : "Other",
    note:String(p.note ?? "")
  }));
  return {
    id:String(i.id),
    invoiceNumber:String(i.invoiceNumber ?? ""),
    date:String(i.date ?? ""),
    dueDate:String(i.dueDate ?? ""),
    estimateId:i.estimateId || null,
    estimateNumber:String(i.estimateNumber ?? ""),
    estimateOption:String(i.estimateOption ?? ""),
    crmProjectId:i.crmProjectId || null,
    // The client and the property (address) of the job, for the client's invoice list.
    client_id:String(i.client_id ?? ""),
    propertyId:String(i.propertyId ?? ""),
    clientName:String(i.clientName ?? ""),
    clientEmail:String(i.clientEmail ?? ""),
    clientPhone:String(i.clientPhone ?? ""),
    address:String(i.address ?? ""),
    items,
    markup:amount(i.markup),
    taxRate:amount(i.taxRate),
    taxMode:i.taxMode==="subtotal" ? "subtotal" : "all",
    subtotal:round2(amount(i.subtotal)),
    markupAmount:round2(amount(i.markupAmount)),
    taxAmount:round2(amount(i.taxAmount)),
    total:round2(amount(i.total)),
    payments,
    paid:round2(amount(i.paid)),
    balance:round2(amount(i.balance)),
    status:["draft","sent","void"].includes(i.status) ? i.status : "draft",
    clientMessage:String(i.clientMessage ?? ""),
    scope:String(i.scope ?? ""),               // scope of work (on the PDF)
    paymentTerms:String(i.paymentTerms ?? ""), // payment terms (on the PDF and in the email)
    amountDue:round2(amount(i.amountDue)),     // amount asked for now (e.g. a deposit); 0 = the full balance
    notes:String(i.notes ?? ""),               // internal notes, never shown to the client
    createdAt:i.createdAt || nowISO(),
    updatedAt:i.updatedAt || i.createdAt || nowISO()
  };
}

function loadInvoices(){
  const list=readStore(STORAGE_KEYS.invoices,[]);
  return Array.isArray(list) ? list.filter(i=>i && i.id).map(normalizeInvoice) : [];
}
function saveInvoices(list){ return writeStore(STORAGE_KEYS.invoices,list); }
function getInvoice(id){ return loadInvoices().find(i=>i.id===id) || null; }

// Totals come from the same engine as estimates; payments give Paid and Balance due.
function computeInvoice(inv){
  const t=computeEstimateTotals({items:inv.items,taxRate:inv.taxRate});
  const paid=round2(inv.payments.reduce((s,p)=>s+amount(p.amount),0));
  return {...inv, items:t.items, subtotal:t.subtotal, markup:t.markup, markupAmount:t.markupAmount,
    taxRate:t.taxRate, taxMode:t.taxMode, taxAmount:t.taxAmount, total:t.grandTotal,
    paid, balance:round2(t.grandTotal-paid)};
}

// Payment status from the payments: unpaid (nothing received), partial, paid (balance $0).
function invoicePayState(inv){
  if(inv.paid>0 && inv.balance<=0) return "paid";
  if(inv.paid>0) return "partial";
  return "unpaid";
}

// The status shown in lists: Void, Paid in Full, Partially Paid, or Unpaid (sent or still a draft).
function invoicePaymentStatus(inv){
  if(inv.status==="void") return {key:"void",label:"Void"};
  const pay=invoicePayState(inv);
  if(pay==="paid") return {key:"paid",label:"Paid in Full"};
  if(pay==="partial") return {key:"partial",label:"Partially Paid"};
  if(inv.status==="sent") return {key:"sent",label:"Unpaid · Sent"};
  return {key:"draft",label:"Unpaid · Draft"};
}

// What the client is asked to pay now: the amount due set on the invoice (e.g. a deposit), at
// most the remaining balance; otherwise the whole remaining balance.
function invoiceAmountDueNow(inv){
  if(inv.status==="void" || inv.balance<=0) return 0;
  return inv.amountDue>0 ? round2(Math.min(inv.amountDue,inv.balance)) : inv.balance;
}

function invoiceSeq(number){
  const m=String(number || "").match(/^INV-(\d{4})-(\d+)$/i);
  return m ? {year:Number(m[1]),n:Number(m[2])} : null;
}
function nextInvoiceNumber(list=loadInvoices()){
  const year=companyYear();
  const used=list.map(i=>invoiceSeq(i.invoiceNumber)).filter(s=>s && s.year===year).map(s=>s.n);
  const n=Math.max(1000,...used)+1;
  return `INV-${year}-${String(n).padStart(4,"0")}`;
}

function newInvoiceRecord(data={}){
  const date=localISODate();
  return computeInvoice(normalizeInvoice({
    id:uid("inv"), invoiceNumber:nextInvoiceNumber(), date, dueDate:addDays(date,INVOICE_DUE_DAYS),
    markup:0, taxRate:SETTINGS.salesTax, taxMode:SETTINGS.taxMode, items:[], payments:[], status:"draft",
    paymentTerms:DEFAULT_INVOICE_TERMS, ...data
  }));
}

// "Work as described in estimate EST-2026-1042 (Option B): Drywall, Painting. Includes approved
// Change Order 1." — the starting scope of work of an invoice made from an estimate.
function invoiceScopeFromEstimate(est){
  const cats=estimateCategories(est).filter(c=>c.key!==CREDIT_CATEGORY && est.items.some(it=>it.category===c.key)).map(c=>c.label);
  const cos=changeOrdersFor(est).filter(changeOrderApproved);
  return `Work as described in estimate ${est.estimateNumber}${est.optionLabel?` (${est.optionLabel})`:""}`+
    (cats.length ? `: ${cats.join(", ")}.` : ".")+
    (cos.length ? ` Includes approved ${cos.map(changeOrderLabel).join(", ")}.` : "");
}

// A new invoice record from one estimate: a separate copy (new line ids) of its client, address,
// lines and tax, plus the lines of its accepted change orders (work removed is subtracted).
// It keeps the estimate's id, its CRM project, client and property. The estimate is not changed.
function invoiceFromEstimate(est, projectId){
  const project=(projectId && getProject(projectId)) || projectForEstimate(est);
  return newInvoiceRecord({
    estimateId:est.id, estimateNumber:est.estimateNumber, estimateOption:est.optionGroup ? est.optionLabel : "",
    crmProjectId:(project && project.id) || est.crmProjectId || null,
    client_id:(project && project.client_id) || est.client_id || "", propertyId:(project && project.propertyId) || "",
    clientName:est.clientName, clientEmail:est.clientEmail, clientPhone:est.clientPhone, address:est.address,
    items:[...clone(est.items).map(it=>({...it,id:uid("li"),categoryName:it.categoryName || categoryLabel(it.category)})),...changeOrderInvoiceItems(est)],
    markup:0, taxRate:est.taxRate, taxMode:est.taxMode, clientMessage:est.clientMessage || "",
    scope:invoiceScopeFromEstimate(est)
  });
}

function invoicesForEstimate(estimateId){ return loadInvoices().filter(i=>i.estimateId===estimateId && i.status!=="void"); }
function invoicesForProject(projectId){ return loadInvoices().filter(i=>i.crmProjectId===projectId && i.status!=="void"); }
// The (one, not void) invoice made from an estimate, or null.
function invoiceForEstimate(estimateId){ return estimateId ? invoicesForEstimate(estimateId)[0] || null : null; }

// The invoice of a CRM project: the one made from its estimate; for a job without an estimate,
// the one made for the project itself. Invoices of other estimates of the same client never count.
function projectInvoice(p){
  if(!p) return null;
  if(p.estimateId && getEstimate(p.estimateId)) return invoiceForEstimate(p.estimateId);
  return invoicesForProject(p.id).find(i=>!i.estimateId || !getEstimate(i.estimateId)) || null;
}

// A client signed the estimate, or it was marked Accepted / Completed.
function estimateIsAgreed(est){
  if(!est) return false;
  if(["accepted","completed"].includes(est.status)) return true;
  const s=latestSignature(est.signatures,"estimate");
  return !!(s && s.status==="signed");
}

/* ---------- Entry points (Estimate page, saved estimates, CRM, client, Invoices page) ---------- */

// "Make Invoice" / "View Invoice" for one estimate: opens its invoice, or makes a new one from it
// (only for a signed / accepted estimate). A change order is billed on its estimate's invoice.
function makeInvoiceForEstimate(estimateId){
  const est=getEstimate(estimateId);
  if(!est) return false;
  if(isChangeOrder(est)){
    const parent=changeOrderParent(est);
    if(!parent){ alert("This change order's estimate was deleted, so there is no invoice to add it to."); return false; }
    return makeInvoiceForEstimate(parent.id);
  }
  const existing=invoiceForEstimate(est.id);
  if(existing){ openInvoiceEditor(existing.id); return true; }
  if(est.legacy){ alert("This estimate was made with the old calculator. Open it, re-enter its services and save it first."); return false; }
  if(!estimateIsAgreed(est)){
    alert(`Estimate ${est.estimateNumber} is not signed yet.\n\nAn invoice is made from a signed estimate (the contract). Send it for signature, or set its status to Accepted when the client agreed another way, then make the invoice.`);
    return false;
  }
  openInvoiceEditor(null, invoiceFromEstimate(est));
  return true;
}

// Older name, used by the Saved Estimates list.
function createOrOpenInvoiceForEstimate(estimateId){ return makeInvoiceForEstimate(estimateId); }

function createOrOpenInvoiceForProject(projectId){
  const p=getProject(projectId);
  if(!p) return;
  const existing=projectInvoice(p);
  if(existing){ openInvoiceEditor(existing.id); return; }
  const est=p.estimateId ? getEstimate(p.estimateId) : null;
  if(est) return makeInvoiceForEstimate(est.id);
  openInvoiceEditor(null, newInvoiceRecord({
    crmProjectId:p.id, client_id:p.client_id, propertyId:p.propertyId,
    clientName:p.clientName, clientEmail:p.clientEmail, clientPhone:p.clientPhone, address:p.address
  }));
}

// Every invoice of a client: through the client's CRM projects (and their estimates).
function clientInvoices(clientId){
  if(!clientId) return [];
  const projectIds=new Set(clientProjects(clientId).map(p=>p.id));
  const estimates=loadEstimates();
  const estProject=new Map(estimates.map(e=>[e.id,e.crmProjectId]));
  return loadInvoices().filter(i=>i.client_id===clientId || projectIds.has(i.crmProjectId) ||
    (i.estimateId && projectIds.has(estProject.get(i.estimateId))))
    .sort((a,b)=>String(b.date).localeCompare(String(a.date)) || b.invoiceNumber.localeCompare(a.invoiceNumber));
}

// A short table of invoices (client and project windows). Each row opens the invoice.
function invoiceRowsHtml(list, attr){
  if(!list.length) return "";
  return `<div class="table-wrap"><table class="table responsive-table inv-mini">
    <thead><tr><th>Invoice #</th><th>Estimate</th><th>Property</th><th class="num">Total</th><th>Status</th><th class="num">Balance</th><th></th></tr></thead>
    <tbody>${list.map(i=>{ const st=invoicePaymentStatus(i); return `<tr>
      <td data-label="Invoice #" class="nowrap"><b>${escapeHtml(i.invoiceNumber)}</b></td>
      <td data-label="Estimate" class="nowrap">${escapeHtml(i.estimateNumber || "—")}${i.estimateOption?` <span class="small">${escapeHtml(i.estimateOption)}</span>`:""}</td>
      <td data-label="Property">${escapeHtml(i.address || "—")}</td>
      <td data-label="Total" class="num nowrap">${money(i.total)}</td>
      <td data-label="Status"><span class="status-badge inv-${st.key}">${escapeHtml(st.label)}</span></td>
      <td data-label="Balance" class="num nowrap"><b>${money(i.status==="void"?0:i.balance)}</b></td>
      <td><button type="button" class="btn btn-light btn-sm" ${attr}="${escapeHtml(i.id)}">Open</button></td>
    </tr>`; }).join("")}</tbody></table></div>`;
}

/* ---------- Invoices page ---------- */

function renderInvoicesPage(){
  const all=loadInvoices();
  const query=$("invoiceSearch").value.trim().toLowerCase();
  const filter=$("invoiceStatusFilter").value;
  const list=all
    .filter(i=>filter==="all" || invoicePaymentStatus(i).key===filter ||
      (filter==="open" && ["draft","sent","partial"].includes(invoicePaymentStatus(i).key)) ||
      (filter==="unpaid" && ["draft","sent"].includes(invoicePaymentStatus(i).key)))
    .filter(i=>!query || [i.invoiceNumber,i.clientName,i.address,i.estimateNumber,i.clientEmail,i.clientPhone].some(v=>v.toLowerCase().includes(query)))
    .sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const open=all.filter(i=>!["void","paid"].includes(invoicePaymentStatus(i).key));
  $("invoicesSummary").innerHTML=`<span class="imp-chip">${all.length} invoice(s)</span>
    <span class="imp-chip">Outstanding: <b>${money(open.reduce((s,i)=>s+i.balance,0))}</b></span>`;
  $("invoicesBody").innerHTML=list.map(i=>{
    const st=invoicePaymentStatus(i);
    return `<tr data-id="${escapeHtml(i.id)}">
      <td data-label="Invoice #" class="nowrap"><b>${escapeHtml(i.invoiceNumber)}</b>${i.estimateNumber?`<div class="small">from ${escapeHtml(i.estimateNumber)}${i.estimateOption?` · ${escapeHtml(i.estimateOption)}`:""}</div>`:""}</td>
      <td data-label="Client">${escapeHtml(i.clientName||"—")}<div class="small">${escapeHtml(i.address||"")}</div></td>
      <td data-label="Date" class="nowrap">${escapeHtml(formatDate(i.date))}<div class="small">due ${escapeHtml(formatDate(i.dueDate)||"—")}</div></td>
      <td data-label="Status"><span class="status-badge inv-${st.key}">${st.label}</span></td>
      <td data-label="Total" class="nowrap"><b>${money(i.total)}</b></td>
      <td data-label="Paid" class="nowrap">${money(i.paid)}</td>
      <td data-label="Balance" class="nowrap"><b>${money(i.status==="void"?0:i.balance)}</b></td>
      <td data-label="Actions"><div class="row-actions"><button class="btn btn-primary btn-sm" data-action="open">Open</button></div></td>
    </tr>`;
  }).join("");
  const empty=$("invoicesEmpty");
  empty.hidden=list.length>0;
  empty.textContent=all.length ? "No invoices match your search." : "No invoices yet. Open a signed estimate and press Make Invoice, or use a completed job in the CRM, or + New Invoice.";
}

function handleInvoicesTable(e){
  const btn=e.target.closest("[data-action]");
  const id=btn?.closest("tr")?.dataset.id;
  if(btn && id) openInvoiceEditor(id);
}

/* ---------- Editor ---------- */

function openInvoiceEditor(id, draft){
  const inv=id ? getInvoice(id) : draft;
  if(!inv) return;
  EDITING_INVOICE={...clone(inv), isNew:!id};
  $("invClientName").value=inv.clientName;
  $("invClientEmail").value=inv.clientEmail;
  $("invClientPhone").value=inv.clientPhone;
  $("invAddress").value=inv.address;
  $("invNumber").value=inv.invoiceNumber;
  $("invDate").value=inv.date;
  $("invDueDate").value=inv.dueDate;
  $("invTaxRate").value=inv.taxRate;
  $("invMessage").value=inv.clientMessage;
  $("invScope").value=inv.scope;
  $("invTerms").value=inv.paymentTerms;
  $("invAmountDue").value=inv.amountDue || "";
  $("invNotes").value=inv.notes;
  INV_PAY_PENDING="";
  $("invPayDate").value=localISODate();
  $("invPayAmount").value="";
  $("invPayMethod").innerHTML=INVOICE_PAYMENT_METHODS.map(m=>`<option>${m}</option>`).join("");
  $("invPayNote").value="";
  $("invoiceModalTitle").textContent=id ? `Invoice ${inv.invoiceNumber}` : "New Invoice";
  $("invEstimateLink").innerHTML=invoiceSourceHtml(inv);
  $("invDelete").hidden=!id;
  renderInvoiceEditor();
  openModal("invoiceModal");
}

// "From signed estimate EST-… · Option B · CRM project …": which contract this invoice bills.
function invoiceSourceHtml(inv){
  if(!inv.estimateNumber) return inv.crmProjectId && getProject(inv.crmProjectId) ? `For CRM project <b>${escapeHtml(projectLabel(getProject(inv.crmProjectId)))}</b>` : "";
  const est=getEstimate(inv.estimateId);
  const s=est ? latestSignature(est.signatures,"estimate") : null;
  const signed=s && s.status==="signed" ? ` · signed ✓ ${escapeHtml(formatDate(String(s.signedAt).slice(0,10)))}` : est ? ` · ${escapeHtml(capitalize(est.status))}` : " · estimate deleted";
  return `From estimate <b>${escapeHtml(inv.estimateNumber)}</b>${inv.estimateOption?` (${escapeHtml(inv.estimateOption)})`:""}${signed}`+
    (est ? ` <button type="button" class="btn btn-link" data-inv="open-estimate">Open estimate</button>` : "")+
    `<div class="small">Changes here stay on this invoice: the estimate (the signed contract) is not changed.</div>`;
}

// Reads the form into the working copy and recomputes the totals.
function readInvoiceForm(){
  const inv=EDITING_INVOICE;
  Object.assign(inv,{
    clientName:$("invClientName").value.trim(), clientEmail:$("invClientEmail").value.trim(),
    clientPhone:$("invClientPhone").value.trim(), address:$("invAddress").value.trim(),
    invoiceNumber:$("invNumber").value.trim(), date:$("invDate").value, dueDate:$("invDueDate").value,
    taxRate:$("invTaxRate").value, clientMessage:$("invMessage").value.trim(),
    scope:$("invScope").value.trim(), paymentTerms:$("invTerms").value.trim(),
    amountDue:$("invAmountDue").value, notes:$("invNotes").value.trim()
  });
  document.querySelectorAll("#invItems tr[data-id]").forEach(row=>{
    const it=inv.items.find(x=>x.id===row.dataset.id);
    if(!it) return;
    it.name=row.querySelector('[data-f="name"]').value;
    it.description=row.querySelector('[data-f="description"]').value;
    it.quantity=row.querySelector('[data-f="quantity"]').value;
    it.price=row.querySelector('[data-f="price"]').value;
  });
  EDITING_INVOICE={...computeInvoice(normalizeInvoice(inv)), isNew:inv.isNew};
  return EDITING_INVOICE;
}

function renderInvoiceEditor(){
  const inv=EDITING_INVOICE=({...computeInvoice(normalizeInvoice(EDITING_INVOICE)), isNew:EDITING_INVOICE.isNew});
  $("invItems").innerHTML=inv.items.map(it=>`
    <tr data-id="${escapeHtml(it.id)}">
      <td><input data-f="name" value="${escapeHtml(it.name)}" placeholder="Service" aria-label="Service"></td>
      <td><input data-f="description" value="${escapeHtml(it.description)}" placeholder="Description (optional)" aria-label="Description"></td>
      <td class="num"><input data-f="quantity" type="number" step="any" min="0" value="${it.quantity}" aria-label="Quantity"></td>
      <td class="num"><input data-f="price" type="number" step="any" min="0" value="${it.price}" aria-label="Price"></td>
      <td class="num nowrap" data-total>${money(it.total)}</td>
      <td><button type="button" class="btn-icon" data-inv="remove-line" aria-label="Remove line">✕</button></td>
    </tr>`).join("") || `<tr><td colspan="6" class="muted">No lines yet. Add a line.</td></tr>`;
  $("invPayments").innerHTML=inv.payments.map(p=>`
    <tr data-pay="${escapeHtml(p.id)}"><td class="nowrap">${escapeHtml(formatDate(p.date))}</td><td>${escapeHtml(p.method)}</td>
      <td>${escapeHtml(p.note)}</td><td class="num nowrap">${money(p.amount)}</td>
      <td><button type="button" class="btn-icon" data-inv="remove-payment" aria-label="Remove payment">✕</button></td></tr>`).join("")
    || `<tr><td colspan="5" class="muted">No payments recorded yet.</td></tr>`;
  renderInvoiceTotals();
}

function renderInvoiceTotals(){
  const inv=EDITING_INVOICE;
  const st=invoicePaymentStatus(inv);
  document.querySelectorAll("#invItems tr[data-id]").forEach(row=>{
    const it=inv.items.find(x=>x.id===row.dataset.id);
    if(it) row.querySelector("[data-total]").textContent=money(it.total);
  });
  const due=invoiceAmountDueNow(inv);
  $("invTotals").innerHTML=`
    <div class="sum-row"><span>Subtotal</span><span>${money(inv.subtotal)}</span></div>
    <div class="sum-row"><span>Sales Tax (${formatQty(inv.taxRate)}%)</span><span>${money(inv.taxAmount)}</span></div>
    <div class="sum-row sum-strong"><span>INVOICE TOTAL</span><span>${money(inv.total)}</span></div>
    <div class="sum-row"><span>Amount paid</span><span id="invPaid">${money(inv.paid)}</span></div>
    <div class="sum-row sum-strong"><span>REMAINING BALANCE</span><span id="invBalance">${money(inv.status==="void"?0:inv.balance)}</span></div>
    ${due>0 && due<inv.balance ? `<div class="sum-row"><span>Amount due now</span><span id="invDueNow">${money(due)}</span></div>` : ""}
    <div><span class="status-badge inv-${st.key}" id="invStatus">${st.label}</span></div>`;
  const state=invoicePayState(inv);
  $("invPayState").value=INV_PAY_PENDING && state==="unpaid" ? INV_PAY_PENDING : state;
  $("invPayState").disabled=inv.status==="void";
  $("invPayHint").textContent=INV_PAY_PENDING==="partial" && state==="unpaid"
    ? "Enter the amount received so far below and press Record payment. The remaining balance is worked out for you."
    : state==="partial" ? `Received ${money(inv.paid)} of ${money(inv.total)}. Remaining balance ${money(inv.balance)}.`
    : state==="paid" ? "Paid in full: nothing left to pay."
    : "No payment received yet.";
  $("invVoid").textContent=inv.status==="void" ? "Restore (un-void)" : "Void";
}

// The Payment status menu: Unpaid removes the recorded payments, Paid in Full records the
// remaining balance as paid, Partially Paid asks for the amount received.
function setInvoicePayState(state){
  const inv=readInvoiceForm();
  const current=invoicePayState(inv);
  INV_PAY_PENDING="";
  if(state==="paid" && inv.balance>0){
    inv.payments.push({id:uid("pay"),date:$("invPayDate").value || localISODate(),amount:inv.balance,method:$("invPayMethod").value,note:"Paid in full"});
  }else if(state==="unpaid" && inv.payments.length){
    if(!confirm(`Mark invoice ${inv.invoiceNumber} as Unpaid? The ${inv.payments.length} recorded payment(s) (${money(inv.paid)}) are removed.`)){ renderInvoiceTotals(); return; }
    inv.payments=[];
  }else if(state==="partial"){
    if(current==="paid"){
      if(!confirm(`Invoice ${inv.invoiceNumber} is paid in full. Remove the recorded payments and enter the amount received so far instead?`)){ renderInvoiceTotals(); return; }
      inv.payments=[];
    }
    if(current!=="partial"){
      INV_PAY_PENDING="partial";
      renderInvoiceEditor();
      $("invPayAmount").focus();
      return;
    }
  }
  renderInvoiceEditor();
}

function handleInvoiceModalInput(e){
  if(e.target.closest("#invItems") || e.target.id==="invTaxRate"){ readInvoiceForm(); renderInvoiceTotals(); }
}

function handleInvoiceModalClick(e){
  const btn=e.target.closest("[data-inv]");
  if(!btn) return;
  const inv=readInvoiceForm();
  const action=btn.dataset.inv;
  if(action==="add-line"){
    inv.items.push({id:uid("li"),category:"invoice",categoryName:"",name:"",description:"",quantity:1,price:0,total:0});
    renderInvoiceEditor();
    const rows=document.querySelectorAll("#invItems tr[data-id]");
    rows[rows.length-1]?.querySelector('[data-f="name"]').focus();
  }else if(action==="remove-line"){
    const id=btn.closest("tr").dataset.id;
    inv.items=inv.items.filter(it=>it.id!==id);
    renderInvoiceEditor();
  }else if(action==="pay-fill"){
    const share=Number(btn.dataset.share);
    $("invPayAmount").value=share ? round2(inv.total*share/100) : Math.max(0,inv.balance);
  }else if(action==="open-estimate"){
    const est=getEstimate(inv.estimateId);
    if(!est) return;
    if(!inv.isNew && !saveInvoiceForm({quiet:true})) return;
    closeModal("invoiceModal");
    openEstimate(est.id);
  }else if(action==="add-payment"){
    const value=round2(amount($("invPayAmount").value));
    if(!(value>0)){ alert("Enter the amount received."); $("invPayAmount").focus(); return; }
    INV_PAY_PENDING="";
    inv.payments.push({id:uid("pay"),date:$("invPayDate").value || localISODate(),amount:value,method:$("invPayMethod").value,note:$("invPayNote").value.trim()});
    $("invPayAmount").value=""; $("invPayNote").value="";
    renderInvoiceEditor();
  }else if(action==="remove-payment"){
    const id=btn.closest("tr").dataset.pay;
    if(!confirm("Remove this payment?")) return;
    inv.payments=inv.payments.filter(p=>p.id!==id);
    renderInvoiceEditor();
  }else if(action==="void"){
    if(inv.status!=="void" && !confirm(`Void invoice ${inv.invoiceNumber}? It stays in the list but no longer counts as owed.`)) return;
    inv.status=inv.status==="void" ? "draft" : "void";
    renderInvoiceTotals();
  }else if(action==="print"){
    if(!saveInvoiceForm({quiet:true})) return;
    printInvoice(EDITING_INVOICE);
  }else if(action==="pdf"){
    if(!saveInvoiceForm({quiet:true})) return;
    const inv2=EDITING_INVOICE;
    downloadPdf(()=>renderInvoicePrint(inv2),invoicePdfName(inv2));
  }else if(action==="email"){
    if(!inv.clientEmail){ alert("Please enter the client's email address."); $("invClientEmail").focus(); return; }
    if(!saveInvoiceForm({quiet:true})) return;
    emailInvoice(EDITING_INVOICE);
  }
}

function saveInvoiceForm({quiet=false}={}){
  const inv=readInvoiceForm();
  if(!inv.clientName && !inv.address){ alert("Please enter at least a client name or an address."); $("invClientName").focus(); return false; }
  if(inv.items.some(it=>!it.name.trim())){ alert("Every line needs a service name (or remove the empty line)."); return false; }
  const list=loadInvoices();
  if(!inv.invoiceNumber) inv.invoiceNumber=nextInvoiceNumber(list);
  if(list.some(i=>i.invoiceNumber===inv.invoiceNumber && i.id!==inv.id)){
    const next=nextInvoiceNumber(list);
    if(!confirm(`Invoice # ${inv.invoiceNumber} is already used.\nUse ${next} instead?`)) return false;
    inv.invoiceNumber=next; $("invNumber").value=next;
  }
  // One invoice per estimate: a second one from the same estimate is not made.
  const twin=inv.estimateId && inv.status!=="void" && list.find(i=>i.id!==inv.id && i.estimateId===inv.estimateId && i.status!=="void");
  if(twin){
    alert(`Estimate ${inv.estimateNumber} already has invoice ${twin.invoiceNumber}. It is opened instead, so the client is not billed twice.`);
    openInvoiceEditor(twin.id);
    return false;
  }
  const {isNew, ...data}=inv;
  const record={...computeInvoice(normalizeInvoice(data)), updatedAt:nowISO()};
  const index=list.findIndex(i=>i.id===record.id);
  if(index>=0) list[index]=record; else list.push(record);
  if(!saveInvoices(list)) return false;
  EDITING_INVOICE={...record,isNew:false};
  $("invoiceModalTitle").textContent=`Invoice ${record.invoiceNumber}`;
  $("invDelete").hidden=false;
  renderInvoicesPage();
  renderCrmBoard();
  renderSavedEstimates();
  updateBuilderMeta();
  if(!quiet) showToast(`Invoice ${record.invoiceNumber} saved.`);
  return true;
}

function markInvoiceSent(){
  const inv=EDITING_INVOICE;
  if(inv && inv.status==="draft"){ inv.status="sent"; saveInvoiceForm({quiet:true}); renderInvoiceTotals(); }
}

function deleteInvoice(id){
  const inv=getInvoice(id);
  if(!inv) return;
  if(typeof cloudDeleteRefused==="function" && cloudDeleteRefused()) return;
  if(!confirm(`Delete invoice ${inv.invoiceNumber}? This cannot be undone. (To keep a record, use Void instead.)`)) return;
  if(!saveInvoices(loadInvoices().filter(i=>i.id!==id))) return;
  closeModal("invoiceModal");
  renderInvoicesPage();
  renderCrmBoard();
  renderSavedEstimates();
  updateBuilderMeta();
  showToast(`Invoice ${inv.invoiceNumber} deleted.`);
}

/* ---------- Print / PDF and email ---------- */

function renderInvoicePrint(inv){
  const st=invoicePaymentStatus(inv);
  const companyLine=companyContactParts().map(escapeHtml).join(" · ");
  $("printView").innerHTML=`
    <div class="pv">
      <header class="pv-header">
        ${docBrandHtml(companyLine)}
        <div class="pv-title">
          <div class="pv-doc">INVOICE</div>
          <table class="pv-meta">
            <tr><td>Invoice #</td><td>${escapeHtml(inv.invoiceNumber)}</td></tr>
            <tr><td>Date</td><td>${escapeHtml(formatDate(inv.date))}</td></tr>
            ${inv.dueDate?`<tr><td>Due date</td><td>${escapeHtml(formatDate(inv.dueDate))}</td></tr>`:""}
            ${inv.estimateNumber?`<tr><td>Estimate #</td><td>${escapeHtml(inv.estimateNumber)}${inv.estimateOption?` (${escapeHtml(inv.estimateOption)})`:""}</td></tr>`:""}
          </table>
        </div>
      </header>
      <div class="pv-parties">
        <div><h4>Bill to</h4><div><b>${escapeHtml(inv.clientName||"—")}</b></div>
          ${inv.clientEmail?`<div>${escapeHtml(inv.clientEmail)}</div>`:""}${inv.clientPhone?`<div>${escapeHtml(inv.clientPhone)}</div>`:""}</div>
        <div><h4>Project Address</h4><div>${escapeHtml(inv.address||"—")}</div></div>
      </div>
      ${inv.clientMessage?`<section class="pv-message">${escapeHtml(inv.clientMessage)}</section>`:""}
      ${inv.scope?`<section class="pv-section"><h3>SCOPE OF WORK</h3><div class="pv-terms-text">${escapeHtml(inv.scope)}</div></section>`:""}
      <section class="pv-section">
        <table class="pv-table">
          <thead><tr><th>Service</th><th class="num">Quantity</th><th class="num">Price</th><th class="num">Total</th></tr></thead>
          <tbody>${clientPricedLines(inv.items,inv.total).map(it=>`<tr><td>${escapeHtml(it.name||"Service")}${it.description?`<div class="pv-desc">${escapeHtml(it.description)}</div>`:""}</td>
            <td class="num">${formatQty(it.quantity)}</td><td class="num">${clientUnitPrice(it)}</td><td class="num">${money(it.total)}</td></tr>`).join("")}</tbody>
        </table>
      </section>
      <table class="pv-totals">
        <tr class="pv-grand"><td>TOTAL</td><td class="num">${money(inv.total)}</td></tr>
        <tr><td colspan="2" class="pv-muted">All taxes included</td></tr>
        ${inv.payments.map(p=>`<tr><td>Paid ${escapeHtml(formatDate(p.date))} · ${escapeHtml(p.method)}</td><td class="num">−${money(p.amount)}</td></tr>`).join("")}
        <tr class="pv-grand"><td>${st.key==="void"?"VOID":"BALANCE DUE"}</td><td class="num">${money(st.key==="void"?0:inv.balance)}</td></tr>
        ${invoiceAmountDueNow(inv)>0 && invoiceAmountDueNow(inv)<inv.balance?`<tr class="pv-grand"><td>AMOUNT DUE NOW</td><td class="num">${money(invoiceAmountDueNow(inv))}</td></tr>`:""}
        ${st.key!=="void"?`<tr><td colspan="2" class="pv-muted">Payment status: ${escapeHtml((INVOICE_PAY_STATES.find(s=>s.key===invoicePayState(inv))||{}).label||"")}</td></tr>`:""}
      </table>
      ${inv.paymentTerms?`<section class="pv-terms"><h3>PAYMENT TERMS</h3><div class="pv-terms-text">${escapeHtml(inv.paymentTerms)}</div></section>`:""}
      ${SETTINGS.terms.trim()?`<section class="pv-terms"><h3>TERMS AND CONDITIONS</h3><div class="pv-terms-text">${formatTermsHtml(SETTINGS.terms.trim())}</div></section>`:""}
      ${SETTINGS.estimateFooter?`<footer class="pv-footer">${escapeHtml(SETTINGS.estimateFooter)}</footer>`:""}
    </div>`;
}

function invoicePdfName(inv){
  return `${companyName()} Invoice ${inv.invoiceNumber}.pdf`.trim();
}

function printInvoice(inv){
  renderInvoicePrint(inv);
  const original=document.title;
  document.title=`${companyName()} Invoice ${inv.invoiceNumber}`.trim();
  markInvoiceSent();
  window.print();
  document.title=original;
}

// The email sent from the CRM with the PDF attached: only the basics; the lines and terms are in the PDF.
function buildInvoiceEmailSummary(inv){
  const lines=[`Hello ${inv.clientName || "there"},`,"",
    `Thank you for choosing ${companyName()}! Here is the invoice for your project${inv.address ? ` at ${inv.address}` : ""}.`,""];
  if(inv.clientMessage) lines.push(inv.clientMessage,"");
  lines.push(`Invoice #: ${inv.invoiceNumber} (${formatDate(inv.date)})`);
  lines.push(`TOTAL: ${money(inv.total)} (all taxes included)`);
  if(inv.paid>0 && inv.status!=="void") lines.push(`Paid: ${money(inv.paid)}`);
  lines.push(`BALANCE DUE: ${money(inv.status==="void"?0:inv.balance)}${inv.dueDate && inv.balance>0 && inv.status!=="void" ? ` by ${formatDate(inv.dueDate)}` : ""}`);
  const due=invoiceAmountDueNow(inv);
  if(due>0 && due<inv.balance) lines.push(`AMOUNT DUE NOW: ${money(due)}`);
  if(inv.paymentTerms && inv.status!=="void") lines.push("",`Payment terms: ${inv.paymentTerms}`);
  lines.push("","The full invoice with all the details is in the attached PDF.","",
    "If you have any questions, just reply to this email or give us a call.","",...emailSignature());
  return lines.join("\n");
}

function emailInvoice(inv){
  const subject=`${companyName()} Invoice ${inv.invoiceNumber} - ${inv.address || inv.clientName || "Project"}`;
  const sign=completionSignOption(inv);
  const viaGmail=(to=inv.clientEmail,subj=subject,extraText="")=>{
    markInvoiceSent();
    openMailto(to,subj,buildInvoiceEmailSummary(inv)+extraText);
    downloadPdfsForGmail([{filename:invoicePdfName(inv),render:()=>renderInvoicePrint(inv)}]);
  };
  if(!canSendFromCrm()){
    if(!sign || !confirm("Include the Certificate of Completion for the client to sign?")) return viaGmail();
    showToast("Preparing the Certificate of Completion…");
    return sign.create().then(res=>{
      if(res.error){ alert(res.error); return viaGmail(); }
      viaGmail(inv.clientEmail,subject,sign.text(res.url));
      renderCrmBoard();
    });
  }
  openSendMail({
    title:`Send invoice ${inv.invoiceNumber}`,
    to:inv.clientEmail, subject, text:buildInvoiceEmailSummary(inv),
    filename:invoicePdfName(inv),
    render:()=>renderInvoicePrint(inv),
    sign,
    fallback:({to,subject:subj,extraText})=>viaGmail(to,subj,extraText||""),
    onSent:()=>{ markInvoiceSent(); if(sign) renderCrmBoard(); }
  });
}

/* ---------- Wiring ---------- */

function wireInvoiceEvents(){
  $("invoiceSearch").addEventListener("input",renderInvoicesPage);
  $("invoiceStatusFilter").addEventListener("change",renderInvoicesPage);
  $("invoicesBody").addEventListener("click",handleInvoicesTable);
  $("btnNewInvoice").addEventListener("click",()=>openInvoiceEditor(null,newInvoiceRecord()));
  $("invoiceModal").addEventListener("input",handleInvoiceModalInput);
  $("invoiceModal").addEventListener("click",handleInvoiceModalClick);
  $("invPayState").addEventListener("change",e=>setInvoicePayState(e.target.value));
  $("invAmountDue").addEventListener("input",()=>{ readInvoiceForm(); renderInvoiceTotals(); });
  $("invoiceForm").addEventListener("submit",e=>{ e.preventDefault(); if(saveInvoiceForm()) closeModal("invoiceModal"); });
  $("invDelete").addEventListener("click",()=>{ if(EDITING_INVOICE && !EDITING_INVOICE.isNew) deleteInvoice(EDITING_INVOICE.id); });
}
