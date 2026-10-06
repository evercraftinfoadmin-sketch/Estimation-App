"use strict";

/* Estimate Builder, Saved Estimates, Print/PDF and Email. */

const ESTIMATE_STATUSES = ["draft","sent","accepted","rejected","completed"];

// The estimate currently open in the builder. Client fields live in the form inputs;
// line items live here and are rendered into the category sections.
let BUILDER = {id:null, crmProjectId:null, status:null, taxMode:null, items:[]};
let CLEAN_SNAPSHOT = "";
let CUSTOM_SERVICE_CATEGORY = "drywall";

/* ---------- Reading the builder ---------- */

function readBuilderInput(){
  return {
    estimateNumber:$("estimateNumber").value.trim(),
    date:$("estimateDate").value,
    clientName:$("clientName").value.trim(),
    clientEmail:$("clientEmail").value.trim(),
    clientPhone:$("clientPhone").value.trim(),
    address:$("projectAddress").value.trim(),
    items:BUILDER.items,
    markup:$("estMarkup").value,
    taxRate:$("estTaxRate").value,
    taxMode:BUILDER.taxMode || SETTINGS.taxMode
  };
}

// Builder data + totals from the single calculation engine.
function getEstimateData(){
  const input=readBuilderInput();
  return {...input, ...computeEstimateTotals(input)};
}

function builderSnapshot(){
  return JSON.stringify(readBuilderInput());
}

function markClean(){
  CLEAN_SNAPSHOT=builderSnapshot();
  updateBuilderMeta();
}

function hasUnsavedChanges(){
  const d=readBuilderInput();
  if(!BUILDER.id && !d.clientName && !d.clientEmail && !d.clientPhone && !d.address && !d.items.length) return false;
  return builderSnapshot()!==CLEAN_SNAPSHOT;
}

function confirmDiscardChanges(){
  return !hasUnsavedChanges() || confirm("The estimate in the builder has unsaved changes. Discard them?");
}

function isBuilderAutoNumber(){
  return !BUILDER.id && $("estimateNumber").value.trim()===formatEstimateNumber(SETTINGS.nextEstimateNumber);
}

/* ---------- Builder rendering ---------- */

function renderBuilderSections(){
  $("builderSections").innerHTML=CATEGORIES.map(c=>`
    <section class="card category-card" data-category="${c.key}">
      <div class="category-head">
        <h2>${c.label.toUpperCase()}</h2>
        <div class="category-total" id="catTotal-${c.key}">$0.00</div>
      </div>
      <div class="line-head" aria-hidden="true"><span>Service</span><span>Quantity</span><span>Price</span><span>Total</span><span></span></div>
      <div class="line-items" id="items-${c.key}"></div>
      <div class="category-actions">
        <button class="btn btn-light" data-action="add-service" data-category="${c.key}">+ Add Service</button>
        <button class="btn btn-ghost" data-action="custom-service" data-category="${c.key}">+ Custom Service</button>
      </div>
    </section>`).join("");
}

function serviceOptions(item){
  const services=activeServices(item.category);
  const linked=item.serviceId ? services.find(s=>s.id===item.serviceId) : null;
  // Show the item's own name when it is custom, or its service was renamed/disabled/deleted.
  const ownName=item.name && (!linked || linked.name!==item.name);
  let html=`<option value="">— Select service —</option>`;
  if(ownName) html+=`<option value="current" selected>${escapeHtml(item.name)}${item.serviceId?"":" (custom)"}</option>`;
  html+=services.map(s=>`<option value="svc:${escapeHtml(s.id)}" ${!ownName && linked && linked.id===s.id ? "selected":""}>${escapeHtml(s.name)}</option>`).join("");
  return html;
}

