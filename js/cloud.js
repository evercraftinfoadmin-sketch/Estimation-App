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
   - Changes arrive by realtime events (about a second) and by a check every 30 seconds.
   - Each Base44 app has its own copy of the data and its own sign-in in this browser
     (storageKey in core.js), so test and production never mix.
   - Only owners/admins delete shared records; members get a message instead.
   CRM photos stay in this browser for now (cloud photos are a later step); in cloud mode they
   are never deleted automatically, because a project can come back from the cloud. */

const CLOUD_SDK_URL = "https://cdn.jsdelivr.net/npm/@base44/sdk@0.8.52/+esm";
// Base44 allows about 40 requests a minute (measured on the free plan), so background
// checks are kept light: each check costs 4 requests, settings + counter 2 more.
const CLOUD_POLL_MS = 30000;
const CLOUD_SETTINGS_EVERY_MS = 5*60000;
// Bookkeeping, conflict copies and the sign-in belong to one Base44 app (see storageKey in core.js).
const CLOUD_META_KEY = storageKey("constructionEstimatorCloudMeta");
const CLOUD_CONFLICTS_KEY = storageKey("constructionEstimatorCloudConflicts");
const CLOUD_TOKEN_KEY = storageKey("base44_access_token");

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
    "followUpDate","followUpType","followUpNotes","followUpCompleted","createdAt","updatedAt"]},
  {key:STORAGE_KEYS.invoices, entity:"Invoice", fields:["invoiceNumber","date","dueDate","estimateId","estimateNumber","crmProjectId",
    "clientName","clientEmail","clientPhone","address","items","markup","taxRate","taxMode","subtotal","markupAmount","taxAmount",
    "total","payments","paid","balance","status","clientMessage","createdAt","updatedAt"]}
];
const CLOUD_NUMBER_FIELDS = new Set(["addressLatitude","addressLongitude","defaultPrice","drywallTotal","stuccoTotal","paintingTotal",
  "otherTotal","subtotal","markup","markupAmount","taxRate","taxAmount","customerTotal","estimateTotal","salesTax",
  "total","paid","balance"]);
// Shared business settings. The Google Maps key and the local estimate counter are never uploaded.
const CLOUD_SETTINGS_FIELDS = ["companyName","companyEmail","companyPhone","companyAddress","licenseNumber",
  "markup","salesTax","taxMode","estimateFooter","terms"];
// Settings kept in the CompanySettings record's "extra" field (no table change needed).
const CLOUD_SETTINGS_EXTRA = ["signTextEstimate","signTextWork","signTextCompletion"];
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
  warned:new Set(),
  failures:[],       // records the server refused in the last sync
  unsaved:0          // changes here not confirmed by the server
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

// Fingerprint of a record as the app itself would save it: the app's own normalizing
// (defaults, the CRM checklist) and the automatic timestamps don't count as a change.
const CLOUD_NORMALIZE = {
  Category:r=>normalizeCategory(r),
  Service:r=>normalizeService(r),
  Estimate:r=>normalizeEstimate(r),
  CrmProject:r=>normalizeProject(r),
  Invoice:r=>normalizeInvoice(r)
};
function cloudRecordHash(def, rec){
  let r=rec;
  try{ if(CLOUD_NORMALIZE[def.entity]) r=CLOUD_NORMALIZE[def.entity](rec); }catch(e){ r=rec; }
  const {createdAt, updatedAt, legacy, ...content}=r;
  return cloudHash(cloudToRemote({...content, id:rec.id},def.fields));
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

// Is this copy of the app connected to a shared cloud app (signed in or not)?
function cloudActive(){ return !!cloudConfig().appId; }

// Only owners and admins may delete shared records. Members' deletes would be undone by the
// next sync anyway, so the app refuses them up front (local-only use is not restricted).
function cloudCanDelete(){ return !(CLOUD.role && !cloudIsAdmin()); }

function cloudDeleteRefused(){
  if(cloudCanDelete()) return false;
  alert("Only an admin can delete shared records. Ask an admin, or change the record instead.");
  return true;
}

// Restoring a backup while this browser syncs: syncing stops until the page reloads and the
// bookkeeping is forgotten, so the restored data counts as data from this computer only. Then the
// next sync neither deletes nor overwrites shared records: where the shared CRM has a record its
// version is kept (the restored copy is saved as a conflict copy), and records only in the backup
// wait for "Upload to shared CRM".
function cloudPrepareRestore(){
  if(!cloudActive()) return false;
  CLOUD.suspended=true;
  clearTimeout(CLOUD.timer);
  clearInterval(CLOUD.pollTimer);
  try{ localStorage.removeItem(CLOUD_META_KEY); }catch(e){}
  return true;
}

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
  if(cloudRateLimited(err)) return "Base44 request limit reached, trying again in about a minute";
  if(!navigator.onLine) return "Offline";
  return (err && err.message) ? String(err.message) : "Cloud error";
}

