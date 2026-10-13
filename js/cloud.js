"use strict";

/* Shared cloud data (Base44).
   The app keeps working on localStorage exactly as before; this module syncs those
   records with the Base44 backend so every signed-in employee sees the same data.
   - Off unless EVERCRAFT_CONFIG.base44AppId is set.
   - Access rules are enforced by Base44 (entity RLS on the User field crm_role),
     not by this code: this module only hides actions that the server would refuse.
   - Every cloud record carries legacy_id (= the app's own id) and a version number.
     A record is only written when its cloud version is still the one this browser last
     saw; otherwise it is a conflict: the cloud copy is kept and the local copy is
     saved under "constructionEstimatorCloudConflicts". Nothing is overwritten silently.
   - Records that existed in this browser before its first sync are NOT uploaded
     automatically: "Upload local data" asks first and downloads a backup.
   - Changes arrive by realtime events when available and by polling every 20 s.
   CRM photos stay in this browser for now (cloud photos are a later step). */

const CLOUD_SDK_URL = "https://cdn.jsdelivr.net/npm/@base44/sdk@0.8.52/+esm";
const CLOUD_POLL_MS = 20000;
const CLOUD_META_KEY = "constructionEstimatorCloudMeta";
const CLOUD_CONFLICTS_KEY = "constructionEstimatorCloudConflicts";

const CLOUD_ADDRESS_FIELDS = ["address","addressStatus","addressStreetNumber","addressRoute","addressUnit","addressCity",
  "addressState","addressPostalCode","addressCountry","addressLatitude","addressLongitude","addressPlaceId","addressLastVerifiedAt"];

// Local list (localStorage key) ↔ Base44 entity, with the fields the entity defines.
// Fields not listed here travel in the entity's "extra" object, so nothing is lost.
const CLOUD_LISTS = [
  {key:STORAGE_KEYS.categories, entity:"Category", fields:["name"]},
  {key:STORAGE_KEYS.services, entity:"Service", fields:["category","name","defaultPrice","description","active","createdAt","updatedAt"]},
  {key:STORAGE_KEYS.estimates, entity:"Estimate", fields:["estimateNumber","date","client_id","clientName","clientEmail","clientPhone",
    ...CLOUD_ADDRESS_FIELDS,"items","drywallTotal","stuccoTotal","paintingTotal","otherTotal","customCategories","categoryTotals",
    "subtotal","markup","markupAmount","taxRate","taxMode","taxAmount","customerTotal","status","crmProjectId","createdAt","updatedAt"]},
  {key:STORAGE_KEYS.crm, entity:"CrmProject", fields:["client_id","clientName","clientEmail","clientPhone",...CLOUD_ADDRESS_FIELDS,
    "estimateId","estimateNumber","estimateTotal","stage","prospectStatus","scheduledDate","assignedTechnician","notes","tasks",
    "followUpDate","followUpType","followUpNotes","followUpCompleted","createdAt","updatedAt"]}
];
const CLOUD_NUMBER_FIELDS = new Set(["addressLatitude","addressLongitude","defaultPrice","drywallTotal","stuccoTotal","paintingTotal",
  "otherTotal","subtotal","markup","markupAmount","taxRate","taxAmount","customerTotal","estimateTotal","salesTax"]);
// Shared business settings. The Google Maps key and the local estimate counter are never uploaded.
const CLOUD_SETTINGS_FIELDS = ["companyName","companyEmail","companyPhone","companyAddress","licenseNumber",
  "markup","salesTax","taxMode","estimateFooter","terms"];
// Fields Base44 adds to every record.
const CLOUD_SYSTEM_FIELDS = new Set(["id","legacy_id","version","extra","deletedAt","created_date","updated_date",
  "created_by_id","created_by","is_sample","app_id","entity_name"]);

