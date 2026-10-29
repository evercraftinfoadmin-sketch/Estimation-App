"use strict";

/* Shared helpers, constants and storage access used by every module. */

const STORAGE_BASE_KEYS = {
  settings: "constructionEstimatorSettings",
  services: "constructionEstimatorServices",
  estimates: "constructionEstimatorSavedEstimates",
  crm: "constructionEstimatorCRM",
  categories: "constructionEstimatorCategories",
  invoices: "constructionEstimatorInvoices",
  // Project financials (js/finance.js)
  costs: "evercraftCostEntries",
  approvals: "evercraftCostApprovals",
  employees: "evercraftEmployees",
  rates: "evercraftEmployeeRates",
  budgets: "evercraftProjectBudgets",
  finlog: "evercraftFinancialLog"
};

// With shared cloud data, each Base44 app (test / production) keeps its own copy of the data
// in this browser ("…@<app id>"), so opening the test and the production version on the same
// web address never mixes them. Without a cloud app the original keys are used.
const STORAGE_NAMESPACE = (()=>{
  const id=String((window.EVERCRAFT_CONFIG || {}).base44AppId || "").trim();
  return id ? "@"+id : "";
})();
function storageKey(base){ return base+STORAGE_NAMESPACE; }
const STORAGE_KEYS = Object.fromEntries(Object.entries(STORAGE_BASE_KEYS).map(([k,v])=>[k,storageKey(v)]));

/* After a backup is restored the page reloads with ?restore=<token>. The reloaded page can read
   this browser's storage before the restore's last writes have arrived there (Chromium delivers
   them separately), so it would see the data from before the restore and might even save it
   again. The restore writes the token last: until the token is visible, nothing is saved and the
   page reloads again shortly (gives up after about 5 seconds and says so). */
const RESTORE_MARK_KEY = storageKey("constructionEstimatorRestoreMark");
const RESTORE_WAITING = (()=>{
  let params;
  try{ params=new URLSearchParams(location.search); }catch(e){ return false; }
  const token=params.get("restore");
  if(!token) return false;
  const tries=Number(params.get("restoreTry")) || 0;
  let seen="";
  try{ seen=localStorage.getItem(RESTORE_MARK_KEY) || ""; }catch(e){}
  const url=new URL(location.href);
  if(seen===token || tries>=20){
    url.searchParams.delete("restore"); url.searchParams.delete("restoreTry");
    try{ history.replaceState(null,"",url.href); }catch(e){}
    if(seen!==token) setTimeout(()=>alert("The restored backup may not have been saved completely in this browser. Please check your data, or restore the backup again."),800);
    return false;
  }
  url.searchParams.set("restoreTry",String(tries+1));
  setTimeout(()=>location.replace(url.href),250);
  return true;
})();

// The three main categories are fixed. Users add their own categories
// (Roofing, Flooring, ...) — see js/categories.js.
const MAIN_CATEGORIES = [
  {key:"drywall", label:"Drywall"},
  {key:"stucco", label:"Stucco"},
  {key:"painting", label:"Painting"}
];
const MAIN_CATEGORY_KEYS = MAIN_CATEGORIES.map(c=>c.key);

// Upper bound for quantities and prices so totals can never overflow to Infinity.
const MAX_AMOUNT = 1e9;

function $(id){ return document.getElementById(id); }

