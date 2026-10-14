"use strict";

/* Migration check (dry run): compares a backup file, or this browser's data, with the shared CRM
   and reports what "Upload local data" would do. It only reads: nothing is written to this
   browser or to Base44. The report lists the ids an upload would create, for a later rollback. */

const MIGRATION_TYPES = [
  {name:"categories", entity:"Category", label:"Custom categories"},
  {name:"services", entity:"Service", label:"Services"},
  {name:"crm", entity:"CrmProject", label:"CRM projects (leads / jobs)"},
  {name:"estimates", entity:"Estimate", label:"Estimates"}
];
const MIGRATION_STAGES = ["lead","prospect","job","started","completed","followup"];
const MIGRATION_LIST_MAX = 50;

const migrationText = v => String(v ?? "").trim().toLowerCase().replace(/\s+/g," ");
const migrationDigits = v => String(v ?? "").replace(/\D/g,"").slice(-10);

// The data to check, in the same shape as a backup file's "data".
function migrationLocalData(){
  const data={};
  for(const t of MIGRATION_TYPES) data[t.name]=readStore(STORAGE_KEYS[t.name],[]);
  data.settings=readStore(STORAGE_KEYS.settings,null);
  return data;
}

// Everything the shared CRM has (read only).
async function migrationCloudData(){
  const cloud={};
  for(const t of MIGRATION_TYPES) cloud[t.entity]=await cloudListAll(t.entity);
  cloud.CompanySettings=(await CLOUD.client.entities.CompanySettings.filter({legacy_id:"company"})).filter(r=>!r.deletedAt);
  cloud.EstimateCounter=await CLOUD.client.entities.EstimateCounter.filter({legacy_id:"estimates"});
  return cloud;
}

function migrationEstimateSeq(number){
  const m=String(number || "").match(/(\d+)\s*$/);
  return m ? Number(m[1]) : 0;
}