const CLOUD = {
  client:null,
  user:null,
  role:"",            // owner | admin | member | "" (no access)
  state:"off",        // off | signed_out | no_access | syncing | synced | error
  message:"",
  lastSync:null,
  pendingUpload:0,    // local records from before the first sync, waiting for "Upload local data"
  timer:null,
  pollTimer:null,
  running:null,
  again:false,
  unsubscribers:[],
  warned:new Set()
};

function cloudConfig(){
  const c=window.EVERCRAFT_CONFIG || {};
  return {appId:String(c.base44AppId || "").trim(), appBaseUrl:String(c.base44AppBaseUrl || "").trim(),
    serverUrl:String(c.base44ServerUrl || "").trim()};
}

function cloudIsAdmin(){ return CLOUD.role==="owner" || CLOUD.role==="admin"; }

/* ---------- record mapping ---------- */

function cloudToRemote(rec, fields){
  const out={legacy_id:String(rec.id)};
  const extra={};
  for(const [k,v] of Object.entries(rec)){
    if(k==="id" || k==="legacy") continue;
    if(fields.includes(k)){
      let val=v===undefined ? null : v;
      if(CLOUD_NUMBER_FIELDS.has(k) && (val==="" || (val!==null && !Number.isFinite(Number(val))))) val=null;
      else if(CLOUD_NUMBER_FIELDS.has(k) && val!==null) val=Number(val);
      out[k]=val;
    }else if(!CLOUD_SYSTEM_FIELDS.has(k) && v!==undefined){
      extra[k]=v;
    }
  }
  out.extra=Object.keys(extra).length ? extra : null;
  return out;
}

function cloudToLocal(remote, fields){
  const rec={id:String(remote.legacy_id)};
  for(const k of fields){
    if(remote[k]!==null && remote[k]!==undefined) rec[k]=remote[k];
  }
  if(remote.extra && typeof remote.extra==="object"){
    for(const [k,v] of Object.entries(remote.extra)) if(!(k in rec) && k!=="id") rec[k]=v;
  }
  return rec;
}

// Stable fingerprint of a record's content: empty values are ignored, so the app
// filling in defaults (normalizing) does not count as a change.
function cloudHash(value){
  const canon=v=>{
    if(Array.isArray(v)) return v.map(canon);
    if(v && typeof v==="object"){
      const o={};
      for(const k of Object.keys(v).sort()){
        const c=canon(v[k]);
        if(c===null || c===undefined || c==="") continue;
        o[k]=c;
      }
      return o;
    }
    return v;
  };
  return JSON.stringify(canon(value));
}

/* ---------- local bookkeeping ---------- */

function cloudMeta(){
  const {appId}=cloudConfig();
  const m=readStore(CLOUD_META_KEY,null);
  if(!m || m.appId!==appId) return {appId, initialized:false, records:{}, unmigrated:{}};
  m.records=m.records || {};
  m.unmigrated=m.unmigrated || {};
  return m;
}

function saveCloudMeta(m){ cloudWriteLocal(CLOUD_META_KEY,m); }

function saveCloudConflict(entity, localRecord, reason){
  const list=readStore(CLOUD_CONFLICTS_KEY,[]);
  list.push({entity, reason, savedAt:nowISO(), record:localRecord});
  cloudWriteLocal(CLOUD_CONFLICTS_KEY,list.slice(-200));
}

// Writes made by the sync itself must not trigger another upload.
let cloudWriteLocal = (key,value)=>writeStore(key,value);

/* ---------- Base44 access ---------- */

async function cloudListAll(entity){
  const api=CLOUD.client.entities[entity];
  const out=[];
  for(let skip=0; skip<100000; skip+=500){
    const page=await api.filter({}, "created_date", 500, skip);
    if(!Array.isArray(page)) break;
    out.push(...page);
    if(page.length<500) break;
  }
  return out;
}

function cloudErrorMessage(err){
  const status=err && (err.status || (err.response && err.response.status));
  if(status===401) return "Signed out";
  if(status===403) return "Not allowed (ask an admin)";
  if(!navigator.onLine) return "Offline";
  return (err && err.message) ? String(err.message) : "Cloud error";
}

