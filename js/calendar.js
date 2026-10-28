"use strict";

/* CRM projects in the company Google Calendar, through the CRM mail service (worker/src/calendar.js).
   The CRM is the source of truth: after a project changes here, its events are added, updated or
   removed. A project can have two events, each with one fixed id on the service, so a repeated or
   retried sync never makes a second event:
     estimate - the estimate visit ("ESTIMATE (name), phone"), in the main calendar, from Prospects on
     job      - the job ("JOB (name), phone · technician"), in the technician's calendar, from Client / Job on
   A sync that fails stays on the project and is tried again by itself, waiting longer each time;
   this browser keeps a log of every attempt.

   Projects in a folder (old CRM) never go to the calendar. Projects that were already in the CRM
   before the sync was turned on are added only once they are changed (they may already be in the
   calendar by hand), and only if not in the past. */

const CALENDAR_STAGES = ["job","started","completed","followup"];
const CALENDAR_KINDS = {
  estimate:{field:"calendarEstimate",label:"Estimate visit"},
  job:{field:"calendar",label:"Job"}
};
const CALENDAR_RETRY_MINUTES = [1,2,5,15,30,60];
const CALENDAR_LOG_KEY = storageKey("calendar_log");
const CALENDAR_REMOVALS_KEY = storageKey("calendar_removals"); // events of deleted projects, still to remove
const CALENDAR_LOG_MAX = 100;
const CALENDAR_TIMEOUT_MS = 20000;

let CALENDAR_RUNNING = false;
let CALENDAR_SCAN_TIMER = null;
let CALENDAR_LIST = null; // the company account's calendars, once loaded on the Settings page

function calendarSyncOn(){
  return SETTINGS.calendarEnabled==="on" && canSendFromCrm();
}

function normalizeCalendarState(c){
  if(!c || typeof c!=="object") return null;
  return {
    state:["synced","pending","error","removed"].includes(c.state) ? c.state : "pending",
    eventId:String(c.eventId || ""),
    calendarId:String(c.calendarId || ""),
    link:String(c.link || ""),
    hash:String(c.hash || ""),   // what is in the calendar now
    want:String(c.want || ""),   // what the CRM wants there (being synced)
    error:String(c.error || ""),
    attempts:Math.max(0,Math.floor(Number(c.attempts) || 0)),
    nextTry:Number(c.nextTry) || 0,
    at:String(c.at || "")
  };
}

function calendarHash(value){
  const s=JSON.stringify(value);
  let h=0x811c9dc5;
  for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,0x01000193); }
  return (h>>>0).toString(36)+"-"+s.length;
}

/* ---------- Which calendar ---------- */

// Settings: [{id, name, names}] - names: other spellings of the team member, comma separated.
function calendarTeam(){
  try{
    const list=JSON.parse(SETTINGS.calendarTeam || "[]");
    return Array.isArray(list) ? list.filter(c=>c && c.id).map(c=>({id:String(c.id),name:String(c.name || ""),names:String(c.names || "")})) : [];
  }catch(e){ return []; }
}

const calendarWords=s=>" "+String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu," ").trim()+" ";

function mainCalendar(){ return SETTINGS.calendarMain || "primary"; }

// The team member's own calendar when the assigned technician names them, else the main calendar.
function calendarFor(technician){
  const text=calendarWords(technician);
  if(text.trim()){
    for(const c of calendarTeam()){
      const names=[c.name,...c.names.split(/[,;]/)].map(calendarWords).filter(n=>n.trim());
      if(names.some(n=>text.includes(n))) return c.id;
    }
  }
  return mainCalendar();
}

/* ---------- What the calendar should show ---------- */

function projectServiceType(p){
  const est=p.estimateId ? getEstimate(p.estimateId) : null;
  if(!est) return "";
  return Object.entries(est.categoryTotals || {}).filter(([,v])=>amount(v)>0).map(([k])=>categoryLabel(k,k)).join(", ");
}

