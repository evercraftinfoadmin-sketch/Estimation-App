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

// Documents the client signs electronically. {{placeholders}} are filled in from the CRM
// (list in Settings → Signature Documents). Drafts: have them reviewed before relying on them.
const DEFAULT_SIGN_TEXT_ESTIMATE = `ACCEPTANCE OF ESTIMATE

By signing below, I accept Estimate {{estimateNumber}} dated {{estimateDate}} from {{company}} for the work at {{address}}, for a total price of {{total}}.

I have read the services, prices, terms and conditions and the payment schedule above, and I agree to them. I authorize {{company}} to schedule the work. The work starts after the Work Authorization is signed and the deposit is paid.`;

const DEFAULT_SIGN_TEXT_WORK = `WORK AUTHORIZATION

I, the undersigned owner of the property (or the owner's authorized agent), authorize {{company}} (License {{license}}) to begin and perform the work described in Estimate {{estimateNumber}} at {{address}}, for a total price of {{total}}, under the terms and conditions and payment schedule of that estimate.

1. Start of work. Scheduled start: {{startDate}}. Dates may move because of weather, material delivery or other causes outside the contractor's control; the client will be told as soon as possible.
2. Access. The client gives access to the work areas, water and electricity during working hours, and keeps children, pets and valuables away from the work areas.
3. Changes. Any change to the scope, materials or price is agreed in writing (signed change order or email) before the changed work is done.
4. Hidden conditions. Damage or conditions that could not be seen before the work started (for example rot, mold, water damage, code issues) are not included; they are described and priced before any extra work is done.
5. Payments. Payments are due as stated in the payment schedule of the estimate.

By signing, I confirm that I have read and accept the estimate, its terms and conditions, and this Work Authorization.`;

const DEFAULT_SIGN_TEXT_COMPLETION = `CERTIFICATE OF COMPLETION AND ACCEPTANCE

I, the undersigned client, confirm that:

1. The work described in Estimate {{estimateNumber}} (and any changes agreed in writing) at {{address}} has been completed by {{company}}.
2. I have inspected the completed work and accept it as complete and satisfactory.
3. The work areas have been cleaned and the leftover materials and debris removed.
4. The balance due on Invoice {{invoiceNumber}} ({{balance}}) is payable as stated on the invoice.
5. The workmanship warranty described in the estimate's terms and conditions starts on {{date}}.

If anything is not complete or not satisfactory, please do not sign and contact us at {{phone}} or {{email}} so we can take care of it.`;

const DEFAULT_SETTINGS = {
  // markup and taxMode are no longer used (there is no markup); kept so saved and shared
  // settings from earlier versions stay readable.
  markup: 0,
  salesTax: 0,
  taxMode: "subtotal",
  nextEstimateNumber: 1001,
  companyName: "EverCraft Home Improvement",
  companyEmail: "EverCraft.pro@gmail.com",
  // Estimates and invoices are emailed from this Gmail account (empty = the device's mail app).
  emailFrom: "EverCraft.pro@gmail.com",
  companyPhone: "+1 818 913 4820",
  companyAddress: "",
  licenseNumber: "#1133560",
  // Browser key for address verification; stored only in this browser (never in the code).
  googleMapsApiKey: "",
  estimateFooter: "Thank you for choosing us.",
  terms: DEFAULT_TERMS,
  signTextEstimate: DEFAULT_SIGN_TEXT_ESTIMATE,
  signTextWork: DEFAULT_SIGN_TEXT_WORK,
  signTextCompletion: DEFAULT_SIGN_TEXT_COMPLETION,
  // Google Calendar (js/calendar.js). calendarTeam: JSON list of team calendars.
  calendarEnabled: "",
  calendarSince: "",
  calendarMain: "primary",
  calendarTeam: "[]",
  calendarOnCancel: "delete",
  // Project financials (js/finance.js): defaults, not business rules. Kept as text like the rest.
  finLaborRate: "",
  finBurdenPercent: "",
  finWarnPct: "90",
  finCritPct: "100",
  finAutoApprove: ""
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
  for(const key of ["companyName","companyEmail","emailFrom","companyPhone","companyAddress","licenseNumber","estimateFooter","terms","googleMapsApiKey","signTextEstimate","signTextWork","signTextCompletion",
    "calendarEnabled","calendarSince","calendarMain","calendarTeam","calendarOnCancel",
    "finLaborRate","finBurdenPercent","finWarnPct","finCritPct","finAutoApprove"]){
    settings[key]=String(settings[key] ?? "");
  }
  return settings;
}