/* ---------- sync ---------- */

const CLOUD_BACKOFF_MS = 45000;

function cloudRateLimited(err){
  const status=err && (err.status || (err.response && err.response.status));
  return status===429 || /rate limit/i.test(String(err && err.message || ""));
}

// Network loss or an expired sign-in stops the whole sync; anything else only affects one record.
function cloudFatalError(err){
  const status=err && (err.status || (err.response && err.response.status));
  return !status || status===401 || status===429;
}

function cloudRecordFailure(entity, lid, reason){
  CLOUD.failures.push({entity, lid, reason});
}

// Changes in this browser that the server has not confirmed yet (new, edited or deleted
// records). Local data from before the first sign-in is counted separately (pendingUpload).
function cloudUnsavedCount(){
  const meta=cloudMeta();
  if(!meta.initialized) return 0;
  let n=0;
  for(const def of CLOUD_LISTS){
    const metaRecs=meta.records[def.entity] || {}, unm=meta.unmigrated[def.entity] || {};
    const local=readStore(def.key,[]);
    const ids=new Set();
    for(const rec of (Array.isArray(local) ? local : [])){
      if(!rec || !rec.id) continue;
      const lid=String(rec.id); ids.add(lid);
      if(unm[lid]) continue;
      const m=metaRecs[lid];
      if(!m || m.hash!==cloudRecordHash(def,rec)) n++;
    }
    for(const lid of Object.keys(metaRecs)) if(!ids.has(lid)) n++;
  }
  return n;
}

