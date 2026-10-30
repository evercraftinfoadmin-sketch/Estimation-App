"use strict";

/* Calendar page: the company Google Calendar (all team calendars) inside the CRM, read through the
   CRM mail service (/calendar/events). A month grid with the events of the chosen calendars; a
   click on a day lists its events, a click on an event opens its CRM project (events the CRM
   made) or the event in Google Calendar. Read only: jobs are changed in the CRM projects.
   Days and times are Pacific time (the company's), whatever the device's time zone is. */

const CALVIEW_HIDDEN_KEY = storageKey("calendar_view_hidden");
const CALVIEW_COLORS = ["#4F57FF","#0b8043","#d50000","#f4511e","#8e24aa","#039be5","#e67c73","#33b679","#f6bf26","#616161"];
const CALVIEW = {month:"", day:"", events:[], errors:[], loading:false, key:"", seq:0}; // month: "YYYY-MM"

function calViewHidden(){
  try{ const v=JSON.parse(localStorage.getItem(CALVIEW_HIDDEN_KEY) || "[]"); return new Set(Array.isArray(v) ? v : []); }catch(e){ return new Set(); }
}

function setCalViewHidden(set){
  try{ localStorage.setItem(CALVIEW_HIDDEN_KEY,JSON.stringify([...set])); }catch(e){}
}

function calViewColor(cal, i){
  return cal.color || CALVIEW_COLORS[i % CALVIEW_COLORS.length];
}

// The 6 weeks shown for a month ("YYYY-MM"): dates from the Sunday before the 1st.
function calViewRange(month){
  const first=month+"-01";
  const start=addDays(first,-weekdayOf(first));
  return {start, end:addDays(start,42)};
}

function calViewMonthLabel(month){
  return new Date(month+"-01T12:00:00Z").toLocaleDateString("en-US",{month:"long",year:"numeric",timeZone:"UTC"});
}

function calViewShiftMonth(month, n){
  const [y,m]=month.split("-").map(Number);
  const t=new Date(Date.UTC(y,m-1+n,1));
  return t.toISOString().slice(0,7);
}

// The local days (YYYY-MM-DD) an event is on.
function calViewEventDays(e){
  let first, last;
  if(e.allDay){
    first=e.start.slice(0,10);
    last=addDays((e.end || e.start).slice(0,10),-1); // Google's all-day end is the day after
  }else{
    const s=new Date(e.start), en=new Date(e.end || e.start);
    first=localISODate(s);
    // Ending exactly at midnight does not take the next day.
    const endDay=new Date(en.getTime()-(en>s ? 1 : 0));
    last=localISODate(endDay);
  }
  if(last<first) last=first;
  const days=[];
  for(let d=first; d<=last && days.length<62; d=addDays(d,1)) days.push(d);
  return days;
}

function calViewTime(e){
  if(e.allDay) return "All day";
  return formatTimeOfDay(e.start);
}

function calViewCalendars(){
  return (CALENDAR_LIST || []).map((c,i)=>({...c,color:calViewColor(c,i)}));
}

async function renderCalendarPage(){
  if(!CALVIEW.month){ CALVIEW.day=localISODate(); CALVIEW.month=CALVIEW.day.slice(0,7); }
  $("calViewMonth").textContent=calViewMonthLabel(CALVIEW.month);
  if(!canSendFromCrm()){
    $("calViewLegend").innerHTML="";
    $("calViewGrid").innerHTML="";
    $("calViewDay").innerHTML="";
    $("calViewStatus").textContent="Sign in to the CRM (shared data) to see the company calendar.";
    return;
  }
  if(!CALENDAR_LIST){
    $("calViewStatus").textContent="Loading calendars…";
    const res=await loadCalendarList();
    if(res.error){ $("calViewStatus").textContent=res.error; return; }
  }
  renderCalViewLegend();
  await loadCalViewEvents();
}

