"use strict";

/* Import of leads / estimates from a spreadsheet (CSV or Excel), and full backups.

   Spreadsheet import:
   - one row = one lead/estimate, or one service line of an estimate
     (rows with the same Estimate # are combined into one estimate)
   - columns are matched automatically and can be changed before importing
   - imported estimates use 0% markup and 0% tax, so their totals stay as in the old system
   - an Estimate # that already exists is skipped; a client already in the CRM is not duplicated */

const XLSX_CDN = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
const BACKUP_APP = "EverCraftEstimator";

const IMPORT_FIELDS = [
  {key:"clientName", label:"Client Name", syn:["client name","client","customer name","customer","full name","name","contact name","contact","lead name","lead"]},
  {key:"clientEmail", label:"Email", syn:["email","e-mail","email address","client email","customer email","mail"]},
  {key:"clientPhone", label:"Phone", syn:["phone","phone number","mobile","cell","cell phone","telephone","tel","client phone","customer phone"]},
  {key:"address", label:"Address", syn:["project address","job address","site address","address","street address","street","location","property"]},
  {key:"estimateNumber", label:"Estimate #", syn:["estimate #","estimate number","estimate no","estimate no.","est #","est no","quote #","quote number","quote no","estimate id","estimate"]},
  {key:"date", label:"Date", syn:["date","estimate date","quote date","created","created date","created at","date created"]},
  {key:"category", label:"Category", syn:["category","trade","work type","service type","type"]},
  {key:"service", label:"Service", syn:["service","service name","item","line item","description","scope","work","task"]},
  {key:"quantity", label:"Quantity", syn:["quantity","qty","units","sq ft","sqft"]},
  {key:"price", label:"Price", syn:["price","unit price","rate","price per unit","unit cost"]},
  {key:"total", label:"Total", syn:["total","estimate total","grand total","amount","total amount","line total","value","sum"]},
  {key:"status", label:"Estimate Status", syn:["status","estimate status","quote status"]},
  {key:"stage", label:"CRM Stage", syn:["stage","crm stage","pipeline","pipeline stage","lead status"]},
  {key:"notes", label:"Notes", syn:["notes","note","comments","comment","remarks","memo"]}
];

const STATUS_WORDS = {
  draft:["draft","new","open"],
  sent:["sent","pending","awaiting","waiting","quoted","quote sent","emailed","submitted","estimate sent"],
  accepted:["accepted","approved","won","signed","sold","booked","converted"],
  rejected:["rejected","declined","lost","cancelled","canceled","dead"],
  completed:["completed","complete","done","finished","paid","closed"]
};

const STAGE_WORDS = {
  lead:["lead","leads","new","new lead","client","clients","leads / clients"],
  prospect:["prospect","prospects","quoted","quote sent","estimate sent"],
  job:["job","client / job","client/job","scheduled","booked","sold","won"],
  started:["started","in progress","start the project","active","working","ongoing"],
  completed:["completed","project completed","done","finished"],
  followup:["follow-up","follow up","followup"]
};

let IMPORT = null; // {headers, rows, mapping}

/* ---------- Parsing ---------- */

function normHeader(s){
  return String(s ?? "").toLowerCase().replace(/[_\-]+/g," ").replace(/[^a-z0-9# /.]/g,"").replace(/\s+/g," ").trim();
}

function parseCSV(text){
  text=String(text).replace(/^﻿/,"");
  const firstLine=text.split(/\r?\n/,1)[0];
  const count=ch=>firstLine.split(ch).length;
  const delim=count("\t")>count(",") && count("\t")>count(";") ? "\t" : count(";")>count(",") ? ";" : ",";
  const rows=[];
  let row=[], field="", quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){
      if(c==='"'){
        if(text[i+1]==='"'){ field+='"'; i++; }
        else quoted=false;
      }else field+=c;
    }else if(c==='"'){
      quoted=true;
    }else if(c===delim){
      row.push(field); field="";
    }else if(c==="\n" || c==="\r"){
      if(c==="\r" && text[i+1]==="\n") i++;
      row.push(field); rows.push(row); row=[]; field="";
    }else field+=c;
  }
  if(field!=="" || row.length){ row.push(field); rows.push(row); }
  return rows.filter(r=>r.some(v=>String(v).trim()!==""));
}