async function cloudSyncList(def, meta, opts){
  const api=CLOUD.client.entities[def.entity];
  const metaRecs=meta.records[def.entity]=meta.records[def.entity] || {};
  const unmigrated=meta.unmigrated[def.entity]=meta.unmigrated[def.entity] || {};
  const uploadLocal=!!(opts && opts.uploadLocal);
  const remote=await cloudListAll(def.entity);
  let local=readStore(def.key,[]);
  if(!Array.isArray(local)) local=[];
  const localById=new Map(local.filter(r=>r && r.id).map(r=>[String(r.id),r]));
  // What the list looked like when this sync read it: anything saved in this browser while the
  // sync waits for the network is detected against it and wins (see the end of this function).
  const readAtStart=new Map(local.filter(r=>r && r.id).map(r=>[String(r.id),JSON.stringify(r)]));
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
      if(loc && (!m || cloudRecordHash(def,loc)===m.hash)){ localById.delete(lid); changed=true; }
      else if(loc){ saveCloudConflict(def.entity,loc,"deleted in the cloud while changed here"); localById.delete(lid); changed=true; conflicts++; }
      delete metaRecs[lid];
      delete unmigrated[lid];
      continue;
    }
    const remoteLocal=cloudToLocal(r,def.fields);
    const remoteHash=cloudRecordHash(def,remoteLocal);
    if(!loc){
      if(m && m.version===version) continue; // deleted here, upload step decides
      localById.set(lid,remoteLocal); changed=true;
    }else{
      const localHash=cloudRecordHash(def,loc);
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

  // Downloaded records are written to this browser even if an upload below fails:
  // the bookkeeping already says they are in sync.
  try{
    // 2. This browser → cloud
    for(const [lid,loc] of localById){
      if(unmigrated[lid] && !uploadLocal) continue;
      const m=metaRecs[lid];
      const data=cloudToRemote(loc,def.fields);
      const hash=cloudRecordHash(def,loc);
      if(m && m.hash===hash) continue;
      if(!m){
        if(def.entity==="Estimate" && data.estimateNumber){
          const taken=(await api.filter({estimateNumber:data.estimateNumber})).find(x=>!x.deletedAt && x.legacy_id!==lid);
          if(taken){
            if(!CLOUD.warned.has(lid+data.estimateNumber)){
              CLOUD.warned.add(lid+data.estimateNumber);
              showToast(`Estimate number ${data.estimateNumber} is already used in the cloud: change the number and save again.`);
            }
            cloudRecordFailure(def.entity,lid,`estimate number ${data.estimateNumber} is already used`);
            continue;
          }
        }
        let created;
        try{ created=await api.create({...data, version:1}); }
        catch(err){ if(cloudFatalError(err)) throw err; cloudRecordFailure(def.entity,lid,cloudErrorMessage(err)); continue; }
        if(!created || !created.id){ cloudRecordFailure(def.entity,lid,"the server did not confirm the save"); continue; }
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
            metaRecs[lid]={rid:current.id, version:curVersion, hash:cloudRecordHash(def,remoteLocal)};
          }else{
            localById.delete(lid); delete metaRecs[lid];
          }
          changed=true; conflicts++;
          continue;
        }
        let updated;
        try{ updated=await api.update(m.rid,{...data, version:curVersion+1}); }
        catch(err){ if(cloudFatalError(err)) throw err; cloudRecordFailure(def.entity,lid,cloudErrorMessage(err)); continue; }
        if(!updated || !updated.id){ cloudRecordFailure(def.entity,lid,"the server did not confirm the save"); continue; }
        metaRecs[lid]={rid:m.rid, version:Number(updated.version) || curVersion+1, hash};
      }
    }

    // 3. Deleted in this browser
    for(const lid of Object.keys(metaRecs)){
      if(localById.has(lid)) continue;
      const m=metaRecs[lid];
      if(cloudIsAdmin()){
        const current=await api.get(m.rid);
        if(current && !current.deletedAt && (Number(current.version) || 1)===m.version){
          try{
            await api.update(m.rid,{deletedAt:nowISO(), version:m.version+1}); // soft delete, restorable
            delete metaRecs[lid];
          }catch(err){ if(cloudFatalError(err)) throw err; cloudRecordFailure(def.entity,lid,"delete: "+cloudErrorMessage(err)); }
        }else if(current && !current.deletedAt){
          localById.set(lid,cloudToLocal(current,def.fields)); // changed meanwhile: bring it back
          metaRecs[lid]={rid:current.id, version:Number(current.version) || 1, hash:cloudRecordHash(def,cloudToLocal(current,def.fields))};
          changed=true;
        }else delete metaRecs[lid];
      }else{
        const r=remoteByLid.get(lid);
        if(r){ localById.set(lid,cloudToLocal(r,def.fields)); changed=true; }
        showToast("Only an admin can delete shared records: the record was restored.");
      }
    }
  }finally{
    if(changed && !CLOUD.suspended){
      // Merge with what is saved now: records created, edited or deleted here during the sync
      // keep the newer local state; the bookkeeping still has the last confirmed version, so
      // the next sync uploads them.
      const now=readStore(def.key,[]);
      const nowById=new Map((Array.isArray(now) ? now : []).filter(r=>r && r.id).map(r=>[String(r.id),r]));
      for(const [lid,rec] of nowById){
        if(readAtStart.get(lid)!==JSON.stringify(rec)){ localById.set(lid,rec); CLOUD.again=true; }
      }
      for(const lid of readAtStart.keys()){
        if(!nowById.has(lid)){ localById.delete(lid); CLOUD.again=true; }
      }
      cloudWriteLocal(def.key,[...localById.values()]);
    }
  }
  return {changed, conflicts, unmigrated:Object.keys(unmigrated).length};
}

