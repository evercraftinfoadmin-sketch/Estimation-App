"use strict";

/* Shared helpers, constants and storage access used by every module. */

const STORAGE_KEYS = {
  settings: "constructionEstimatorSettings",
  services: "constructionEstimatorServices",
  estimates: "constructionEstimatorSavedEstimates",
  crm: "constructionEstimatorCRM"
};

const CATEGORIES = [
  {key:"drywall", label:"Drywall"},
  {key:"stucco", label:"Stucco"},
  {key:"painting", label:"Painting"},
  // Anything outside the three main trades (demolition, cleanup, carpentry, ...)
  {key:"other", label:"Other Services"}
];
const CATEGORY_KEYS = CATEGORIES.map(c=>c.key);

// Upper bound for quantities and prices so totals can never overflow to Infinity.
const MAX_AMOUNT = 1e9;

function $(id){ return document.getElementById(id); }

function categoryLabel(key){
  const c=CATEGORIES.find(c=>c.key===key);
  return c ? c.label : "";
}

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