// The fields the service turns into the event (title "ESTIMATE (name), phone" / "JOB (name), phone · technician").
function calendarEvent(p, kind){
  const base={kind,name:p.clientName || p.address || "CRM project",phone:p.clientPhone,service:projectServiceType(p),
    location:p.address,notes:p.notes,canceled:!!p.canceled};
  if(kind==="estimate") return {...base,date:p.estimateVisitDate,time:p.estimateVisitTime};
  return {...base,technician:p.assignedTechnician,date:p.scheduledDate,time:p.scheduledTime,endDate:p.scheduledEndDate};
}

// {action:"upsert", calendarId, event, hash} or {action:"remove", hash}.
function calendarWant(p, kind){
  const remove={action:"remove",hash:"remove"};
  const date=kind==="estimate" ? p.estimateVisitDate : p.scheduledDate;
  const stageOk=kind==="estimate" ? p.stage!=="lead" : CALENDAR_STAGES.includes(p.stage);
  if(p.folder || !date || !stageOk) return remove;
  if(p.canceled && SETTINGS.calendarOnCancel!=="mark") return remove;
  const calendarId=kind==="estimate" ? mainCalendar() : calendarFor(p.assignedTechnician);
  const event=calendarEvent(p,kind);
  return {action:"upsert",calendarId,event,hash:calendarHash({calendarId,event})};
}

// An event the calendar has never had: added only if the project changed since the sync was
// turned on and the date is not past.
function calendarIsNew(p, want, kind){
  const last=kind==="estimate" ? p.estimateVisitDate : (p.scheduledEndDate || p.scheduledDate);
  return want.action==="upsert" && !!SETTINGS.calendarSince && p.updatedAt>=SETTINGS.calendarSince && last>=localISODate();
}

/* ---------- Finding the projects to sync ---------- */

function scheduleCalendarScan(){
  if(SETTINGS.calendarEnabled!=="on") return;
  clearTimeout(CALENDAR_SCAN_TIMER);
  CALENDAR_SCAN_TIMER=setTimeout(()=>{ if(scanCalendarProjects()) runCalendarSync(); },0);
}

// Marks events that must change as waiting. Returns how many are waiting or failed.
function scanCalendarProjects(){
  const list=loadProjects();
  let changed=false, waiting=0;
  for(const p of list){
    for(const [kind,{field}] of Object.entries(CALENDAR_KINDS)){
      const want=calendarWant(p,kind);
      const c=p[field];
      if(!c){
        if(!calendarIsNew(p,want,kind)) continue;
      }else if(c.hash===want.hash && (c.state==="synced" || c.state==="removed")){
        continue;
      }else if((c.state==="pending" || c.state==="error") && c.want===want.hash){
        waiting++;
        continue;
      }
      p[field]={...normalizeCalendarState(c || {}),state:"pending",want:want.hash,error:"",attempts:0,nextTry:0};
      changed=true;
      waiting++;
    }
  }
  if(changed) writeStore(STORAGE_KEYS.crm,list); // status only: updatedAt stays
  return waiting+calendarRemovals().length;
}

function calendarRemovals(){
  const list=readStore(CALENDAR_REMOVALS_KEY,[]);
  return Array.isArray(list) ? list.filter(r=>r && r.projectId).map(r=>({...r,kind:r.kind==="estimate" ? "estimate" : "job"})) : [];
}

// A deleted project's events are removed too (whatever the cancel setting says).
function queueCalendarRemoval(p){
  if(!p) return;
  let list=calendarRemovals(), added=false;
  for(const [kind,{field}] of Object.entries(CALENDAR_KINDS)){
    const c=p[field];
    if(!c || c.state==="removed") continue;
    list=list.filter(r=>!(r.projectId===p.id && r.kind===kind));
    list.push({projectId:p.id,kind,name:p.clientName || p.address || "",
      calendarId:c.calendarId || (kind==="estimate" ? mainCalendar() : calendarFor(p.assignedTechnician)),attempts:0,nextTry:0});
    added=true;
  }
  if(!added) return;
  writeStore(CALENDAR_REMOVALS_KEY,list);
  if(SETTINGS.calendarEnabled==="on") setTimeout(()=>runCalendarSync(),0);
}

/* ---------- Talking to the service ---------- */