async function cloudSyncSettings(meta){
  const api=CLOUD.client.entities.CompanySettings;
  const rows=(await api.filter({legacy_id:"company"})).filter(r=>!r.deletedAt);
  const r=rows[0];
  const m=meta.records.CompanySettings || null;
  const localData={extra:{}};
  for(const k of CLOUD_SETTINGS_FIELDS) localData[k]=SETTINGS[k];
  for(const k of CLOUD_SETTINGS_EXTRA) localData.extra[k]=SETTINGS[k];
  const localHash=cloudHash(localData);
  let changed=false;
  if(r){
    const version=Number(r.version) || 1;
    const remoteData={extra:{}};
    for(const k of CLOUD_SETTINGS_FIELDS) if(r[k]!==null && r[k]!==undefined) remoteData[k]=r[k];
    const rx=(r.extra && typeof r.extra==="object") ? r.extra : {};
    for(const k of CLOUD_SETTINGS_EXTRA) remoteData.extra[k]=typeof rx[k]==="string" ? rx[k] : DEFAULT_SETTINGS[k];
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
      const {extra:remoteExtra,...remoteFields}=remoteData;
      Object.assign(SETTINGS,remoteFields,remoteExtra);
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

async function cloudSyncOnce(){
  if(!CLOUD.client || !CLOUD.role || CLOUD.suspended) return;
  const opts={uploadLocal:!!CLOUD.uploadRequested};
  setCloudState("syncing");
  const meta=cloudMeta();
  CLOUD.failures=[];
  let changed=false, conflicts=0, unmigrated=0;
  const pendingBy={};
  try{
    // Categories and services first: estimates refer to them.
    for(const def of CLOUD_LISTS){
      const res=await cloudSyncList(def,meta,opts);
      changed=changed || res.changed;
      conflicts+=res.conflicts;
      unmigrated+=res.unmigrated;
      pendingBy[def.entity]=res.unmigrated;
    }
    // Settings and the estimate counter: on the first sync, after a local change to settings or
    // estimates, and every few minutes.
    if(!meta.initialized || CLOUD.settingsDirty || Date.now()-(CLOUD.settingsSyncedAt || 0)>CLOUD_SETTINGS_EVERY_MS){
      CLOUD.settingsDirty=false;
      if(await cloudSyncSettings(meta)) changed=true;
      CLOUD.settingsSyncedAt=Date.now();
    }
    meta.initialized=true;
    if(CLOUD.suspended) return;
    saveCloudMeta(meta);
    if(opts.uploadLocal && !unmigrated) CLOUD.uploadRequested=false; // everything uploaded
    CLOUD.pendingUpload=unmigrated;
    CLOUD.pendingBy=pendingBy;
    CLOUD.lastSync=new Date();
    CLOUD.unsaved=cloudUnsavedCount();
    const notes=[];
    if(conflicts) notes.push(`${conflicts} conflict(s): the cloud version was kept`);
    if(CLOUD.failures.length) notes.push(CLOUD.failures.slice(0,3).map(f=>f.reason).join("; "));
    setCloudState("synced", notes.join(" · "));
    if(conflicts) showToast("Some records were changed by someone else: their version was kept (your copy is saved).");
  }catch(err){
    if(CLOUD.suspended) return;
    saveCloudMeta(meta); // keep what was synced before the error
    CLOUD.unsaved=cloudUnsavedCount();
    if(cloudRateLimited(err)){
      // Too many requests for the Base44 plan: pause, then try again once.
      CLOUD.backoffUntil=Date.now()+CLOUD_BACKOFF_MS;
      scheduleCloudSync(CLOUD_BACKOFF_MS);
    }
    setCloudState(err && (err.status===401 || (err.response && err.response.status===401)) ? "signed_out" : "error", cloudErrorMessage(err));
    changed=true; // part of the data may have arrived before the error
  }
  if(changed) refreshVisibleData();
}

// One sync at a time. A request that arrives while one runs makes it run again right after,
// and the returned promise only settles when no follow-up is due (unless paused by the limit).
// {uploadLocal:true} asks to upload local data; the request stays until the upload is complete.
function cloudSync(opts){
  if(opts && opts.uploadLocal) CLOUD.uploadRequested=true;
  if(CLOUD.running){ CLOUD.again=true; return CLOUD.running; }
  CLOUD.running=(async()=>{
    do{
      CLOUD.again=false;
      await cloudSyncOnce();
    }while(CLOUD.again && !CLOUD.suspended && Date.now()>=(CLOUD.backoffUntil || 0));
  })().finally(()=>{
    CLOUD.running=null;
    if(CLOUD.again){ CLOUD.again=false; scheduleCloudSync(300); }
  });
  return CLOUD.running;
}

function scheduleCloudSync(delay=1500){
  if(!CLOUD.role) return;
  delay=Math.max(delay,(CLOUD.backoffUntil || 0)-Date.now());
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
  else if(page==="invoices") renderInvoicesPage();
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
    synced:CLOUD.unsaved ? `☁ ${CLOUD.unsaved} not saved` : "☁ Synced"+(CLOUD.lastSync ? " "+CLOUD.lastSync.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}) : ""),
    error:"☁ "+(CLOUD.message || "Cloud error")
  };
  chip.textContent=labels[CLOUD.state] || "☁";
  chip.dataset.state=CLOUD.state==="synced" && CLOUD.unsaved ? "error" : CLOUD.state;
  chip.title=CLOUD.state==="no_access"
    ? `Signed in as ${CLOUD.user && CLOUD.user.email}, but this account has no CRM access yet. Ask an admin.`
    : CLOUD.state==="synced" ? `Signed in as ${CLOUD.user && CLOUD.user.email} (${CLOUD.role}). Click to sync now.${CLOUD.message ? "\n"+CLOUD.message : ""}`
    : CLOUD.message || "";
  const up=$("cloudUpload");
  const showPending=CLOUD.pendingUpload>0 && !!CLOUD.role;
  if(up){
    up.hidden=!showPending;
    up.textContent=`⬆ Upload local data (${CLOUD.pendingUpload})`;
  }
  const bar=$("cloudPendingBar");
  if(bar){
    // Shown only after a sync attempt, so a save in progress does not flash it.
    const showUnsaved=CLOUD.unsaved>0 && !!CLOUD.role && CLOUD.state!=="syncing";
    bar.hidden=!(showPending || showUnsaved);
    const lines=[];
    if(showPending) lines.push(`${pendingSummary()} on this computer ${CLOUD.pendingUpload===1 ? "is" : "are"} not in the shared CRM yet. Other users can't see ${CLOUD.pendingUpload===1 ? "it" : "them"} until you upload.`);
    if(showUnsaved){
      const why=CLOUD.state==="error" ? (CLOUD.message || "connection problem")
        : (CLOUD.failures.length ? CLOUD.failures.slice(0,2).map(f=>f.reason).join("; ") : "waiting for the next sync");
      lines.push(`${CLOUD.unsaved} change${CLOUD.unsaved===1 ? " is" : "s are"} not saved to the shared CRM yet (${why}). ${CLOUD.state==="error" ? "They stay on this computer and are saved automatically when the connection works again." : "Fix the problem and save again, or try again."}`);
    }
    $("cloudPendingText").textContent=lines.join(" ");
    $("cloudPendingUpload").hidden=!showPending;
    $("cloudRetry").hidden=!showUnsaved;
  }
  const out=$("cloudSignOut");
  if(out) out.hidden=!CLOUD.user;
}