function num(value, fallback=0){
  const n=Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// Non-negative, finite, capped number (quantities, prices, percentages).
function amount(value){
  return Math.min(MAX_AMOUNT, Math.max(0, num(value)));
}

function round2(n){
  return Math.round((num(n)+Number.EPSILON)*100)/100;
}

function escapeHtml(s){
  return String(s ?? "").replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}

function money(n){
  return "$"+num(n).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
}

function formatQty(n){
  return num(n).toLocaleString("en-US",{maximumFractionDigits:2});
}

function capitalize(s){
  s=String(s ?? "");
  return s.charAt(0).toUpperCase()+s.slice(1);
}

// Local calendar date (YYYY-MM-DD). toISOString() would give the UTC date,
// which is already "tomorrow" in US evenings.
function localISODate(d=new Date()){
  const pad=n=>String(n).padStart(2,"0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

function formatDate(isoDate){
  if(!isoDate) return "";
  const [y,m,d]=String(isoDate).split("-").map(Number);
  const date=new Date(y,(m||1)-1,d||1);
  return isNaN(date) ? String(isoDate) : date.toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"});
}

function formatDateTime(iso){
  const d=new Date(iso);
  return isNaN(d) ? "" : d.toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit"});
}

function nowISO(){ return new Date().toISOString(); }

function uid(prefix){
  const rand=(window.crypto && crypto.randomUUID) ? crypto.randomUUID()
    : Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,10);
  return `${prefix}-${rand}`;
}

function clone(obj){ return JSON.parse(JSON.stringify(obj)); }

function readStore(key, fallback){
  try{
    const raw=localStorage.getItem(key);
    return raw==null ? fallback : JSON.parse(raw);
  }catch(e){
    return fallback;
  }
}

function writeStore(key, value){
  if(RESTORE_WAITING) return false; // see RESTORE_WAITING: never save data from before the restore
  try{
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  }catch(e){
    alert("Could not save data in this browser (storage may be full or blocked).");
    return false;
  }
}

function openModal(id){
  $(id).classList.add("open");
  document.body.classList.add("modal-open");
}

function closeModal(id){
  $(id).classList.remove("open");
  if(!document.querySelector(".modal.open")) document.body.classList.remove("modal-open");
}

let TOAST_TIMER = null;

function showToast(message){
  const el=$("toast");
  el.textContent=message;
  el.classList.add("show");
  clearTimeout(TOAST_TIMER);
  TOAST_TIMER=setTimeout(()=>el.classList.remove("show"),2600);
}

/* First start with a cloud app: copy this browser's existing data (the original keys) into the
   app's own copy. The original data is left untouched. Records that this browser exchanged with
   a different cloud app (e.g. test records when opening production) are not copied. All or
   nothing: if the browser storage is full, the partial copy is removed and STORAGE_COPY_FAILED
   tells the cloud module not to sync; the app then works on the original data. */
let STORAGE_COPY_FAILED = false;
(function copyLegacyDataIntoNamespace(){
  if(!STORAGE_NAMESPACE || RESTORE_WAITING) return;
  const ready=storageKey("constructionEstimatorDataReady");
  const written=[];
  try{
    if(localStorage.getItem(ready)) return;
    const appId=STORAGE_NAMESPACE.slice(1);
    const legacyMeta=JSON.parse(localStorage.getItem("constructionEstimatorCloudMeta") || "null");
    const sameApp=!!(legacyMeta && legacyMeta.appId===appId);
    const otherAppRecords=(!sameApp && legacyMeta && legacyMeta.records) || {};
    const entityOfKey={
      [STORAGE_BASE_KEYS.categories]:"Category", [STORAGE_BASE_KEYS.services]:"Service",
      [STORAGE_BASE_KEYS.estimates]:"Estimate", [STORAGE_BASE_KEYS.crm]:"CrmProject"
    };
    const bases=[...Object.values(STORAGE_BASE_KEYS)];
    if(sameApp) bases.push("constructionEstimatorCloudMeta","constructionEstimatorCloudConflicts");
    for(const base of bases){
      const raw=localStorage.getItem(base);
      if(raw===null || localStorage.getItem(storageKey(base))!==null) continue; // never overwrite
      let value=JSON.parse(raw);
      const ids=otherAppRecords[entityOfKey[base]];
      if(ids && Array.isArray(value)) value=value.filter(r=>!(r && Object.prototype.hasOwnProperty.call(ids,String(r.id))));
      // Numbering continues after the remaining estimates, not from the other app's counter.
      if(base===STORAGE_BASE_KEYS.settings && !sameApp && legacyMeta && value){
        let estimates=JSON.parse(localStorage.getItem(STORAGE_BASE_KEYS.estimates) || "[]");
        const estIds=otherAppRecords.Estimate || {};
        if(!Array.isArray(estimates)) estimates=[];
        const usedMax=estimates.filter(e=>e && !Object.prototype.hasOwnProperty.call(estIds,String(e.id)))
          .reduce((max,e)=>{ const n=parseInt(String(e.estimateNumber || "").split("-").pop(),10); return Number.isFinite(n) && n>max ? n : max; },0);
        if(usedMax) value.nextEstimateNumber=usedMax+1; else delete value.nextEstimateNumber;
      }
      localStorage.setItem(storageKey(base),JSON.stringify(value));
      written.push(storageKey(base));
    }
    localStorage.setItem(ready,new Date().toISOString());
  }catch(e){
    STORAGE_COPY_FAILED=true;
    for(const k of written){ try{ localStorage.removeItem(k); }catch(e2){} }
    // Keep working on the original data (cloud off) until the copy succeeds on a later start.
    Object.assign(STORAGE_KEYS,STORAGE_BASE_KEYS);
  }
})();

/* ---------- Email (mailto) ---------- */

// Mail apps refuse or cut long mailto links (about 2000 characters in Outlook, Windows Mail and
// some webmail handlers). The full text is tried first; then the version without the terms (they
// are on the PDF); then a cut version. When the email is shortened the full text is copied to the
// clipboard so it can be pasted.
const MAILTO_MAX = 1900;  // many mail apps cut longer mailto links
const GMAIL_MAX = 8000;   // Gmail's compose link takes much more
let MAILTO_OPENING = false; // the "unsaved changes" warning is not shown for the mail app

function mailtoUrl(to, subject, body){
  return "mailto:"+encodeURIComponent(to)+"?subject="+encodeURIComponent(subject)+"&body="+encodeURIComponent(body);
}

// Gmail compose window in the given account (authuser), so the email is sent from that address.
function gmailComposeUrl(from, to, subject, body){
  return "https://mail.google.com/mail/?authuser="+encodeURIComponent(from)+"&view=cm&fs=1&to="+encodeURIComponent(to)+
    "&su="+encodeURIComponent(subject)+"&body="+encodeURIComponent(body);
}

// Opens a new email: in Gmail as Settings → "Send emails from", or in the device's mail app when that is empty.
function openMailto(to, subject, fullBody, shortBody){
  const from=String((typeof SETTINGS!=="undefined" && SETTINGS.emailFrom) || "").trim();
  const make=from ? (t,s,b)=>gmailComposeUrl(from,t,s,b) : mailtoUrl;
  const max=from ? GMAIL_MAX : MAILTO_MAX;
  let url=make(to,subject,fullBody), shortened=false;
  if(url.length>max && shortBody){ url=make(to,subject,shortBody); shortened=true; }
  if(url.length>max){
    let text=shortBody || fullBody;
    const note="\n\n(Shortened. The full estimate is in the attached PDF.)";
    while(text.length>200 && make(to,subject,text+note).length>max) text=text.slice(0,Math.floor(text.length*0.9));
    url=make(to,subject,text+note); shortened=true;
  }
  if(shortened){
    try{ navigator.clipboard && navigator.clipboard.writeText(fullBody).catch(()=>{}); }catch(e){}
    showToast("Email opened with a shorter text (email links limit the length). The full text is copied: paste it if you need it. Attach the PDF.");
  }
  // Open in a new window without leaving this page (no "Leave site?" prompt, the CRM tab stays open).
  MAILTO_OPENING=true;
  const a=document.createElement("a");
  a.href=url; a.target="_blank"; a.rel="noopener";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>{ MAILTO_OPENING=false; },1500);
  return url;
}