/* ---------- sync ---------- */

async function cloudSyncList(def, meta, opts){
  const api=CLOUD.client.entities[def.entity];
  const metaRecs=meta.records[def.entity]=meta.records[def.entity] || {};
  const unmigrated=meta.unmigrated[def.entity]=meta.unmigrated[def.entity] || {};
  const remote=await cloudListAll(def.entity);
  let local=readStore(def.key,[]);
  if(!Array.isArray(local)) local=[];
  const localById=new Map(local.filter(r=>r && r.id).map(r=>[String(r.id),r]));
  const remoteByLid=new Map();
  let changed=false, conflicts=0;

  // 1. Cloud → this browser
  for(const r of remote){
    if(!r || !r.legacy_id) continue;
    const lid=String(r.legacy_id);
    if(remoteByLid.has(lid)) continue; // duplicate legacy_id in the cloud: the oldest record wins
    remoteByLid.set(lid,r);
    const m=metaRecs[lid];
    const loc=localById.get(lid);
    const version=Number(r.version) || 1;

    if(r.deletedAt){ // deleted in the cloud (by an admin)
      if(loc && (!m || cloudHash(cloudToRemote(loc,def.fields))===m.hash)){ localById.delete(lid); changed=true; }
      else if(loc){ saveCloudConflict(def.entity,loc,"deleted in the cloud while changed here"); localById.delete(lid); changed=true; conflicts++; }
      delete metaRecs[lid];
      delete unmigrated[lid];
      continue;
    }
    const remoteLocal=cloudToLocal(r,def.fields);
    const remoteHash=cloudHash(cloudToRemote(remoteLocal,def.fields));
    if(!loc){
      if(m && m.version===version) continue; // deleted here, upload step decides
      localById.set(lid,remoteLocal); changed=true;
    }else{
      const localHash=cloudHash(cloudToRemote(loc,def.fields));
      const localChanged=!m || localHash!==m.hash;
      const remoteChanged=!m || m.version!==version;
      if(localHash===remoteHash){ /* same content */ }
      else if(remoteChanged && localChanged){
        saveCloudConflict(def.entity,loc,m ? "changed here and in the cloud" : "same id here and in the cloud");
        localById.set(lid,remoteLocal); changed=true; conflicts++;
      }else if(remoteChanged){
        localById.set(lid,remoteLocal); changed=true;
      }else{
        continue; // changed only here: uploaded below (metadata stays until then)
      }
    }
    metaRecs[lid]={rid:r.id, version, hash:remoteHash};
    delete unmigrated[lid];
  }
  for(const lid of Object.keys(metaRecs)){
    if(!remoteByLid.has(lid) && localById.has(lid)){
      // Removed from the cloud entirely: keep the local copy as a new record.
      delete metaRecs[lid];
    }
  }
  if(def.entity==="Service"){
    // Every browser creates the default services with its own ids: a service that is
    // only here and has the same category + name as a cloud service becomes that one.
    const byName=new Map();
    for(const r of remoteByLid.values()) if(!r.deletedAt) byName.set(`${r.category}|${String(r.name).trim().toLowerCase()}`,r);
    for(const [lid,loc] of [...localById]){
      if(metaRecs[lid] || remoteByLid.has(lid)) continue;
      const r=byName.get(`${loc.category}|${String(loc.name ?? "").trim().toLowerCase()}`);
      if(!r) continue;
      const cloudCopy=localById.get(String(r.legacy_id)) || cloudToLocal(r,def.fields);
      if(Number(loc.defaultPrice || 0)!==Number(cloudCopy.defaultPrice || 0) || String(loc.description || "")!==String(cloudCopy.description || "")){
        saveCloudConflict(def.entity,loc,"same service name as a cloud service");
      }
      localById.delete(lid);
      localById.set(String(r.legacy_id),cloudCopy);
      delete unmigrated[lid];
      changed=true;
    }
  }
  for(const lid of Object.keys(unmigrated)) if(!localById.has(lid)) delete unmigrated[lid];
  if(!meta.initialized){
    // First sync in this browser: records only here are old local data → explicit upload.
    for(const lid of localById.keys()) if(!metaRecs[lid]) unmigrated[lid]=true;
  }

  // 2. This browser → cloud
  for(const [lid,loc] of localById){
    if(unmigrated[lid] && !opts.uploadLocal) continue;
    const m=metaRecs[lid];
    const data=cloudToRemote(loc,def.fields);
    const hash=cloudHash(data);
    if(m && m.hash===hash) continue;
    if(!m){
      if(def.entity==="Estimate" && data.estimateNumber){
        const taken=(await api.filter({estimateNumber:data.estimateNumber})).find(x=>!x.deletedAt && x.legacy_id!==lid);
        if(taken){
          if(!CLOUD.warned.has(lid+data.estimateNumber)){
            CLOUD.warned.add(lid+data.estimateNumber);
            showToast(`Estimate number ${data.estimateNumber} is already used in the cloud: change the number and save again.`);
          }
          continue;
        }
      }
      const created=await api.create({...data, version:1});
      metaRecs[lid]={rid:created.id, version:Number(created.version) || 1, hash};
      delete unmigrated[lid];
    }else{
      const current=await api.get(m.rid);
      const curVersion=Number(current && current.version) || 1;
      if(!current || current.deletedAt || curVersion!==m.version){
        // Someone else saved first: keep theirs, never overwrite.
        saveCloudConflict(def.entity,loc,"changed here and in the cloud");
        if(current && !current.deletedAt){
          const remoteLocal=cloudToLocal(current,def.fields);
          localById.set(lid,remoteLocal);
          metaRecs[lid]={rid:current.id, version:curVersion, hash:cloudHash(cloudToRemote(remoteLocal,def.fields))};
        }else{
          localById.delete(lid); delete metaRecs[lid];
        }
        changed=true; conflicts++;
        continue;
      }
      const updated=await api.update(m.rid,{...data, version:curVersion+1});
      metaRecs[lid]={rid:m.rid, version:Number(updated && updated.version) || curVersion+1, hash};
    }
  }

  // 3. Deleted in this browser
  for(const lid of Object.keys(metaRecs)){
    if(localById.has(lid)) continue;
    const m=metaRecs[lid];
    if(cloudIsAdmin()){
      const current=await api.get(m.rid);
      if(current && !current.deletedAt && (Number(current.version) || 1)===m.version){
        await api.update(m.rid,{deletedAt:nowISO(), version:m.version+1}); // soft delete, restorable
        delete metaRecs[lid];
      }else if(current && !current.deletedAt){
        localById.set(lid,cloudToLocal(current,def.fields)); // changed meanwhile: bring it back
        metaRecs[lid]={rid:current.id, version:Number(current.version) || 1, hash:cloudHash(cloudToRemote(cloudToLocal(current,def.fields),def.fields))};
        changed=true;
      }else delete metaRecs[lid];
    }else{
      const r=remoteByLid.get(lid);
      if(r){ localById.set(lid,cloudToLocal(r,def.fields)); changed=true; }
      showToast("Only an admin can delete shared records: the record was restored.");
    }
  }

  if(changed) cloudWriteLocal(def.key,[...localById.values()]);
  return {changed, conflicts, unmigrated:Object.keys(unmigrated).length};
}

