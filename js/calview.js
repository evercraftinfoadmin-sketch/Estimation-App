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

const calViewChip=e=>`<button type="button" class="calv-chip" style="--cal:${escapeHtml(e.color)}" data-event="${escapeHtml(e.calendarId+"|"+e.id)}" title="${escapeHtml(calViewTime(e)+" · "+e.summary+(e.location?" · "+e.location:""))}">
        ${e.allDay?"":`<span class="calv-time">${escapeHtml(calViewTime(e))}</span> `}${escapeHtml(e.summary)}</button>`;

// Column widths follow the workload: a weekday with more events on its busiest day gets a wider
// column (never narrower than the others), so busy days stay readable. Rows grow by themselves.
function calViewColumnWidths(start){
  const most=[0,0,0,0,0,0,0];
  for(let i=0;i<42;i++) most[i%7]=Math.max(most[i%7],calViewEventsOn(addDays(start,i)).length);
  return most.map(n=>`minmax(0,${(1+Math.min(n,12)*0.15).toFixed(2)}fr)`).join(" ");
}

// The month: every event of every day is shown (no "+ more"); a day with many events makes its
// week's row taller and its column wider. Redrawn whenever the events are loaded again.
function renderCalViewGrid(){
  const {start}=calViewRange(CALVIEW.month);
  const today=localISODate();
  const head=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d=>`<div class="calv-head">${d}</div>`).join("");
  let cells="";
  for(let i=0;i<42;i++){
    const iso=addDays(start,i);
    const list=calViewEventsOn(iso);
    cells+=`<div class="calv-cell ${iso.slice(0,7)!==CALVIEW.month?"calv-out":""} ${iso===today?"calv-today":""} ${iso===CALVIEW.day?"calv-sel":""} ${list.length?"calv-busy":""}" data-day="${iso}">
      <div class="calv-num">${Number(iso.slice(8))}${list.length>1?` <span class="calv-count">${list.length}</span>`:""}</div>
      <div class="calv-chips">${list.map(calViewChip).join("")}</div>
      <div class="calv-dots">${list.map(e=>`<span class="calv-dot" style="--cal:${escapeHtml(e.color)}"></span>`).join("")}</div>
    </div>`;
  }
  $("calViewGrid").style.gridTemplateColumns=calViewColumnWidths(start);
  $("calViewGrid").innerHTML=head+cells;
  renderCalViewPhone();
  renderCalViewDay();
}

/* ---------- Phones: 7 days from today, big cards, week strip, person filter, "jobs only" ---------- */

const CALVIEW_PHONE_KEY = storageKey("calendar_phone_view");
const CALVIEW_PHONE = {start:"", person:"", jobsOnly:false};

(()=>{ try{ const v=JSON.parse(localStorage.getItem(CALVIEW_PHONE_KEY) || "{}"); CALVIEW_PHONE.person=String(v.person || ""); CALVIEW_PHONE.jobsOnly=!!v.jobsOnly; }catch(e){} })();

function saveCalViewPhone(){
  try{ localStorage.setItem(CALVIEW_PHONE_KEY,JSON.stringify({person:CALVIEW_PHONE.person,jobsOnly:CALVIEW_PHONE.jobsOnly})); }catch(e){}
}

// A job or visit: made by the CRM, or with a street address (a number in it). Personal items
// (computer reminders, flights, birthdays, calls) have neither.
const calViewIsJob=e=>!!e.crmKind || /\d/.test(e.location || "");

function calViewPhoneEvents(day){
  return calViewEventsOn(day)
    .filter(e=>!CALVIEW_PHONE.person || e.calendarId===CALVIEW_PHONE.person)
    .filter(e=>!CALVIEW_PHONE.jobsOnly || calViewIsJob(e));
}

const calViewDayLabel=(d,opts)=>new Date(d+"T12:00:00Z").toLocaleDateString("en-US",{...opts,timeZone:"UTC"});

