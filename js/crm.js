"use strict";

/* Construction CRM: Kanban pipeline
   Leads / Clients → Prospects → Client / Job → Start the Project → Project Completed → Follow-up
   The linked estimate stays the source of truth for pricing. */

const CRM_STAGES = [
  {key:"lead", label:"Leads / Clients"},
  {key:"prospect", label:"Prospects"},
  {key:"job", label:"Client / Job"},
  {key:"started", label:"Start the Project"},
  {key:"completed", label:"Project Completed"},
  {key:"followup", label:"Follow-up"}
];
const CRM_STAGE_KEYS = CRM_STAGES.map(s=>s.key);

const PROSPECT_STATUSES = [
  {key:"quote_sent", label:"Quote sent"},
  {key:"quote_accepted", label:"Quote accepted"},
  {key:"needs_action", label:"Unconfirmed / needs action"}
];

const FOLLOWUP_TYPES = [
  {key:"client", label:"Client follow-up"},
  {key:"personal", label:"Personal follow-up"}
];

const TASK_GROUPS = [
  {key:"before", label:"Before arrival", stage:"started"},
  {key:"project", label:"Project", stage:"started"},
  {key:"completion", label:"Close-out", stage:"completed"}
];

const TASK_TEMPLATE = [
  {key:"checkTechnician", group:"before", label:"Check technician"},
  {key:"checkWO", group:"before", label:"Check WO"},
  {key:"checkClient", group:"before", label:"Check client"},
  {key:"photosReports", group:"project", label:"Photos / reports"},
  {key:"techReports", group:"project", label:"Tech's reports"},
  {key:"salariesExpenses", group:"project", label:"Salaries / expenses"},
  {key:"backOffice", group:"project", label:"Back office"},
  {key:"clientPayments", group:"project", label:"Payments from client"},
  {key:"acceptanceForm", group:"completion", label:"Acceptance form"},
  {key:"invoice", group:"completion", label:"Invoice"},
  {key:"askReview", group:"completion", label:"Ask for review"}
];

let EDITING_PROJECT_ID = null;

function stageLabel(key){ return (CRM_STAGES.find(s=>s.key===key)||{}).label || ""; }
function prospectLabel(key){ return (PROSPECT_STATUSES.find(s=>s.key===key)||{}).label || ""; }
function followUpTypeLabel(key){ return (FOLLOWUP_TYPES.find(s=>s.key===key)||{}).label || ""; }

/* ---------- Storage ---------- */

function normalizeProject(p){
  const stored=Array.isArray(p.tasks) ? p.tasks : [];
  return {
    id:String(p.id),
    clientName:String(p.clientName ?? ""),
    clientEmail:String(p.clientEmail ?? ""),
    clientPhone:String(p.clientPhone ?? ""),
    address:String(p.address ?? ""),
    estimateId:p.estimateId || null,
    estimateNumber:String(p.estimateNumber ?? ""),
    estimateTotal:round2(amount(p.estimateTotal)),
    stage:CRM_STAGE_KEYS.includes(p.stage) ? p.stage : "lead",
    prospectStatus:PROSPECT_STATUSES.some(s=>s.key===p.prospectStatus) ? p.prospectStatus : "needs_action",
    scheduledDate:String(p.scheduledDate ?? ""),
    assignedTechnician:String(p.assignedTechnician ?? ""),
    notes:String(p.notes ?? ""),
    tasks:TASK_TEMPLATE.map(t=>({...t,done:!!(stored.find(x=>x && x.key===t.key)||{}).done})),
    followUpDate:String(p.followUpDate ?? ""),
    followUpType:FOLLOWUP_TYPES.some(t=>t.key===p.followUpType) ? p.followUpType : "client",
    followUpNotes:String(p.followUpNotes ?? ""),
    followUpCompleted:!!p.followUpCompleted,
    createdAt:p.createdAt || nowISO(),
    updatedAt:p.updatedAt || p.createdAt || nowISO()
  };
}

function loadProjects(){
  const list=readStore(STORAGE_KEYS.crm,[]);
  return Array.isArray(list) ? list.filter(p=>p && p.id).map(normalizeProject) : [];
}

