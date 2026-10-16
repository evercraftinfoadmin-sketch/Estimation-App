"use strict";

/* Estimate Builder, Saved Estimates, Print/PDF and Email. */

const ESTIMATE_STATUSES = ["draft","sent","accepted","rejected","completed"];

// The estimate currently open in the builder. Client fields live in the form inputs;
// line items live here and are rendered into the category sections.
// customCategories: ids of the custom categories shown in this estimate (in order);
// categoryNames: names saved with the estimate, used if a category is later deleted.
let BUILDER = {id:null, crmProjectId:null, status:null, taxMode:null, items:[], customCategories:[], categoryNames:{}};
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
    clientMessage:$("clientMessage").value.trim(),
    address:BUILDER_ADDRESS.getData().address,
    addressData:BUILDER_ADDRESS.getData(),
    items:BUILDER.items,
    markup:$("estMarkup").value,
    taxRate:$("estTaxRate").value,
    taxMode:BUILDER.taxMode || SETTINGS.taxMode,
    customCategories:BUILDER.customCategories.map(id=>({id,name:builderCategoryLabel(id)}))
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

/* ---------- Categories in the builder ---------- */

function builderCategoryLabel(key){
  const item=BUILDER.items.find(it=>it.category===key && it.categoryName);
  return categoryLabel(key, BUILDER.categoryNames[key] || (item && item.categoryName));
}

// Main categories always, then the custom categories added to this estimate.
function builderCategories(){
  return [
    ...MAIN_CATEGORIES.map(c=>({...c,custom:false})),
    ...BUILDER.customCategories.map(id=>({key:id,label:builderCategoryLabel(id),custom:true}))
  ];
}

function ensureCategoryInBuilder(key){
  if(!isMainCategory(key) && !BUILDER.customCategories.includes(key)) BUILDER.customCategories.push(key);
}

