"use strict";

/* Service categories.
   Drywall, Stucco and Painting are the fixed main categories. Users can add their own
   categories (Roofing, Flooring, Tile, ...) — stored in constructionEstimatorCategories as
   {id, name, createdAt, updatedAt}. Services and estimate lines refer to a category by id. */

const MAX_CATEGORY_NAME = 40;

function normalizeCategory(c){
  return {
    id:String(c.id),
    name:String(c.name ?? "").trim().slice(0,MAX_CATEGORY_NAME) || "Custom",
    createdAt:c.createdAt || nowISO(),
    updatedAt:c.updatedAt || c.createdAt || nowISO()
  };
}

// The previous version had a fixed "Other Services" category (id "other").
// If it was used, it becomes a normal custom category with the same name.
function migratedCategories(){
  const services=readStore(STORAGE_KEYS.services,[]);
  const estimates=readStore(STORAGE_KEYS.estimates,[]);
  const usesOther=(Array.isArray(services) && services.some(s=>s && s.category==="other")) ||
    (Array.isArray(estimates) && estimates.some(e=>e && Array.isArray(e.items) && e.items.some(it=>it && it.category==="other")));
  return usesOther ? [normalizeCategory({id:"other",name:"Other Services"})] : [];
}

function loadCustomCategories(){
  const stored=readStore(STORAGE_KEYS.categories,null);
  if(!Array.isArray(stored)){
    const list=migratedCategories();
    writeStore(STORAGE_KEYS.categories,list);
    return list;
  }
  return stored.filter(c=>c && c.id).map(normalizeCategory);
}

function saveCustomCategories(list){
  return writeStore(STORAGE_KEYS.categories,list);
}

function isMainCategory(key){
  return MAIN_CATEGORY_KEYS.includes(key);
}

// Main categories first, then custom ones: [{key, label, custom}]
function allCategories(){
  return [
    ...MAIN_CATEGORIES.map(c=>({...c,custom:false})),
    ...loadCustomCategories().map(c=>({key:c.id,label:c.name,custom:true}))
  ];
}

function getCustomCategory(id){
  return loadCustomCategories().find(c=>c.id===id) || null;
}

// Current name of a category; `fallback` is used when a custom category was deleted.
function categoryLabel(key, fallback){
  const main=MAIN_CATEGORIES.find(c=>c.key===key);
  if(main) return main.label;
  const custom=getCustomCategory(key);
  return custom ? custom.name : (fallback || "Other");
}

function categoryNameTaken(name, exceptId){
  const n=name.trim().toLowerCase();
  return MAIN_CATEGORIES.some(c=>c.label.toLowerCase()===n) ||
    loadCustomCategories().some(c=>c.name.toLowerCase()===n && c.id!==exceptId);
}

function validateCategoryName(name, exceptId){
  name=String(name ?? "").trim();
  if(!name){ alert("Please enter a category name."); return null; }
  if(name.length>MAX_CATEGORY_NAME){ alert(`Category names can be at most ${MAX_CATEGORY_NAME} characters.`); return null; }
  if(categoryNameTaken(name,exceptId)){ alert(`A category named "${name}" already exists.`); return null; }
  return name;
}

// Creates a custom category; returns it, or null (an alert explains why).
function createCategory(name){
  name=validateCategoryName(name);
  if(!name) return null;
  const list=loadCustomCategories();
  const now=nowISO();
  const category=normalizeCategory({id:uid("cat"),name,createdAt:now,updatedAt:now});
  list.push(category);
  return saveCustomCategories(list) ? category : null;
}

function renameCategory(id, name){
  const list=loadCustomCategories();
  const c=list.find(x=>x.id===id);
  if(!c) return false;
  name=validateCategoryName(name,id);
  if(!name) return false;
  c.name=name;
  c.updatedAt=nowISO();
  return saveCustomCategories(list);
}

// Deletes a custom category and its services. Saved estimates keep their lines.
function deleteCategory(id){
  const c=getCustomCategory(id);
  if(!c) return false;
  const services=loadServices().filter(s=>s.category===id);
  const msg=services.length
    ? `Delete category "${c.name}" and its ${services.length} service(s)? Saved estimates keep their lines.`
    : `Delete category "${c.name}"? Saved estimates keep their lines.`;
  if(!confirm(msg)) return false;
  if(!saveCustomCategories(loadCustomCategories().filter(x=>x.id!==id))) return false;
  if(services.length) saveServices(loadServices().filter(s=>s.category!==id));
  return true;
}

function categoryOptionsHtml(selected, categories=allCategories()){
  return categories.map(c=>`<option value="${escapeHtml(c.key)}" ${c.key===selected?"selected":""}>${escapeHtml(c.label)}</option>`).join("");
}

/* ---------- Categories card (Services page) ---------- */

function renderCategoriesCard(){
  const custom=loadCustomCategories();
  const services=loadServices();
  $("categoriesList").innerHTML=
    MAIN_CATEGORIES.map(c=>`<span class="cat-chip cat-main">${escapeHtml(c.label)}<span class="small">main</span></span>`).join("")+
    custom.map(c=>`
      <span class="cat-chip" data-id="${escapeHtml(c.id)}">
        ${escapeHtml(c.name)} <span class="small">${services.filter(s=>s.category===c.id).length} services</span>
        <button class="btn-link" data-action="rename-category">Rename</button>
        <button class="btn-link danger-link" data-action="delete-category">Delete</button>
      </span>`).join("");
}

function addCategoryFromServicesPage(){
  const name=prompt("New category name (e.g. Roofing, Flooring, Tile):");
  if(name===null) return;
  const c=createCategory(name);
  if(!c) return;
  refreshAfterCategoryChange();
  showToast(`Category "${c.name}" added.`);
}

function handleCategoriesCard(event){
  const btn=event.target.closest("[data-action]");
  const id=btn?.closest(".cat-chip")?.dataset.id;
  if(!id) return;
  if(btn.dataset.action==="rename-category"){
    const c=getCustomCategory(id);
    const name=prompt("Rename category:",c ? c.name : "");
    if(name===null || !renameCategory(id,name)) return;
    refreshAfterCategoryChange();
    showToast("Category renamed.");
  }else if(btn.dataset.action==="delete-category"){
    if(!deleteCategory(id)) return;
    refreshAfterCategoryChange();
    showToast("Category deleted.");
  }
}

function refreshAfterCategoryChange(){
  renderCategoriesCard();
  renderServicesPage();
  renderBuilderItems();
}