// Pure comparison: source = backup "data", cloud = migrationCloudData(). Returns the report.
function migrationReport(source, cloud){
  const report={createdAt:nowISO(), types:{}, problems:[], newIds:{}, settings:null, counter:null};
  const add=(list,item)=>{ if(list.length<MIGRATION_LIST_MAX) list.push(item); };
  const problem=(type,id,text)=>{ report.problems.push({type,id,text}); };
  const known={}; // every id that exists after an upload, per type (for link checks)

  for(const t of MIGRATION_TYPES){
    const def=CLOUD_LISTS.find(d=>d.entity===t.entity);
    const rows=Array.isArray(source[t.name]) ? source[t.name] : [];
    const remote=(cloud[t.entity] || []).filter(r=>r && r.legacy_id);
    const live=new Map(), deleted=new Map();
    for(const r of remote){
      const lid=String(r.legacy_id);
      if(r.deletedAt){ if(!live.has(lid)) deleted.set(lid,r); }
      else if(!live.has(lid)) live.set(lid,r);
    }
    const s={label:t.label, source:rows.length, cloud:live.size, cloudDeleted:deleted.size,
      create:0, identical:0, different:0, deletedInCloud:0, mergedByName:0, invalid:0, duplicateIds:0, examples:{}};
    const ex=k=>s.examples[k]=s.examples[k] || [];
    const seen=new Set();
    const serviceByName=new Map();
    if(t.entity==="Service") for(const r of live.values()) serviceByName.set(`${r.category}|${migrationText(r.name)}`,r);
    report.newIds[t.entity]=[];
    known[t.entity]=new Set(live.keys());

    for(const rec of rows){
      if(!rec || typeof rec!=="object" || !rec.id){ s.invalid++; problem(t.label,"","a record without an id is skipped"); continue; }
      const lid=String(rec.id);
      const name=rec.clientName || rec.name || rec.estimateNumber || "";
      if(seen.has(lid)){ s.duplicateIds++; problem(t.label,lid,`the same id appears twice in the source (${name})`); continue; }
      seen.add(lid);
      if(live.has(lid)){
        const same=cloudRecordHash(def,rec)===cloudRecordHash(def,cloudToLocal(live.get(lid),def.fields));
        if(same) s.identical++;
        else{ s.different++; add(ex("different"),{id:lid,name}); }
        continue;
      }
      if(deleted.has(lid)){ s.deletedInCloud++; add(ex("deletedInCloud"),{id:lid,name}); continue; }
      if(t.entity==="Service"){
        const match=serviceByName.get(`${rec.category}|${migrationText(rec.name)}`);
        if(match){
          s.mergedByName++;
          const priceDiffers=Number(rec.defaultPrice || 0)!==Number(match.defaultPrice || 0);
          add(ex("mergedByName"),{id:lid,name,into:String(match.legacy_id),priceDiffers});
          continue;
        }
      }
      if(t.entity==="Estimate" && !String(rec.estimateNumber || "").trim()){ s.invalid++; problem(t.label,lid,`estimate without a number (${rec.clientName || "no client"}) cannot be uploaded`); continue; }
      if(t.entity==="CrmProject" && rec.stage && !MIGRATION_STAGES.includes(rec.stage)) problem(t.label,lid,`unknown stage "${rec.stage}" (${name})`);
      s.create++;
      report.newIds[t.entity].push(lid);
      known[t.entity].add(lid);
      add(ex("create"),{id:lid,name});
    }
    report.types[t.entity]=s;
  }

  // Estimate numbers: duplicates in the source, and numbers already used in the cloud by another estimate.
  const estimates=(Array.isArray(source.estimates) ? source.estimates : []).filter(e=>e && e.id);
  const creating=new Set(report.newIds.Estimate);
  const cloudNumbers=new Map();
  for(const r of cloud.Estimate || []) if(r && !r.deletedAt && r.estimateNumber) cloudNumbers.set(String(r.estimateNumber).trim(),String(r.legacy_id));
  const sourceNumbers=new Map();
  for(const e of estimates){
    const no=String(e.estimateNumber || "").trim();
    if(!no) continue;
    if(sourceNumbers.has(no) && sourceNumbers.get(no)!==String(e.id)) problem("Estimates",String(e.id),`estimate number ${no} is used twice in the source`);
    sourceNumbers.set(no,String(e.id));
    if(creating.has(String(e.id)) && cloudNumbers.has(no) && cloudNumbers.get(no)!==String(e.id)){
      problem("Estimates",String(e.id),`estimate number ${no} is already used in the shared CRM: it will not be uploaded until the number is changed`);
      report.types.Estimate.create--;
      report.types.Estimate.numberTaken=(report.types.Estimate.numberTaken || 0)+1;
      report.newIds.Estimate=report.newIds.Estimate.filter(id=>id!==String(e.id));
    }
  }

  // Possible duplicate leads: same client name and the same phone or address, different ids.
  const leads=[...(cloud.CrmProject || []).filter(r=>r && !r.deletedAt).map(r=>({id:String(r.legacy_id),clientName:r.clientName,clientPhone:r.clientPhone,address:r.address,where:"shared CRM"})),
    ...(Array.isArray(source.crm) ? source.crm : []).filter(p=>p && p.id).map(p=>({...p,id:String(p.id),where:"source"}))];
  const byKey=new Map();
  for(const p of leads){
    const n=migrationText(p.clientName);
    if(!n) continue;
    for(const k of [migrationDigits(p.clientPhone).length>=7 ? "p:"+migrationDigits(p.clientPhone) : "", migrationText(p.address) ? "a:"+migrationText(p.address) : "", "n:"].filter(Boolean)){
      const key=n+"|"+k;
      const other=byKey.get(key);
      if(other && other.id!==p.id){
        report.duplicates=report.duplicates || [];
        if(!report.duplicates.some(d=>d.ids.includes(p.id) && d.ids.includes(other.id)))
          report.duplicates.push({name:p.clientName, ids:[other.id,p.id], where:[other.where,p.where], match:k.startsWith("p:") ? "phone" : k.startsWith("a:") ? "address" : "name only"});
      }else if(!other) byKey.set(key,p);
    }
  }

  // Links between records, as they will be after the upload.
  const sourceById=(name)=>new Map((Array.isArray(source[name]) ? source[name] : []).filter(r=>r && r.id).map(r=>[String(r.id),r]));
  const projects=sourceById("crm"), ests=sourceById("estimates"), services=sourceById("services");
  for(const [id,e] of ests){
    if(!report.newIds.Estimate.includes(id)) continue;
    if(e.crmProjectId && !known.CrmProject.has(String(e.crmProjectId))) problem("Estimates",id,`linked CRM project ${e.crmProjectId} does not exist`);
    for(const it of Array.isArray(e.items) ? e.items : []){
      if(it && it.serviceId && !known.Service.has(String(it.serviceId)) && !services.has(String(it.serviceId))) { problem("Estimates",id,`line "${it.name || ""}" refers to a service that no longer exists (the line keeps its own name and price)`); break; }
    }
  }
  for(const [id,p] of projects){
    if(!report.newIds.CrmProject.includes(id)) continue;
    if(p.estimateId && !known.Estimate.has(String(p.estimateId))) problem("CRM projects",id,`linked estimate ${p.estimateId} (${p.estimateNumber || ""}) does not exist or is not uploaded`);
  }
  for(const [id,s] of services){
    if(!report.newIds.Service.includes(id)) continue;
    const c=String(s.category || "");
    if(c.startsWith("cat-") && !known.Category.has(c)) problem("Services",id,`category ${c} of "${s.name || ""}" does not exist`);
  }

  // Company settings and the estimate counter: the shared CRM keeps its own; only reported.
  const cs=(cloud.CompanySettings || [])[0];
  if(source.settings && cs){
    const fields=["companyName","companyEmail","companyPhone","companyAddress","licenseNumber","markup","salesTax","taxMode","terms","estimateFooter"];
    const diff=fields.filter(f=>source.settings[f]!==undefined && String(source.settings[f] ?? "")!==String(cs[f] ?? ""));
    report.settings={inCloud:true, differentFields:diff};
  }else report.settings={inCloud:!!cs, differentFields:[]};
  const maxSeq=Math.max(0,...estimates.map(e=>migrationEstimateSeq(e.estimateNumber)),...[...cloudNumbers.keys()].map(migrationEstimateSeq));
  const counter=(cloud.EstimateCounter || [])[0];
  report.counter={cloudNext:counter ? Number(counter.nextNumber) : null, highestUsed:maxSeq,
    ok:!counter || Number(counter.nextNumber)>maxSeq};
  return report;
}