function renderCategoryItems(category){
  const items=BUILDER.items.filter(it=>it.category===category);
  $(`items-${category}`).innerHTML=items.length ? items.map(it=>`
    <div class="line-item" data-item-id="${escapeHtml(it.id)}">
      <div class="li-service">
        <select data-field="service" aria-label="Service">${serviceOptions(it)}</select>
        ${it.description ? `<div class="li-desc">${escapeHtml(it.description)}</div>` : ""}
      </div>
      <label class="li-field"><span class="li-label">Quantity</span>
        <input data-field="quantity" type="number" min="0" step="any" inputmode="decimal" value="${it.quantity}">
      </label>
      <label class="li-field"><span class="li-label">Price ($)</span>
        <input data-field="price" type="number" min="0" step="0.01" inputmode="decimal" value="${it.price}">
      </label>
      <div class="li-total"><span class="li-label">Total</span><b data-total>$0.00</b></div>
      <button class="btn-icon" data-action="delete-item" title="Delete service" aria-label="Delete service">✕</button>
    </div>`).join("")
    : `<div class="line-empty">No ${categoryLabel(category).toLowerCase()} services yet.</div>`;
}

function renderBuilderItems(){
  CATEGORY_KEYS.forEach(renderCategoryItems);
  updateBuilderTotals();
}

function updateBuilderTotals(){
  const d=getEstimateData();
  d.items.forEach(it=>{
    const cell=document.querySelector(`.line-item[data-item-id="${CSS.escape(it.id)}"] [data-total]`);
    if(cell) cell.textContent=money(it.total);
  });
  CATEGORY_KEYS.forEach(k=>{
    $(`catTotal-${k}`).textContent=money(d.categoryTotals[k]);
    $(`sum-${k}`).textContent=money(d.categoryTotals[k]);
  });
  $("sumSubtotal").textContent=money(d.subtotal);
  $("sumMarkup").textContent=money(d.markupAmount);
  $("sumTaxNote").textContent=`on ${taxModeLabel(d.taxMode)}`;
  $("sumTax").textContent=money(d.taxAmount);
  $("sumTotal").textContent=money(d.grandTotal);
}

function updateBuilderMeta(){
  const saved=BUILDER.id ? getEstimate(BUILDER.id) : null;
  const badge=$("builderBadge");
  badge.className="status-badge status-"+(saved ? saved.status : "unsaved");
  badge.textContent=saved ? capitalize(saved.status) : "Not saved";

  const project=BUILDER.crmProjectId ? getProject(BUILDER.crmProjectId) : null;
  let html="";
  if(project){
    html=`🔗 Linked to CRM project <b>${escapeHtml(project.clientName || project.address || "")}</b> (${escapeHtml(stageLabel(project.stage))})
      <button class="btn btn-link" data-action="open-crm">Open CRM Project</button>`;
  }else if(saved){
    html=`<button class="btn btn-link" data-action="create-crm">+ Create CRM Project</button>`;
  }
  $("builderMeta").innerHTML=html;
}

/* ---------- Builder events ---------- */

function findItem(id){ return BUILDER.items.find(it=>it.id===id); }

function addLineItem(category, data={}){
  const item={id:uid("li"),category,serviceId:null,name:"",description:"",quantity:1,price:0,...data};
  BUILDER.items.push(item);
  renderCategoryItems(category);
  updateBuilderTotals();
  return item;
}

function handleBuilderClick(event){
  const btn=event.target.closest("[data-action]");
  if(!btn) return;
  const action=btn.dataset.action;
  if(action==="add-service"){
    const item=addLineItem(btn.dataset.category);
    document.querySelector(`.line-item[data-item-id="${CSS.escape(item.id)}"] select`)?.focus();
  }else if(action==="custom-service"){
    openCustomServiceForm(btn.dataset.category);
  }else if(action==="delete-item"){
    const id=btn.closest(".line-item").dataset.itemId;
    const item=findItem(id);
    if(!item) return;
    BUILDER.items=BUILDER.items.filter(it=>it.id!==id);
    renderCategoryItems(item.category);
    updateBuilderTotals();
  }
}

