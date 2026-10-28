"use strict";

/* CRM projects in the company Google Calendar, through the CRM mail service (worker/src/calendar.js).
   The CRM is the source of truth: after a project changes here, its event is added, updated or
   removed. Each project has one fixed event id on the service, so a repeated or retried sync
   never makes a second event. A sync that fails stays on the project and is tried again by
   itself, waiting longer each time; this browser keeps a log of every attempt.

   Which projects: stage Client / Job or later, with a scheduled date, not in a folder (old CRM).
   Projects that were already in the CRM before the sync was turned on are added only once they
   are changed (they may already be in the calendar by hand), and only if not in the past. */

const CALENDAR_STAGES = ["job","started","completed","followup"];
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

// The team member's own calendar when the assigned technician names them, else the main calendar.
function calendarFor(technician){
  const text=calendarWords(technician);
  if(text.trim()){
    for(const c of calendarTeam()){
      const names=[c.name,...c.names.split(/[,;]/)].map(calendarWords).filter(n=>n.trim());
      if(names.some(n=>text.includes(n))) return c.id;
    }
  }
  return SETTINGS.calendarMain || "primary";
}

/* ---------- What the calendar should show ---------- */

function projectServiceType(p){
  const est=p.estimateId ? getEstimate(p.estimateId) : null;
  if(!est) return "";
  return Object.entries(est.categoryTotals || {}).filter(([,v])=>amount(v)>0).map(([k])=>categoryLabel(k,k)).join(", ");
}

function calendarEvent(p){
  return {
    title:p.clientName || p.address || "CRM project",
    service:projectServiceType(p),
    location:p.address,
    technician:p.assignedTechnician,
    notes:p.notes,
    date:p.scheduledDate,
    time:p.scheduledTime,
    endDate:p.scheduledEndDate,
    canceled:!!p.canceled
  };
}

// {action:"upsert", calendarId, event, hash} or {action:"remove", hash}.
function calendarWant(p){
  const remove={action:"remove",hash:"remove"};
  if(p.folder || !p.scheduledDate || !CALENDAR_STAGES.includes(p.stage)) return remove;
  if(p.canceled && SETTINGS.calendarOnCancel!=="mark") return remove;
  const calendarId=calendarFor(p.assignedTechnician);
  const event=calendarEvent(p);
  return {action:"upsert",calendarId,event,hash:calendarHash({calendarId,event})};
}

// A project the calendar has never had: added only if changed since the sync was turned on
// and not over yet.
function calendarIsNew(p, want){
  return want.action==="upsert" && !!SETTINGS.calendarSince && p.updatedAt>=SETTINGS.calendarSince
    && (p.scheduledEndDate || p.scheduledDate)>=localISODate();
}

/* ---------- Finding the projects to sync ---------- */

function scheduleCalendarScan(){
  if(SETTINGS.calendarEnabled!=="on") return;
  clearTimeout(CALENDAR_SCAN_TIMER);
  CALENDAR_SCAN_TIMER=setTimeout(()=>{ if(scanCalendarProjects()) runCalendarSync(); },0);
}

// Marks projects whose event must change as waiting. Returns how many are waiting or failed.
function scanCalendarProjects(){
  const list=loadProjects();
  let changed=false, waiting=0;
  for(const p of list){
    const want=calendarWant(p);
    const c=p.calendar;
    if(!c){
      if(!calendarIsNew(p,want)) continue;
    }else if(c.hash===want.hash && (c.state==="synced" || c.state==="removed")){
      continue;
    }else if((c.state==="pending" || c.state==="error") && c.want===want.hash){
      waiting++;
      continue;
    }
    p.calendar={...normalizeCalendarState(c || {}),state:"pending",want:want.hash,error:"",attempts:0,nextTry:0};
    changed=true;
    waiting++;
  }
  if(changed) writeStore(STORAGE_KEYS.crm,list); // status only: updatedAt stays
  return waiting+calendarRemovals().length;
}

function calendarRemovals(){
  const list=readStore(CALENDAR_REMOVALS_KEY,[]);
  return Array.isArray(list) ? list.filter(r=>r && r.projectId) : [];
}

// A deleted project's event is removed too (whatever the cancel setting says).
function queueCalendarRemoval(p){
  if(!p || !p.calendar || p.calendar.state==="removed") return;
  const list=calendarRemovals().filter(r=>r.projectId!==p.id);
  list.push({projectId:p.id,name:p.clientName || p.address || "",calendarId:p.calendar.calendarId || calendarFor(p.assignedTechnician),attempts:0,nextTry:0});
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
      const p=loadProjects().find(x=>!tried.has(x.id) && calendarDue(x.calendar,force));
      if(!p) break;
      tried.add(p.id);
      await syncProjectCalendar(p);
    }
    for(const r of calendarRemovals()){
      if(!force && r.nextTry>Date.now()) continue;
      const res=await calendarRequest("/calendar/sync",{projectId:r.projectId,action:"remove",calendarId:r.calendarId});
      const left=calendarRemovals().filter(x=>x.projectId!==r.projectId);
      if(res.error){
        const attempts=r.attempts+1;
        left.push({...r,attempts,nextTry:calendarNextTry(attempts,res.retry)});
      }
      writeStore(CALENDAR_REMOVALS_KEY,left);
      calendarLog({name:r.name,action:"remove (project deleted)",ok:!res.error,message:res.error || "Event removed."});
    }
  }finally{
    CALENDAR_RUNNING=false;
    refreshCalendarViews();
  }
}