async function calendarRequest(path, body){
  const ctl=new AbortController();
  const timer=setTimeout(()=>ctl.abort(),CALENDAR_TIMEOUT_MS);
  try{
    const r=await fetch(mailServiceUrl()+path,{
      method:"POST",
      headers:{"Content-Type":"application/json",Authorization:"Bearer "+cloudSignInToken()},
      body:JSON.stringify({appId:cloudConfig().appId,...body}),
      signal:ctl.signal
    });
    const j=await r.json().catch(()=>({}));
    if(r.ok && j.ok!==false) return j;
    return {error:j.error || `The calendar service answered ${r.status}.`,retry:j.retry!==false};
  }catch(e){
    return {error:"The calendar service could not be reached (offline?).",retry:true};
  }finally{
    clearTimeout(timer);
  }
}

function calendarNextTry(attempts, retry){
  const minutes=retry ? CALENDAR_RETRY_MINUTES[Math.min(attempts-1,CALENDAR_RETRY_MINUTES.length-1)] : CALENDAR_RETRY_MINUTES[CALENDAR_RETRY_MINUTES.length-1];
  return Date.now()+minutes*60000;
}

function calendarDue(c, force){
  return c && (c.state==="pending" || c.state==="error") && (force || c.nextTry<=Date.now());
}

// Syncs everything that is waiting and due. force: also the ones still waiting for a retry.
async function runCalendarSync(force=false){
  if(CALENDAR_RUNNING || !calendarSyncOn()) return;
  CALENDAR_RUNNING=true;
  try{
    const tried=new Set();
    for(;;){
      let next=null;
      for(const x of loadProjects()){
        const kind=Object.keys(CALENDAR_KINDS).find(k=>!tried.has(x.id+":"+k) && calendarDue(x[CALENDAR_KINDS[k].field],force));
        if(kind){ next={p:x,kind}; break; }
      }
      if(!next) break;
      tried.add(next.p.id+":"+next.kind);
      await syncProjectCalendar(next.p,next.kind);
    }
    for(const r of calendarRemovals()){
      if(!force && r.nextTry>Date.now()) continue;
      const res=await calendarRequest("/calendar/sync",{projectId:r.projectId,kind:r.kind,action:"remove",calendarId:r.calendarId});
      const left=calendarRemovals().filter(x=>!(x.projectId===r.projectId && x.kind===r.kind));
      if(res.error){
        const attempts=r.attempts+1;
        left.push({...r,attempts,nextTry:calendarNextTry(attempts,res.retry)});
      }
      writeStore(CALENDAR_REMOVALS_KEY,left);
      calendarLog({name:r.name,action:`${CALENDAR_KINDS[r.kind].label.toLowerCase()}: remove (project deleted)`,ok:!res.error,message:res.error || "Event removed."});
    }
  }finally{
    CALENDAR_RUNNING=false;
    refreshCalendarViews();
  }
}

async function syncProjectCalendar(p, kind){
  const field=CALENDAR_KINDS[kind].field;
  const want=calendarWant(p,kind);
  const c=p[field] || normalizeCalendarState({});
  const body={projectId:p.id,kind,action:want.action};
  if(want.action==="upsert"){
    body.calendarId=want.calendarId;
    body.event=want.event;
    if(c.calendarId && c.calendarId!==want.calendarId) body.prevCalendarId=c.calendarId;
  }else{
    body.calendarId=c.calendarId || (kind==="estimate" ? mainCalendar() : calendarFor(p.assignedTechnician));
  }
  const res=await calendarRequest("/calendar/sync",body);

  // Saved on the project as it is now (it may have changed while waiting for the answer).
  const list=loadProjects();
  const cur=list.find(x=>x.id===p.id);
  if(!cur) return;
  let next;
  if(res.error){
    const attempts=c.attempts+1;
    next={...c,state:"error",want:want.hash,error:res.error,attempts,nextTry:calendarNextTry(attempts,res.retry),at:nowISO()};
  }else if(want.action==="remove"){
    next={...c,state:"removed",hash:want.hash,want:want.hash,eventId:"",calendarId:"",link:"",error:"",attempts:0,nextTry:0,at:nowISO()};
  }else{
    next={...c,state:"synced",hash:want.hash,want:want.hash,eventId:res.eventId || c.eventId,calendarId:res.calendarId || want.calendarId,
      link:res.link || c.link,error:"",attempts:0,nextTry:0,at:nowISO()};
  }
  cur[field]=next;
  writeStore(STORAGE_KEYS.crm,list);
  calendarLog({name:p.clientName || p.address || "",action:`${CALENDAR_KINDS[kind].label.toLowerCase()}: ${want.action==="remove" ? "remove" : (c.eventId ? "update" : "add")}`,ok:!res.error,
    message:res.error ? `${res.error} Next try ${formatCalendarTime(next.nextTry)}.` : (want.action==="remove" ? "Event removed." : "Event saved.")});
  // Changed while it was being sent: send the newer version too.
  if(calendarWant(cur,kind).hash!==want.hash) scanCalendarProjects();
}