function saveProjects(list){
  return writeStore(STORAGE_KEYS.crm,list);
}

function getProject(id){
  return id ? loadProjects().find(p=>p.id===id) || null : null;
}

function updateProject(id, changes){
  const list=loadProjects();
  const p=list.find(x=>x.id===id);
  if(!p) return null;
  Object.assign(p,changes,{updatedAt:nowISO()});
  return saveProjects(list) ? p : null;
}

function newProjectRecord(data){
  const now=nowISO();
  return normalizeProject({...data,id:uid("crm"),createdAt:now,updatedAt:now});
}

function taskProgress(project, stage){
  const groups=TASK_GROUPS.filter(g=>g.stage===stage).map(g=>g.key);
  const tasks=project.tasks.filter(t=>groups.includes(t.group));
  return {done:tasks.filter(t=>t.done).length,total:tasks.length};
}

/* ---------- Estimate ↔ CRM ---------- */

function prospectStatusForEstimate(est){
  if(!est) return "needs_action";
  if(est.status==="accepted") return "quote_accepted";
  if(est.status==="sent") return "quote_sent";
  return "needs_action";
}

// Called when a linked estimate is saved: the project takes its number and total.
function linkProjectToEstimate(projectId, est){
  const list=loadProjects();
  const p=list.find(x=>x.id===projectId);
  if(!p) return false;
  // One project per estimate: any other project pointing at it is unlinked.
  list.forEach(other=>{
    if(other.id!==p.id && other.estimateId===est.id) Object.assign(other,{estimateId:null,estimateNumber:"",estimateTotal:0});
  });
  Object.assign(p,{
    estimateId:est.id,
    estimateNumber:est.estimateNumber,
    estimateTotal:est.customerTotal,
    clientName:p.clientName || est.clientName,
    clientEmail:p.clientEmail || est.clientEmail,
    clientPhone:p.clientPhone || est.clientPhone,
    address:p.address || est.address,
    updatedAt:nowISO()
  });
  return saveProjects(list);
}

function unlinkEstimateFromProjects(estimateId){
  const list=loadProjects();
  let changed=false;
  list.forEach(p=>{
    if(p.estimateId===estimateId){
      Object.assign(p,{estimateId:null,estimateNumber:"",estimateTotal:0,updatedAt:nowISO()});
      changed=true;
    }
  });
  if(changed) saveProjects(list);
}

// Estimate status "sent"/"accepted" updates the quote status of a linked prospect.
function syncProjectFromEstimateStatus(est){
  const p=loadProjects().find(x=>x.id===est.crmProjectId || x.estimateId===est.id);
  if(!p || p.stage!=="prospect") return;
  if(est.status==="sent" || est.status==="accepted") updateProject(p.id,{prospectStatus:prospectStatusForEstimate(est)});
}

// From a saved estimate: opens its CRM project, or creates one. Never creates duplicates.
function createOrOpenCrmFromEstimate(estimateId){
  const est=getEstimate(estimateId);
  if(!est) return;
  const list=loadProjects();
  let project=list.find(p=>p.id===est.crmProjectId) || list.find(p=>p.estimateId===est.id);
  let created=false;

  if(!project){
    const quoted=est.status==="sent" || est.status==="accepted";
    project=newProjectRecord({
      clientName:est.clientName,
      clientEmail:est.clientEmail,
      clientPhone:est.clientPhone,
      address:est.address,
      estimateId:est.id,
      estimateNumber:est.estimateNumber,
      estimateTotal:est.customerTotal,
      stage:quoted ? "prospect" : "lead",
      prospectStatus:prospectStatusForEstimate(est)
    });
    list.push(project);
    if(!saveProjects(list)) return;
    created=true;
  }else if(project.estimateId!==est.id){
    linkProjectToEstimate(project.id,est);
  }

  if(est.crmProjectId!==project.id) updateEstimate(est.id,{crmProjectId:project.id});
  if(BUILDER.id===est.id) BUILDER.crmProjectId=project.id;

  updateBuilderMeta();
  renderSavedEstimates();
  showPage("crm");
  openProjectModal(project.id);
  if(created) showToast(`CRM project created in ${stageLabel(project.stage)}.`);
}