let SETTINGS = loadSettings();

function persistSettings(){
  return writeStore(STORAGE_KEYS.settings, SETTINGS);
}

function companyName(){ return SETTINGS.companyName || "Construction Estimate"; }

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
  $("setEmailFrom").value=SETTINGS.emailFrom;
  $("setCompanyPhone").value=SETTINGS.companyPhone;
  $("setCompanyAddress").value=SETTINGS.companyAddress;
  $("setLicense").value=SETTINGS.licenseNumber;
  $("setMapsKey").value=SETTINGS.googleMapsApiKey;
  renderMapsKeyStatus();
  $("setEstimateFooter").value=SETTINGS.estimateFooter;
  $("setTerms").value=SETTINGS.terms;
  $("setSignEstimate").value=SETTINGS.signTextEstimate;
  $("setSignWork").value=SETTINGS.signTextWork;
  $("setSignCompletion").value=SETTINGS.signTextCompletion;
  $("setSalesTax").value=SETTINGS.salesTax;
  $("setNextNumber").value=SETTINGS.nextEstimateNumber;
  renderCalendarSettings();
  renderFinanceSettings();
  if(!CALENDAR_LIST && SETTINGS.calendarEnabled==="on" && canSendFromCrm()) refreshCalendarSettings();
}

function saveSettings(){
  SETTINGS.companyName=$("setCompanyName").value.trim();
  SETTINGS.companyEmail=$("setCompanyEmail").value.trim();
  SETTINGS.emailFrom=$("setEmailFrom").value.trim();
  SETTINGS.companyPhone=$("setCompanyPhone").value.trim();
  SETTINGS.companyAddress=$("setCompanyAddress").value.trim();
  SETTINGS.licenseNumber=$("setLicense").value.trim();
  const oldMapsKey=SETTINGS.googleMapsApiKey;
  SETTINGS.googleMapsApiKey=$("setMapsKey").value.trim();
  SETTINGS.estimateFooter=$("setEstimateFooter").value.trim();
  SETTINGS.terms=$("setTerms").value.replace(/\s+$/,"");
  SETTINGS.signTextEstimate=$("setSignEstimate").value.replace(/\s+$/,"") || DEFAULT_SIGN_TEXT_ESTIMATE;
  SETTINGS.signTextWork=$("setSignWork").value.replace(/\s+$/,"") || DEFAULT_SIGN_TEXT_WORK;
  SETTINGS.signTextCompletion=$("setSignCompletion").value.replace(/\s+$/,"") || DEFAULT_SIGN_TEXT_COMPLETION;
  SETTINGS.salesTax=amount($("setSalesTax").value);
  readCalendarSettings();
  readFinanceSettings();

  const builderHadAutoNumber=isBuilderAutoNumber();
  SETTINGS.nextEstimateNumber=Math.max(1,Math.floor(num($("setNextNumber").value,SETTINGS.nextEstimateNumber)));
  if(!persistSettings()) return;

  loadSettingsForm();
  renderBrand();
  if(oldMapsKey!==SETTINGS.googleMapsApiKey) resetPlacesLoader();
  if(builderHadAutoNumber) $("estimateNumber").value=nextAvailableEstimateNumber();
  updateBuilderTotals();
  scheduleCalendarScan();
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

function restoreDefaultSignTexts(){
  if(!confirm("Replace the three document texts with the defaults? Press Save Settings to keep them.")) return;
  $("setSignEstimate").value=DEFAULT_SIGN_TEXT_ESTIMATE;
  $("setSignWork").value=DEFAULT_SIGN_TEXT_WORK;
  $("setSignCompletion").value=DEFAULT_SIGN_TEXT_COMPLETION;
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

function renderMapsKeyStatus(){
  const el=$("mapsKeyStatus");
  if(!el) return;
  const loaded=!!(window.google && google.maps && google.maps.importLibrary);
  el.textContent=configuredMapsKey()
    ? (PLACES_UNAVAILABLE ? "Google rejected this key. Check the key restrictions, enabled APIs and billing." : "A key is set. Address suggestions are on.")
    : loaded ? "Google Maps is already loaded on this page." : "No key: addresses can be typed but not verified.";
}

function renderBrand(){
  $("brandName").textContent=companyName();
}