async function cloudSyncSettings(meta){
  const api=CLOUD.client.entities.CompanySettings;
  const rows=(await api.filter({legacy_id:"company"})).filter(r=>!r.deletedAt);
  const r=rows[0];
  const m=meta.records.CompanySettings || null;
  const localData={};
  for(const k of CLOUD_SETTINGS_FIELDS) localData[k]=SETTINGS[k];
  const localHash=cloudHash(localData);
  let changed=false;
  if(r){
    const version=Number(r.version) || 1;
    const remoteData={};
    for(const k of CLOUD_SETTINGS_FIELDS) if(r[k]!==null && r[k]!==undefined) remoteData[k]=r[k];
    const remoteHash=cloudHash(remoteData);
    const localChanged=!m || localHash!==m.hash;
    const remoteChanged=!m || m.version!==version;
    if(remoteHash===localHash){
      meta.records.CompanySettings={rid:r.id, version, hash:remoteHash};
    }else if(localChanged && !remoteChanged && cloudIsAdmin()){
      // Only an admin's own change: upload it.
      const updated=await api.update(r.id,{...localData, version:version+1});
      meta.records.CompanySettings={rid:r.id, version:Number(updated && updated.version) || version+1, hash:localHash};
    }else{
      // The cloud copy wins (changed by someone else, first sync, or not allowed to change it).
      if(localChanged && m) saveCloudConflict("CompanySettings",localData,remoteChanged ? "changed here and in the cloud" : "only admins can change settings");
      Object.assign(SETTINGS,remoteData);
      cloudWriteLocal(STORAGE_KEYS.settings,SETTINGS);
      changed=true;
      meta.records.CompanySettings={rid:r.id, version, hash:remoteHash};
    }
  }else if(cloudIsAdmin()){
    const created=await api.create({legacy_id:"company", ...localData, version:1});
    meta.records.CompanySettings={rid:created.id, version:Number(created.version) || 1, hash:localHash};
  }

  // Estimate numbers: never go below the shared counter or a number already used.
  const counterApi=CLOUD.client.entities.EstimateCounter;
  const counter=(await counterApi.filter({legacy_id:"estimates"}))[0];
  const usedMax=readStore(STORAGE_KEYS.estimates,[]).reduce((max,e)=>{
    const n=parseInt(String((e && e.estimateNumber) || "").split("-").pop(),10);
    return Number.isFinite(n) && n>max ? n : max;
  },0);
  const next=Math.max(Number(SETTINGS.nextEstimateNumber) || 1, counter ? Number(counter.nextNumber) || 1 : 1, usedMax+1);
  if(next!==SETTINGS.nextEstimateNumber){
    const autoNumber=isBuilderAutoNumber(); // a new estimate still shows the suggested number
    SETTINGS.nextEstimateNumber=next;
    cloudWriteLocal(STORAGE_KEYS.settings,SETTINGS);
    if(autoNumber) $("estimateNumber").value=nextAvailableEstimateNumber();
  }
  if(counter && next>(Number(counter.nextNumber) || 1)){
    await counterApi.update(counter.id,{nextNumber:next, version:(Number(counter.version) || 1)+1});
  }else if(!counter && cloudIsAdmin()){
    await counterApi.create({legacy_id:"estimates", nextNumber:next, version:1});
  }
  return changed;
}

