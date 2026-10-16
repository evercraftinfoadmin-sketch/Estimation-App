"use strict";

/* Invoices: created after the job, usually from the estimate (its lines, markup and tax are copied
   and can be edited). Payments received are recorded on the invoice; Paid / Balance due and the
   payment status follow from them. Numbers: INV-<year>-<NNNN>, a separate sequence from estimates. */

const INVOICE_PAYMENT_METHODS = ["Cash","Check","Card","Zelle","Bank transfer","Other"];
const INVOICE_DUE_DAYS = 7;
let EDITING_INVOICE = null; // the invoice open in the editor (a working copy)

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
    total:round2(amount(it.total))
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
    crmProjectId:i.crmProjectId || null,
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
  const t=computeEstimateTotals({items:inv.items,markup:inv.markup,taxRate:inv.taxRate,taxMode:inv.taxMode});
  const paid=round2(inv.payments.reduce((s,p)=>s+amount(p.amount),0));
  return {...inv, items:t.items, subtotal:t.subtotal, markup:t.markup, markupAmount:t.markupAmount,
    taxRate:t.taxRate, taxMode:t.taxMode, taxAmount:t.taxAmount, total:t.grandTotal,
    paid, balance:round2(t.grandTotal-paid)};
}

// What the client sees: Void, Paid, Partially paid, Sent or Draft.
function invoicePaymentStatus(inv){
  if(inv.status==="void") return {key:"void",label:"Void"};
  if(inv.total>0 && inv.balance<=0) return {key:"paid",label:"Paid"};
  if(inv.paid>0) return {key:"partial",label:"Partially paid"};
  if(inv.status==="sent") return {key:"sent",label:"Sent"};
  return {key:"draft",label:"Draft"};
}

function invoiceSeq(number){
  const m=String(number || "").match(/^INV-(\d{4})-(\d+)$/i);
  return m ? {year:Number(m[1]),n:Number(m[2])} : null;
}
function nextInvoiceNumber(list=loadInvoices()){
  const year=new Date().getFullYear();
  const used=list.map(i=>invoiceSeq(i.invoiceNumber)).filter(s=>s && s.year===year).map(s=>s.n);
  const n=Math.max(1000,...used)+1;
  return `INV-${year}-${String(n).padStart(4,"0")}`;
}

function addDays(isoDate, days){
  const d=new Date(isoDate+"T12:00:00");
  if(isNaN(d)) return "";
  d.setDate(d.getDate()+days);
  return localISODate(d);
}

function newInvoiceRecord(data={}){
  const date=localISODate();
  return computeInvoice(normalizeInvoice({
    id:uid("inv"), invoiceNumber:nextInvoiceNumber(), date, dueDate:addDays(date,INVOICE_DUE_DAYS),
    markup:0, taxRate:SETTINGS.salesTax, taxMode:SETTINGS.taxMode, items:[], payments:[], status:"draft", ...data
  }));
}

// The invoice copies the estimate: client, address, lines, markup and tax (so the totals match).
function invoiceFromEstimate(est, projectId){
  return newInvoiceRecord({
    estimateId:est.id, estimateNumber:est.estimateNumber, crmProjectId:projectId || est.crmProjectId || null,
    clientName:est.clientName, clientEmail:est.clientEmail, clientPhone:est.clientPhone, address:est.address,
    items:est.items.map(it=>({...it,id:uid("li"),categoryName:it.categoryName || categoryLabel(it.category)})),
    markup:est.markup, taxRate:est.taxRate, taxMode:est.taxMode, clientMessage:est.clientMessage || ""
  });
}

function invoicesForEstimate(estimateId){ return loadInvoices().filter(i=>i.estimateId===estimateId && i.status!=="void"); }
function invoicesForProject(projectId){ return loadInvoices().filter(i=>i.crmProjectId===projectId && i.status!=="void"); }

/* ---------- Entry points (saved estimates, CRM, Invoices page) ---------- */

