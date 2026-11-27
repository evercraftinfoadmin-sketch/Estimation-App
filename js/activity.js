"use strict";

/* Lead activity history and lead links.

   History: every change to a CRM project (lead), to its estimates and to its invoices is written
   to an append-only list of events (STORAGE_KEYS.activity) when it is saved: the save functions
   (saveProjects, saveEstimates, saveInvoices) compare the list before and after and record what
   changed. Nobody has to write the history by hand, and nothing in the app edits or deletes an
   event, so it stays when the lead's status or details change later (also when the lead is deleted).
   Events are their own records (cloud table "Activity"), never part of the project record, so two
   people working on the same lead never overwrite each other's history.
   Events that several devices can notice at the same time (a client signing, a payment) get an id
   made from what happened (e.g. the signature id), so they are recorded once.

   Lead links: "#lead=<project id>" opens a page with that one lead card only. With the shared
   cloud CRM the card is shown only to a signed-in user with CRM access (the same rule as for the
   whole CRM: Base44 only gives the data to such users); others are asked to sign in or to ask for
   access. Changing the id in a link only ever opens leads the user may already see in the CRM. */

const ACTIVITY_KINDS = {
  created:"🆕", deleted:"🗑", customer:"👤", status:"🔀", notes:"📝", assigned:"👷", schedule:"📅",
  estimate:"📄", email:"✉️", signature_sent:"✍️", signed:"✅", signature_withdrawn:"↩️",
  invoice:"🧾", payment:"💵", paid:"💰", task:"☑️", followup:"🔔", other:"•"
};
const ACTIVITY_PAGE_SIZE = 50;

/* ---------- Storage ---------- */

function normalizeActivity(a){
  return {
    id:String(a.id),
    projectId:String(a.projectId ?? ""),
    kind:ACTIVITY_KINDS[a.kind] ? a.kind : "other",
    title:String(a.title ?? ""),
    details:String(a.details ?? ""),
    actor:String(a.actor ?? ""),
    at:String(a.at || a.createdAt || ""),
    createdAt:String(a.createdAt || a.at || "")
  };
}

function loadActivity(){
  const list=readStore(STORAGE_KEYS.activity,[]);
  return Array.isArray(list) ? list.filter(a=>a && a.id).map(normalizeActivity) : [];
}

// Who did it: the signed-in employee, or this device when the CRM is used without sign-in.
function activityActor(){
  const u=typeof CLOUD!=="undefined" && CLOUD.user;
  if(u) return String(u.full_name || u.email || "");
  return "";
}

// Adds events (an event whose id is already in the history is skipped).
function logActivities(entries){
  const list=(entries || []).filter(e=>e && e.projectId && e.title);
  if(!list.length) return true;
  const all=readStore(STORAGE_KEYS.activity,[]);
  const history=Array.isArray(all) ? all : [];
  const ids=new Set(history.map(a=>a && a.id));
  const now=nowISO(), actor=activityActor();
  let added=false;
  for(const e of list){
    const rec=normalizeActivity({id:e.id || uid("act"), projectId:e.projectId, kind:e.kind, title:e.title, details:e.details,
      actor:e.actor ?? actor, at:e.at || now, createdAt:now});
    if(ids.has(rec.id)) continue;
    ids.add(rec.id);
    history.push(rec);
    added=true;
  }
  return added ? writeStore(STORAGE_KEYS.activity,history) : true;
}

function logActivity(projectId, kind, title, details="", extra={}){
  return logActivities([{...extra, projectId, kind, title, details}]);
}