async function syncProjectCalendar(p){
  const want=calendarWant(p);
  const c=p.calendar || normalizeCalendarState({});
  const body={projectId:p.id,action:want.action};
  if(want.action==="upsert"){
    body.calendarId=want.calendarId;
    body.event=want.event;
    if(c.calendarId && c.calendarId!==want.calendarId) body.prevCalendarId=c.calendarId;
  }else{
    body.calendarId=c.calendarId || calendarFor(p.assignedTechnician);
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
  cur.calendar=next;
  writeStore(STORAGE_KEYS.crm,list);
  calendarLog({name:p.clientName || p.address || "",action:want.action==="remove" ? "remove" : (c.eventId ? "update" : "add"),ok:!res.error,
    message:res.error ? `${res.error} Next try ${formatCalendarTime(next.nextTry)}.` : (want.action==="remove" ? "Event removed." : "Event saved.")});
  // Changed while it was being sent: send the newer version too.
  if(calendarWant(cur).hash!==want.hash) scanCalendarProjects();
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

function projectStartText(p){
  if(!p.scheduledDate) return "No start date";
  const end=p.scheduledEndDate && p.scheduledEndDate!==p.scheduledDate ? ` – ${formatDate(p.scheduledEndDate)}` : "";
  return `${formatDate(p.scheduledDate)}${p.scheduledTime ? " at "+formatTime12(p.scheduledTime) : " (all day)"}${end}`;
}

// Small mark on the board card.
function calendarBadgeHtml(p){
  const c=p.calendar;
  if(SETTINGS.calendarEnabled!=="on" || !c) return "";
  if(c.state==="synced") return `<span class="cal-badge cal-ok" title="In Google Calendar">✓ Calendar</span>`;
  if(c.state==="error") return `<span class="cal-badge cal-error" title="${escapeHtml(c.error)}">⚠ Calendar</span>`;
  if(c.state==="pending") return `<span class="cal-badge cal-wait" title="Waiting to sync">⏳ Calendar</span>`;
  return "";
}

// The Calendar box in the project window.
function calendarStatusHtml(p){
  const start=`<div><b>Start:</b> ${escapeHtml(projectStartText(p))}</div>`;
  if(SETTINGS.calendarEnabled!=="on") return start+`<div class="muted">Google Calendar sync is off (Settings).</div>`;
  const c=p.calendar;
  const link=c && c.link && c.state==="synced" ? ` <a href="${escapeHtml(c.link)}" target="_blank" rel="noopener">Open in Google Calendar</a>` : "";
  const retry=`<button type="button" class="btn btn-light btn-sm" data-pm-action="calendar-sync">Sync now</button>`;
  let line;
  if(!c){
    line=calendarWant(p).action==="upsert"
      ? `<span class="muted">Not in the calendar yet: it is added when the project is saved.</span>`
      : `<span class="muted">Not in the calendar (needs a scheduled date and stage Client / Job or later).</span>`;
  }else if(c.state==="synced"){
    line=`<span class="cal-badge cal-ok">✓ In Google Calendar</span> <span class="small">synced ${escapeHtml(formatDateTime(c.at))}</span>${link}`;
  }else if(c.state==="removed"){
    line=`<span class="muted">Not in the calendar${p.canceled ? " (project canceled)" : ""}. The event was removed ${escapeHtml(formatDateTime(c.at))}.</span>`;
  }else if(c.state==="error"){
    line=`<span class="cal-badge cal-error">⚠ Not synced</span> ${escapeHtml(c.error)} <span class="small">Tried ${c.attempts} time${c.attempts===1?"":"s"}; next try ${escapeHtml(formatCalendarTime(c.nextTry))}.</span> ${retry}`;
  }else{
    line=`<span class="cal-badge cal-wait">⏳ Waiting to sync…</span>${calendarSyncOn() ? "" : ` <span class="small">Sign in to the CRM to sync.</span>`} ${retry}`;
  }
  return start+`<div>${line}</div>`;
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
  if(p.calendar){ p.calendar.nextTry=0; writeStore(STORAGE_KEYS.crm,list); }
  scanCalendarProjects();
  runCalendarSync(true);
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
  const main=SETTINGS.calendarMain || "primary";
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
  const waiting=loadProjects().filter(p=>p.calendar && (p.calendar.state==="pending" || p.calendar.state==="error")).length+calendarRemovals().length;
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
  // Retries: every minute while the CRM is open, and as soon as the device is back online.
  setInterval(()=>{ if(calendarSyncOn()) runCalendarSync(); },60000);
  window.addEventListener("online",()=>runCalendarSync(true));
  setTimeout(()=>{ if(calendarSyncOn() && scanCalendarProjects()) runCalendarSync(); },3000);
}