/* ---------- screen ---------- */

function migrationRenderReport(report, sourceLabel){
  const T=report.types;
  const row=t=>{ const s=T[t.entity]; return `<tr><td>${escapeHtml(s.label)}</td><td>${s.source}</td><td>${s.cloud}</td><td><b>${s.create}</b></td><td>${s.identical}</td>
    <td>${s.different}</td><td>${s.deletedInCloud}</td><td>${s.mergedByName}</td><td>${s.invalid+s.duplicateIds+(s.numberTaken || 0)}</td></tr>`; };
  const list=(title,items,fmt)=>items && items.length ? `<h3>${escapeHtml(title)}</h3><ul class="small">${items.map(i=>`<li>${fmt(i)}</li>`).join("")}</ul>` : "";
  const ex=(k)=>MIGRATION_TYPES.flatMap(t=>(T[t.entity].examples[k] || []).map(i=>({...i,label:T[t.entity].label})));
  const total=MIGRATION_TYPES.reduce((n,t)=>n+T[t.entity].create,0);
  $("migrationResult").innerHTML=`
    <p><b>Nothing was changed.</b> Source: ${escapeHtml(sourceLabel)}. Compared with the shared CRM at ${escapeHtml(formatDateTime(report.createdAt))}.</p>
    <p>An upload would add <b>${total}</b> record(s). Records that already exist in the shared CRM are never overwritten.</p>
    <div class="table-wrap"><table class="table"><thead><tr><th>Type</th><th>Source</th><th>Shared now</th><th>Would be added</th><th>Same</th><th>Different (shared kept)</th><th>Deleted in shared</th><th>Merged by name</th><th>Problems</th></tr></thead>
    <tbody>${MIGRATION_TYPES.map(row).join("")}</tbody></table></div>
    ${list("Problems to fix first",report.problems.slice(0,MIGRATION_LIST_MAX),p=>`${escapeHtml(p.type)} ${escapeHtml(p.id)}: ${escapeHtml(p.text)}`)}
    ${list("Possible duplicate clients (check before uploading)",(report.duplicates || []).slice(0,MIGRATION_LIST_MAX),d=>`${escapeHtml(d.name || "")}: ${d.ids.map((id,i)=>`${escapeHtml(id)} (${escapeHtml(d.where[i])})`).join(" and ")}, same ${d.match==="name only" ? "name" : d.match}`)}
    ${list("Different from the shared version (the shared version is kept, yours is saved as a conflict copy)",ex("different"),i=>`${escapeHtml(i.label)}: ${escapeHtml(i.name)} (${escapeHtml(i.id)})`)}
    ${list("Deleted in the shared CRM (not uploaded again)",ex("deletedInCloud"),i=>`${escapeHtml(i.label)}: ${escapeHtml(i.name)} (${escapeHtml(i.id)})`)}
    ${list("Services merged into a shared service with the same name",ex("mergedByName"),i=>`${escapeHtml(i.name)}${i.priceDiffers ? " (different price: the shared price is kept)" : ""}`)}
    <h3>Company settings and estimate numbers</h3>
    <ul class="small">
      <li>${report.settings.inCloud ? (report.settings.differentFields.length ? `Shared company settings differ in: ${escapeHtml(report.settings.differentFields.join(", "))}. The shared settings are kept.` : "Company settings: same as the shared settings.") : "No shared company settings yet."}</li>
      <li>${report.counter.cloudNext===null ? "No shared estimate counter yet." : `Shared next estimate number: ${report.counter.cloudNext}; highest number used: ${report.counter.highestUsed}.`} ${report.counter.ok ? "" : "<b>The counter must be raised above the highest number.</b>"}</li>
    </ul>`;
  $("migrationDownload").hidden=false;
}