function handleCloudChipClick(){
  if(CLOUD.state==="signed_out") return openCloudLogin();
  if(CLOUD.state==="no_access"){
    alert(`Signed in as ${CLOUD.user && CLOUD.user.email}.\n\nThis account has no access to the company data yet. Ask an admin to give you access (Settings → Team Access).`);
    return;
  }
  cloudSync();
}

/* ---------- sign-in ---------- */

function cloudApiUrl(pth){
  const cfg=cloudConfig();
  return `${(cfg.serverUrl || "https://base44.app").replace(/\/$/,"")}/api/apps/${cfg.appId}${pth}`;
}

function openCloudLogin(){
  $("cloudLoginError").textContent="";
  openModal("cloudLoginModal");
  setTimeout(()=>$("cloudLoginEmail").focus(),50);
}

// Email + password sign-in happens inside the app, so it works wherever the app is hosted.
async function submitCloudLogin(){
  const email=$("cloudLoginEmail").value.trim(), password=$("cloudLoginPassword").value;
  const err=$("cloudLoginError"), btn=$("cloudLoginSubmit");
  if(!email || !password){ err.textContent="Enter your email and password."; return; }
  err.textContent=""; btn.disabled=true; btn.textContent="Signing in…";
  try{
    const r=await fetch(cloudApiUrl("/auth/login"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email,password})});
    let body={}; try{ body=await r.json(); }catch(e){}
    if(!r.ok || !body.access_token){
      err.textContent=(body && (body.detail || body.message)) || `Sign-in failed (${r.status}).`;
      return;
    }
    $("cloudLoginPassword").value="";
    try{ localStorage.setItem(CLOUD_TOKEN_KEY,body.access_token); }catch(e){}
    cloudUseToken(body.access_token);
    closeModal("cloudLoginModal");
    await startCloudSession();
  }catch(e){
    err.textContent="Could not reach the sign-in service. Check the internet connection.";
  }finally{
    btn.disabled=false; btn.textContent="Sign in";
  }
}

