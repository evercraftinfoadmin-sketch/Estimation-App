"use strict";

/* Services database (no units — every service is priced by quantity × price). */

const DEFAULT_SERVICE_NAMES = {
  drywall: ["Drywall Repair","Drywall Installation","Drywall Replacement","Drywall Finishing","Drywall Patching","Drywall Sanding","Drywall Texture"],
  stucco: ["Stucco Repair","Stucco Installation","Stucco Patching","Stucco Crack Repair","Stucco Removal","Stucco Finish","Stucco Color Coat"],
  painting: ["Interior Painting","Exterior Painting","Wall Painting","Ceiling Painting","Door Painting","Trim Painting","Cabinet Painting","Fence Painting"]
};

function defaultServices(){
  const now=nowISO();
  const list=[];
  for(const category of CATEGORY_KEYS){
    for(const name of DEFAULT_SERVICE_NAMES[category]){
      list.push({id:uid("svc"),category,name,defaultPrice:0,description:"",active:true,createdAt:now,updatedAt:now});
    }
  }
  return list;
}

function normalizeService(s){
  return {
    id:String(s.id || uid("svc")),
    category:CATEGORY_KEYS.includes(s.category) ? s.category : "drywall",
    name:String(s.name ?? "").trim() || "Service",
    defaultPrice:round2(amount(s.defaultPrice)),
    description:String(s.description ?? ""),
    active:s.active!==false,
    createdAt:s.createdAt || nowISO(),
    updatedAt:s.updatedAt || s.createdAt || nowISO()
  };
}

// Default services are created only the first time (when nothing is stored yet).
function loadServices(){
  const stored=readStore(STORAGE_KEYS.services,null);
  if(!Array.isArray(stored)){
    const seeded=defaultServices();
    writeStore(STORAGE_KEYS.services,seeded);
    return seeded;
  }
  return stored.filter(s=>s && typeof s==="object").map(normalizeService);
}

function saveServices(list){
  return writeStore(STORAGE_KEYS.services,list);
}

function getService(id){
  return id ? loadServices().find(s=>s.id===id) || null : null;
}

function activeServices(category){
  return loadServices().filter(s=>s.category===category && s.active);
}

function serviceNameTaken(list,category,name,exceptId){
  const n=name.trim().toLowerCase();
  return list.some(s=>s.category===category && s.name.toLowerCase()===n && s.id!==exceptId);
}

// Creates a service; returns it, or null if invalid/duplicate (an alert explains why).
function createService({category,name,defaultPrice,description,active=true}){
  name=String(name||"").trim();
  if(!name){ alert("Please enter a service name."); return null; }
  const list=loadServices();
  if(serviceNameTaken(list,category,name)){
    alert(`"${name}" already exists in ${categoryLabel(category)}.`);
    return null;
  }
  const now=nowISO();
  const service=normalizeService({id:uid("svc"),category,name,defaultPrice,description,active,createdAt:now,updatedAt:now});
  list.push(service);
  return saveServices(list) ? service : null;
}

/* ---------- Services page ---------- */

let EDITING_SERVICE_ID = null;

function renderServicesPage(){
  const query=$("serviceSearch").value.trim().toLowerCase();
  const category=$("serviceCategoryFilter").value;
  const all=loadServices();
  const list=all
    .filter(s=>category==="all" || s.category===category)
    .filter(s=>!query || [s.name,s.description,categoryLabel(s.category)].some(v=>v.toLowerCase().includes(query)));

  $("servicesBody").innerHTML=list.map(s=>`
    <tr data-id="${escapeHtml(s.id)}" class="${s.active?"":"row-muted"}">
      <td data-label="Service"><b>${escapeHtml(s.name)}</b></td>
      <td data-label="Category">${escapeHtml(categoryLabel(s.category))}</td>
      <td data-label="Default Price">${money(s.defaultPrice)}</td>
      <td data-label="Description" class="small">${escapeHtml(s.description) || "—"}</td>
      <td data-label="Status"><span class="status-badge ${s.active?"status-active":"status-inactive"}">${s.active?"Active":"Disabled"}</span></td>
      <td data-label="Actions">
        <div class="row-actions">
          <button class="btn btn-light btn-sm" data-action="edit">Edit</button>
          <button class="btn btn-light btn-sm" data-action="toggle">${s.active?"Disable":"Enable"}</button>
          <button class="btn btn-danger btn-sm" data-action="delete">Delete</button>
        </div>
      </td>
    </tr>`).join("");

  const empty=$("servicesEmpty");
  empty.hidden=list.length>0;
  empty.textContent=all.length ? "No services match your search." : "No services yet. Click + Add Service.";
}

function openServiceForm(id){
  const s=id ? getService(id) : null;
  EDITING_SERVICE_ID=s ? s.id : null;
  $("serviceModalTitle").textContent=s ? "Edit Service" : "Add Service";
  $("svcName").value=s ? s.name : "";
  $("svcCategory").value=s ? s.category : ($("serviceCategoryFilter").value!=="all" ? $("serviceCategoryFilter").value : "drywall");
  $("svcPrice").value=s ? s.defaultPrice : "";
  $("svcDescription").value=s ? s.description : "";
  $("svcActive").checked=s ? s.active : true;
  openModal("serviceModal");
  $("svcName").focus();
}

function submitServiceForm(){
  const data={
    category:$("svcCategory").value,
    name:$("svcName").value.trim(),
    defaultPrice:$("svcPrice").value,
    description:$("svcDescription").value.trim(),
    active:$("svcActive").checked
  };
  if(!EDITING_SERVICE_ID){
    if(!createService(data)) return;
  }else{
    if(!data.name){ alert("Please enter a service name."); return; }
    const list=loadServices();
    const s=list.find(x=>x.id===EDITING_SERVICE_ID);
    if(!s) return;
    if(serviceNameTaken(list,data.category,data.name,s.id)){
      alert(`"${data.name}" already exists in ${categoryLabel(data.category)}.`);
      return;
    }
    Object.assign(s,normalizeService({...s,...data,updatedAt:nowISO()}));
    if(!saveServices(list)) return;
  }
  closeModal("serviceModal");
  renderServicesPage();
  renderBuilderItems();
}

function toggleService(id){
  const list=loadServices();
  const s=list.find(x=>x.id===id);
  if(!s) return;
  s.active=!s.active;
  s.updatedAt=nowISO();
  saveServices(list);
  renderServicesPage();
  renderBuilderItems();
}

function deleteService(id){
  const s=getService(id);
  if(!s) return;
  if(!confirm(`Delete service "${s.name}"? Existing estimates keep their line items.`)) return;
  saveServices(loadServices().filter(x=>x.id!==id));
  renderServicesPage();
  renderBuilderItems();
}

function handleServicesAction(event){
  const btn=event.target.closest("[data-action]");
  const id=btn?.closest("tr")?.dataset.id;
  if(!id) return;
  ({edit:()=>openServiceForm(id),toggle:()=>toggleService(id),delete:()=>deleteService(id)})[btn.dataset.action]?.();
}