async function cloudSyncOnce(opts={}){
  if(!CLOUD.client || !CLOUD.role) return;
  setCloudState("syncing");
  const meta=cloudMeta();
  let changed=false, conflicts=0, unmigrated=0;
  try{
    // Categories and services first: estimates refer to them.
    for(const def of CLOUD_LISTS){
      const res=await cloudSyncList(def,meta,opts);
      changed=changed || res.changed;
      conflicts+=res.conflicts;
      unmigrated+=res.unmigrated;
    }
    if(await cloudSyncSettings(meta)) changed=true;
    meta.initialized=true;
    saveCloudMeta(meta);
    CLOUD.pendingUpload=unmigrated;
    CLOUD.lastSync=new Date();
    setCloudState("synced", conflicts ? `${conflicts} conflict(s): the cloud version was kept` : "");
    if(conflicts) showToast("Some records were changed by someone else: their version was kept (your copy is saved).");
  }catch(err){
    saveCloudMeta(meta); // keep what was synced before the error
    setCloudState(err && (err.status===401 || (err.response && err.response.status===401)) ? "signed_out" : "error", cloudErrorMessage(err));
  }
  if(changed) refreshVisibleData();
}

function cloudSync(opts){
  if(CLOUD.running){ CLOUD.again=true; return CLOUD.running; }
  CLOUD.running=cloudSyncOnce(opts).finally(()=>{
    CLOUD.running=null;
    if(CLOUD.again){ CLOUD.again=false; scheduleCloudSync(300); }
  });
  return CLOUD.running;
}

