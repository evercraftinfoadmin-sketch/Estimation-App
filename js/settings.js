"use strict";

/* Company settings, pricing defaults and the estimate number counter.
   Uses the same storage key as the previous version so existing settings are kept. */

const DEFAULT_SETTINGS = {
  markup: 25,
  salesTax: 0,
  // "all": tax on subtotal + markup; "subtotal": tax on the services subtotal only
  taxMode: "all",
  nextEstimateNumber: 1001,
  companyName: "EverCraft Home Improvement",
  companyEmail: "",
  companyPhone: "",
  companyAddress: "",
  estimateFooter: "Thank you for choosing us."
};

function loadSettings(){
  const stored=readStore(STORAGE_KEYS.settings,{}) || {};
  const settings=clone(DEFAULT_SETTINGS);
  for(const key of Object.keys(DEFAULT_SETTINGS)){
    if(stored[key]!==undefined) settings[key]=stored[key];
  }
  settings.markup=amount(settings.markup);
  settings.salesTax=amount(settings.salesTax);
  // The old calculator had a "materials only" mode; there are no materials any more.
  if(!["all","subtotal"].includes(settings.taxMode)) settings.taxMode="all";
  settings.nextEstimateNumber=Math.max(1,Math.floor(num(settings.nextEstimateNumber,1001)));
  for(const key of ["companyName","companyEmail","companyPhone","companyAddress","estimateFooter"]){
    settings[key]=String(settings[key] ?? "");
  }
  return settings;
}

let SETTINGS = loadSettings();

function persistSettings(){
  return writeStore(STORAGE_KEYS.settings, SETTINGS);
}

function companyName(){ return SETTINGS.companyName || "Construction Estimate"; }

function taxModeLabel(mode){
  return mode==="subtotal" ? "subtotal" : "subtotal + markup";
}

/* ---------- Estimate numbers ---------- */

function formatEstimateNumber(n){
  return `EST-${new Date().getFullYear()}-${String(n).padStart(4,"0")}`;
}

// Next number not used by any saved estimate. Advances the stored counter past used numbers.
function nextAvailableEstimateNumber(){
  const used=new Set(loadEstimates().map(e=>e.estimateNumber));
  let changed=false;
  while(used.has(formatEstimateNumber(SETTINGS.nextEstimateNumber))){
    SETTINGS.nextEstimateNumber++;
    changed=true;
  }
  if(changed) persistSettings();
  return formatEstimateNumber(SETTINGS.nextEstimateNumber);
}

// Reserves a number once it has been used (saved, printed or emailed),
// so the next estimate gets a new one.
function issueEstimateNumber(number){
  if(number===formatEstimateNumber(SETTINGS.nextEstimateNumber)){
    SETTINGS.nextEstimateNumber++;
    persistSettings();
  }
}

// Takes the next free number for a new record (e.g. a duplicate).
function takeEstimateNumber(){
  const number=nextAvailableEstimateNumber();
  SETTINGS.nextEstimateNumber++;
  persistSettings();
  return number;
}

/* ---------- Settings page ---------- */

function loadSettingsForm(){
  $("setCompanyName").value=SETTINGS.companyName;
  $("setCompanyEmail").value=SETTINGS.companyEmail;
  $("setCompanyPhone").value=SETTINGS.companyPhone;
  $("setCompanyAddress").value=SETTINGS.companyAddress;
  $("setEstimateFooter").value=SETTINGS.estimateFooter;
  $("setMarkup").value=SETTINGS.markup;
  $("setSalesTax").value=SETTINGS.salesTax;
  $("setTaxMode").value=SETTINGS.taxMode;
  $("setNextNumber").value=SETTINGS.nextEstimateNumber;
}

function saveSettings(){
  SETTINGS.companyName=$("setCompanyName").value.trim();
  SETTINGS.companyEmail=$("setCompanyEmail").value.trim();
  SETTINGS.companyPhone=$("setCompanyPhone").value.trim();
  SETTINGS.companyAddress=$("setCompanyAddress").value.trim();
  SETTINGS.estimateFooter=$("setEstimateFooter").value.trim();
  SETTINGS.markup=amount($("setMarkup").value);
  SETTINGS.salesTax=amount($("setSalesTax").value);
  SETTINGS.taxMode=$("setTaxMode").value==="subtotal" ? "subtotal" : "all";

  const builderHadAutoNumber=isBuilderAutoNumber();
  SETTINGS.nextEstimateNumber=Math.max(1,Math.floor(num($("setNextNumber").value,SETTINGS.nextEstimateNumber)));
  if(!persistSettings()) return;

  loadSettingsForm();
  renderBrand();
  if(builderHadAutoNumber) $("estimateNumber").value=nextAvailableEstimateNumber();
  updateBuilderTotals();
  alert("Settings saved.");
}

function resetSettings(){
  if(!confirm("Reset company details and pricing defaults? The estimate number counter, services, estimates and CRM data are kept.")) return;
  const next=SETTINGS.nextEstimateNumber;
  SETTINGS=clone(DEFAULT_SETTINGS);
  SETTINGS.nextEstimateNumber=next;
  persistSettings();
  loadSettingsForm();
  renderBrand();
  updateBuilderTotals();
}

function renderBrand(){
  $("brandName").textContent=companyName();
}