function handleBuilderInput(event){
  const el=event.target;
  const row=el.closest(".line-item");
  if(!row) return;
  const item=findItem(row.dataset.itemId);
  if(!item) return;
  const field=el.dataset.field;

  if(field==="quantity" || field==="price"){
    item[field]=amount(el.value);
    updateBuilderTotals();
  }else if(field==="service" && event.type==="change"){
    if(el.value==="current") return;
    if(el.value===""){
      Object.assign(item,{serviceId:null,name:"",description:""});
    }else{
      const service=getService(el.value.slice(4));
      if(!service) return;
      // Loads name + default price. Changing the price later only affects this estimate.
      Object.assign(item,{serviceId:service.id,name:service.name,description:service.description,price:service.defaultPrice});
    }
    renderCategoryItems(item.category);
    updateBuilderTotals();
  }
}

/* ---------- Custom service ---------- */

function openCustomServiceForm(category){
  CUSTOM_SERVICE_CATEGORY=category;
  $("csName").value="";
  $("csPrice").value="";
  $("csDescription").value="";
  $("csCategory").value=category;
  $("csSave").checked=false;
  openModal("customServiceModal");
  $("csName").focus();
}

function submitCustomService(){
  const name=$("csName").value.trim();
  const category=$("csCategory").value;
  const defaultPrice=amount($("csPrice").value);
  const description=$("csDescription").value.trim();
  if(!name){ alert("Please enter a service name."); $("csName").focus(); return; }

  let serviceId=null;
  if($("csSave").checked){
    const service=createService({category,name,defaultPrice,description});
    if(!service) return;
    serviceId=service.id;
    renderServicesPage();
  }
  closeModal("customServiceModal");
  addLineItem(category,{serviceId,name,description,price:defaultPrice});
  // Other rows' dropdowns in this category should list a newly saved service.
  if(serviceId) renderBuilderItems();
  showToast(serviceId ? `"${name}" added and saved to the service list.` : `"${name}" added to this estimate.`);
}

/* ---------- New / reset / open ---------- */

function newEstimate(prefill={}){
  BUILDER={id:null,crmProjectId:prefill.crmProjectId||null,status:null,taxMode:null,items:[]};
  $("clientName").value=prefill.clientName||"";
  $("clientEmail").value=prefill.clientEmail||"";
  $("clientPhone").value=prefill.clientPhone||"";
  $("projectAddress").value=prefill.address||"";
  $("estimateNumber").value=nextAvailableEstimateNumber();
  $("estimateDate").value=localISODate();
  $("estMarkup").value=SETTINGS.markup;
  $("estTaxRate").value=SETTINGS.salesTax;
  renderBuilderItems();
  markClean();
}

function resetBuilder(){
  if(hasUnsavedChanges() && !confirm("Clear this estimate and start a new one? Unsaved changes will be lost.")) return;
  newEstimate();
  showToast("New estimate started.");
}

function loadEstimateIntoBuilder(est){
  BUILDER={
    id:est.id,
    crmProjectId:est.crmProjectId,
    status:est.status,
    taxMode:est.taxMode,
    items:clone(est.items)
  };
  $("clientName").value=est.clientName;
  $("clientEmail").value=est.clientEmail;
  $("clientPhone").value=est.clientPhone;
  $("projectAddress").value=est.address;
  $("estimateNumber").value=est.estimateNumber;
  $("estimateDate").value=est.date;
  $("estMarkup").value=est.markup;
  $("estTaxRate").value=est.taxRate;
  renderBuilderItems();
  markClean();
}

function openEstimate(id){
  const est=getEstimate(id);
  if(!est) return false;
  if(BUILDER.id!==id && !confirmDiscardChanges()) return false;
  if(BUILDER.id===id && hasUnsavedChanges() && !confirm("Reload the saved version of this estimate? Unsaved changes will be lost.")) return false;
  loadEstimateIntoBuilder(est);
  showPage("builder");
  if(est.legacy) alert("This estimate was created with the old calculator. Its services need to be re-entered before saving.");
  return true;
}

/* ---------- Saved estimates storage ---------- */