async function requestPasswordLink(){
  const email=$("cloudLoginEmail").value.trim(), err=$("cloudLoginError");
  if(!email){ err.textContent="Enter your email first."; $("cloudLoginEmail").focus(); return; }
  try{
    await fetch(cloudApiUrl("/auth/reset-password-request"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email})});
    err.textContent="";
    alert(`If ${email} can sign in to this app, an email with a link to set a password is on its way. Set the password there, then come back and sign in here.`);
  }catch(e){
    err.textContent="Could not reach the sign-in service. Check the internet connection.";
  }
}

function cloudGoogleLogin(){
  // After the Base44 login, return to the Base44 app's own home page: it forwards to this app
  // with the sign-in after a "#" (Base44 does not reliably hand the sign-in to other web
  // addresses, e.g. on phones). The current page is reopened after sign-in.
  try{ sessionStorage.setItem(CLOUD_RETURN_PAGE_KEY,location.hash.slice(1)); }catch(e){}
  const home=cloudConfig().appBaseUrl.replace(/\/$/,"");
  CLOUD.client.auth.redirectToLogin(home ? home+"/" : location.origin+location.pathname+location.search);
}

/* ---------- team access (Base44 app admins) ---------- */

const TEAM_ROLES = [["none","No access"],["member","Member"],["admin","Admin"],["owner","Owner"]];

function canManageTeam(){ return !!(CLOUD.user && CLOUD.user.role==="admin" && CLOUD.role); }

async function renderTeamCard(){
  const card=$("teamCard");
  if(!card) return;
  card.hidden=!canManageTeam();
  if(card.hidden) return;
  const status=$("teamStatus");
  let users;
  try{ users=await CLOUD.client.entities.User.list("full_name",500); }
  catch(e){ status.textContent="Could not load the team: "+cloudErrorMessage(e); return; }
  status.textContent="";
  $("teamBody").innerHTML=(users || []).map(u=>{
    const me=CLOUD.user && u.id===CLOUD.user.id;
    const role=["member","admin","owner"].includes(u.crm_role) ? u.crm_role : "none";
    return `<tr><td>${escapeHtml(u.full_name || "")}${me ? " <span class=\"small\">(you)</span>" : ""}</td><td>${escapeHtml(u.email || "")}</td>
      <td><select data-user="${escapeHtml(u.id)}" data-current="${role}" ${me ? "disabled title=\"You cannot change your own access\"" : ""}>
        ${TEAM_ROLES.map(([k,l])=>`<option value="${k}"${k===role ? " selected" : ""}>${l}</option>`).join("")}
      </select></td></tr>`;
  }).join("") || `<tr><td colspan="3" class="small">Nobody has signed in yet.</td></tr>`;
}

async function handleTeamChange(e){
  const sel=e.target.closest("select[data-user]");
  if(!sel) return;
  const status=$("teamStatus");
  sel.disabled=true;
  try{
    await CLOUD.client.entities.User.update(sel.dataset.user,{crm_role:sel.value});
    sel.dataset.current=sel.value;
    status.textContent="Saved. The person gets the new access the next time the app opens.";
  }catch(err){
    sel.value=sel.dataset.current;
    status.textContent="Not saved: "+cloudErrorMessage(err);
  }finally{
    sel.disabled=false;
  }
}

// "3 CRM leads, 1 estimate, 21 services"
function pendingSummary(){
  const names={CrmProject:["CRM lead","CRM leads"],Estimate:["estimate","estimates"],Invoice:["invoice","invoices"],Service:["service","services"],Category:["category","categories"]};
  const by=CLOUD.pendingBy || {};
  const parts=["CrmProject","Estimate","Invoice","Service","Category"].filter(k=>by[k]>0).map(k=>`${by[k]} ${names[k][by[k]===1 ? 0 : 1]}`);
  return parts.join(", ") || `${CLOUD.pendingUpload} record(s)`;
}

async function uploadLocalData(){
  const n=CLOUD.pendingUpload;
  if(!n) return;
  if(!confirm(`Upload ${pendingSummary()} that exist only on this computer to the shared CRM?\n\n`+
    "A backup file is downloaded first. Records that already exist in the cloud are not overwritten, and estimate numbers already used in the cloud are skipped.")) return;
  exportBackup();
  await cloudSync({uploadLocal:true});
  // Report what really happened.
  if(CLOUD.state==="synced" && !CLOUD.pendingUpload){
    showToast(`Local data uploaded (${n} record(s)).`);
  }else if(CLOUD.state==="synced"){
    alert(`${n-CLOUD.pendingUpload} of ${n} record(s) uploaded. ${CLOUD.pendingUpload} could not be uploaded`+
      (CLOUD.failures.length ? `: ${CLOUD.failures.slice(0,3).map(f=>f.reason).join("; ")}` : "")+
      ".\n\nThey stay on this computer; fix the problem and click Upload again.");
  }else{
    alert(`The upload is not finished (${CLOUD.message || "cloud error"}).\n\n`+
      "Nothing is lost: the records stay on this computer and the upload continues automatically when the shared CRM is reachable again.");
  }
}