function calViewPhoneCard(e){
  const time=e.allDay ? "All day" : calViewTime(e);
  const [hm,ampm]=time.split(" ");
  const maps=e.location ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(e.location)}` : "";
  return `<div class="calv-pcard" style="--cal:${escapeHtml(e.color)}" data-event="${escapeHtml(e.calendarId+"|"+e.id)}">
    <div class="calv-ptime">${escapeHtml(hm)}${ampm?`<span>${escapeHtml(ampm)}</span>`:""}</div>
    <div class="calv-pbody">
      <div class="calv-ptitle">${escapeHtml(e.summary)}</div>
      <div class="calv-pmeta"><span class="calv-dot"></span> ${escapeHtml(e.calendarName)}${e.location?` · <a href="${escapeHtml(maps)}" target="_blank" rel="noopener" data-maps="1">📍 ${escapeHtml(e.location)}</a>`:""}</div>
    </div>
  </div>`;
}

function renderCalViewPhone(){
  const box=$("calViewPhone");
  if(!box) return;
  if(!CALVIEW_PHONE.start) CALVIEW_PHONE.start=localISODate();
  const today=localISODate();
  const days=[0,1,2,3,4,5,6].map(i=>addDays(CALVIEW_PHONE.start,i));
  const cals=calViewCalendars().filter(c=>!calViewHidden().has(c.id));
  if(CALVIEW_PHONE.person && !cals.some(c=>c.id===CALVIEW_PHONE.person)) CALVIEW_PHONE.person="";
  const people=`<div class="calv-people" role="group" aria-label="Show one person">
      <button type="button" class="calv-person ${CALVIEW_PHONE.person?"":"on"}" data-person="">All</button>
      ${cals.map(c=>`<button type="button" class="calv-person ${CALVIEW_PHONE.person===c.id?"on":""}" data-person="${escapeHtml(c.id)}" style="--cal:${escapeHtml(c.color)}"><span class="calv-dot"></span>${escapeHtml(c.primary ? "Main" : c.name)}</button>`).join("")}
    </div>`;
  const strip=`<div class="calv-strip">${days.map(d=>{
      const n=calViewPhoneEvents(d).length;
      return `<button type="button" class="calv-sday ${d===today?"calv-stoday":""}" data-jump="${d}">
        <span class="calv-swd">${escapeHtml(calViewDayLabel(d,{weekday:"short"}))}</span>
        <span class="calv-snum">${Number(d.slice(8))}</span>
        <span class="calv-sn">${n||""}</span></button>`;
    }).join("")}</div>`;
  const nav=`<div class="calv-pnav">
      <button type="button" class="btn btn-light btn-sm" data-pmove="-7">‹ Earlier</button>
      <button type="button" class="btn btn-light btn-sm" data-pmove="0">Today</button>
      <button type="button" class="btn btn-light btn-sm" data-pmove="7">Next week ›</button>
    </div>
    <label class="check calv-jobs"><input type="checkbox" data-jobs ${CALVIEW_PHONE.jobsOnly?"checked":""}> <span>Jobs only (hide personal items)</span></label>`;
  const agenda=days.map(d=>{
    const list=calViewPhoneEvents(d);
    return `<div class="calv-pday ${d===today?"calv-today":""}" id="calv-pday-${d}" data-day="${d}">
      <div class="calv-phead">${escapeHtml(calViewDayLabel(d,{weekday:"long",month:"short",day:"numeric"}))}${d===today?` <span class="calv-ptoday">Today</span>`:""}${list.length?` <span class="calv-count">${list.length}</span>`:""}</div>
      ${list.length ? list.map(calViewPhoneCard).join("") : `<p class="muted calv-pnone">Nothing scheduled.</p>`}
    </div>`;
  }).join("");
  box.innerHTML=people+nav+strip+`<div class="calv-agenda">${agenda}</div>`;
}

// The 7 days shown start here; the month whose events are loaded follows them.
function calViewPhoneMove(days){
  CALVIEW_PHONE.start=days ? addDays(CALVIEW_PHONE.start || localISODate(),days) : localISODate();
  const month=CALVIEW_PHONE.start.slice(0,7);
  if(month!==CALVIEW.month){
    CALVIEW.month=month;
    CALVIEW.day=CALVIEW_PHONE.start;
    $("calViewMonth").textContent=calViewMonthLabel(CALVIEW.month);
    loadCalViewEvents();
  }else renderCalViewPhone();
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
  $("calViewPhone").addEventListener("click",e=>{
    const t=e.target;
    if(t.closest("[data-maps]")) return; // the address opens Maps
    const person=t.closest("[data-person]");
    if(person){ CALVIEW_PHONE.person=person.dataset.person; saveCalViewPhone(); renderCalViewPhone(); return; }
    const move=t.closest("[data-pmove]");
    if(move){ calViewPhoneMove(Number(move.dataset.pmove)); return; }
    const jump=t.closest("[data-jump]");
    if(jump){ const el=$("calv-pday-"+jump.dataset.jump); if(el) el.scrollIntoView({behavior:"smooth",block:"start"}); return; }
    const card=t.closest("[data-event]");
    if(!card) return;
    const ev=CALVIEW.events.find(x=>x.calendarId+"|"+x.id===card.dataset.event);
    if(ev && ev.crmProject && getProject(ev.crmProject)) openProjectModal(ev.crmProject);
    else if(ev && ev.link) window.open(ev.link,"_blank","noopener");
  });
  $("calViewPhone").addEventListener("change",e=>{
    if(!e.target.matches("[data-jobs]")) return;
    CALVIEW_PHONE.jobsOnly=e.target.checked;
    saveCalViewPhone();
    renderCalViewPhone();
  });
  $("calViewDay").addEventListener("click",e=>{
    const btn=e.target.closest("[data-calv-project]");
    if(btn) openProjectModal(btn.dataset.calvProject);
  });
  // Saving a project changes its event: show the new calendar shortly after.
  $("projectForm").addEventListener("submit",()=>{ if(!$("page-calendar").hidden) setTimeout(()=>loadCalViewEvents(true),4000); });
}