function scheduleCloudSync(delay=1500){
  if(!CLOUD.role) return;
  clearTimeout(CLOUD.timer);
  CLOUD.timer=setTimeout(()=>cloudSync(),delay);
}

/* ---------- screen ---------- */

// Re-draw list pages after data arrived, without touching open forms.
function refreshVisibleData(){
  renderBrand();
  if(document.querySelector(".modal.open")) return;
  const page=(location.hash.slice(1) || "builder");
  if(page==="estimates") renderSavedEstimates();
  else if(page==="services") renderServicesPage();
  else if(page==="crm") renderCrmBoard();
  else if(page==="builder") updateBuilderMeta();
}

function setCloudState(state, message=""){
  CLOUD.state=state;
  CLOUD.message=message;
  renderCloudStatus();
}

function renderCloudStatus(){
  const chip=$("cloudStatus");
  if(!chip) return;
  chip.hidden=CLOUD.state==="off";
  const labels={
    signed_out:"☁ Sign in",
    no_access:"☁ No access",
    syncing:"☁ Syncing…",
    synced:"☁ Synced"+(CLOUD.lastSync ? " "+CLOUD.lastSync.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}) : ""),
    error:"☁ "+(CLOUD.message || "Cloud error")
  };
  chip.textContent=labels[CLOUD.state] || "☁";
  chip.dataset.state=CLOUD.state;
  chip.title=CLOUD.state==="no_access"
    ? `Signed in as ${CLOUD.user && CLOUD.user.email}, but this account has no CRM access yet. Ask an admin.`
    : CLOUD.state==="synced" ? `Signed in as ${CLOUD.user && CLOUD.user.email} (${CLOUD.role}). Click to sync now.${CLOUD.message ? "\n"+CLOUD.message : ""}`
    : CLOUD.message || "";
  const up=$("cloudUpload");
  if(up){
    up.hidden=!(CLOUD.pendingUpload>0 && CLOUD.role);
    up.textContent=`⬆ Upload local data (${CLOUD.pendingUpload})`;
  }
  const out=$("cloudSignOut");
  if(out) out.hidden=!CLOUD.user;
}

function handleCloudChipClick(){
  if(CLOUD.state==="signed_out"){
    // Return without the #page part: the login adds ?access_token=… to this address,
    // and after a "#" it would be lost. The page is reopened after sign-in.
    try{ sessionStorage.setItem(CLOUD_RETURN_PAGE_KEY,location.hash.slice(1)); }catch(e){}
    return CLOUD.client.auth.redirectToLogin(location.origin+location.pathname+location.search);
  }
  if(CLOUD.state==="no_access"){
    alert(`Signed in as ${CLOUD.user && CLOUD.user.email}.\n\nThis account has no access to the company data yet. Ask an admin to set your CRM role.`);
    return;
  }
  cloudSync();
}

async function uploadLocalData(){
  const n=CLOUD.pendingUpload;
  if(!n) return;
  if(!confirm(`Upload ${n} record(s) that exist only in this browser to the shared cloud data?\n\n`+
    "A backup file is downloaded first. Records that already exist in the cloud are not overwritten, and estimate numbers already used in the cloud are skipped.")) return;
  exportBackup();
  await cloudSync({uploadLocal:true});
  if(CLOUD.state==="synced") showToast(CLOUD.pendingUpload ? `Uploaded. ${CLOUD.pendingUpload} record(s) could not be uploaded (see messages).` : "Local data uploaded.");
}

function cloudSignOut(){
  if(!confirm("Sign out of the shared cloud data? Data stays in this browser.")) return;
  CLOUD.client.auth.logout(location.href);
}