function normalizeEstimate(e){
  const legacy=!Array.isArray(e.items);
  const items=(legacy ? [] : e.items)
    .filter(it=>it && CATEGORY_KEYS.includes(it.category))
    .map(it=>({
      id:String(it.id || uid("li")),
      category:it.category,
      serviceId:it.serviceId || null,
      name:String(it.name ?? ""),
      description:String(it.description ?? ""),
      quantity:amount(it.quantity),
      price:amount(it.price),
      total:round2(amount(it.total))
    }));
  return {
    id:String(e.id),
    estimateNumber:String(e.estimateNumber ?? ""),
    date:String(e.date ?? ""),
    clientName:String(e.clientName ?? ""),
    clientEmail:String(e.clientEmail ?? ""),
    clientPhone:String(e.clientPhone ?? ""),
    address:String(e.address ?? ""),
    items,
    drywallTotal:round2(amount(e.drywallTotal)),
    stuccoTotal:round2(amount(e.stuccoTotal)),
    paintingTotal:round2(amount(e.paintingTotal)),
    subtotal:round2(amount(e.subtotal)),
    markup:amount(e.markup),
    markupAmount:round2(amount(e.markupAmount)),
    taxRate:amount(e.taxRate),
    taxMode:e.taxMode==="subtotal" ? "subtotal" : "all",
    taxAmount:round2(amount(e.taxAmount)),
    customerTotal:round2(amount(e.customerTotal ?? e.customer)),
    status:ESTIMATE_STATUSES.includes(e.status) ? e.status : "draft",
    crmProjectId:e.crmProjectId || null,
    createdAt:e.createdAt || nowISO(),
    updatedAt:e.updatedAt || e.createdAt || nowISO(),
    legacy
  };
}

function loadEstimates(){
  const list=readStore(STORAGE_KEYS.estimates,[]);
  return Array.isArray(list) ? list.filter(e=>e && e.id).map(normalizeEstimate) : [];
}

function saveEstimates(list){
  return writeStore(STORAGE_KEYS.estimates,list.map(({legacy,...e})=>e));
}

function getEstimate(id){
  return id ? loadEstimates().find(e=>e.id===id) || null : null;
}

function updateEstimate(id, changes){
  const list=loadEstimates();
  const est=list.find(e=>e.id===id);
  if(!est) return null;
  Object.assign(est,changes);
  return saveEstimates(list) ? est : null;
}

function buildEstimateRecord(d, existing){
  const now=nowISO();
  return {
    id:existing ? existing.id : uid("est"),
    estimateNumber:d.estimateNumber,
    date:d.date,
    clientName:d.clientName,
    clientEmail:d.clientEmail,
    clientPhone:d.clientPhone,
    address:d.address,
    items:d.items.map(({id,category,serviceId,name,description,quantity,price,total})=>({id,category,serviceId,name,description,quantity,price,total})),
    drywallTotal:d.categoryTotals.drywall,
    stuccoTotal:d.categoryTotals.stucco,
    paintingTotal:d.categoryTotals.painting,
    subtotal:d.subtotal,
    markup:d.markup,
    markupAmount:d.markupAmount,
    taxRate:d.taxRate,
    taxMode:d.taxMode,
    taxAmount:d.taxAmount,
    customerTotal:d.grandTotal,
    status:existing ? existing.status : "draft",
    crmProjectId:BUILDER.crmProjectId || (existing && existing.crmProjectId) || null,
    createdAt:existing ? existing.createdAt : now,
    updatedAt:now
  };
}

function saveEstimate(){
  if(!$("estimateNumber").value.trim()) $("estimateNumber").value=nextAvailableEstimateNumber();
  const d=getEstimateData();

  if(!d.clientName && !d.address){
    alert("Please enter at least a Client Name or a Project Address before saving.");
    $("clientName").focus();
    return false;
  }
  if(d.items.some(it=>!it.name)){
    alert("Please choose a service for every line, or delete the empty lines.");
    return false;
  }

  const list=loadEstimates();
  const index=BUILDER.id ? list.findIndex(e=>e.id===BUILDER.id) : -1;
  const existing=index>=0 ? list[index] : null;

  // Estimate numbers are never duplicated.
  if(list.some(e=>e.estimateNumber===d.estimateNumber && e.id!==(existing && existing.id))){
    const next=nextAvailableEstimateNumber();
    if(!confirm(`Estimate # ${d.estimateNumber} is already used by another saved estimate.\nUse ${next} instead?`)) return false;
    $("estimateNumber").value=next;
    return saveEstimate();
  }

  const record=buildEstimateRecord(d,existing);
  // A link to a CRM project that no longer exists is dropped.
  if(record.crmProjectId && !getProject(record.crmProjectId)) record.crmProjectId=null;

  if(existing) list[index]=record; else list.push(record);
  if(!saveEstimates(list)) return false;

  BUILDER.id=record.id;
  BUILDER.status=record.status;
  BUILDER.taxMode=record.taxMode;
  BUILDER.crmProjectId=record.crmProjectId;
  issueEstimateNumber(record.estimateNumber);
  if(record.crmProjectId) linkProjectToEstimate(record.crmProjectId,record);

  markClean();
  renderSavedEstimates();
  renderCrmBoard();
  showToast(existing ? `Estimate ${record.estimateNumber} updated.` : `Estimate ${record.estimateNumber} saved.`);
  return true;
}