function renderCalViewLegend(){
  const hidden=calViewHidden();
  $("calViewLegend").innerHTML=calViewCalendars().map(c=>`
    <label class="calv-cal" style="--cal:${escapeHtml(c.color)}">
      <input type="checkbox" data-cal="${escapeHtml(c.id)}" ${hidden.has(c.id)?"":"checked"}>
      <span class="calv-dot"></span><span>${escapeHtml(c.primary ? "Main calendar" : c.name)}</span>
    </label>`).join("");
}

async function loadCalViewEvents(force=false){
  const hidden=calViewHidden();
  const cals=calViewCalendars().filter(c=>!hidden.has(c.id));
  const {start,end}=calViewRange(CALVIEW.month);
  const key=cals.map(c=>c.id).join(",")+"|"+start;
  if(!cals.length){
    CALVIEW.events=[]; CALVIEW.errors=[]; CALVIEW.key=key;
    $("calViewStatus").textContent="No calendar chosen.";
    renderCalViewGrid();
    return;
  }
  if(!force && key===CALVIEW.key){ renderCalViewGrid(); return; }
  const seq=++CALVIEW.seq;
  $("calViewStatus").textContent="Loading events…";
  renderCalViewGrid();
  // A day more on each side: Pacific midnight is 7-8 hours after UTC midnight. Events are then
  // put on their Pacific days; the ones outside the grid are simply not shown.
  const res=await calendarRequest("/calendar/events",{calendarIds:cals.map(c=>c.id),timeMin:addDays(start,-1)+"T00:00:00Z",timeMax:addDays(end,1)+"T00:00:00Z"});
  if(seq!==CALVIEW.seq) return; // a newer month or choice was asked meanwhile
  if(res.error){ $("calViewStatus").textContent=res.error; return; }
  const byId=new Map(cals.map(c=>[c.id,c]));
  CALVIEW.events=[];
  CALVIEW.errors=[];
  for(const r of res.calendars || []){
    const cal=byId.get(r.calendarId);
    if(!cal) continue;
    if(r.error) CALVIEW.errors.push(`${cal.name}: ${r.error}`);
    for(const e of r.events || []) CALVIEW.events.push({...e,color:cal.color,calendarName:cal.primary ? "Main calendar" : cal.name,days:calViewEventDays(e)});
  }
  CALVIEW.events.sort((a,b)=>(b.allDay-a.allDay) || (a.allDay ? a.start.localeCompare(b.start) : Date.parse(a.start)-Date.parse(b.start)));
  CALVIEW.key=key;
  const n=CALVIEW.events.length;
  $("calViewStatus").textContent=(CALVIEW.errors.length ? "⚠ "+CALVIEW.errors.join(" · ")+" · " : "")+`${n} event${n===1?"":"s"} · updated ${formatTimeOfDay(new Date(),true)} · times in Pacific time`;
  renderCalViewGrid();
}

function calViewEventsOn(day){
  return CALVIEW.events.filter(e=>e.days.includes(day));
}

function renderCalViewGrid(){
  const {start}=calViewRange(CALVIEW.month);
  const today=localISODate();
  const head=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d=>`<div class="calv-head">${d}</div>`).join("");
  let cells="";
  for(let i=0;i<42;i++){
    const iso=addDays(start,i);
    const list=calViewEventsOn(iso);
    const chips=list.slice(0,3).map(e=>`<button type="button" class="calv-chip" style="--cal:${escapeHtml(e.color)}" data-event="${escapeHtml(e.calendarId+"|"+e.id)}" title="${escapeHtml(calViewTime(e)+" · "+e.summary)}">
        ${e.allDay?"":`<span class="calv-time">${escapeHtml(calViewTime(e))}</span> `}${escapeHtml(e.summary)}</button>`).join("");
    cells+=`<div class="calv-cell ${iso.slice(0,7)!==CALVIEW.month?"calv-out":""} ${iso===today?"calv-today":""} ${iso===CALVIEW.day?"calv-sel":""}" data-day="${iso}">
      <div class="calv-num">${Number(iso.slice(8))}</div>
      <div class="calv-chips">${chips}${list.length>3?`<div class="calv-more">+${list.length-3} more</div>`:""}</div>
      <div class="calv-dots">${list.slice(0,4).map(e=>`<span class="calv-dot" style="--cal:${escapeHtml(e.color)}"></span>`).join("")}</div>
    </div>`;
  }
  $("calViewGrid").innerHTML=head+cells;
  renderCalViewDay();
}