// The history of one lead, newest first.
function activityForProject(projectId){
  return loadActivity().filter(a=>a.projectId===projectId)
    .sort((a,b)=>b.at.localeCompare(a.at) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

/* ---------- Recording changes (called by the save functions) ---------- */

const ACT_EMPTY = "—";
const actValue=v=>String(v ?? "").trim() || ACT_EMPTY;
const actChange=(label,a,b)=>`${label}: ${actValue(a)} → ${actValue(b)}`;
const actShort=(text,max=300)=>{ const t=String(text || "").trim(); return t.length>max ? t.slice(0,max-1)+"…" : t; };

// Compares a saved list with the one about to be saved; records the events. Never stops a save.
function recordListChanges(kind, prevRaw, nextList){
  try{
    const prev=Array.isArray(prevRaw) ? prevRaw.filter(r=>r && r.id) : [];
    const next=(nextList || []).filter(r=>r && r.id);
    const events=kind==="projects" ? projectEvents(prev.map(normalizeProject),next.map(normalizeProject))
      : kind==="estimates" ? estimateEvents(prev.map(normalizeEstimate),next.map(normalizeEstimate))
      : kind==="invoices" ? invoiceEvents(prev.map(normalizeInvoice),next.map(normalizeInvoice)) : [];
    if(events.length) logActivities(events);
  }catch(e){
    console.warn("Activity history: could not record a change.",e);
  }
}

// A signing request was created, signed by the client, or withdrawn.
function signatureEvents(projectId, docLabel, prevList, nextList){
  const prevById=new Map((prevList || []).map(s=>[s.id,s]));
  const out=[];
  for(const s of nextList || []){
    const before=prevById.get(s.id);
    if(!before) out.push({id:`act-sig-${s.id}-sent`, projectId, kind:"signature_sent", title:`${docLabel} sent for signature`,
      details:s.sentTo ? `Signing link for ${s.sentTo}` : "", at:s.createdAt || ""});
    if(s.status==="signed" && (!before || before.status!=="signed")){
      out.push({id:`act-sig-${s.id}-signed`, projectId, kind:"signed", title:`${docLabel} signed by the client`,
        details:[s.signerName && `Signed by ${s.signerName}`, s.chosenOption && `Option chosen: ${s.chosenOption}`].filter(Boolean).join(" · "),
        at:s.signedAt || "", actor:s.signerName ? `Client: ${s.signerName}` : "Client"});
    }
    if(s.status==="cancelled" && before && before.status!=="cancelled"){
      out.push({id:`act-sig-${s.id}-withdrawn`, projectId, kind:"signature_withdrawn", title:`${docLabel}: signing link withdrawn`});
    }
  }
  return out;
}

function signDocLabel(type){
  if(type==="work_authorization") return "Work Authorization (contract)";
  return (SIGN_TYPES[type] || {label:"Document"}).label;
}

function projectScheduleText(p){
  return p.scheduledDate ? projectStartText(p) : "";
}
function projectVisitText(p){
  return p.estimateVisitDate ? formatDate(p.estimateVisitDate)+(p.estimateVisitTime ? " at "+formatTimeOfDay(new Date(`2000-01-01T${p.estimateVisitTime}:00`)) : "") : "";
}

function projectEvents(prev, next){
  const prevById=new Map(prev.map(p=>[p.id,p]));
  const nextIds=new Set(next.map(p=>p.id));
  const out=[];
  for(const p of next){
    const b=prevById.get(p.id);
    const id=p.id;
    if(!b){
      out.push({projectId:id, kind:"created", title:p.stage==="lead" ? "Lead created" : `Lead created (${stageLabel(p.stage)})`,
        details:[p.clientName, p.clientPhone, p.clientEmail, p.address, p.estimateNumber && `Estimate ${p.estimateNumber}`].filter(Boolean).join(" · ")});
      out.push(...projectSignatureEvents(id,[],p.signatures));
      continue;
    }
    const customer=[["Name","clientName"],["Phone","clientPhone"],["Email","clientEmail"],["Address","address"]]
      .filter(([,k])=>String(b[k]).trim()!==String(p[k]).trim()).map(([l,k])=>actChange(l,b[k],p[k]));
    if(customer.length) out.push({projectId:id, kind:"customer", title:"Customer information updated", details:customer.join("\n")});
    if(b.stage!==p.stage) out.push({projectId:id, kind:"status", title:`Status changed to ${stageLabel(p.stage)}`, details:actChange("Status",stageLabel(b.stage),stageLabel(p.stage))});
    if(b.prospectStatus!==p.prospectStatus && p.stage==="prospect") out.push({projectId:id, kind:"status", title:`Quote status: ${prospectLabel(p.prospectStatus)}`, details:actChange("Quote status",prospectLabel(b.prospectStatus),prospectLabel(p.prospectStatus))});
    if(b.folder!==p.folder){
      const label=k=>(CRM_FOLDERS.find(f=>f.key===k) || {}).label || "";
      out.push({projectId:id, kind:"status", title:p.folder ? `Moved to ${label(p.folder)}` : `Taken out of ${label(b.folder)}`});
    }
    if(b.canceled!==p.canceled) out.push({projectId:id, kind:"status", title:p.canceled ? "Job canceled" : "Job no longer canceled"});
    if(b.assignedTechnician.trim()!==p.assignedTechnician.trim()) out.push({projectId:id, kind:"assigned", title:p.assignedTechnician.trim() ? `Assigned to ${p.assignedTechnician.trim()}` : "Assigned employee removed", details:actChange("Assigned employee",b.assignedTechnician,p.assignedTechnician)});
    const sched=projectScheduleText(p), schedBefore=projectScheduleText(b);
    if(sched!==schedBefore) out.push({projectId:id, kind:"schedule", title:!sched ? "Job date removed" : schedBefore ? "Job rescheduled" : "Job scheduled", details:actChange("Job",schedBefore,sched)});
    const visit=projectVisitText(p), visitBefore=projectVisitText(b);
    if(visit!==visitBefore) out.push({projectId:id, kind:"schedule", title:!visit ? "Estimate visit removed" : visitBefore ? "Estimate visit moved" : "Estimate visit scheduled", details:actChange("Estimate visit",visitBefore,visit)});
    if(b.notes.trim()!==p.notes.trim()) out.push(notesEvent(id,"Note",b.notes,p.notes));
    if(b.followUpNotes.trim()!==p.followUpNotes.trim()) out.push(notesEvent(id,"Follow-up note",b.followUpNotes,p.followUpNotes));
    if(b.followUpDate!==p.followUpDate) out.push({projectId:id, kind:"followup", title:p.followUpDate ? "Follow-up date set" : "Follow-up date removed", details:actChange("Follow-up",b.followUpDate && formatDate(b.followUpDate),p.followUpDate && formatDate(p.followUpDate))});
    if(b.followUpCompleted!==p.followUpCompleted) out.push({projectId:id, kind:"followup", title:p.followUpCompleted ? "Follow-up completed" : "Follow-up reopened"});
    if(b.paymentStatus!==p.paymentStatus) out.push({projectId:id, kind:"payment", title:`Payment status: ${paymentLabel(p.paymentStatus)}`, details:actChange("Payment status",paymentLabel(b.paymentStatus),paymentLabel(p.paymentStatus))});
    for(const t of p.tasks){
      const was=b.tasks.find(x=>x.key===t.key);
      if(was && was.done!==t.done) out.push({projectId:id, kind:"task", title:t.done ? `Task done: ${t.label}` : `Task reopened: ${t.label}`});
    }
    if(b.estimateId!==p.estimateId && p.estimateId) out.push({projectId:id, kind:"estimate", title:`Estimate ${p.estimateNumber || ""} linked`.replace(/\s+/g," ")});
    const mat=materialsTotal(p.materials), matBefore=materialsTotal(b.materials);
    if(mat!==matBefore || p.materials.length!==b.materials.length) out.push({projectId:id, kind:"other", title:"Materials updated", details:`${p.materials.length} item${p.materials.length===1?"":"s"} · ${money(mat)} (was ${money(matBefore)})`});
    out.push(...projectSignatureEvents(id,b.signatures,p.signatures));
  }
  for(const b of prev) if(!nextIds.has(b.id)) out.push({projectId:b.id, kind:"deleted", title:"Lead deleted", details:b.clientName || b.address || ""});
  return out;
}

// Project documents (Work Authorization, Certificate of Completion), each named by its type.
function projectSignatureEvents(projectId, prevList, nextList){
  return (nextList || []).flatMap(s=>signatureEvents(projectId,signDocLabel(s.type),(prevList || []).filter(x=>x.id===s.id),[s]));
}

function notesEvent(projectId, label, before, after){
  const a=String(before || "").trim(), b=String(after || "").trim();
  if(!b) return {projectId, kind:"notes", title:`${label}s cleared`, details:actShort(a)};
  if(!a) return {projectId, kind:"notes", title:`${label} added`, details:actShort(b)};
  if(b.startsWith(a)) return {projectId, kind:"notes", title:`${label} added`, details:actShort(b.slice(a.length))};
  return {projectId, kind:"notes", title:`${label}s edited`, details:actShort(b)};
}

// The project an estimate or invoice belongs to (projects: the list being saved or the stored one).
function activityProjectFor(rec, projects){
  if(!rec) return "";
  if(rec.crmProjectId && projects.some(p=>p.id===rec.crmProjectId)) return rec.crmProjectId;
  const viaEstimate=rec.estimateId ? projects.find(p=>p.estimateId===rec.estimateId) : null;
  const own=projects.find(p=>p.estimateId===rec.id);
  return (own || viaEstimate || {}).id || rec.crmProjectId || "";
}

function estimateDocLabel(e){
  const kind=typeof isChangeOrder==="function" && isChangeOrder(e) ? "Change order" : "Estimate";
  return `${kind} ${e.estimateNumber || ""}${e.optionGroup && e.optionLabel ? ` (${e.optionLabel})` : ""}`.replace(/\s+/g," ").trim();
}

function estimateEvents(prev, next){
  const projects=loadProjects();
  const prevById=new Map(prev.map(e=>[e.id,e]));
  const nextIds=new Set(next.map(e=>e.id));
  const out=[];
  for(const e of next){
    const projectId=activityProjectFor(e,projects);
    if(!projectId) continue;
    const b=prevById.get(e.id);
    const label=estimateDocLabel(e);
    if(!b){
      out.push({projectId, kind:"estimate", title:`${label} created`, details:`Total ${money(e.customerTotal)}`});
    }else{
      if(b.status!==e.status) out.push({projectId, kind:e.status==="accepted" ? "signed" : "estimate",
        title:e.status==="accepted" ? `${label} accepted` : `${label}: ${capitalize(e.status)}`, details:actChange("Status",capitalize(b.status),capitalize(e.status))});
      if(round2(b.customerTotal)!==round2(e.customerTotal)) out.push({projectId, kind:"estimate", title:`${label} updated`, details:actChange("Total",money(b.customerTotal),money(e.customerTotal))});
      if(b.estimateNumber && e.estimateNumber!==b.estimateNumber) out.push({projectId, kind:"estimate", title:`Estimate number changed`, details:actChange("Number",b.estimateNumber,e.estimateNumber)});
    }
    out.push(...signatureEvents(projectId,label,b ? b.signatures : [],e.signatures));
  }
  for(const b of prev){
    if(nextIds.has(b.id)) continue;
    const projectId=activityProjectFor(b,projects);
    if(projectId) out.push({projectId, kind:"estimate", title:`${estimateDocLabel(b)} deleted`});
  }
  return out;
}

function invoiceEvents(prev, next){
  const projects=loadProjects();
  const prevById=new Map(prev.map(i=>[i.id,i]));
  const nextIds=new Set(next.map(i=>i.id));
  const out=[];
  for(const raw of next){
    const inv=computeInvoice(raw);
    const projectId=activityProjectFor(inv,projects);
    if(!projectId) continue;
    const bRaw=prevById.get(inv.id), b=bRaw ? computeInvoice(bRaw) : null;
    const label=`Invoice ${inv.invoiceNumber}`.trim();
    if(!b) out.push({projectId, kind:"invoice", title:`${label} created`, details:`Total ${money(inv.total)}${inv.estimateNumber ? ` · from estimate ${inv.estimateNumber}` : ""}`});
    else{
      if(b.status!==inv.status) out.push({projectId, kind:"invoice",
        title:inv.status==="sent" ? `${label} sent to the client` : inv.status==="void" ? `${label} voided` : `${label}: ${capitalize(inv.status)}`,
        details:actChange("Status",capitalize(b.status),capitalize(inv.status))});
      if(round2(b.total)!==round2(inv.total)) out.push({projectId, kind:"invoice", title:`${label} updated`, details:actChange("Total",money(b.total),money(inv.total))});
    }
    // Payments: each one once (its id), in the order received.
    const before=new Set((b ? b.payments : []).map(p=>p.id));
    let paid=round2((b ? b.payments : []).filter(p=>inv.payments.some(x=>x.id===p.id)).reduce((s,p)=>s+amount(p.amount),0));
    for(const pay of inv.payments){
      if(before.has(pay.id)) continue;
      paid=round2(paid+amount(pay.amount));
      const left=round2(inv.total-paid);
      const full=left<=0;
      out.push({id:`act-pay-${pay.id}`, projectId, kind:full ? "paid" : "payment",
        title:full ? `Full payment received: ${label} Paid in Full` : `Partial payment received: ${label}`,
        details:[`${money(pay.amount)} · ${pay.method}`, pay.date && `Date ${formatDate(pay.date)}`, pay.note, full ? `Paid in total ${money(paid)}` : `Remaining balance ${money(left)}`].filter(Boolean).join(" · ")});
    }
    for(const pay of b ? b.payments : []){
      if(!inv.payments.some(x=>x.id===pay.id)) out.push({id:`act-payrm-${pay.id}`, projectId, kind:"payment", title:`Payment removed: ${label}`, details:`${money(pay.amount)} · ${pay.method}${pay.date ? ` · ${formatDate(pay.date)}` : ""}`});
    }
  }
  for(const b of prev){
    if(nextIds.has(b.id)) continue;
    const projectId=activityProjectFor(b,projects);
    if(projectId) out.push({projectId, kind:"invoice", title:`Invoice ${b.invoiceNumber} deleted`});
  }
  return out;
}

/* ---------- Showing the history ---------- */

function activityItemHtml(a){
  const actor=a.actor || "This device (not signed in)";
  return `<li class="hist-item hist-${escapeHtml(a.kind)}">
    <span class="hist-icon" aria-hidden="true">${ACTIVITY_KINDS[a.kind] || "•"}</span>
    <div class="hist-body">
      <div class="hist-title">${escapeHtml(a.title)}</div>
      <div class="hist-meta"><time datetime="${escapeHtml(a.at)}">${escapeHtml(a.at ? formatDateTime(a.at) : "")}</time> · ${escapeHtml(actor)}</div>
      ${a.details ? `<div class="hist-details">${escapeHtml(a.details)}</div>` : ""}
    </div>
  </li>`;
}

function activityHistoryHtml(projectId, showAll){
  const list=activityForProject(projectId);
  if(!list.length) return `<p class="muted small">No activity recorded yet. From now on every change to this lead is listed here automatically.</p>`;
  const shown=showAll ? list : list.slice(0,ACTIVITY_PAGE_SIZE);
  return `<ol class="hist-list">${shown.map(activityItemHtml).join("")}</ol>
    ${list.length>shown.length ? `<button type="button" class="btn btn-light btn-sm" data-history-all="${escapeHtml(projectId)}">Show all ${list.length} events</button>` : ""}`;
}

// At a glance: estimate / contract signed? payment received?
function leadStatusSummary(p){
  const ests=loadEstimates().filter(e=>(e.crmProjectId===p.id || e.id===p.estimateId) && !(typeof isChangeOrder==="function" && isChangeOrder(e)));
  const chips=[];
  const signedEst=ests.map(e=>({e,s:latestSignature(e.signatures,"estimate")})).filter(x=>x.s && x.s.status==="signed");
  if(signedEst.length) chips.push(["ok",`Estimate signed ✓ ${signedEst.map(x=>x.e.optionGroup && x.e.optionLabel ? x.e.optionLabel : x.e.estimateNumber).join(", ")} · ${formatDate((signedEst[0].s.signedAt || "").slice(0,10)) || ""}`.replace(/ · $/,"")]);
  else if(ests.some(e=>e.status==="accepted")) chips.push(["ok","Estimate accepted ✓"]);
  else if(ests.some(e=>latestSignature(e.signatures,"estimate"))) chips.push(["wait","Estimate sent for signature, not signed yet"]);
  else if(ests.some(e=>e.status==="sent")) chips.push(["wait","Estimate sent, not signed yet"]);
  else chips.push(["none",ests.length ? "Estimate not sent yet" : "No estimate yet"]);
  const wa=latestSignature(p.signatures,"work_authorization");
  chips.push(wa && wa.status==="signed" ? ["ok",`Contract (Work Authorization) signed ✓ ${formatDate((wa.signedAt || "").slice(0,10))}`.trim()]
    : wa ? ["wait","Contract (Work Authorization) sent, not signed yet"] : ["none","Contract (Work Authorization) not sent"]);
  const invs=invoicesForProject(p.id).map(computeInvoice);
  if(invs.length){
    const total=round2(invs.reduce((s,i)=>s+i.total,0)), paid=round2(invs.reduce((s,i)=>s+i.paid,0));
    chips.push(paid>0 && paid>=total ? ["ok",`Paid in Full ✓ ${money(paid)}`] : paid>0 ? ["wait",`Partially paid: ${money(paid)} of ${money(total)}`] : ["none",`Not paid yet: ${money(total)} invoiced`]);
  }else{
    chips.push(p.paymentStatus==="not_paid" ? ["none","No payment yet"] : [p.paymentStatus==="paid" ? "ok" : "wait",`Payment: ${paymentLabel(p.paymentStatus)}`]);
  }
  return `<div class="lead-summary">${chips.map(([c,t])=>`<span class="lead-chip lead-${c}">${escapeHtml(t)}</span>`).join("")}</div>`;
}

/* ---------- Lead links: Share Lead / Copy Link ---------- */

function leadLink(projectId){
  return location.origin+location.pathname+location.search.replace(/[?&]access_token=[^&]*/,"")+"#lead="+encodeURIComponent(projectId);
}

async function copyText(text){
  try{
    if(navigator.clipboard && window.isSecureContext){ await navigator.clipboard.writeText(text); return true; }
  }catch(e){ /* fall back below */ }
  const ta=document.createElement("textarea");
  ta.value=text; ta.setAttribute("readonly",""); ta.style.position="fixed"; ta.style.opacity="0";
  document.body.appendChild(ta); ta.select();
  let ok=false;
  try{ ok=document.execCommand("copy"); }catch(e){ ok=false; }
  ta.remove();
  return ok;
}

async function copyLeadLink(projectId){
  const url=leadLink(projectId);
  if(await copyText(url)) showToast("Link copied. Only people with access to the CRM can open it.");
  else prompt("Copy this link:",url);
}

async function shareLead(projectId){
  const p=getProject(projectId);
  if(!p) return;
  const url=leadLink(projectId);
  const title=`Lead: ${p.clientName || p.address || "CRM lead"}`;
  if(navigator.share){
    try{ await navigator.share({title, text:`${title} (EverCraft CRM, sign-in needed)`, url}); return; }
    catch(e){ if(e && e.name==="AbortError") return; }
  }
  copyLeadLink(projectId);
}

/* ---------- The single lead page (#lead=<id>) ---------- */

let LEAD_PAGE_ID = "";
let LEAD_PAGE_ALL = false;

function leadIdFromHash(hash){
  const m=/^lead=([^?&#]+)/.exec(String(hash || ""));
  if(!m) return "";
  try{ return decodeURIComponent(m[1]); }catch(e){ return ""; }
}

function showLeadPage(projectId){
  if(LEAD_PAGE_ID!==projectId) LEAD_PAGE_ALL=false;
  LEAD_PAGE_ID=projectId;
  renderLeadPage();
}

// What the person opening the link may see: "ok", or why not.
function leadAccess(){
  if(!(typeof cloudActive==="function" && cloudActive())) return "ok"; // this device's own CRM
  if(CLOUD.role) return "ok";
  if(CLOUD.state==="signed_out") return "signed_out";
  if(CLOUD.state==="no_access") return "no_access";
  if(CLOUD.state==="error") return "error";
  return "checking";
}

function renderLeadPage(){
  const box=$("leadView");
  if(!box || $("page-lead").hidden) return;
  const id=LEAD_PAGE_ID;
  const access=leadAccess();
  const msg=(title,text,buttons="")=>`<section class="card lead-gate"><h2>${escapeHtml(title)}</h2><p>${text}</p>${buttons ? `<div class="btn-row">${buttons}</div>` : ""}</section>`;
  if(access==="checking"){ box.innerHTML=msg("Opening the lead…","Checking your access to the CRM."); return; }
  if(access==="signed_out"){
    box.innerHTML=msg("Sign in to open this lead","This link opens a lead in the EverCraft CRM. Only team members with CRM access can see it.",
      `<button type="button" class="btn btn-primary" data-lead-action="sign-in">Sign in</button>`);
    return;
  }
  if(access==="no_access"){
    box.innerHTML=msg("No access to this lead",`You are signed in as <b>${escapeHtml((CLOUD.user && CLOUD.user.email) || "")}</b>, but this account has no access to the CRM yet. `+
      `Ask an owner or admin to give you access (Settings → Team Access), then open the link again.`,
      `<button type="button" class="btn btn-primary" data-lead-action="request-access">Request access</button>
       <button type="button" class="btn btn-light" data-lead-action="switch-account">Sign in with another account</button>`);
    return;
  }
  if(access==="error" && !getProject(id)){
    box.innerHTML=msg("The lead could not be loaded",escapeHtml(CLOUD.message || "The shared CRM could not be reached."),
      `<button type="button" class="btn btn-primary" data-lead-action="retry">Try again</button>`);
    return;
  }
  const p=getProject(id);
  if(!p){
    const waiting=cloudActive() && !CLOUD.lastSync;
    box.innerHTML=waiting ? msg("Opening the lead…","Loading the CRM data.")
      : msg("Lead not found","This lead does not exist (it may have been deleted), or the link is not complete. "+
        (cloudActive() ? "" : "Without the shared CRM, a lead link only opens on the device where the lead was created."),
        `<button type="button" class="btn btn-light" data-lead-action="crm">Go to the CRM</button>`);
    return;
  }
  box.innerHTML=leadCardHtml(p);
}

function leadCardHtml(p){
  const ests=loadEstimates().filter(e=>e.crmProjectId===p.id || e.id===p.estimateId);
  const invs=invoicesForProject(p.id);
  const maps=p.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.address)}` : "";
  const row=(label,value)=>value ? `<div class="lead-row"><span>${escapeHtml(label)}</span><div>${value}</div></div>` : "";
  return `<article class="card lead-card" data-id="${escapeHtml(p.id)}">
    <div class="lead-head">
      <div>
        <div class="small">CRM lead · ${escapeHtml(stageLabel(p.stage))}${p.canceled ? " · Canceled" : ""}</div>
        <h2>${escapeHtml(p.clientName || p.address || "Unnamed client")}</h2>
      </div>
      <div class="btn-row lead-share">
        <button type="button" class="btn btn-light btn-sm" data-share-lead="${escapeHtml(p.id)}">📤 Share Lead</button>
        <button type="button" class="btn btn-light btn-sm" data-copy-lead="${escapeHtml(p.id)}">🔗 Copy Link</button>
        <button type="button" class="btn btn-primary btn-sm" data-lead-action="edit">Edit</button>
      </div>
    </div>
    ${leadStatusSummary(p)}
    <div class="lead-rows">
      ${row("Phone",p.clientPhone ? `<a href="tel:${escapeHtml(p.clientPhone.replace(/[^\d+]/g,""))}">${escapeHtml(p.clientPhone)}</a>` : "")}
      ${row("Email",p.clientEmail ? `<a href="mailto:${escapeHtml(p.clientEmail)}">${escapeHtml(p.clientEmail)}</a>` : "")}
      ${row("Address",p.address ? `<a href="${escapeHtml(maps)}" target="_blank" rel="noopener">${escapeHtml(p.address)}</a>` : "")}
      ${row("Status",escapeHtml(stageLabel(p.stage)+(p.stage==="prospect" ? ` · ${prospectLabel(p.prospectStatus)}` : "")))}
      ${row("Estimate visit",escapeHtml(projectVisitText(p)))}
      ${row("Job",escapeHtml(projectScheduleText(p)))}
      ${row("Assigned to",escapeHtml(p.assignedTechnician))}
      ${row("Estimates",ests.map(e=>`${escapeHtml(estimateDocLabel(e))} · ${money(e.customerTotal)} · <span class="status-badge status-${escapeHtml(e.status)}">${escapeHtml(capitalize(e.status))}</span>`).join("<br>"))}
      ${row("Invoices",invs.map(computeInvoice).map(i=>`${escapeHtml(i.invoiceNumber)} · ${money(i.total)} · ${escapeHtml(invoicePaymentStatus(i).label)}${i.paid>0 && i.balance>0 ? ` · balance ${money(i.balance)}` : ""}`).join("<br>"))}
      ${row("Notes",p.notes ? `<div class="lead-notes">${escapeHtml(p.notes)}</div>` : "")}
    </div>
    <h3>History</h3>
    <div class="lead-history">${activityHistoryHtml(p.id,LEAD_PAGE_ALL)}</div>
  </article>`;
}

function handleLeadPageClick(e){
  const t=e.target;
  const share=t.closest("[data-share-lead]");
  if(share){ shareLead(share.dataset.shareLead); return; }
  const copy=t.closest("[data-copy-lead]");
  if(copy){ copyLeadLink(copy.dataset.copyLead); return; }
  if(t.closest("[data-history-all]")){ LEAD_PAGE_ALL=true; renderLeadPage(); return; }
  const btn=t.closest("[data-lead-action]");
  if(!btn) return;
  const action=btn.dataset.leadAction;
  if(action==="sign-in") openCloudLogin();
  else if(action==="switch-account") cloudSignOut();
  else if(action==="retry") cloudSync();
  else if(action==="crm") showPage("crm");
  else if(action==="edit") openProjectModal(LEAD_PAGE_ID);
  else if(action==="request-access"){
    const to=(SETTINGS && SETTINGS.companyEmail) || "";
    const who=(CLOUD.user && CLOUD.user.email) || "";
    location.href=`mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent("Access to the EverCraft CRM")}&body=${encodeURIComponent(`Hello,\n\nPlease give my account ${who} access to the CRM (Settings → Team Access). I need to open this lead:\n${location.href}\n\nThank you.`)}`;
  }
}

/* ---------- In the lead window (project modal) ---------- */

function renderProjectHistory(projectId, showAll){
  const box=$("pmHistory");
  if(!box) return;
  $("pmHistorySection").hidden=!projectId;
  $("pmShare").hidden=!projectId;
  if(!projectId){ box.innerHTML=""; return; }
  const p=getProject(projectId);
  box.innerHTML=(p ? leadStatusSummary(p) : "")+activityHistoryHtml(projectId,showAll);
}

function wireActivityEvents(){
  $("leadView").addEventListener("click",handleLeadPageClick);
  $("pmShare").addEventListener("click",e=>{
    const id=EDITING_PROJECT_ID;
    if(!id) return;
    if(e.target.closest("[data-pm-share]")) shareLead(id);
    else if(e.target.closest("[data-pm-copy]")) copyLeadLink(id);
  });
  $("pmHistory").addEventListener("click",e=>{
    const all=e.target.closest("[data-history-all]");
    if(all) renderProjectHistory(all.dataset.historyAll,true);
  });
}