/* ---------- Saved estimates actions ---------- */

function duplicateEstimate(id){
  const original=getEstimate(id);
  if(!original) return;
  const builderWasClean=!hasUnsavedChanges();
  const builderWasAuto=isBuilderAutoNumber();

  const number=takeEstimateNumber();
  const now=nowISO();
  const copy={
    ...clone(original),
    id:uid("est"),
    estimateNumber:number,
    status:"draft",
    crmProjectId:null,
    items:original.items.map(it=>({...it,id:uid("li")})),
    createdAt:now,
    updatedAt:now
  };
  const list=loadEstimates();
  list.push(copy);
  if(!saveEstimates(list)) return;

  // An unsaved new estimate in the builder must not keep the number just taken.
  if(builderWasAuto){
    $("estimateNumber").value=nextAvailableEstimateNumber();
    if(builderWasClean) markClean();
  }
  renderSavedEstimates();
  showToast(`Duplicated as ${number} (draft).`);
}

function deleteEstimate(id){
  const est=getEstimate(id);
  if(!est) return;
  if(!confirm(`Delete estimate ${est.estimateNumber} for ${est.clientName || est.address || "this client"}? This cannot be undone.`)) return;
  if(!saveEstimates(loadEstimates().filter(e=>e.id!==id))) return;
  unlinkEstimateFromProjects(id);
  if(BUILDER.id===id){
    // The builder keeps its content as a new, unsaved estimate.
    BUILDER.id=null;
    BUILDER.status=null;
    CLEAN_SNAPSHOT="";
    updateBuilderMeta();
  }
  renderSavedEstimates();
  renderCrmBoard();
  showToast(`Estimate ${est.estimateNumber} deleted.`);
}

function setEstimateStatus(id, status){
  if(!ESTIMATE_STATUSES.includes(status)) return;
  const est=updateEstimate(id,{status,updatedAt:nowISO()});
  if(!est) return;
  if(BUILDER.id===id) BUILDER.status=status;
  syncProjectFromEstimateStatus(est);
  updateBuilderMeta();
  renderSavedEstimates();
  renderCrmBoard();
}

function printSavedEstimate(id){
  if(openEstimate(id)) printEstimate();
}

function emailSavedEstimate(id){
  if(openEstimate(id)) emailEstimate();
}

/* ---------- Saved estimates page ---------- */