/* ---------- Log (this browser) ---------- */

function calendarLog(entry){
  const list=readStore(CALENDAR_LOG_KEY,[]);
  const log=Array.isArray(list) ? list : [];
  log.unshift({at:nowISO(),...entry});
  writeStore(CALENDAR_LOG_KEY,log.slice(0,CALENDAR_LOG_MAX));
}

function calendarLogEntries(){
  const list=readStore(CALENDAR_LOG_KEY,[]);
  return Array.isArray(list) ? list : [];
}

/* ---------- Showing it ---------- */

function formatCalendarTime(ms){
  return new Date(ms).toLocaleTimeString([], {hour:"numeric",minute:"2-digit"});
}

function formatTime12(hhmm){
  const [h,m]=String(hhmm).split(":").map(Number);
  return `${(h%12)||12}:${String(m).padStart(2,"0")} ${h<12?"AM":"PM"}`;
}

function dateTimeText(date, time){
  return `${formatDate(date)}${time ? " at "+formatTime12(time) : " (all day)"}`;
}

function projectStartText(p){
  if(!p.scheduledDate) return "No start date";
  const end=p.scheduledEndDate && p.scheduledEndDate!==p.scheduledDate ? ` – ${formatDate(p.scheduledEndDate)}` : "";
  return dateTimeText(p.scheduledDate,p.scheduledTime)+end;
}

function estimateVisitText(p){
  return p.estimateVisitDate ? dateTimeText(p.estimateVisitDate,p.estimateVisitTime) : "No estimate visit date";
}

// Small mark on the board card.
function calendarBadgeHtml(p, kind="job"){
  const c=p[CALENDAR_KINDS[kind].field];
  if(SETTINGS.calendarEnabled!=="on" || !c) return "";
  if(c.state==="synced") return `<span class="cal-badge cal-ok" title="In Google Calendar">✓ Calendar</span>`;
  if(c.state==="error") return `<span class="cal-badge cal-error" title="${escapeHtml(c.error)}">⚠ Calendar</span>`;
  if(c.state==="pending") return `<span class="cal-badge cal-wait" title="Waiting to sync">⏳ Calendar</span>`;
  return "";
}

function calendarKindStatusHtml(p, kind){
  const c=p[CALENDAR_KINDS[kind].field];
  const label=CALENDAR_KINDS[kind].label;
  const when=kind==="estimate" ? estimateVisitText(p) : projectStartText(p);
  const head=`<div><b>${label}:</b> ${escapeHtml(when)}</div>`;
  if(SETTINGS.calendarEnabled!=="on") return head;
  const link=c && c.link && c.state==="synced" ? ` <a href="${escapeHtml(c.link)}" target="_blank" rel="noopener">Open in Google Calendar</a>` : "";
  const retry=`<button type="button" class="btn btn-light btn-sm" data-pm-action="calendar-sync">Sync now</button>`;
  const needs=kind==="estimate" ? "an estimate visit date and stage Prospects or later" : "a scheduled date and stage Client / Job or later";
  let line;
  if(!c){
    line=calendarWant(p,kind).action==="upsert"
      ? `<span class="muted">Not in the calendar yet: it is added when the project is saved.</span>`
      : `<span class="muted">Not in the calendar (needs ${needs}).</span>`;
  }else if(c.state==="synced"){
    line=`<span class="cal-badge cal-ok">✓ In Google Calendar</span> <span class="small">synced ${escapeHtml(formatDateTime(c.at))}</span>${link}`;
  }else if(c.state==="removed"){
    line=`<span class="muted">Not in the calendar${p.canceled ? " (project canceled)" : ""}. The event was removed ${escapeHtml(formatDateTime(c.at))}.</span>`;
  }else if(c.state==="error"){
    line=`<span class="cal-badge cal-error">⚠ Not synced</span> ${escapeHtml(c.error)} <span class="small">Tried ${c.attempts} time${c.attempts===1?"":"s"}; next try ${escapeHtml(formatCalendarTime(c.nextTry))}.</span> ${retry}`;
  }else{
    line=`<span class="cal-badge cal-wait">⏳ Waiting to sync…</span>${calendarSyncOn() ? "" : ` <span class="small">Sign in to the CRM to sync.</span>`} ${retry}`;
  }
  return head+`<div>${line}</div>`;
}