function openAddCategoryForm(){
  const available=loadCustomCategories().filter(c=>!BUILDER.customCategories.includes(c.id));
  $("catExisting").innerHTML=`<option value="">— Create a new category —</option>`+
    available.map(c=>`<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join("");
  $("catExistingField").hidden=!available.length;
  $("catName").value="";
  $("catNewField").hidden=false;
  openModal("categoryModal");
  (available.length ? $("catExisting") : $("catName")).focus();
}

function submitAddCategory(){
  let id=$("catExisting").value;
  if(!id){
    const category=createCategory($("catName").value);
    if(!category){ $("catName").focus(); return; }
    id=category.id;
    renderServicesPage();
  }
  ensureCategoryInBuilder(id);
  closeModal("categoryModal");
  renderBuilderItems();
  showToast(`Category "${builderCategoryLabel(id)}" added to this estimate.`);
  const section=document.querySelector(`.category-card[data-category="${CSS.escape(id)}"]`);
  if(section){
    section.scrollIntoView({behavior:"smooth",block:"center"});
    section.querySelector('[data-action="add-service"]').focus({preventScroll:true});
  }
}

function removeCategoryFromEstimate(key){
  const count=BUILDER.items.filter(it=>it.category===key).length;
  if(count && !confirm(`Remove "${builderCategoryLabel(key)}" and its ${count} service line(s) from this estimate? The category stays in your list.`)) return;
  BUILDER.items=BUILDER.items.filter(it=>it.category!==key);
  BUILDER.customCategories=BUILDER.customCategories.filter(id=>id!==key);
  renderBuilderItems();
}

/* ---------- Builder rendering ---------- */

function renderBuilderSections(){
  $("builderSections").innerHTML=builderCategories().map(c=>{
    const key=escapeHtml(c.key);
    return `
    <section class="card category-card ${c.custom?"category-custom":""}" data-category="${key}">
      <div class="category-head">
        <h2>${escapeHtml(c.label.toUpperCase())}${c.custom?` <span class="cat-tag">custom</span>`:""}</h2>
        <div class="category-head-right">
          <div class="category-total" id="catTotal-${key}">$0.00</div>
          ${c.custom?`<button class="btn-link danger-link" data-action="remove-category" data-category="${key}">Remove</button>`:""}
        </div>
      </div>
      <div class="line-head" aria-hidden="true"><span>Service</span><span>Quantity</span><span>Price</span><span>Total</span><span></span></div>
      <div class="line-items" id="items-${key}"></div>
      <div class="category-actions">
        <button class="btn btn-light" data-action="add-service" data-category="${key}">+ Add Service</button>
        <button class="btn btn-ghost" data-action="custom-service" data-category="${key}">+ Custom Service</button>
      </div>
    </section>`;
  }).join("")+`
    <div class="add-category">
      <button class="btn btn-light" data-action="add-category">+ Add Category</button>
      <span class="small">For work outside Drywall, Stucco and Painting: Roofing, Flooring, Tile, …</span>
    </div>`;
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
  const container=$(`items-${category}`);
  if(!container) return;
  const items=BUILDER.items.filter(it=>it.category===category);
  container.innerHTML=items.length ? items.map(it=>`
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
    : `<div class="line-empty">No services added yet.</div>`;
}

function renderBuilderItems(){
  renderBuilderSections();
  builderCategories().forEach(c=>renderCategoryItems(c.key));
  updateBuilderTotals();
}

function updateBuilderTotals(){
  const d=getEstimateData();
  d.items.forEach(it=>{
    const cell=document.querySelector(`.line-item[data-item-id="${CSS.escape(it.id)}"] [data-total]`);
    if(cell) cell.textContent=money(it.total);
  });
  const categories=builderCategories();
  categories.forEach(c=>{
    const cell=$(`catTotal-${c.key}`);
    if(cell) cell.textContent=money(d.categoryTotals[c.key]);
  });
  $("sumCategories").innerHTML=categories.map(c=>
    `<div class="sum-row sum-cat"><span>${escapeHtml(c.label)}</span><span id="sum-${escapeHtml(c.key)}">${money(d.categoryTotals[c.key])}</span></div>`
  ).join("");
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
  }else if(action==="add-category"){
    openAddCategoryForm();
  }else if(action==="remove-category"){
    removeCategoryFromEstimate(btn.dataset.category);
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
  // Main + all saved custom categories; a category deleted meanwhile stays selectable here.
  const options=allCategories();
  if(!options.some(c=>c.key===category)) options.push({key:category,label:builderCategoryLabel(category)});
  $("csCategory").innerHTML=categoryOptionsHtml(category,options);
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
  const newSection=!isMainCategory(category) && !BUILDER.customCategories.includes(category);
  ensureCategoryInBuilder(category);
  if(newSection) renderBuilderItems();
  addLineItem(category,{serviceId,name,description,price:defaultPrice});
  // Other rows' dropdowns in this category should list a newly saved service.
  if(serviceId) renderBuilderItems();
  showToast(serviceId ? `"${name}" added and saved to the service list.` : `"${name}" added to this estimate.`);
}

/* ---------- New / reset / open ---------- */

function newEstimate(prefill={}){
  BUILDER={id:null,crmProjectId:prefill.crmProjectId||null,status:null,taxMode:null,items:[],customCategories:[],categoryNames:{}};
  $("clientName").value=prefill.clientName||"";
  $("clientEmail").value=prefill.clientEmail||"";
  $("clientPhone").value=prefill.clientPhone||"";
  $("clientMessage").value=prefill.clientMessage||"";
  BUILDER_ADDRESS.setData(prefill.addressFields || {address:prefill.address||""});
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
    items:clone(est.items),
    customCategories:[],
    categoryNames:{}
  };
  // Custom categories of this estimate: the saved list first, then any used by its lines.
  est.customCategories.forEach(c=>{ ensureCategoryInBuilder(c.id); BUILDER.categoryNames[c.id]=c.name; });
  est.items.forEach(it=>{
    ensureCategoryInBuilder(it.category);
    if(it.categoryName && !BUILDER.categoryNames[it.category]) BUILDER.categoryNames[it.category]=it.categoryName;
  });
  $("clientName").value=est.clientName;
  $("clientEmail").value=est.clientEmail;
  $("clientPhone").value=est.clientPhone;
  $("clientMessage").value=est.clientMessage;
  BUILDER_ADDRESS.setData(est);
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
    .filter(it=>it && it.category)
    .map(it=>({
      id:String(it.id || uid("li")),
      category:String(it.category),
      categoryName:String(it.categoryName ?? ""),
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
    clientMessage:String(e.clientMessage ?? ""),
    address:String(e.address ?? ""),
    ...normalizeAddressFields(e),
    items,
    drywallTotal:round2(amount(e.drywallTotal)),
    stuccoTotal:round2(amount(e.stuccoTotal)),
    paintingTotal:round2(amount(e.paintingTotal)),
    otherTotal:round2(amount(e.otherTotal)),
    customCategories:(Array.isArray(e.customCategories) ? e.customCategories : [])
      .filter(c=>c && c.id && !isMainCategory(c.id))
      .map(c=>({id:String(c.id),name:String(c.name ?? "")})),
    categoryTotals:(e.categoryTotals && typeof e.categoryTotals==="object") ? e.categoryTotals : {},
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
    clientMessage:d.clientMessage,
    ...d.addressData,
    address:d.address,
    items:d.items.map(({id,category,serviceId,name,description,quantity,price,total})=>
      ({id,category,categoryName:builderCategoryLabel(category),serviceId,name,description,quantity,price,total})),
    drywallTotal:d.categoryTotals.drywall,
    stuccoTotal:d.categoryTotals.stucco,
    paintingTotal:d.categoryTotals.painting,
    // Sum of all custom categories; per-category amounts are in categoryTotals.
    otherTotal:round2(Object.keys(d.categoryTotals).filter(k=>!isMainCategory(k)).reduce((s,k)=>s+d.categoryTotals[k],0)),
    customCategories:d.customCategories,
    categoryTotals:d.categoryTotals,
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
  if(record.crmProjectId){
    const link=linkProjectToEstimate(record.crmProjectId,record);
    if(link && link.addressBlocked) setTimeout(()=>showToast("The CRM project keeps its verified address. Verify this address to update both."),2700);
  }

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
  if(typeof cloudDeleteRefused==="function" && cloudDeleteRefused()) return;
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
  const addressFilter=$("estimateAddressFilter").value;
  $("estimateAddressFilter").innerHTML=addressFilterOptions(all,addressFilter);

  const list=all
    .filter(e=>status==="all" || e.status===status)
    .filter(e=>matchesAddressFilter(e,addressFilter))
    .filter(e=>!query || [e.clientName,e.address,e.estimateNumber,e.clientEmail,e.clientPhone].some(v=>v.toLowerCase().includes(query)))
    .sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));

  $("estimatesBody").innerHTML=list.map(e=>{
    const hasProject=e.crmProjectId && projects.some(p=>p.id===e.crmProjectId);
    return `
    <tr data-id="${escapeHtml(e.id)}" class="${e.id===BUILDER.id?"row-current":""}">
      <td data-label="Estimate #" class="nowrap"><b>${escapeHtml(e.estimateNumber)}</b>${e.legacy?`<div class="small">old calculator</div>`:""}</td>
      <td data-label="Client">${escapeHtml(e.clientName||"—")}<div class="small">${escapeHtml([e.clientEmail,e.clientPhone].filter(Boolean).join(" · "))}</div></td>
      <td data-label="Address">${escapeHtml(e.address||"—")}<div>${addressBadgeHtml(e)}</div></td>
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
          <button class="btn btn-light btn-sm" data-action="invoice">${invoicesForEstimate(e.id).length?"Open Invoice":"Create Invoice"}</button>
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
    invoice:()=>createOrOpenInvoiceForEstimate(id),
    delete:()=>deleteEstimate(id)
  })[action]?.();
}

/* ---------- Print / PDF ---------- */

// Categories of an estimate in display order: main ones, then its custom categories.
function estimateCategories(d){
  const list=MAIN_CATEGORIES.map(c=>({key:c.key,label:c.label}));
  const add=(key,label)=>{ if(!list.some(c=>c.key===key)) list.push({key,label}); };
  (d.customCategories||[]).forEach(c=>add(c.id,c.name));
  d.items.forEach(it=>add(it.category,categoryLabel(it.category,it.categoryName)));
  return list;
}

function renderPrintView(d){
  const companyLine=companyContactParts().map(escapeHtml).join(" · ");
  const sections=estimateCategories(d).map(c=>{
    const lines=d.items.filter(it=>it.category===c.key);
    if(!lines.length) return "";
    return `
      <section class="pv-section">
        <h3>${escapeHtml(c.label.toUpperCase())}</h3>
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
          <tfoot><tr><td colspan="3">${escapeHtml(c.label)} total</td><td class="num">${money(d.categoryTotals[c.key])}</td></tr></tfoot>
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
      ${d.clientMessage?`<section class="pv-message">${escapeHtml(d.clientMessage)}</section>`:""}
      ${sections || `<p class="pv-muted">No services added.</p>`}
      <table class="pv-totals">
        <tr><td>Subtotal</td><td class="num">${money(d.subtotal)}</td></tr>
        <tr><td>Markup (${formatQty(d.markup)}%)</td><td class="num">${money(d.markupAmount)}</td></tr>
        <tr><td>Sales Tax (${formatQty(d.taxRate)}%)</td><td class="num">${money(d.taxAmount)}</td></tr>
        <tr class="pv-grand"><td>TOTAL</td><td class="num">${money(d.grandTotal)}</td></tr>
      </table>
      ${SETTINGS.terms.trim()?`
      <section class="pv-terms">
        <h3>TERMS AND CONDITIONS</h3>
        <div class="pv-terms-text">${formatTermsHtml(SETTINGS.terms.trim())}</div>
      </section>`:""}
      ${SETTINGS.estimateFooter?`<footer class="pv-footer">${escapeHtml(SETTINGS.estimateFooter)}</footer>`:""}
    </div>`;
}

// Terms are plain text. Headings ("PAYMENT SCHEDULE", "1. Deposit") are shown in bold.
function formatTermsHtml(text){
  return text.split("\n").map(line=>{
    const t=line.trim();
    const heading=/^\d+\.\s+\S.{0,48}$/.test(t) && !/[.:]$/.test(t) || (/^[A-Z][A-Z &/-]{3,}$/.test(t));
    return heading ? `<b>${escapeHtml(line)}</b>` : escapeHtml(line);
  }).join("\n");
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

function buildEmailBody(d, {withTerms=true}={}){
  const lines=[];
  lines.push(`Hello ${d.clientName || "there"},`,"");
  lines.push(`Please find your estimate from ${companyName()} below.`,"");
  if(d.clientMessage) lines.push(d.clientMessage,"");
  lines.push(`Estimate #: ${d.estimateNumber || "N/A"}`);
  lines.push(`Date: ${formatDate(d.date) || "N/A"}`);
  lines.push(`Client: ${d.clientName || "N/A"}`);
  lines.push(`Project: ${d.address || "N/A"}`,"");

  for(const c of estimateCategories(d)){
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
  if(SETTINGS.terms.trim()) lines.push(...(withTerms ? ["TERMS AND CONDITIONS","",SETTINGS.terms.trim(),""] : ["Terms and Conditions: see the attached PDF estimate.",""]));
  if(SETTINGS.estimateFooter) lines.push(SETTINGS.estimateFooter,"");
  lines.push("Please let us know if you have any questions.","","Best regards,");
  lines.push(...[SETTINGS.companyName,...companyContactParts()]);
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
  const viaGmail=(to=d.clientEmail,subj=subject)=>openMailto(to,subj,buildEmailBody(d),buildEmailBody(d,{withTerms:false}));
  if(!canSendFromCrm()) return viaGmail();
  openSendMail({
    title:`Send estimate ${d.estimateNumber}`,
    to:d.clientEmail, subject, text:buildEmailBody(d),
    filename:`${companyName()} Estimate ${d.estimateNumber}.pdf`.trim(),
    render:()=>renderPrintView(d),
    fallback:({to,subject:subj})=>viaGmail(to,subj)
  });
}