function createOrOpenInvoiceForEstimate(estimateId){
  const est=getEstimate(estimateId);
  if(!est) return;
  const existing=invoicesForEstimate(estimateId)[0];
  if(existing){ openInvoiceEditor(existing.id); return; }
  openInvoiceEditor(null, invoiceFromEstimate(est));
}

function createOrOpenInvoiceForProject(projectId){
  const p=getProject(projectId);
  if(!p) return;
  const existing=invoicesForProject(projectId)[0] || (p.estimateId && invoicesForEstimate(p.estimateId)[0]);
  if(existing){ openInvoiceEditor(existing.id); return; }
  const est=p.estimateId ? getEstimate(p.estimateId) : null;
  openInvoiceEditor(null, est ? invoiceFromEstimate(est,p.id) : newInvoiceRecord({
    crmProjectId:p.id, clientName:p.clientName, clientEmail:p.clientEmail, clientPhone:p.clientPhone, address:p.address
  }));
}

/* ---------- Invoices page ---------- */

function renderInvoicesPage(){
  const all=loadInvoices();
  const query=$("invoiceSearch").value.trim().toLowerCase();
  const filter=$("invoiceStatusFilter").value;
  const list=all
    .filter(i=>filter==="all" || invoicePaymentStatus(i).key===filter || (filter==="open" && ["draft","sent","partial"].includes(invoicePaymentStatus(i).key)))
    .filter(i=>!query || [i.invoiceNumber,i.clientName,i.address,i.estimateNumber,i.clientEmail,i.clientPhone].some(v=>v.toLowerCase().includes(query)))
    .sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const open=all.filter(i=>!["void","paid"].includes(invoicePaymentStatus(i).key));
  $("invoicesSummary").innerHTML=`<span class="imp-chip">${all.length} invoice(s)</span>
    <span class="imp-chip">Outstanding: <b>${money(open.reduce((s,i)=>s+i.balance,0))}</b></span>`;
  $("invoicesBody").innerHTML=list.map(i=>{
    const st=invoicePaymentStatus(i);
    return `<tr data-id="${escapeHtml(i.id)}">
      <td data-label="Invoice #" class="nowrap"><b>${escapeHtml(i.invoiceNumber)}</b>${i.estimateNumber?`<div class="small">from ${escapeHtml(i.estimateNumber)}</div>`:""}</td>
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
  empty.textContent=all.length ? "No invoices match your search." : "No invoices yet. Create one from a completed job in the CRM, from a saved estimate, or with + New Invoice.";
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
  $("invMarkup").value=inv.markup;
  $("invTaxRate").value=inv.taxRate;
  $("invMessage").value=inv.clientMessage;
  $("invPayDate").value=localISODate();
  $("invPayAmount").value="";
  $("invPayMethod").innerHTML=INVOICE_PAYMENT_METHODS.map(m=>`<option>${m}</option>`).join("");
  $("invPayNote").value="";
  $("invoiceModalTitle").textContent=id ? `Invoice ${inv.invoiceNumber}` : "New Invoice";
  $("invEstimateLink").innerHTML=inv.estimateNumber ? `From estimate <b>${escapeHtml(inv.estimateNumber)}</b>` : "";
  $("invDelete").hidden=!id;
  renderInvoiceEditor();
  openModal("invoiceModal");
}

// Reads the form into the working copy and recomputes the totals.
function readInvoiceForm(){
  const inv=EDITING_INVOICE;
  Object.assign(inv,{
    clientName:$("invClientName").value.trim(), clientEmail:$("invClientEmail").value.trim(),
    clientPhone:$("invClientPhone").value.trim(), address:$("invAddress").value.trim(),
    invoiceNumber:$("invNumber").value.trim(), date:$("invDate").value, dueDate:$("invDueDate").value,
    markup:$("invMarkup").value, taxRate:$("invTaxRate").value, clientMessage:$("invMessage").value.trim()
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
  $("invTotals").innerHTML=`
    <div class="sum-row"><span>Subtotal</span><span>${money(inv.subtotal)}</span></div>
    <div class="sum-row"><span>Markup (${formatQty(inv.markup)}%)</span><span>${money(inv.markupAmount)}</span></div>
    <div class="sum-row"><span>Sales Tax (${formatQty(inv.taxRate)}%)</span><span>${money(inv.taxAmount)}</span></div>
    <div class="sum-row sum-strong"><span>TOTAL</span><span>${money(inv.total)}</span></div>
    <div class="sum-row"><span>Paid</span><span>${money(inv.paid)}</span></div>
    <div class="sum-row sum-strong"><span>BALANCE DUE</span><span id="invBalance">${money(inv.status==="void"?0:inv.balance)}</span></div>
    <div><span class="status-badge inv-${st.key}" id="invStatus">${st.label}</span></div>`;
  $("invVoid").textContent=inv.status==="void" ? "Restore (un-void)" : "Void";
}

function handleInvoiceModalInput(e){
  if(e.target.closest("#invItems") || ["invMarkup","invTaxRate"].includes(e.target.id)){ readInvoiceForm(); renderInvoiceTotals(); }
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
  }else if(action==="add-payment"){
    const value=round2(amount($("invPayAmount").value));
    if(!(value>0)){ alert("Enter the amount received."); $("invPayAmount").focus(); return; }
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
  showToast(`Invoice ${inv.invoiceNumber} deleted.`);
}

/* ---------- Print / PDF and email ---------- */

function renderInvoicePrint(inv){
  const st=invoicePaymentStatus(inv);
  const companyLine=companyContactParts().map(escapeHtml).join(" · ");
  $("printView").innerHTML=`
    <div class="pv">
      <header class="pv-header">
        <div><div class="pv-company">${escapeHtml(companyName())}</div><div class="pv-muted">${companyLine}</div></div>
        <div class="pv-title">
          <div class="pv-doc">INVOICE</div>
          <table class="pv-meta">
            <tr><td>Invoice #</td><td>${escapeHtml(inv.invoiceNumber)}</td></tr>
            <tr><td>Date</td><td>${escapeHtml(formatDate(inv.date))}</td></tr>
            ${inv.dueDate?`<tr><td>Due date</td><td>${escapeHtml(formatDate(inv.dueDate))}</td></tr>`:""}
            ${inv.estimateNumber?`<tr><td>Estimate #</td><td>${escapeHtml(inv.estimateNumber)}</td></tr>`:""}
          </table>
        </div>
      </header>
      <div class="pv-parties">
        <div><h4>Bill to</h4><div><b>${escapeHtml(inv.clientName||"—")}</b></div>
          ${inv.clientEmail?`<div>${escapeHtml(inv.clientEmail)}</div>`:""}${inv.clientPhone?`<div>${escapeHtml(inv.clientPhone)}</div>`:""}</div>
        <div><h4>Project Address</h4><div>${escapeHtml(inv.address||"—")}</div></div>
      </div>
      ${inv.clientMessage?`<section class="pv-message">${escapeHtml(inv.clientMessage)}</section>`:""}
      <section class="pv-section">
        <table class="pv-table">
          <thead><tr><th>Service</th><th class="num">Quantity</th><th class="num">Price</th><th class="num">Total</th></tr></thead>
          <tbody>${inv.items.map(it=>`<tr><td>${escapeHtml(it.name||"Service")}${it.description?`<div class="pv-desc">${escapeHtml(it.description)}</div>`:""}</td>
            <td class="num">${formatQty(it.quantity)}</td><td class="num">${money(it.price)}</td><td class="num">${money(it.total)}</td></tr>`).join("")}</tbody>
        </table>
      </section>
      <table class="pv-totals">
        <tr><td>Subtotal</td><td class="num">${money(inv.subtotal)}</td></tr>
        ${inv.markupAmount?`<tr><td>Markup (${formatQty(inv.markup)}%)</td><td class="num">${money(inv.markupAmount)}</td></tr>`:""}
        <tr><td>Sales Tax (${formatQty(inv.taxRate)}%)</td><td class="num">${money(inv.taxAmount)}</td></tr>
        <tr class="pv-grand"><td>TOTAL</td><td class="num">${money(inv.total)}</td></tr>
        ${inv.payments.map(p=>`<tr><td>Paid ${escapeHtml(formatDate(p.date))} · ${escapeHtml(p.method)}</td><td class="num">−${money(p.amount)}</td></tr>`).join("")}
        <tr class="pv-grand"><td>${st.key==="void"?"VOID":"BALANCE DUE"}</td><td class="num">${money(st.key==="void"?0:inv.balance)}</td></tr>
      </table>
      ${SETTINGS.terms.trim()?`<section class="pv-terms"><h3>TERMS AND CONDITIONS</h3><div class="pv-terms-text">${formatTermsHtml(SETTINGS.terms.trim())}</div></section>`:""}
      ${SETTINGS.estimateFooter?`<footer class="pv-footer">${escapeHtml(SETTINGS.estimateFooter)}</footer>`:""}
    </div>`;
}

function printInvoice(inv){
  renderInvoicePrint(inv);
  const original=document.title;
  document.title=`${companyName()} Invoice ${inv.invoiceNumber}`.trim();
  markInvoiceSent();
  window.print();
  document.title=original;
}

function buildInvoiceEmailBody(inv, {withTerms=true}={}){
  const lines=[`Hello ${inv.clientName || "there"},`,"",`Please find your invoice from ${companyName()} below.`,""];
  if(inv.clientMessage) lines.push(inv.clientMessage,"");
  lines.push(`Invoice #: ${inv.invoiceNumber}`,`Date: ${formatDate(inv.date)}`);
  if(inv.dueDate) lines.push(`Due date: ${formatDate(inv.dueDate)}`);
  if(inv.estimateNumber) lines.push(`Estimate #: ${inv.estimateNumber}`);
  lines.push(`Project: ${inv.address || "N/A"}`,"");
  for(const it of inv.items) lines.push(`- ${it.name || "Service"}: Qty ${formatQty(it.quantity)} x ${money(it.price)} = ${money(it.total)}`);
  lines.push("",`Subtotal: ${money(inv.subtotal)}`);
  if(inv.markupAmount) lines.push(`Markup (${formatQty(inv.markup)}%): ${money(inv.markupAmount)}`);
  lines.push(`Sales Tax (${formatQty(inv.taxRate)}%): ${money(inv.taxAmount)}`,`TOTAL: ${money(inv.total)}`);
  for(const p of inv.payments) lines.push(`Paid ${formatDate(p.date)} (${p.method}): ${money(p.amount)}`);
  lines.push(`BALANCE DUE: ${money(inv.status==="void"?0:inv.balance)}`,"");
  if(SETTINGS.terms.trim()) lines.push(...(withTerms ? ["TERMS AND CONDITIONS","",SETTINGS.terms.trim(),""] : ["Terms and Conditions: see the attached PDF invoice.",""]));
  lines.push("Thank you for your business!","","Best regards,",...[SETTINGS.companyName,...companyContactParts()]);
  return lines.join("\n");
}

function emailInvoice(inv){
  const subject=`${companyName()} Invoice ${inv.invoiceNumber} - ${inv.address || inv.clientName || "Project"}`;
  markInvoiceSent();
  openMailto(inv.clientEmail,subject,buildInvoiceEmailBody(inv),buildInvoiceEmailBody(inv,{withTerms:false}));
}

/* ---------- Wiring ---------- */

function wireInvoiceEvents(){
  $("invoiceSearch").addEventListener("input",renderInvoicesPage);
  $("invoiceStatusFilter").addEventListener("change",renderInvoicesPage);
  $("invoicesBody").addEventListener("click",handleInvoicesTable);
  $("btnNewInvoice").addEventListener("click",()=>openInvoiceEditor(null,newInvoiceRecord()));
  $("invoiceModal").addEventListener("input",handleInvoiceModalInput);
  $("invoiceModal").addEventListener("click",handleInvoiceModalClick);
  $("invoiceForm").addEventListener("submit",e=>{ e.preventDefault(); if(saveInvoiceForm()) closeModal("invoiceModal"); });
  $("invDelete").addEventListener("click",()=>{ if(EDITING_INVOICE && !EDITING_INVOICE.isNew) deleteInvoice(EDITING_INVOICE.id); });
}