// The Calendar box in the project window: the estimate visit and the job.
function calendarStatusHtml(p){
  return calendarKindStatusHtml(p,"estimate")+calendarKindStatusHtml(p,"job")
    +(SETTINGS.calendarEnabled==="on" ? "" : `<div class="muted">Google Calendar sync is off (Settings).</div>`);
}

function refreshCalendarViews(){
  const box=$("pmCalendar");
  if(box && EDITING_PROJECT_ID && $("projectModal").classList.contains("open")){
    const p=getProject(EDITING_PROJECT_ID);
    if(p) box.innerHTML=calendarStatusHtml(p);
  }
  if(!$("page-crm").hidden) renderCrmBoard();
  if(!$("page-settings").hidden) renderCalendarLog();
}

function syncProjectCalendarNow(id){
  const list=loadProjects();
  const p=list.find(x=>x.id===id);
  if(!p) return;
  if(!calendarSyncOn()){ alert("Sign in to the CRM (shared data) to sync with Google Calendar."); return; }
  for(const {field} of Object.values(CALENDAR_KINDS)) if(p[field]) p[field].nextTry=0;
  writeStore(STORAGE_KEYS.crm,list);
  scanCalendarProjects();
  runCalendarSync(true);
}

/* ---------- Estimate visit (asked when a lead moves to Prospects) ---------- */

let VISIT_PROJECT_ID = null;

function openEstimateVisitModal(id){
  const p=getProject(id);
  if(!p) return;
  VISIT_PROJECT_ID=id;
  $("visitClient").textContent=p.clientName || p.address || "this client";
  $("visitDate").value=p.estimateVisitDate || localISODate();
  $("visitTime").value=p.estimateVisitTime || "";
  openModal("estimateVisitModal");
  $("visitDate").focus();
}

function saveEstimateVisit(){
  const date=$("visitDate").value;
  if(!date){ alert("Choose the date of the estimate visit, or press Later."); $("visitDate").focus(); return; }
  updateProject(VISIT_PROJECT_ID,{estimateVisitDate:date,estimateVisitTime:$("visitTime").value});
  closeModal("estimateVisitModal");
  renderCrmBoard();
  showToast(SETTINGS.calendarEnabled==="on" ? "Estimate visit saved. It goes into the calendar." : "Estimate visit saved.");
}

/* ---------- Settings ---------- */

async function loadCalendarList(){
  if(!canSendFromCrm()){ CALENDAR_LIST=null; return {error:"Sign in to the CRM (shared data) to choose calendars."}; }
  const res=await calendarRequest("/calendar/calendars",{});
  if(res.error) return res;
  CALENDAR_LIST=Array.isArray(res.calendars) ? res.calendars : [];
  return {ok:true};
}