// From a CRM project: opens its estimate, or starts a new one pre-filled with the client.
function createEstimateFromProject(projectId){
  const p=getProject(projectId);
  if(!p) return;
  if(p.estimateId && getEstimate(p.estimateId)){
    openProjectEstimate(projectId);
    return;
  }
  if(!confirmDiscardChanges()) return;
  closeModal("projectModal");
  newEstimate({
    clientName:p.clientName,
    clientEmail:p.clientEmail,
    clientPhone:p.clientPhone,
    address:p.address,
    crmProjectId:p.id
  });
  showPage("builder");
  showToast("New estimate for this CRM project. Add services and press Save Estimate.");
}

function openProjectEstimate(projectId){
  const p=getProject(projectId);
  if(p && p.estimateId && getEstimate(p.estimateId)){
    closeModal("projectModal");
    openEstimate(p.estimateId);
  }
}

/* ---------- Moving through the pipeline ---------- */

function moveProject(id, stage){
  const p=getProject(id);
  if(!p || !CRM_STAGE_KEYS.includes(stage)) return;
  const changes={stage};

  if(stage==="prospect" && p.stage==="lead"){
    changes.prospectStatus=prospectStatusForEstimate(getEstimate(p.estimateId));
  }
  if(stage==="started" && (!p.scheduledDate || !p.assignedTechnician)){
    if(!confirm("This job has no scheduled date or assigned technician yet. Start the project anyway?")) return;
  }
  if(stage==="completed"){
    const pr=taskProgress(p,"started");
    if(pr.done<pr.total && !confirm(`Only ${pr.done} of ${pr.total} project tasks are completed. Move to Project Completed anyway?`)) return;
  }
  if(stage==="followup"){
    const pr=taskProgress(p,"completed");
    if(pr.done<pr.total && !confirm(`Only ${pr.done} of ${pr.total} completion tasks are done. Move to Follow-up anyway?`)) return;
  }

  updateProject(id,changes);
  renderCrmBoard();
  updateBuilderMeta();
  showToast(`Moved to ${stageLabel(stage)}.`);
}

function setTask(id, key, done){
  const p=getProject(id);
  if(!p) return;
  const tasks=p.tasks.map(t=>t.key===key ? {...t,done} : t);
  const updated=updateProject(id,{tasks});
  renderCrmBoard();
  if(updated && updated.stage==="completed"){
    const pr=taskProgress(updated,"completed");
    if(pr.done===pr.total) showToast("All completion tasks done. Ready to move to Follow-up.");
  }
}

function setFollowUpCompleted(id, completed){
  updateProject(id,{followUpCompleted:completed});
  renderCrmBoard();
  showToast(completed ? "Follow-up completed." : "Follow-up reopened.");
}

function deleteProject(id){
  const p=getProject(id);
  if(!p) return false;
  if(!confirm(`Delete CRM project for ${p.clientName || p.address || "this client"}? The linked estimate is kept.`)) return false;
  if(!saveProjects(loadProjects().filter(x=>x.id!==id))) return false;
  deleteOwnerPhotos("project",id);

  const estimates=loadEstimates();
  let changed=false;
  estimates.forEach(e=>{ if(e.crmProjectId===id){ e.crmProjectId=null; changed=true; } });
  if(changed) saveEstimates(estimates);
  if(BUILDER.crmProjectId===id) BUILDER.crmProjectId=null;

  closeModal("projectModal");
  updateBuilderMeta();
  renderCrmBoard();
  renderSavedEstimates();
  showToast("CRM project deleted.");
  return true;
}

/* ---------- Board ---------- */

function renderChecklist(p, stage, context){
  const groups=TASK_GROUPS.filter(g=>g.stage===stage);
  return groups.map(g=>`
    <div class="checklist-group">
      <div class="checklist-title">${escapeHtml(g.label)}</div>
      ${p.tasks.filter(t=>t.group===g.key).map(t=>`
        <label class="check">
          <input type="checkbox" data-action="${context}" data-task="${t.key}" ${t.done?"checked":""}>
          <span>${escapeHtml(t.label)}</span>
        </label>`).join("")}
    </div>`).join("");
}