function loadScript(src){
  return new Promise((resolve,reject)=>{
    const s=document.createElement("script");
    s.src=src; s.onload=resolve; s.onerror=()=>reject(new Error("Could not load "+src));
    document.head.appendChild(s);
  });
}

async function readSpreadsheet(file){
  if(/\.(xlsx|xls)$/i.test(file.name)){
    if(!window.XLSX) await loadScript(XLSX_CDN);
    const wb=XLSX.read(await file.arrayBuffer(),{type:"array",cellDates:true});
    const sheet=wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet,{header:1,raw:false,defval:"",dateNF:"yyyy-mm-dd"})
      .map(r=>r.map(v=>v==null ? "" : String(v)))
      .filter(r=>r.some(v=>v.trim()!==""));
  }
  return parseCSV(await file.text());
}

function parseMoney(v){
  const s=String(v ?? "").trim();
  if(!s) return null;
  const n=Number(s.replace(/[^0-9.\-]/g,""));
  return Number.isFinite(n) ? Math.min(MAX_AMOUNT,Math.max(0,n)) : null;
}

function parseImportDate(v){
  const s=String(v ?? "").trim();
  if(!s) return "";
  let m;
  if((m=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return localISODate(new Date(+m[1],m[2]-1,+m[3]));
  if((m=s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/))){
    const y=m[3].length===2 ? 2000+Number(m[3]) : Number(m[3]);
    return localISODate(new Date(y,m[1]-1,+m[2]));
  }
  if(/^\d{5}$/.test(s)){ // Excel serial date
    const d=new Date(Date.UTC(1899,11,30)+Number(s)*86400000);
    return localISODate(new Date(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()));
  }
  const d=new Date(s);
  return isNaN(d) ? "" : localISODate(d);
}

function matchWord(value, table){
  const v=normHeader(value);
  if(!v) return null;
  for(const [key,words] of Object.entries(table)) if(words.includes(v)) return key;
  for(const [key,words] of Object.entries(table)) if(words.some(w=>v.startsWith(w))) return key;
  return null;
}

/* ---------- Column mapping ---------- */

function autoMapColumns(headers){
  const norm=headers.map(normHeader);
  const mapping={};
  const used=new Set();
  // exact synonym matches first, then "header contains synonym"
  for(const pass of ["exact","contains"]){
    for(const f of IMPORT_FIELDS){
      if(mapping[f.key]!==undefined) continue;
      for(const syn of f.syn){
        const i=norm.findIndex((h,idx)=>!used.has(idx) && (pass==="exact" ? h===syn : h.includes(syn) && syn.length>=4));
        if(i>=0){ mapping[f.key]=i; used.add(i); break; }
      }
    }
  }
  return mapping;
}

function cell(row, mapping, key){
  const i=mapping[key];
  return i===undefined || i===null || i<0 ? "" : String(row[i] ?? "").trim();
}

/* ---------- Planning (no changes are saved here) ---------- */

function inferMainCategory(text){
  const t=String(text).toLowerCase();
  if(/drywall|sheetrock|gypsum|joint compound|mud|taping/.test(t)) return "drywall";
  if(/stucco|plaster|lath|render/.test(t)) return "stucco";
  if(/paint|primer|coat|stain/.test(t)) return "painting";
  return null;
}

// Category for a line: {key} of a main/existing category, or {newName} to create.
function planCategory(categoryText, serviceText){
  const c=String(categoryText||"").trim();
  if(c){
    const main=MAIN_CATEGORIES.find(m=>m.label.toLowerCase()===c.toLowerCase() || m.key===c.toLowerCase());
    if(main) return {key:main.key};
    const custom=loadCustomCategories().find(x=>x.name.toLowerCase()===c.toLowerCase());
    if(custom) return {key:custom.id};
    const inferred=inferMainCategory(c);
    if(inferred) return {key:inferred};
    return {newName:c.slice(0,MAX_CATEGORY_NAME)};
  }
  const inferred=inferMainCategory(serviceText);
  if(inferred) return {key:inferred};
  const other=loadCustomCategories().find(x=>x.name.toLowerCase()==="other services");
  return other ? {key:other.id} : {newName:"Other Services"};
}

function planImport(rows, mapping, options){
  const existingNumbers=new Set(loadEstimates().map(e=>e.estimateNumber.toLowerCase()));
  const groups=[];
  const byNumber=new Map();

  rows.forEach((row,index)=>{
    const rec={
      clientName:cell(row,mapping,"clientName"),
      clientEmail:cell(row,mapping,"clientEmail"),
      clientPhone:cell(row,mapping,"clientPhone"),
      address:cell(row,mapping,"address"),
      estimateNumber:cell(row,mapping,"estimateNumber"),
      date:parseImportDate(cell(row,mapping,"date")),
      category:cell(row,mapping,"category"),
      service:cell(row,mapping,"service"),
      quantity:parseMoney(cell(row,mapping,"quantity")),
      price:parseMoney(cell(row,mapping,"price")),
      total:parseMoney(cell(row,mapping,"total")),
      status:matchWord(cell(row,mapping,"status"),STATUS_WORDS),
      stage:matchWord(cell(row,mapping,"stage"),STAGE_WORDS),
      notes:cell(row,mapping,"notes"),
      row:index+2
    };
    const key=rec.estimateNumber ? rec.estimateNumber.toLowerCase() : null;
    if(key && byNumber.has(key)){ byNumber.get(key).rows.push(rec); return; }
    const group={rows:[rec]};
    groups.push(group);
    if(key) byNumber.set(key,group);
  });

  return groups.map(g=>{
    const first=g.rows[0];
    const pick=k=>(g.rows.find(r=>r[k])||{})[k] || "";
    const plan={
      clientName:pick("clientName"), clientEmail:pick("clientEmail"), clientPhone:pick("clientPhone"),
      address:pick("address"), estimateNumber:first.estimateNumber, date:pick("date"),
      status:g.rows.map(r=>r.status).find(Boolean) || null,
      stage:g.rows.map(r=>r.stage).find(Boolean) || null,
      notes:g.rows.map(r=>r.notes).filter(Boolean).join("\n"),
      lines:[], rows:g.rows.map(r=>r.row), action:"", reason:""
    };
    for(const r of g.rows){
      const hasQP=r.quantity!==null || r.price!==null;
      if(!r.service && !hasQP && r.total===null) continue;
      let quantity=1, price=0;
      if(hasQP){ quantity=r.quantity ?? 1; price=r.price ?? (r.total!==null && quantity ? r.total/quantity : 0); }
      else price=r.total ?? 0;
      plan.lines.push({name:r.service || "Imported estimate",quantity,price:round2(price),category:planCategory(r.category,r.service)});
    }
    plan.total=round2(plan.lines.reduce((s,l)=>s+round2(l.quantity*l.price),0));

    if(!plan.clientName && !plan.address && !plan.clientEmail && !plan.clientPhone){
      plan.action="skip"; plan.reason="No client name, address, email or phone";
    }else if(plan.lines.length){
      if(plan.estimateNumber && existingNumbers.has(plan.estimateNumber.toLowerCase())){
        plan.action="skip"; plan.reason=`Estimate # ${plan.estimateNumber} already exists`;
      }else plan.action=options.createLeads ? "estimate+lead" : "estimate";
    }else if(options.createLeads){
      plan.action="lead";
    }else{
      plan.action="skip"; plan.reason="No estimate data (turn on CRM leads to import it as a lead)";
    }
    return plan;
  });
}

/* ---------- Saving ---------- */

function stageForImport(plan){
  if(plan.stage) return plan.stage;
  if(plan.status==="sent" || plan.status==="accepted") return "prospect";
  if(plan.status==="completed") return "completed";
  return "lead";
}

function sameClient(p, plan){
  const n=s=>String(s||"").trim().toLowerCase();
  const digits=s=>String(s||"").replace(/\D/g,"");
  if(!n(p.clientName) || n(p.clientName)!==n(plan.clientName)) return false;
  return (plan.clientPhone && digits(p.clientPhone)===digits(plan.clientPhone)) ||
    (plan.clientEmail && n(p.clientEmail)===n(plan.clientEmail)) ||
    (plan.address && n(p.address)===n(plan.address)) ||
    (!plan.clientPhone && !plan.clientEmail && !plan.address);
}

function commitImport(plans, folder=""){
  const estimates=loadEstimates();
  const projects=loadProjects();
  const usedNumbers=new Set(estimates.map(e=>e.estimateNumber.toLowerCase()));
  const newCategories={};
  const result={estimates:0,leads:0,linked:0,skipped:0};

  const categoryKey=c=>{
    if(c.key) return c.key;
    const k=c.newName.toLowerCase();
    if(!newCategories[k]){
      const existing=loadCustomCategories().find(x=>x.name.toLowerCase()===k);
      newCategories[k]=existing ? existing.id : (createCategory(c.newName)||{}).id;
    }
    return newCategories[k];
  };

  for(const plan of plans){
    if(plan.action==="skip"){ result.skipped++; continue; }
    const now=nowISO();
    const created=plan.date ? new Date(plan.date+"T12:00:00").toISOString() : now;
    let est=null;

    if(plan.lines.length){
      let number=plan.estimateNumber;
      if(!number || usedNumbers.has(number.toLowerCase())){
        if(number){ result.skipped++; continue; }
        do{ number=takeEstimateNumber(); }while(usedNumbers.has(number.toLowerCase()));
      }
      usedNumbers.add(number.toLowerCase());
      const items=plan.lines.map(l=>{
        const category=categoryKey(l.category) || "drywall";
        return {id:uid("li"),category,categoryName:categoryLabel(category),serviceId:null,name:l.name,description:"",quantity:l.quantity,price:l.price};
      });
      const t=computeEstimateTotals({items,markup:0,taxRate:0,taxMode:"all"});
      const custom=[...new Set(items.map(i=>i.category).filter(k=>!isMainCategory(k)))];
      est={
        id:uid("est"), estimateNumber:number, date:plan.date || localISODate(),
        clientName:plan.clientName, clientEmail:plan.clientEmail, clientPhone:plan.clientPhone, address:plan.address,
        items:t.items.map(({id,category,categoryName,serviceId,name,description,quantity,price,total})=>({id,category,categoryName,serviceId,name,description,quantity,price,total})),
        drywallTotal:t.categoryTotals.drywall, stuccoTotal:t.categoryTotals.stucco, paintingTotal:t.categoryTotals.painting,
        otherTotal:round2(Object.keys(t.categoryTotals).filter(k=>!isMainCategory(k)).reduce((s,k)=>s+t.categoryTotals[k],0)),
        customCategories:custom.map(id=>({id,name:categoryLabel(id)})),
        categoryTotals:t.categoryTotals,
        subtotal:t.subtotal, markup:0, markupAmount:0, taxRate:0, taxMode:"all", taxAmount:0,
        customerTotal:t.grandTotal,
        status:plan.status || "draft",
        crmProjectId:null,
        imported:true,
        createdAt:created, updatedAt:now
      };
      estimates.push(est);
      result.estimates++;
    }

    if(plan.action==="lead" || plan.action==="estimate+lead"){
      let project=projects.find(p=>sameClient(p,plan) && (!est || !p.estimateId));
      if(project){
        if(est){
          Object.assign(project,{estimateId:est.id,estimateNumber:est.estimateNumber,estimateTotal:est.customerTotal,updatedAt:now});
          result.linked++;
        }
      }else{
        project=newProjectRecord({
          clientName:plan.clientName, clientEmail:plan.clientEmail, clientPhone:plan.clientPhone, address:plan.address,
          estimateId:est ? est.id : null, estimateNumber:est ? est.estimateNumber : "", estimateTotal:est ? est.customerTotal : 0,
          stage:stageForImport(plan), prospectStatus:prospectStatusForEstimate(est),
          notes:plan.notes, folder
        });
        project.createdAt=created;
        projects.push(project);
        result.leads++;
      }
      if(est) est.crmProjectId=project.id;
    }
  }

  if(!saveEstimates(estimates) || !saveProjects(projects)) return null;
  return result;
}

/* ---------- Import window ---------- */

function openImport(){
  IMPORT=null;
  $("importFile").value="";
  $("importStep2").hidden=true;
  $("importStep1").hidden=false;
  $("importError").textContent="";
  openModal("importModal");
}

async function handleImportFile(){
  const file=$("importFile").files[0];
  if(!file) return;
  $("importError").textContent="Reading file…";
  try{
    if(/\.json$/i.test(file.name)){
      $("importError").textContent="";
      await restoreBackupFile(file);
      return;
    }
    const rows=await readSpreadsheet(file);
    if(rows.length<2) throw new Error("The file has no data rows. The first row must contain the column names.");
    const headers=rows[0].map((h,i)=>String(h).trim() || `Column ${i+1}`);
    IMPORT={fileName:file.name,headers,rows:rows.slice(1),mapping:autoMapColumns(headers)};
    $("importError").textContent="";
    renderImportMapping();
    renderImportPreview();
    $("importStep1").hidden=true;
    $("importStep2").hidden=false;
  }catch(e){
    $("importError").textContent=/xlsx/i.test(String(e.message)) || /load/.test(String(e.message))
      ? "Could not read the Excel file (no internet connection?). Save it as CSV and try again."
      : (e.message || "Could not read this file.");
  }
}

function renderImportMapping(){
  const options=i=>`<option value="-1">— not in file —</option>`+
    IMPORT.headers.map((h,idx)=>`<option value="${idx}" ${idx===i?"selected":""}>${escapeHtml(h)}</option>`).join("");
  $("importFileName").textContent=`${IMPORT.fileName} · ${IMPORT.rows.length} row(s)`;
  $("importMapping").innerHTML=IMPORT_FIELDS.map(f=>`
    <label class="map-field"><span>${escapeHtml(f.label)}</span>
      <select data-map="${f.key}">${options(IMPORT.mapping[f.key] ?? -1)}</select>
    </label>`).join("");
}

function importOptions(){
  return {createLeads:$("importCreateLeads").checked, folder:$("importOldFolder").checked ? "old-crm" : ""};
}

function renderImportPreview(){
  const plans=planImport(IMPORT.rows,IMPORT.mapping,importOptions());
  IMPORT.plans=plans;
  const count=a=>plans.filter(p=>p.action===a).length;
  const est=count("estimate")+count("estimate+lead");
  const leads=count("lead")+count("estimate+lead");
  const skip=count("skip");
  $("importSummary").innerHTML=`
    <span class="imp-chip">${est} estimate(s)</span>
    ${$("importCreateLeads").checked?`<span class="imp-chip">${leads} CRM lead(s)</span>`:""}
    ${skip?`<span class="imp-chip imp-skip">${skip} skipped</span>`:""}`;
  const label={"estimate+lead":"Estimate + lead",estimate:"Estimate",lead:"Lead only",skip:"Skip"};
  $("importPreviewBody").innerHTML=plans.slice(0,50).map(p=>`
    <tr class="${p.action==="skip"?"row-muted":""}">
      <td>${escapeHtml(p.clientName||"—")}<div class="small">${escapeHtml([p.clientPhone,p.clientEmail].filter(Boolean).join(" · "))}</div></td>
      <td>${escapeHtml(p.address||"—")}</td>
      <td class="nowrap">${escapeHtml(p.estimateNumber||(p.lines.length?"(new #)":"—"))}</td>
      <td>${p.lines.length}</td>
      <td class="nowrap">${p.lines.length?money(p.total):"—"}</td>
      <td>${escapeHtml(label[p.action])}${p.reason?`<div class="small">${escapeHtml(p.reason)}</div>`:""}</td>
    </tr>`).join("");
  $("importMore").textContent=plans.length>50 ? `Showing 50 of ${plans.length}.` : "";
  $("btnRunImport").disabled=!(est || leads);
}

function runImport(){
  if(!IMPORT || !IMPORT.plans) return;
  const plans=planImport(IMPORT.rows,IMPORT.mapping,importOptions());
  const opts=importOptions();
  const result=commitImport(plans, opts.createLeads ? opts.folder : "");
  if(!result) return;
  closeModal("importModal");
  renderSavedEstimates();
  if(opts.folder && result.leads && $("crmFolder")) $("crmFolder").value=opts.folder; // show where they went
  renderCrmBoard();
  renderServicesPage();
  updateBuilderMeta();
  alert(`Import finished.\n\nEstimates created: ${result.estimates}\nCRM leads created: ${result.leads}${opts.folder && result.leads ? " (folder: Old CRM leads)" : ""}\nLinked to existing leads: ${result.linked}\nSkipped: ${result.skipped}`);
}

function downloadFile(name, content, type){
  const url=URL.createObjectURL(new Blob([content],{type}));
  const a=document.createElement("a");
  a.href=url; a.download=name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

function downloadImportTemplate(){
  const rows=[
    ["Client Name","Email","Phone","Address","Estimate #","Date","Category","Service","Quantity","Price","Total","Status","Stage","Notes"],
    ["John Smith","john@email.com","(818) 555-0101","123 Main St, Los Angeles, CA","EST-1001","2026-09-15","Drywall","Drywall Repair","500","4","","Sent","","Kitchen ceiling"],
    ["John Smith","john@email.com","(818) 555-0101","123 Main St, Los Angeles, CA","EST-1001","2026-09-15","Painting","Interior Painting","1200","2.5","","Sent","",""],
    ["Mary Lee","mary@email.com","(818) 555-0102","9 Oak Ave, Glendale, CA","EST-1002","2026-09-20","","Exterior stucco repair","","","4800","Accepted","",""],
    ["Tom Brown","","(818) 555-0103","5 Pine Rd, Burbank, CA","","","","","","","","","Lead","Called about a quote"]
  ];
  const csv=rows.map(r=>r.map(v=>/[",\n]/.test(v) ? `"${v.replace(/"/g,'""')}"` : v).join(",")).join("\r\n");
  downloadFile("import-template.csv","﻿"+csv,"text/csv");
}

/* ---------- Backup ---------- */

function exportBackup(){
  const data={};
  for(const [name,key] of Object.entries(STORAGE_KEYS)) data[name]=readStore(key,null);
  data.settings=SETTINGS; // settings in use, even if they were never saved
  const backup={app:BACKUP_APP,version:1,exportedAt:nowISO(),data};
  downloadFile(`estimator-backup-${localISODate()}.json`,JSON.stringify(backup,null,1),"application/json");
  showToast("Backup downloaded. Photos are not included.");
}

async function restoreBackupFile(file){
  let backup;
  try{ backup=JSON.parse(await file.text()); }catch(e){ backup=null; }
  if(!backup || backup.app!==BACKUP_APP || !backup.data){
    alert("This is not a backup file from this app.");
    return;
  }
  const d=backup.data;
  const n=v=>Array.isArray(v) ? v.length : 0;
  const shared=typeof cloudActive==="function" && cloudActive();
  if(!confirm(`Restore the backup from ${formatDateTime(backup.exportedAt)}?\n\n${n(d.estimates)} estimates, ${n(d.crm)} CRM projects, ${n(d.services)} services.\n\nALL current data in this browser will be replaced.`+
    (shared ? "\n\nShared CRM: the backup does not change or delete shared records. Where the shared CRM has a record, its version is kept; records only in the backup can then be added with \"Upload to shared CRM\"." : ""))) return;
  // Stop syncing first, so the restore can never be taken for changes made here.
  if(shared){
    cloudPrepareRestore();
    // A sync still running finishes first (it writes nothing more once paused).
    if(CLOUD.running){ try{ await CLOUD.running; }catch(e){} }
  }
  for(const [name,key] of Object.entries(STORAGE_KEYS)){
    if(d[name]===null || d[name]===undefined) localStorage.removeItem(key);
    else if(!writeStore(key,d[name])) return;
  }
  alert("Backup restored. The app will now reload.");
  location.reload();
}

function wireImportEvents(){
  ["btnImportCrm","btnImportEstimates","btnImportSettings"].forEach(id=>$(id).addEventListener("click",openImport));
  $("btnRestoreBackup").addEventListener("click",openImport);
  $("btnExportBackup").addEventListener("click",exportBackup);
  $("btnImportTemplate").addEventListener("click",downloadImportTemplate);
  $("btnImportTemplate2").addEventListener("click",downloadImportTemplate);
  $("importFile").addEventListener("change",handleImportFile);
  $("importMapping").addEventListener("change",e=>{
    const sel=e.target.closest("[data-map]");
    if(!sel) return;
    IMPORT.mapping[sel.dataset.map]=Number(sel.value);
    renderImportPreview();
  });
  $("importCreateLeads").addEventListener("change",renderImportPreview);
  $("btnImportBack").addEventListener("click",()=>{ $("importStep2").hidden=true; $("importStep1").hidden=false; $("importFile").value=""; });
  $("btnRunImport").addEventListener("click",runImport);
}