function renderCalendarSettings(message){
  $("setCalEnabled").checked=SETTINGS.calendarEnabled==="on";
  $("setCalCancel").value=SETTINGS.calendarOnCancel==="mark" ? "mark" : "delete";
  const team=calendarTeam();
  // The calendars from Google, else the ones saved before.
  const cals=CALENDAR_LIST || team.map(c=>({id:c.id,name:c.name}));
  const main=mainCalendar();
  const opts=[{id:"primary",name:"Main calendar of the company account"},...cals.filter(c=>c.id!=="primary" && !c.primary)];
  if(!opts.some(c=>c.id===main)) opts.push({id:main,name:main});
  $("setCalMain").innerHTML=opts.map(c=>`<option value="${escapeHtml(c.id)}" ${c.id===main?"selected":""}>${escapeHtml(c.name)}</option>`).join("");
  $("calTeamBody").innerHTML=cals.filter(c=>!c.primary).map(c=>{
    const saved=team.find(t=>t.id===c.id);
    return `<tr data-cal="${escapeHtml(c.id)}" data-name="${escapeHtml(c.name)}">
      <td>${escapeHtml(c.name)}</td>
      <td><input type="text" class="cal-names" value="${escapeHtml(saved ? saved.names : "")}" placeholder="other spellings, e.g. Yurii" aria-label="Names for ${escapeHtml(c.name)}"></td>
    </tr>`;
  }).join("") || `<tr><td colspan="2" class="muted">No team calendars loaded.</td></tr>`;
  $("calStatus").textContent=message || "";
  renderCalendarLog();
}

async function refreshCalendarSettings(){
  $("calStatus").textContent="Loading calendars…";
  const res=await loadCalendarList();
  renderCalendarSettings(res.error ? res.error : `${CALENDAR_LIST.length} calendar${CALENDAR_LIST.length===1?"":"s"} found.`);
}

// Read from the form when Settings are saved.
function readCalendarSettings(){
  const wasOn=SETTINGS.calendarEnabled==="on";
  SETTINGS.calendarEnabled=$("setCalEnabled").checked ? "on" : "";
  if(SETTINGS.calendarEnabled==="on" && !wasOn) SETTINGS.calendarSince=nowISO();
  SETTINGS.calendarOnCancel=$("setCalCancel").value==="mark" ? "mark" : "delete";
  SETTINGS.calendarMain=$("setCalMain").value || "primary";
  const rows=[...$("calTeamBody").querySelectorAll("tr[data-cal]")];
  if(rows.length){
    SETTINGS.calendarTeam=JSON.stringify(rows.map(tr=>({id:tr.dataset.cal,name:tr.dataset.name,names:tr.querySelector(".cal-names").value.trim()})));
  }
}

function renderCalendarLog(){
  const box=$("calLog");
  if(!box) return;
  const log=calendarLogEntries().slice(0,20);
  const waiting=loadProjects().reduce((n,p)=>n+Object.values(CALENDAR_KINDS).filter(({field})=>p[field] && (p[field].state==="pending" || p[field].state==="error")).length,0)+calendarRemovals().length;
  $("calWaiting").textContent=waiting ? `${waiting} waiting to sync.` : "Nothing waiting.";
  box.innerHTML=log.length ? log.map(e=>`<li class="${e.ok?"":"cal-log-error"}"><span class="small">${escapeHtml(formatDateTime(e.at))}</span> ${e.ok?"✓":"⚠"} ${escapeHtml(e.name || "Project")}: ${escapeHtml(e.action)}. ${escapeHtml(e.message)}</li>`).join("")
    : `<li class="muted">No calendar syncs on this device yet.</li>`;
}

function wireCalendarEvents(){
  $("btnCalRefresh").addEventListener("click",refreshCalendarSettings);
  $("btnCalRetry").addEventListener("click",()=>{
    if(!calendarSyncOn()){ alert("Turn on the calendar sync and sign in to the CRM first."); return; }
    scanCalendarProjects();
    runCalendarSync(true);
  });
  $("estimateVisitForm").addEventListener("submit",e=>{ e.preventDefault(); saveEstimateVisit(); });
  // Retries: every minute while the CRM is open, and as soon as the device is back online.
  setInterval(()=>{ if(calendarSyncOn()) runCalendarSync(); },60000);
  window.addEventListener("online",()=>runCalendarSync(true));
  setTimeout(()=>{ if(calendarSyncOn() && scanCalendarProjects()) runCalendarSync(); },3000);
}