function progressBar(pr){
  const pct=pr.total ? Math.round(pr.done/pr.total*100) : 0;
  return `<div class="progress"><div class="progress-bar" style="width:${pct}%"></div></div>
    <div class="progress-text"><b>${pr.done} / ${pr.total}</b> completed</div>`;
}

function renderCard(p){
  const btn=(action,label,cls="btn-light")=>`<button class="btn ${cls} btn-sm" data-action="${action}">${label}</button>`;
  const hasEstimate=p.estimateId && getEstimate(p.estimateId);
  const estimateLine=hasEstimate
    ? `<button class="kcard-estimate" data-action="open-estimate">📄 ${escapeHtml(p.estimateNumber)} · <b>${money(p.estimateTotal)}</b></button>`
    : `<div class="kcard-line muted">No estimate yet</div>`;
  const photoBadge=`<button type="button" class="kcard-photos" data-action="photos" data-photo-badge hidden></button>`;

  let body="", actions="";
  switch(p.stage){
    case "lead":
      body=`${p.clientEmail?`<div class="kcard-line">✉ ${escapeHtml(p.clientEmail)}</div>`:""}
        ${p.clientPhone?`<div class="kcard-line">☎ ${escapeHtml(p.clientPhone)}</div>`:""}
        <div class="kcard-line muted">Created ${escapeHtml(formatDate(p.createdAt.slice(0,10)))}</div>`;
      actions=btn("open","Open")+btn("edit","Edit")+btn("estimate",hasEstimate?"Open Estimate":"Create Estimate")
        +btn("to-prospect","Move to Prospect","btn-primary");
      break;
    case "prospect":
      body=`<select class="kcard-select" data-action="prospect-status" aria-label="Prospect status">
          ${PROSPECT_STATUSES.map(s=>`<option value="${s.key}" ${s.key===p.prospectStatus?"selected":""}>${s.label}</option>`).join("")}
        </select>`;
      actions=btn("open","Open")+btn("edit","Edit")+btn("to-job","Move to Client / Job","btn-primary");
      break;
    case "job":
      body=`<div class="kcard-line">📅 ${p.scheduledDate?escapeHtml(formatDate(p.scheduledDate)):`<span class="muted">Not scheduled</span>`}</div>
        <div class="kcard-line">👷 ${p.assignedTechnician?escapeHtml(p.assignedTechnician):`<span class="muted">No technician</span>`}</div>
        ${p.notes?`<div class="kcard-notes">${escapeHtml(p.notes)}</div>`:""}`;
      actions=btn("schedule","Schedule Job")+btn("assign","Assign Technician")+btn("open","Open")
        +btn("to-started","Move to Start Project","btn-primary");
      break;
    case "started":
      body=progressBar(taskProgress(p,"started"))+renderChecklist(p,"started","task");
      actions=btn("open","Open")+btn("to-completed","Move to Completed","btn-primary");
      break;
    case "completed": {
      const pr=taskProgress(p,"completed");
      body=progressBar(pr)+renderChecklist(p,"completed","task");
      actions=btn("open","Open")+btn("to-followup","Move to Follow-up",pr.done===pr.total?"btn-primary":"btn-light");
      break;
    }
    case "followup":
      body=`<div class="kcard-line">📅 ${p.followUpDate?escapeHtml(formatDate(p.followUpDate)):`<span class="muted">No follow-up date</span>`}</div>
        <div class="kcard-line">${escapeHtml(followUpTypeLabel(p.followUpType))}</div>
        ${p.followUpNotes?`<div class="kcard-notes">${escapeHtml(p.followUpNotes)}</div>`:""}
        <span class="status-badge ${p.followUpCompleted?"status-completed":"status-draft"}">${p.followUpCompleted?"Completed":"Open"}</span>`;
      actions=(p.followUpCompleted ? btn("reopen-followup","Reopen") : btn("complete-followup","Complete Follow-up","btn-primary"))
        +btn("open","Open");
      break;
  }

  return `
    <article class="kcard ${p.stage==="followup"&&p.followUpCompleted?"kcard-done":""}" data-id="${escapeHtml(p.id)}">
      <div class="kcard-top">
        <div class="kcard-title">${escapeHtml(p.clientName || p.address || "Unnamed client")}</div>
        <button type="button" class="kcard-delete" data-action="delete" title="Delete" aria-label="Delete ${escapeHtml(p.clientName || p.address || "project")}">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 12H7L6 9zm4 2v8h2v-8h-2zm4 0v8h2v-8h-2z"/></svg>
        </button>
      </div>
      ${p.address && p.clientName ? `<div class="kcard-line muted">${escapeHtml(p.address)}</div>` : ""}
      ${estimateLine}
      ${photoBadge}
      ${body}
      <div class="kcard-actions">${actions}</div>
    </article>`;
}