function renderSavedEstimates(){
  const all=loadEstimates();
  const query=$("estimateSearch").value.trim().toLowerCase();
  const status=$("estimateStatusFilter").value;
  const projects=loadProjects();

  const list=all
    .filter(e=>status==="all" || e.status===status)
    .filter(e=>!query || [e.clientName,e.address,e.estimateNumber,e.clientEmail,e.clientPhone].some(v=>v.toLowerCase().includes(query)))
    .sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));

  $("estimatesBody").innerHTML=list.map(e=>{
    const hasProject=e.crmProjectId && projects.some(p=>p.id===e.crmProjectId);
    return `
    <tr data-id="${escapeHtml(e.id)}" class="${e.id===BUILDER.id?"row-current":""}">
      <td data-label="Estimate #" class="nowrap"><b>${escapeHtml(e.estimateNumber)}</b>${e.legacy?`<div class="small">old calculator</div>`:""}</td>
      <td data-label="Client">${escapeHtml(e.clientName||"—")}<div class="small">${escapeHtml([e.clientEmail,e.clientPhone].filter(Boolean).join(" · "))}</div></td>
      <td data-label="Address">${escapeHtml(e.address||"—")}</td>
      <td data-label="Date" class="nowrap">${escapeHtml(formatDate(e.date))}</td>
      <td data-label="Status">
        <select data-action="status" aria-label="Status" class="status-select status-${e.status}">
          ${ESTIMATE_STATUSES.map(s=>`<option value="${s}" ${s===e.status?"selected":""}>${capitalize(s)}</option>`).join("")}
        </select>
      </td>
      <td data-label="Total" class="nowrap"><b>${money(e.customerTotal)}</b></td>
      <td data-label="Updated" class="small nowrap">${escapeHtml(formatDateTime(e.updatedAt))}</td>
      <td data-label="Actions">
        <div class="row-actions">
          <button class="btn btn-primary btn-sm" data-action="open">Open / Edit</button>
          <button class="btn btn-light btn-sm" data-action="duplicate">Duplicate</button>
          <button class="btn btn-light btn-sm" data-action="print">Print</button>
          <button class="btn btn-light btn-sm" data-action="email">Email</button>
          <button class="btn btn-light btn-sm" data-action="crm">${hasProject?"Open CRM Project":"Create CRM Project"}</button>
          <button class="btn btn-danger btn-sm" data-action="delete">Delete</button>
        </div>
      </td>
    </tr>`;
  }).join("");

  const empty=$("estimatesEmpty");
  empty.hidden=list.length>0;
  empty.textContent=all.length ? "No estimates match your search." : "No saved estimates yet. Build an estimate and press Save Estimate.";
}

function handleEstimatesAction(event){
  const el=event.target.closest("[data-action]");
  const id=el?.closest("tr")?.dataset.id;
  if(!id) return;
  const action=el.dataset.action;
  if(action==="status"){
    if(event.type==="change") setEstimateStatus(id,el.value);
    return;
  }
  if(event.type!=="click") return;
  ({
    open:()=>openEstimate(id),
    duplicate:()=>duplicateEstimate(id),
    print:()=>printSavedEstimate(id),
    email:()=>emailSavedEstimate(id),
    crm:()=>createOrOpenCrmFromEstimate(id),
    delete:()=>deleteEstimate(id)
  })[action]?.();
}

/* ---------- Print / PDF ---------- */

function renderPrintView(d){
  const companyLine=[SETTINGS.companyAddress,SETTINGS.companyPhone,SETTINGS.companyEmail].filter(Boolean).map(escapeHtml).join(" · ");
  const sections=CATEGORIES.map(c=>{
    const lines=d.items.filter(it=>it.category===c.key);
    if(!lines.length) return "";
    return `
      <section class="pv-section">
        <h3>${c.label.toUpperCase()}</h3>
        <table class="pv-table">
          <thead><tr><th>Service</th><th class="num">Quantity</th><th class="num">Price</th><th class="num">Total</th></tr></thead>
          <tbody>${lines.map(it=>`
            <tr>
              <td>${escapeHtml(it.name||"Service")}${it.description?`<div class="pv-desc">${escapeHtml(it.description)}</div>`:""}</td>
              <td class="num">${formatQty(it.quantity)}</td>
              <td class="num">${money(it.price)}</td>
              <td class="num">${money(it.total)}</td>
            </tr>`).join("")}
          </tbody>
          <tfoot><tr><td colspan="3">${c.label} total</td><td class="num">${money(d.categoryTotals[c.key])}</td></tr></tfoot>
        </table>
      </section>`;
  }).join("");

  $("printView").innerHTML=`
    <div class="pv">
      <header class="pv-header">
        <div>
          <div class="pv-company">${escapeHtml(companyName())}</div>
          <div class="pv-muted">${companyLine}</div>
        </div>
        <div class="pv-title">
          <div class="pv-doc">ESTIMATE</div>
          <table class="pv-meta">
            <tr><td>Estimate #</td><td>${escapeHtml(d.estimateNumber)}</td></tr>
            <tr><td>Date</td><td>${escapeHtml(formatDate(d.date))}</td></tr>
          </table>
        </div>
      </header>
      <div class="pv-parties">
        <div><h4>Client</h4>
          <div><b>${escapeHtml(d.clientName||"—")}</b></div>
          ${d.clientEmail?`<div>${escapeHtml(d.clientEmail)}</div>`:""}
          ${d.clientPhone?`<div>${escapeHtml(d.clientPhone)}</div>`:""}
        </div>
        <div><h4>Project Address</h4><div>${escapeHtml(d.address||"—")}</div></div>
      </div>
      ${sections || `<p class="pv-muted">No services added.</p>`}
      <table class="pv-totals">
        <tr><td>Subtotal</td><td class="num">${money(d.subtotal)}</td></tr>
        <tr><td>Markup (${formatQty(d.markup)}%)</td><td class="num">${money(d.markupAmount)}</td></tr>
        <tr><td>Sales Tax (${formatQty(d.taxRate)}%)</td><td class="num">${money(d.taxAmount)}</td></tr>
        <tr class="pv-grand"><td>TOTAL</td><td class="num">${money(d.grandTotal)}</td></tr>
      </table>
      ${SETTINGS.estimateFooter?`<footer class="pv-footer">${escapeHtml(SETTINGS.estimateFooter)}</footer>`:""}
    </div>`;
}

