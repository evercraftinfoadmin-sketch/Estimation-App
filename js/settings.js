"use strict";

/* Company settings, pricing defaults and the estimate number counter.
   Uses the same storage key as the previous version so existing settings are kept. */

// Added to every estimate sent to a client (PDF/print and email). Editable in Settings.
const DEFAULT_TERMS = `Please read the terms and conditions.

The price includes proper coverage of the floor, the paint and materials.
Paint brand: Sherwin-Williams

Credit card payment fee: 3.5%
Cash discount: 5%

Duration of the project: 2-3 working days

PAYMENT SCHEDULE
Payments are due according to the following schedule:

1. Deposit
A non-refundable deposit of ten percent (10%) of the total contract amount is required to secure and reserve the project start date. No work will be scheduled until this deposit is received.

2. First Progress Payment
A forty percent (40%) payment of the total contract amount is due at the end of the first working day once the crew has commenced work.

3. Final Payment
The remaining fifty percent (50%) of the total contract amount is due immediately upon completion of all contracted work, prior to equipment removal and final walkthrough.

4. Late or Missing Payments
Failure to make payments according to the schedule may result in suspension of work and/or additional fees as allowed under California law.

Number to contact: +1 818 913 4820
Email: EverCraft.pro@gmail.com
License number: #1133560`;

const DEFAULT_SETTINGS = {
  markup: 25,
  salesTax: 0,
  // "all": tax on subtotal + markup; "subtotal": tax on the services subtotal only
  taxMode: "all",
  nextEstimateNumber: 1001,
  companyName: "EverCraft Home Improvement",
  companyEmail: "EverCraft.pro@gmail.com",
  companyPhone: "+1 818 913 4820",
  companyAddress: "",
  licenseNumber: "#1133560",
  estimateFooter: "Thank you for choosing us.",
  terms: DEFAULT_TERMS
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
  // Settings saved before Terms & Conditions existed: fill in the company contact details.
  if(stored.terms===undefined){
    for(const key of ["companyEmail","companyPhone","licenseNumber"]){
      if(!stored[key]) settings[key]=DEFAULT_SETTINGS[key];
    }
  }
  for(const key of ["companyName","companyEmail","companyPhone","companyAddress","licenseNumber","estimateFooter","terms"]){
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
  $("setLicense").value=SETTINGS.licenseNumber;
  $("setEstimateFooter").value=SETTINGS.estimateFooter;
  $("setTerms").value=SETTINGS.terms;
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
  SETTINGS.licenseNumber=$("setLicense").value.trim();
  SETTINGS.estimateFooter=$("setEstimateFooter").value.trim();
  SETTINGS.terms=$("setTerms").value.replace(/\s+$/,"");
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
  if(!confirm("Reset company details, Terms & Conditions and pricing defaults? The estimate number counter, services, estimates and CRM data are kept.")) return;
  const next=SETTINGS.nextEstimateNumber;
  SETTINGS=clone(DEFAULT_SETTINGS);
  SETTINGS.nextEstimateNumber=next;
  persistSettings();
  loadSettingsForm();
  renderBrand();
  updateBuilderTotals();
}

function restoreDefaultTerms(){
  if(!confirm("Replace the text in the box with the default Terms & Conditions? Press Save Settings to keep it.")) return;
  $("setTerms").value=DEFAULT_TERMS;
}

// Company contact line used on the estimate header.
function companyContactParts(){
  return [
    SETTINGS.companyAddress,
    SETTINGS.companyPhone,
    SETTINGS.companyEmail,
    SETTINGS.licenseNumber ? `License ${SETTINGS.licenseNumber}` : ""
  ].filter(Boolean);
}

function renderBrand(){
  $("brandName").textContent=companyName();
}