// Shows "📷 N" on cards that have photos (filled in after the board is drawn).
async function fillCrmPhotoCounts(){
  let counts={};
  try{ counts=await photoCountsByOwner(); }catch(e){ return; }
  document.querySelectorAll("#crmBoard .kcard").forEach(card=>{
    const n=counts[photoOwner("project",card.dataset.id)]||0;
    const badge=card.querySelector("[data-photo-badge]");
    if(!badge) return;
    badge.hidden=!n;
    badge.textContent=`📷 ${n} photo${n===1?"":"s"}`;
  });
}

function renderCrmBoard(){
  const query=$("crmSearch").value.trim().toLowerCase();
  const projects=loadProjects()
    .filter(p=>!query || [p.clientName,p.clientEmail,p.clientPhone,p.address,p.estimateNumber].some(v=>v.toLowerCase().includes(query)))
    .sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));

  $("crmBoard").innerHTML=CRM_STAGES.map(st=>{
    const cards=projects.filter(p=>p.stage===st.key);
    return `
      <div class="kanban-col" data-stage="${st.key}">
        <div class="kanban-head"><span>${st.label}</span><span class="kanban-count">${cards.length}</span></div>
        <div class="kanban-cards">${cards.map(renderCard).join("") || `<div class="kanban-empty">No projects</div>`}</div>
      </div>`;
  }).join("");
  fillCrmPhotoCounts();
}

function handleCrmBoard(event){
  const el=event.target.closest("[data-action]");
  const id=el?.closest(".kcard")?.dataset.id;
  if(!id) return;
  const action=el.dataset.action;

  if(event.type==="change"){
    if(action==="prospect-status"){ updateProject(id,{prospectStatus:el.value}); renderCrmBoard(); }
    else if(action==="task") setTask(id,el.dataset.task,el.checked);
    return;
  }
  if(action==="prospect-status" || action==="task") return;

  ({
    open:()=>openProjectModal(id),
    photos:()=>{ openProjectModal(id); $("pmPhotos").scrollIntoView({block:"center"}); },
    edit:()=>openProjectModal(id,"pmClientName"),
    estimate:()=>createEstimateFromProject(id),
    "open-estimate":()=>openProjectEstimate(id),
    "to-prospect":()=>moveProject(id,"prospect"),
    "to-job":()=>moveProject(id,"job"),
    "to-started":()=>moveProject(id,"started"),
    "to-completed":()=>moveProject(id,"completed"),
    "to-followup":()=>moveProject(id,"followup"),
    schedule:()=>openProjectModal(id,"pmScheduledDate"),
    assign:()=>openProjectModal(id,"pmTechnician"),
    "complete-followup":()=>setFollowUpCompleted(id,true),
    "reopen-followup":()=>setFollowUpCompleted(id,false),
    delete:()=>deleteProject(id)
  })[action]?.();
}

/* ---------- Project modal (open / edit / new lead) ---------- */

