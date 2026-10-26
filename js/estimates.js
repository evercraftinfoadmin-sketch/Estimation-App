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
    taxRate:$("estTaxRate").value,
    taxMode:BUILDER.taxMode || SETTINGS.taxMode,
    customCategories:BUILDER.customCategories.map(id=>({id,name:builderCategoryLabel(id)})),
    optionGroup:BUILDER.optionGroup || "",
    optionLabel:BUILDER.optionLabel || ""
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
      <div class="li-actions">
        <button class="btn-icon" data-action="edit-item" title="Edit name and description" aria-label="Edit service line">✎</button>
        <button class="btn-icon" data-action="delete-item" title="Delete service" aria-label="Delete service">✕</button>
      </div>
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
  if(saved) html+=estimateSignBadgeHtml(saved);
  if(saved) html+=optionsBarHtml(saved);
  $("builderMeta").innerHTML=html;
  // The big "+ Add Option" button under Save Estimate (also for an estimate not saved yet).
  const count=saved ? estimateOptions(saved).length : 1;
  $("btnAddOption").hidden=count>=MAX_OPTIONS;
  $("btnAddOption").textContent=count<2 ? "+ Add Option B (give the client a choice)" : `+ Add Option ${"ABCDE"[count]}`;
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
  }else if(action==="edit-item"){
    openLineEdit(btn.closest(".line-item").dataset.itemId);
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

/* ---------- Edit a line (pencil): name and description ---------- */

let EDITING_LINE_ID = null;

function openLineEdit(id){
  const item=findItem(id);
  if(!item) return;
  EDITING_LINE_ID=id;
  const service=item.serviceId ? getService(item.serviceId) : null;
  $("leName").value=item.name || (service ? service.name : "");
  $("leDescription").value=item.description || "";
  $("leSave").checked=false;
  $("leSaveLabel").textContent=service ? `Also update "${service.name}" in my Services list` : "Also save to my Services list";
  $("leSaveNote").textContent=service
    ? "Future estimates will use this name and description. Lines already in other estimates stay as they are."
    : `Saves it as a new ${categoryLabel(item.category)} service at ${money(item.price)}.`;
  openModal("lineEditModal");
  $("leDescription").focus();
}

function submitLineEdit(){
  const item=findItem(EDITING_LINE_ID);
  if(!item){ closeModal("lineEditModal"); return; }
  const name=$("leName").value.trim(), description=$("leDescription").value.replace(/\s+$/,"");
  if(!name){ alert("Please enter a service name."); $("leName").focus(); return; }
  let note="Line updated for this estimate.";
  if($("leSave").checked){
    const service=item.serviceId ? getService(item.serviceId) : null;
    if(service){
      if(!updateServiceText(service.id,{name,description})) return;
      note=`Line and "${name}" in the Services list updated.`;
    }else{
      const created=createService({category:item.category,name,defaultPrice:item.price,description});
      if(!created) return;
      item.serviceId=created.id;
      note=`Line updated and "${name}" saved to the Services list.`;
    }
    renderServicesPage();
  }
  Object.assign(item,{name,description});
  closeModal("lineEditModal");
  renderBuilderItems();
  showToast(note);
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
    categoryNames:{},
    optionGroup:est.optionGroup || "",
    optionLabel:est.optionLabel || ""
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
    signatures:normalizeSignatures(e.signatures),
    // Options: estimates offered together as choices (Option A, B, C) share an optionGroup.
    optionGroup:String(e.optionGroup ?? ""),
    optionLabel:String(e.optionLabel ?? ""),
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
    signatures:existing ? existing.signatures : [],
    optionGroup:d.optionGroup || "",
    optionLabel:d.optionLabel || "",
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
  const project=record.crmProjectId ? getProject(record.crmProjectId) : null;
  // Options share one CRM project; it stays on the option it shows until the client chooses one.
  const onSibling=project && project.estimateId && project.estimateId!==record.id && record.optionGroup &&
    (getEstimate(project.estimateId)||{}).optionGroup===record.optionGroup;
  if(record.crmProjectId && !onSibling){
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

/* ---------- Options: several estimates offered to one client as choices ---------- */

const MAX_OPTIONS = 5;

// The saved estimates of one offer (Option A, B, C…), in order.
function estimateOptions(est){
  if(!est || !est.optionGroup) return est ? [est] : [];
  return loadEstimates().filter(e=>e.optionGroup===est.optionGroup)
    .sort((a,b)=>a.optionLabel.localeCompare(b.optionLabel) || String(a.createdAt).localeCompare(String(b.createdAt)));
}

// Data for the PDF / email of a saved estimate (totals from the same engine as the builder).
function estimateDataFromRecord(est){
  return {...est, ...computeEstimateTotals({items:est.items,taxRate:est.taxRate})};
}

function optionsBarHtml(est){
  const options=estimateOptions(est);
  if(options.length<2){
    return `<div class="opt-bar"><button class="btn btn-link" data-action="add-option" title="Make a second version of this estimate (other services or prices) and send both as choices">+ Add Option B (give the client a choice)</button></div>`;
  }
  const pills=options.map(o=>`<button type="button" class="opt-pill${o.id===est.id?" on":""}" data-action="open-option" data-id="${escapeHtml(o.id)}">${escapeHtml(o.optionLabel||"Option")} · ${escapeHtml(o.estimateNumber)} · ${money(o.customerTotal)}</button>`).join("");
  return `<div class="opt-bar"><span class="small">Options sent together:</span> ${pills}
    ${options.length<MAX_OPTIONS?`<button class="btn btn-link" data-action="add-option">+ Add option</button>`:""}</div>`;
}

// Makes another option of the estimate in the builder (saved first) and opens it.
function addEstimateOption(){
  if(!BUILDER.id || hasUnsavedChanges()){
    if(!confirm("The estimate is saved first, then a copy is made as the next option. Save now?")) return;
    if(!saveEstimate()) return;
  }
  const est=getEstimate(BUILDER.id);
  if(!est) return;
  const group=est.optionGroup || uid("opt");
  if(!est.optionGroup) updateEstimate(est.id,{optionGroup:group,optionLabel:"Option A",updatedAt:nowISO()});
  const options=estimateOptions({...est,optionGroup:group});
  if(options.length>=MAX_OPTIONS){ alert(`An offer can have at most ${MAX_OPTIONS} options.`); return; }
  const used=new Set(options.map(o=>o.optionLabel));
  const label=["A","B","C","D","E"].map(l=>"Option "+l).find(l=>!used.has(l));
  const now=nowISO();
  const copy={
    ...clone(getEstimate(est.id)),
    id:uid("est"),
    estimateNumber:takeEstimateNumber(),
    status:"draft",
    signatures:[],
    optionGroup:group,
    optionLabel:label,
    items:est.items.map(it=>({...it,id:uid("li")})),
    createdAt:now,
    updatedAt:now
  };
  const list=loadEstimates();
  list.push(copy);
  if(!saveEstimates(list)) return;
  loadEstimateIntoBuilder(copy);
  updateBuilderMeta();
  renderSavedEstimates();
  showToast(`${label} made as ${copy.estimateNumber}: change its services or prices, then Save.`);
}

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
    signatures:[],
    optionGroup:"",
    optionLabel:"",
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

function estimatePdfName(d){
  if(d.optionLabel) return `${companyName()} Estimate ${d.estimateNumber} ${d.optionLabel}.pdf`.trim();
  return `${companyName()} Estimate ${d.estimateNumber}.pdf`.trim();
}

function downloadEstimatePdf(){
  const d=getEstimateData();
  issueEstimateNumber(d.estimateNumber);
  return downloadPdf(()=>renderPrintView(d),estimatePdfName(d));
}

function pdfSavedEstimate(id){
  if(openEstimate(id)) downloadEstimatePdf();
}

function emailSavedEstimate(id){
  if(openEstimate(id)) emailEstimate();
}

/* ---------- Saved estimates page ---------- */

function renderSavedEstimates(){
  refreshSignatures();
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
      <td data-label="Estimate #" class="nowrap"><b>${escapeHtml(e.estimateNumber)}</b>${e.optionLabel?`<div><span class="opt-badge">${escapeHtml(e.optionLabel)}</span></div>`:""}${e.legacy?`<div class="small">old calculator</div>`:""}</td>
      <td data-label="Client">${escapeHtml(e.clientName||"—")}<div class="small">${escapeHtml([e.clientEmail,e.clientPhone].filter(Boolean).join(" · "))}</div></td>
      <td data-label="Address">${escapeHtml(e.address||"—")}<div>${addressBadgeHtml(e)}</div></td>
      <td data-label="Date" class="nowrap">${escapeHtml(formatDate(e.date))}</td>
      <td data-label="Status">
        <select data-action="status" aria-label="Status" class="status-select status-${e.status}">
          ${ESTIMATE_STATUSES.map(s=>`<option value="${s}" ${s===e.status?"selected":""}>${capitalize(s)}</option>`).join("")}
        </select>
        ${estimateSignBadgeHtml(e)}
      </td>
      <td data-label="Total" class="nowrap"><b>${money(e.customerTotal)}</b></td>
      <td data-label="Updated" class="small nowrap">${escapeHtml(formatDateTime(e.updatedAt))}</td>
      <td data-label="Actions">
        <div class="row-actions">
          <button class="btn btn-primary btn-sm" data-action="open">Open / Edit</button>
          <button class="btn btn-light btn-sm" data-action="duplicate">Duplicate</button>
          <button class="btn btn-light btn-sm" data-action="print">Print</button>
          <button class="btn btn-light btn-sm" data-action="pdf">PDF</button>
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
    pdf:()=>pdfSavedEstimate(id),
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
  const clientItems=clientPricedLines(d.items,d.grandTotal); // tax built into the prices
  const sections=estimateCategories(d).map(c=>{
    const lines=clientItems.filter(it=>it.category===c.key);
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
              <td class="num">${clientUnitPrice(it)}</td>
              <td class="num">${money(it.total)}</td>
            </tr>`).join("")}
          </tbody>
          <tfoot><tr><td colspan="3">${escapeHtml(c.label)} total</td><td class="num">${money(lines.reduce((t,it)=>t+it.total,0))}</td></tr></tfoot>
        </table>
      </section>`;
  }).join("");

  $("printView").innerHTML=`
    <div class="pv">
      <header class="pv-header">
        ${docBrandHtml(companyLine)}
        <div class="pv-title">
          <div class="pv-doc">ESTIMATE</div>
          <table class="pv-meta">
            ${d.optionLabel?`<tr><td>Option</td><td><b>${escapeHtml(d.optionLabel)}</b></td></tr>`:""}
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
        <tr class="pv-grand"><td>TOTAL</td><td class="num">${money(d.grandTotal)}</td></tr>
        <tr><td colspan="2" class="pv-muted">All taxes included</td></tr>
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

// The services of an estimate as email lines, prices with tax included, grouped by category.
function estimateLinesText(d){
  const lines=[];
  const clientItems=clientPricedLines(d.items,d.grandTotal); // tax built into the prices
  for(const c of estimateCategories(d)){
    const items=clientItems.filter(it=>it.category===c.key);
    if(!items.length) continue;
    lines.push(c.label.toUpperCase());
    for(const it of items){
      lines.push(`- ${it.name || "Service"}: Qty ${formatQty(it.quantity)} x ${clientUnitPrice(it)} = ${money(it.total)}`);
    }
    lines.push(`${c.label} total: ${money(items.reduce((t,it)=>t+it.total,0))}`,"");
  }
  return lines;
}

function buildEmailBody(d, {withTerms=true}={}){
  const lines=[];
  lines.push(`Hello ${d.clientName || "there"},`,"");
  lines.push(`Please find your estimate from ${companyName()} below.`,"");
  if(d.clientMessage) lines.push(d.clientMessage,"");
  lines.push(`Estimate #: ${d.estimateNumber || "N/A"}`);
  lines.push(`Date: ${formatDate(d.date) || "N/A"}`);
  lines.push(`Client: ${d.clientName || "N/A"}`);
  lines.push(`Project: ${d.address || "N/A"}`,"");

  lines.push(...estimateLinesText(d));

  lines.push(`TOTAL: ${money(d.grandTotal)} (all taxes included)`,"");
  if(SETTINGS.terms.trim()) lines.push(...(withTerms ? ["TERMS AND CONDITIONS","",SETTINGS.terms.trim(),""] : ["Terms and Conditions: see the attached PDF estimate.",""]));
  if(SETTINGS.estimateFooter) lines.push(SETTINGS.estimateFooter,"");
  lines.push("Please let us know if you have any questions.","","Best regards,");
  lines.push(...[SETTINGS.companyName,...companyContactParts()]);
  return lines.join("\n");
}

// Deposit percentage from the payment schedule in the Terms ("a deposit of ten percent (10%)"),
// so the email always matches them. null when the Terms name no deposit.
function termsDepositPercent(){
  const t=String(SETTINGS.terms || "");
  // "deposit of ten percent (10%)" or "25% deposit"
  const m=t.match(/deposit[^%]{0,160}?(\d+(?:\.\d+)?)\s*%/i) || t.match(/(\d+(?:\.\d+)?)\s*%\s*(?:non-refundable\s+)?deposit/i);
  const pct=m ? Number(m[1]) : NaN;
  return pct>0 && pct<100 ? pct : null;
}

function emailSignature(){
  return ["Best regards,",SETTINGS.companyName,...companyContactParts()];
}

// The email sent from the CRM with the PDF attached: only the basics. Everything else
// (services, prices, terms) is in the PDF.
function buildEmailSummary(d){
  const pct=termsDepositPercent();
  const lines=[`Hello ${d.clientName || "there"},`,"",
    `Thank you for asking ${companyName()} to quote your project${d.address ? ` at ${d.address}` : ""}.`,""];
  if(d.clientMessage) lines.push(d.clientMessage,"");
  lines.push(`Estimate #: ${d.estimateNumber || "N/A"} (${formatDate(d.date) || "N/A"})`);
  lines.push(`TOTAL: ${money(d.grandTotal)} (all taxes included)`);
  if(pct) lines.push(`Required deposit (${formatQty(pct)}%): ${money(round2(d.grandTotal*pct/100))}`);
  lines.push("","The full estimate with all the details and our terms is in the attached PDF.","",
    "If you have any questions, just reply to this email or give us a call.","",...emailSignature());
  return lines.join("\n");
}

// One line per option: "Option B - Estimate EST-2026-1261: $4,200.00 (deposit 10%: $420.00)".
function optionLine(d){
  const pct=termsDepositPercent();
  return `${d.optionLabel || "Option"} - Estimate ${d.estimateNumber}: ${money(d.grandTotal)}`+
    (pct ? ` (deposit ${formatQty(pct)}%: ${money(round2(d.grandTotal*pct/100))})` : "");
}

function optionsIntro(ds){
  const d=ds[0];
  return [`Hello ${d.clientName || "there"},`,"",
    `Thank you for asking ${companyName()} to quote your project${d.address ? ` at ${d.address}` : ""}. `+
    `We prepared ${ds.length} options for you to choose from:`,""];
}

// Several options in one email, with their PDFs attached: only the basics.
function buildOptionsEmailSummary(ds){
  const lines=optionsIntro(ds);
  ds.forEach(d=>lines.push(optionLine(d)));
  lines.push("","All prices include taxes. The full details of each option and our terms are in the attached PDFs.","",
    "If you have any questions, just reply to this email or give us a call.","",...emailSignature());
  return lines.join("\n");
}

// The same without PDFs: every option with its services, the terms once.
function buildOptionsEmailFull(ds){
  const lines=optionsIntro(ds);
  ds.forEach(d=>{ lines.push(optionLine(d).toUpperCase(),"",...estimateLinesText(d)); });
  if(SETTINGS.terms.trim()) lines.push("TERMS AND CONDITIONS","",SETTINGS.terms.trim(),"");
  lines.push("Please let us know which option you choose, or if you have any questions.","",...emailSignature());
  return lines.join("\n");
}

// The saved options of the estimate in the builder, ready to send (saved first if needed).
// null when it is not part of an offer with several options.
function builderOptionsForSending(action){
  const est=BUILDER.id ? getEstimate(BUILDER.id) : null;
  if(!est || estimateOptions(est).length<2) return null;
  if(hasUnsavedChanges()){
    if(!confirm(`All options are ${action} together, as they are saved. Save this one first?`)) return false;
    if(!saveEstimate()) return false;
  }
  return estimateOptions(getEstimate(BUILDER.id)).map(estimateDataFromRecord);
}

function emailEstimateOptions(ds){
  const first=ds[0];
  const subject=`${companyName()} Estimate - ${ds.length} options - ${first.address || first.clientName || "Project"}`;
  ds.forEach(d=>issueEstimateNumber(d.estimateNumber));
  const viaGmail=(to=first.clientEmail,subj=subject)=>openMailto(to,subj,buildOptionsEmailFull(ds),buildOptionsEmailSummary(ds));
  if(!canSendFromCrm()) return viaGmail();
  openSendMail({
    title:`Send ${ds.length} options (${ds.map(d=>d.estimateNumber).join(", ")})`,
    to:first.clientEmail, subject, text:buildOptionsEmailSummary(ds), textWithoutPdf:buildOptionsEmailFull(ds),
    attachments:ds.map(d=>({filename:estimatePdfName(d),render:()=>renderPrintView(d)})),
    fallback:({to,subject:subj})=>viaGmail(to,subj)
  });
}

function emailEstimate(){
  const d=getEstimateData();
  if(!d.clientEmail){
    alert("Please enter the client's email address.");
    showPage("builder");
    $("clientEmail").focus();
    return;
  }
  const options=builderOptionsForSending("emailed");
  if(options===false) return;
  if(options) return emailEstimateOptions(options);
  const subject=`${companyName()} Estimate ${d.estimateNumber} - ${d.address || d.clientName || "Project"}`;
  issueEstimateNumber(d.estimateNumber);
  const viaGmail=(to=d.clientEmail,subj=subject)=>openMailto(to,subj,buildEmailBody(d),buildEmailBody(d,{withTerms:false}));
  if(!canSendFromCrm()) return viaGmail();
  openSendMail({
    title:`Send estimate ${d.estimateNumber}`,
    to:d.clientEmail, subject, text:buildEmailSummary(d), textWithoutPdf:buildEmailBody(d),
    filename:estimatePdfName(d),
    render:()=>renderPrintView(d),
    fallback:({to,subject:subj})=>viaGmail(to,subj)
  });
}