function printEstimate(){
  const d=getEstimateData();
  renderPrintView(d);
  const originalTitle=document.title;
  document.title=`${companyName()} Estimate ${d.estimateNumber}`.trim();
  issueEstimateNumber(d.estimateNumber);
  window.print();
  document.title=originalTitle;
}

/* ---------- Email ---------- */

function buildEmailBody(d){
  const lines=[];
  lines.push(`Hello ${d.clientName || "there"},`,"");
  lines.push(`Please find your estimate from ${companyName()} below.`,"");
  lines.push(`Estimate #: ${d.estimateNumber || "N/A"}`);
  lines.push(`Date: ${formatDate(d.date) || "N/A"}`);
  lines.push(`Client: ${d.clientName || "N/A"}`);
  lines.push(`Project: ${d.address || "N/A"}`,"");

  for(const c of CATEGORIES){
    const items=d.items.filter(it=>it.category===c.key);
    if(!items.length) continue;
    lines.push(c.label.toUpperCase());
    for(const it of items){
      lines.push(`- ${it.name || "Service"}: Qty ${formatQty(it.quantity)} x ${money(it.price)} = ${money(it.total)}`);
    }
    lines.push(`${c.label} total: ${money(d.categoryTotals[c.key])}`,"");
  }

  lines.push(`Subtotal: ${money(d.subtotal)}`);
  lines.push(`Markup (${formatQty(d.markup)}%): ${money(d.markupAmount)}`);
  lines.push(`Sales Tax (${formatQty(d.taxRate)}%): ${money(d.taxAmount)}`);
  lines.push(`TOTAL: ${money(d.grandTotal)}`,"");
  if(SETTINGS.estimateFooter) lines.push(SETTINGS.estimateFooter,"");
  lines.push("Please let us know if you have any questions.","","Best regards,");
  lines.push(...[SETTINGS.companyName,SETTINGS.companyPhone,SETTINGS.companyEmail,SETTINGS.companyAddress].filter(Boolean));
  return lines.join("\n");
}

function emailEstimate(){
  const d=getEstimateData();
  if(!d.clientEmail){
    alert("Please enter the client's email address.");
    showPage("builder");
    $("clientEmail").focus();
    return;
  }
  const subject=`${companyName()} Estimate ${d.estimateNumber} - ${d.address || d.clientName || "Project"}`;
  issueEstimateNumber(d.estimateNumber);
  window.location.href=
    "mailto:"+encodeURIComponent(d.clientEmail)+
    "?subject="+encodeURIComponent(subject)+
    "&body="+encodeURIComponent(buildEmailBody(d));
}