function openProjectModal(id, focusField){
  const p=id ? getProject(id) : newProjectRecord({stage:"lead"});
  if(!p) return;
  EDITING_PROJECT_ID=id ? p.id : null;

  $("projectModalTitle").textContent=id ? (p.clientName || p.address || "CRM Project") : "New Lead";
  $("pmClientName").value=p.clientName;
  $("pmClientEmail").value=p.clientEmail;
  $("pmClientPhone").value=p.clientPhone;
  $("pmAddress").value=p.address;
  $("pmStage").value=p.stage;
  $("pmProspectStatus").value=p.prospectStatus;
  $("pmScheduledDate").value=p.scheduledDate;
  $("pmTechnician").value=p.assignedTechnician;
  $("pmNotes").value=p.notes;
  $("pmFollowUpDate").value=p.followUpDate;
  $("pmFollowUpType").value=p.followUpType;
  $("pmFollowUpNotes").value=p.followUpNotes;
  $("pmFollowUpCompleted").checked=p.followUpCompleted;

  const started=taskProgress(p,"started"), completed=taskProgress(p,"completed");
  $("pmStartedProgress").textContent=`${started.done} / ${started.total} completed`;
  $("pmCompletedProgress").textContent=`${completed.done} / ${completed.total} completed`;
  $("pmStartedTasks").innerHTML=renderChecklist(p,"started","pm-task");
  $("pmCompletedTasks").innerHTML=renderChecklist(p,"completed","pm-task");

  const est=p.estimateId ? getEstimate(p.estimateId) : null;
  $("pmEstimate").innerHTML=est
    ? `<div><b>${escapeHtml(est.estimateNumber)}</b> · ${money(est.customerTotal)} · <span class="status-badge status-${est.status}">${capitalize(est.status)}</span></div>
       <button class="btn btn-light btn-sm" data-pm-action="open-estimate">Open Estimate</button>`
    : `<div class="muted">No estimate linked.</div>
       ${id?`<button class="btn btn-light btn-sm" data-pm-action="create-estimate">Create Estimate</button>`:`<div class="small">Save the lead first, then create an estimate.</div>`}`;
  $("pmDelete").hidden=!id;
  setPhotoGalleryOwner($("pmPhotos"),"project",id ? p.id : "","Save the lead first, then add photos.");

  openModal("projectModal");
  (focusField ? $(focusField) : $("pmClientName")).focus();
}

function readProjectChecklist(){
  const done=new Set([...document.querySelectorAll('#projectModal input[data-action="pm-task"]:checked')].map(el=>el.dataset.task));
  return TASK_TEMPLATE.map(t=>({...t,done:done.has(t.key)}));
}

function saveProjectForm(){
  const data={
    clientName:$("pmClientName").value.trim(),
    clientEmail:$("pmClientEmail").value.trim(),
    clientPhone:$("pmClientPhone").value.trim(),
    address:$("pmAddress").value.trim(),
    stage:$("pmStage").value,
    prospectStatus:$("pmProspectStatus").value,
    scheduledDate:$("pmScheduledDate").value,
    assignedTechnician:$("pmTechnician").value.trim(),
    notes:$("pmNotes").value.trim(),
    tasks:readProjectChecklist(),
    followUpDate:$("pmFollowUpDate").value,
    followUpType:$("pmFollowUpType").value,
    followUpNotes:$("pmFollowUpNotes").value.trim(),
    followUpCompleted:$("pmFollowUpCompleted").checked
  };
  if(!data.clientName && !data.address){
    alert("Please enter at least a Client Name or an Address.");
    $("pmClientName").focus();
    return;
  }

  if(EDITING_PROJECT_ID){
    if(!updateProject(EDITING_PROJECT_ID,data)) return;
  }else{
    const list=loadProjects();
    list.push(newProjectRecord(data));
    if(!saveProjects(list)) return;
  }
  closeModal("projectModal");
  renderCrmBoard();
  updateBuilderMeta();
  showToast(EDITING_PROJECT_ID ? "CRM project saved." : "Lead added.");
}

function handleProjectModalClick(event){
  const el=event.target.closest("[data-pm-action]");
  if(!el || !EDITING_PROJECT_ID) return;
  if(el.dataset.pmAction==="open-estimate") openProjectEstimate(EDITING_PROJECT_ID);
  else if(el.dataset.pmAction==="create-estimate") createEstimateFromProject(EDITING_PROJECT_ID);
}

function handleProjectModalChange(event){
  if(event.target.dataset.action!=="pm-task") return;
  const tasks=readProjectChecklist();
  const count=group=>{
    const keys=TASK_GROUPS.filter(g=>g.stage===group).map(g=>g.key);
    const list=tasks.filter(t=>keys.includes(t.group));
    return `${list.filter(t=>t.done).length} / ${list.length} completed`;
  };
  $("pmStartedProgress").textContent=count("started");
  $("pmCompletedProgress").textContent=count("completed");
}