/* ---------- start-up ---------- */

const CLOUD_RETURN_PAGE_KEY = "constructionEstimatorCloudReturnPage";

// A sign-in token that arrived after the "#" (e.g. "#crm?access_token=…") is moved to where
// the Base44 library keeps it, before the app rewrites the address. Runs when this file loads.
function takeTokenFromHash(){
  const m=/[?&#]access_token=([^&#]+)/.exec(location.hash);
  if(!m) return false;
  try{ localStorage.setItem("base44_access_token",decodeURIComponent(m[1])); }catch(e){}
  const page=location.hash.slice(1).split(/[?&]/)[0];
  history.replaceState(null,"",location.pathname+location.search+(page ? "#"+page : ""));
  return true;
}
takeTokenFromHash();
// Same token arriving without a page load: reload so the sign-in takes effect.
window.addEventListener("hashchange",()=>{ if(takeTokenFromHash()) location.reload(); });

async function loadBase44Sdk(){
  if(window.__EVERCRAFT_BASE44_SDK) return window.__EVERCRAFT_BASE44_SDK; // tests
  return import(CLOUD_SDK_URL);
}

async function initCloud(){
  const cfg=cloudConfig();
  if(!cfg.appId){ setCloudState("off"); return; }
  setCloudState("syncing","Connecting…");
  try{
    const sdk=await loadBase44Sdk();
    CLOUD.client=sdk.createClient({appId:cfg.appId, appBaseUrl:cfg.appBaseUrl || undefined,
      serverUrl:cfg.serverUrl || undefined, requiresAuth:false});
  }catch(err){
    setCloudState("error","Cloud library could not load");
    return;
  }
  try{
    CLOUD.user=await CLOUD.client.auth.me();
  }catch(err){
    CLOUD.user=null;
  }
  if(!CLOUD.user){ setCloudState("signed_out"); return; }
  const role=CLOUD.user.crm_role || (CLOUD.user.data && CLOUD.user.data.crm_role) || "";
  CLOUD.role=["owner","admin","member"].includes(role) ? role : "";
  let returnPage="";
  try{ returnPage=sessionStorage.getItem(CLOUD_RETURN_PAGE_KEY) || ""; sessionStorage.removeItem(CLOUD_RETURN_PAGE_KEY); }catch(e){}
  if(returnPage && PAGES.includes(returnPage)) showPage(returnPage);
  if(!CLOUD.role){ setCloudState("no_access"); return; }

  // Every save in the app schedules an upload of the changed lists.
  const syncedKeys=new Set([...CLOUD_LISTS.map(d=>d.key),STORAGE_KEYS.settings]);
  const appWriteStore=writeStore;
  cloudWriteLocal=(key,value)=>appWriteStore(key,value);
  writeStore=function(key,value){
    const ok=appWriteStore(key,value);
    if(ok && syncedKeys.has(key)) scheduleCloudSync();
    return ok;
  };

  await cloudSync();
  CLOUD.pollTimer=setInterval(()=>{ if(!document.hidden) cloudSync(); },CLOUD_POLL_MS);
  document.addEventListener("visibilitychange",()=>{ if(!document.hidden) scheduleCloudSync(200); });
  window.addEventListener("online",()=>scheduleCloudSync(200));
  // Realtime: a change by someone else triggers a sync right away (polling stays as the safety net).
  for(const name of [...CLOUD_LISTS.map(d=>d.entity),"CompanySettings"]){
    try{
      const api=CLOUD.client.entities[name];
      if(api && typeof api.subscribe==="function") CLOUD.unsubscribers.push(api.subscribe(()=>scheduleCloudSync(800)));
    }catch(e){ /* polling covers it */ }
  }
}

function wireCloudEvents(){
  $("cloudStatus").addEventListener("click",handleCloudChipClick);
  $("cloudUpload").addEventListener("click",uploadLocalData);
  $("cloudSignOut").addEventListener("click",cloudSignOut);
}