function cloudSignOut(){
  if(!confirm("Sign out of the shared cloud data? Data stays in this browser.")) return;
  try{ localStorage.removeItem(CLOUD_TOKEN_KEY); }catch(e){}
  CLOUD.client.auth.logout(location.href);
}

/* ---------- start-up ---------- */

const CLOUD_RETURN_PAGE_KEY = "constructionEstimatorCloudReturnPage";

// A sign-in token that arrived after the "#" (e.g. "#crm?access_token=…") is moved to where
// the Base44 library keeps it, before the app rewrites the address. Runs when this file loads.
function takeTokenFromHash(){
  const m=/[?&#]access_token=([^&#]+)/.exec(location.hash);
  if(!m) return false;
  try{ localStorage.setItem(CLOUD_TOKEN_KEY,decodeURIComponent(m[1])); }catch(e){}
  const page=location.hash.slice(1).split(/[?&]/)[0];
  history.replaceState(null,"",location.pathname+location.search+(page ? "#"+page : ""));
  return true;
}
// The same for "?access_token=…" (Base44 login returning to this page).
function takeTokenFromSearch(){
  const params=new URLSearchParams(location.search);
  const token=params.get("access_token");
  if(!token) return;
  try{ localStorage.setItem(CLOUD_TOKEN_KEY,token); }catch(e){}
  params.delete("access_token");
  const q=params.toString();
  history.replaceState(null,"",location.pathname+(q ? "?"+q : "")+location.hash);
}
takeTokenFromHash();
takeTokenFromSearch();
// Same token arriving without a page load: reload so the sign-in takes effect.
window.addEventListener("hashchange",()=>{ if(takeTokenFromHash()) location.reload(); });

async function loadBase44Sdk(){
  if(window.__EVERCRAFT_BASE44_SDK) return window.__EVERCRAFT_BASE44_SDK; // tests
  return import(CLOUD_SDK_URL);
}

async function initCloud(){
  const cfg=cloudConfig();
  if(!cfg.appId){ setCloudState("off"); return; }
  if(STORAGE_COPY_FAILED){
    // core.js could not prepare this app's copy of the data: never sync a partial copy.
    setCloudState("error","Not enough browser storage to prepare the shared data. Free some space and reload.");
    return;
  }
  setCloudState("syncing","Connecting…");
  try{
    const sdk=await loadBase44Sdk();
    // The Base44 library also keeps a copy of the sign-in under one shared name, which the test
    // and the production app would share on this web address. This app only uses its own key
    // (CLOUD_TOKEN_KEY), so the shared copy is removed before and after the library starts.
    clearSharedSdkToken();
    CLOUD.client=sdk.createClient({appId:cfg.appId, appBaseUrl:cfg.appBaseUrl || undefined,
      serverUrl:cfg.serverUrl || undefined, requiresAuth:false, token:cloudStoredToken() || undefined});
    clearSharedSdkToken();
  }catch(err){
    setCloudState("error","Cloud library could not load");
    return;
  }
  await startCloudSession();
}

function cloudStoredToken(){
  try{ return localStorage.getItem(CLOUD_TOKEN_KEY) || ""; }catch(e){ return ""; }
}

function hasStoredSignIn(){ return !!cloudStoredToken(); }

// Gives the sign-in to the whole Base44 client: data requests AND the realtime connection
// (auth.setToken alone leaves realtime signed out, so it would get no events).
function cloudUseToken(token){
  if(!token || !CLOUD.client) return;
  if(typeof CLOUD.client.setToken==="function") CLOUD.client.setToken(token);
  else CLOUD.client.auth.setToken(token,false);
  clearSharedSdkToken(); // this app's sign-in only
}

function clearSharedSdkToken(){
  try{ localStorage.removeItem("base44_access_token"); }catch(e){}
}

async function startCloudSession(){
  CLOUD.user=null;
  // Not signed in on this browser: no need to ask the server.
  if(hasStoredSignIn()){
    try{
      CLOUD.user=await CLOUD.client.auth.me();
    }catch(err){
      const status=err && (err.status || (err.response && err.response.status));
      if(status===401 || status===403){
        try{ localStorage.removeItem(CLOUD_TOKEN_KEY); }catch(e){} // sign-in expired or refused
      }else{
        // Offline or Base44 not reachable: keep the sign-in and try again.
        setCloudState("error",cloudErrorMessage(err));
        clearTimeout(CLOUD.retryTimer);
        CLOUD.retryTimer=setTimeout(startCloudSession,30000);
        return;
      }
    }
  }
  if(!CLOUD.user){ setCloudState("signed_out"); return; }
  let role=CLOUD.user.crm_role || (CLOUD.user.data && CLOUD.user.data.crm_role) || "";
  if(!["owner","admin","member"].includes(role) && CLOUD.user.role==="admin"){
    // A Base44 app admin (set by the app's owner in Base44) takes owner access on first sign-in.
    try{
      await CLOUD.client.auth.updateMe({crm_role:"owner"});
      CLOUD.user=await CLOUD.client.auth.me();
      role=CLOUD.user.crm_role || "";
    }catch(e){ /* stays without access */ }
  }
  CLOUD.role=["owner","admin","member"].includes(role) ? role : "";
  let returnPage="";
  try{ returnPage=sessionStorage.getItem(CLOUD_RETURN_PAGE_KEY) || ""; sessionStorage.removeItem(CLOUD_RETURN_PAGE_KEY); }catch(e){}
  if(returnPage && PAGES.includes(returnPage)) showPage(returnPage);
  if(!CLOUD.role){ setCloudState("no_access"); return; }
  if(!$("page-settings").hidden) renderTeamCard();
  if(CLOUD.started) return cloudSync();
  CLOUD.started=true;

  // Every save in the app schedules an upload of the changed lists.
  const syncedKeys=new Set([...CLOUD_LISTS.map(d=>d.key),STORAGE_KEYS.settings]);
  const appWriteStore=writeStore;
  cloudWriteLocal=(key,value)=>appWriteStore(key,value);
  writeStore=function(key,value){
    const ok=appWriteStore(key,value);
    if(ok && syncedKeys.has(key)){
      if(key===STORAGE_KEYS.settings || key===STORAGE_KEYS.estimates) CLOUD.settingsDirty=true;
      scheduleCloudSync();
    }
    return ok;
  };

  await cloudSync();
  CLOUD.pollTimer=setInterval(()=>{ if(!document.hidden && Date.now()>=(CLOUD.backoffUntil || 0)) cloudSync(); },CLOUD_POLL_MS);
  document.addEventListener("visibilitychange",()=>{ if(!document.hidden) scheduleCloudSync(200); });
  window.addEventListener("online",()=>scheduleCloudSync(200));
  // Realtime: a change by someone else triggers a sync right away (polling stays as the safety net).
  cloudUseToken(cloudStoredToken());
  for(const name of [...CLOUD_LISTS.map(d=>d.entity),"CompanySettings"]){
    try{
      const api=CLOUD.client.entities[name];
      if(api && typeof api.subscribe==="function") CLOUD.unsubscribers.push(api.subscribe(()=>{ if(name==="CompanySettings") CLOUD.settingsDirty=true; scheduleCloudSync(1000); }));
    }catch(e){ /* polling covers it */ }
  }
}

function wireCloudEvents(){
  $("cloudStatus").addEventListener("click",handleCloudChipClick);
  $("cloudUpload").addEventListener("click",uploadLocalData);
  $("cloudPendingUpload").addEventListener("click",uploadLocalData);
  $("cloudRetry").addEventListener("click",()=>cloudSync());
  $("cloudSignOut").addEventListener("click",cloudSignOut);
  $("cloudLoginForm").addEventListener("submit",e=>{ e.preventDefault(); submitCloudLogin(); });
  $("cloudLoginReset").addEventListener("click",requestPasswordLink);
  $("cloudLoginGoogle").addEventListener("click",cloudGoogleLogin);
  $("teamBody").addEventListener("change",handleTeamChange);
  // Settings page: also show the team list (admins only).
  const appLoadSettingsForm=loadSettingsForm;
  loadSettingsForm=function(){ appLoadSettingsForm(); renderTeamCard(); };
}