async function runMigrationCheck(source, sourceLabel){
  const status=$("migrationStatus");
  status.textContent="Reading the shared CRM… (nothing is changed)";
  $("migrationResult").innerHTML="";
  $("migrationDownload").hidden=true;
  try{
    const report=migrationReport(source, await migrationCloudData());
    report.source=sourceLabel;
    MIGRATION_LAST=report;
    migrationRenderReport(report, sourceLabel);
    status.textContent="";
  }catch(e){
    status.textContent="Could not read the shared CRM: "+cloudErrorMessage(e);
  }
}
let MIGRATION_LAST=null;

function renderMigrationCard(){
  const card=$("migrationCard");
  if(!card) return;
  card.hidden=!(typeof CLOUD!=="undefined" && CLOUD.client && cloudIsAdmin());
}

function wireMigrationEvents(){
  if(!$("migrationCard")) return;
  $("btnMigrationLocal").addEventListener("click",()=>runMigrationCheck(migrationLocalData(),"this browser"));
  $("btnMigrationFile").addEventListener("click",()=>$("migrationFile").click());
  $("migrationFile").addEventListener("change",async e=>{
    const file=e.target.files[0];
    e.target.value="";
    if(!file) return;
    let backup=null;
    try{ backup=JSON.parse(await file.text()); }catch(err){ backup=null; }
    if(!backup || backup.app!==BACKUP_APP || !backup.data){ $("migrationStatus").textContent="This is not a backup file from this app."; return; }
    runMigrationCheck(backup.data,`backup file ${file.name} (${formatDateTime(backup.exportedAt)})`);
  });
  $("migrationDownload").addEventListener("click",()=>{
    if(!MIGRATION_LAST) return;
    downloadFile(`migration-check-${localISODate()}.json`,JSON.stringify(MIGRATION_LAST,null,1),"application/json");
  });
}