function renderCalViewDay(){
  const day=CALVIEW.day;
  const list=day ? calViewEventsOn(day) : [];
  $("calViewDay").innerHTML=`<h2>${escapeHtml(day ? formatDate(day) : "")}</h2>`+(list.length ? list.map(e=>{
    const project=e.crmProject ? getProject(e.crmProject) : null;
    return `<div class="calv-item" style="--cal:${escapeHtml(e.color)}">
      <div class="calv-item-time">${escapeHtml(calViewTime(e))}</div>
      <div class="calv-item-body">
        <div class="calv-item-title">${escapeHtml(e.summary)}</div>
        ${e.location?`<div class="small">📍 <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(e.location)}" target="_blank" rel="noopener">${escapeHtml(e.location)}</a></div>`:""}
        <div class="small">${escapeHtml(e.calendarName)}${e.crmKind?` · from the CRM (${e.crmKind==="estimate"?"estimate visit":"job"})`:""}</div>
        <div class="btn-row">
          ${project?`<button type="button" class="btn btn-light btn-sm" data-calv-project="${escapeHtml(project.id)}">Open CRM project</button>`:""}
          ${e.link?`<a class="btn btn-light btn-sm" href="${escapeHtml(e.link)}" target="_blank" rel="noopener">Open in Google Calendar</a>`:""}
        </div>
      </div>
    </div>`;
  }).join("") : `<p class="muted">No events on this day.</p>`);
}

function calViewMove(months){
  CALVIEW.month=calViewShiftMonth(CALVIEW.month,months);
  CALVIEW.day=CALVIEW.month+"-01";
  $("calViewMonth").textContent=calViewMonthLabel(CALVIEW.month);
  loadCalViewEvents();
}

function wireCalendarPage(){
  $("calViewPrev").addEventListener("click",()=>calViewMove(-1));
  $("calViewNext").addEventListener("click",()=>calViewMove(1));
  $("calViewToday").addEventListener("click",()=>{
    CALVIEW.day=localISODate();
    CALVIEW.month=CALVIEW.day.slice(0,7);
    renderCalendarPage();
  });
  $("calViewRefresh").addEventListener("click",()=>{ CALENDAR_LIST=null; CALVIEW.key=""; renderCalendarPage(); });
  $("calViewLegend").addEventListener("change",e=>{
    const id=e.target.dataset.cal;
    if(!id) return;
    const hidden=calViewHidden();
    if(e.target.checked) hidden.delete(id); else hidden.add(id);
    setCalViewHidden(hidden);
    loadCalViewEvents();
  });
  $("calViewGrid").addEventListener("click",e=>{
    const chip=e.target.closest("[data-event]");
    const cell=e.target.closest("[data-day]");
    if(cell){ CALVIEW.day=cell.dataset.day; document.querySelectorAll("#calViewGrid .calv-sel").forEach(c=>c.classList.remove("calv-sel")); cell.classList.add("calv-sel"); renderCalViewDay(); }
    if(chip){
      const ev=CALVIEW.events.find(x=>x.calendarId+"|"+x.id===chip.dataset.event);
      if(ev && ev.crmProject && getProject(ev.crmProject)) openProjectModal(ev.crmProject);
      else if(cell) $("calViewDay").scrollIntoView({behavior:"smooth",block:"nearest"});
    }
  });
  $("calViewDay").addEventListener("click",e=>{
    const btn=e.target.closest("[data-calv-project]");
    if(btn) openProjectModal(btn.dataset.calvProject);
  });
  // Saving a project changes its event: show the new calendar shortly after.
  $("projectForm").addEventListener("submit",()=>{ if(!$("page-calendar").hidden) setTimeout(()=>loadCalViewEvents(true),4000); });
}
