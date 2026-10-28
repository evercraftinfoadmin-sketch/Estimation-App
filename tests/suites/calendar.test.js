// CRM projects → Google Calendar (js/calendar.js): what is sent and when, retries, cancel, delete,
// the status in the project window, Settings and the log. The calendar service is faked inside
// the page (no network); it keeps one event per project like the real one.
const { launch, FILE, OUT, TEST_APP_ID, SIGNED_OUT_SDK } = require('../helpers');
let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m);};
const MAIL='https://mail.test.invalid';
const CONFIG={ base44AppId:TEST_APP_ID, base44AppBaseUrl:'https://preview--ci-test.base44.invalid', base44ServerUrl:'https://preview--ci-test.base44.invalid', mailServiceUrl:MAIL };
const YURA='yura@group.calendar.google.com';

(async()=>{
  const b=await launch({config:CONFIG});
  const ctx=await b.newContext({viewport:{width:1360,height:1000}});
  await ctx.addInitScript(SIGNED_OUT_SDK);
  const p=await ctx.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
  const dialogs=[]; p.on('dialog',d=>{dialogs.push(d.message()); d.accept();});

  // fake calendar service: events by project id
  const svc={down:0, requests:[], events:new Map()};
  await p.exposeFunction('__mail',(path,method,headers,body)=>{
    const req={path,headers,body:body?JSON.parse(body):{}}; svc.requests.push(req);
    if(path==='/calendar/calendars') return {status:200,body:{calendars:[{id:'evercraft.pro@gmail.com',name:'evercraft.pro@gmail.com',primary:true},{id:YURA,name:'Yura'},{id:'oleg@group.calendar.google.com',name:'Oleg'}]}};
    if(path==='/calendar/sync'){
      if(svc.down){ svc.down--; return {status:502,body:{error:'Google Calendar is not available right now (503: Backend Error).',retry:true}}; }
      const b=req.body;
      const key=b.kind==='estimate' ? b.projectId+':estimate' : b.projectId; // job events keep the plain project id
      if(b.action==='remove'){ svc.events.delete(key); return {status:200,body:{ok:true,removed:true}}; }
      svc.events.set(key,{calendarId:b.calendarId,...b.event});
      return {status:200,body:{ok:true,eventId:'evc'+b.projectId.replace(/\W/g,''),calendarId:b.calendarId,link:'https://www.google.com/calendar/event?eid=x'+b.projectId}};
    }
    return {status:404,body:{}};
  });
  await p.addInitScript(MAIL=>{ const real=window.fetch; window.fetch=function(url,opts={}){ url=String(url); if(!url.startsWith(MAIL)) return real.apply(this,arguments);
    return window.__mail(url.slice(MAIL.length),opts.method||'GET',opts.headers||{},opts.body||'').then(r=>new Response(JSON.stringify(r.body),{status:r.status,headers:{'Content-Type':'application/json'}})); }; },MAIL);
  await p.goto(FILE);
  await p.waitForFunction(()=>typeof CLOUD!=='undefined' && CLOUD.state!=='syncing');
  const syncs=()=>svc.requests.filter(r=>r.path==='/calendar/sync');
  const settle=async()=>{ await p.waitForTimeout(150); await p.waitForFunction(()=>!CALENDAR_RUNNING); };
  const cal=id=>p.evaluate(id=>getProject(id).calendar,id);
  const future=(days)=>{ const d=new Date(); d.setDate(d.getDate()+days); return d.toISOString().slice(0,10); };
  const D1=future(10), D2=future(12), D3=future(20);

  // a project that was in the CRM before the sync was turned on (it may already be in the calendar by hand)
  const oldId=await p.evaluate(D1=>{ const r=newProjectRecord({clientName:'Old Job',address:'5 Old Rd',stage:'job',scheduledDate:D1,assignedTechnician:'Yura',updatedAt:'2026-01-01T00:00:00.000Z'});
    r.updatedAt='2026-01-01T00:00:00.000Z'; const l=loadProjects(); l.push(r); saveProjects(l); return r.id; },D1);

  // sync off: nothing is sent
  await settle();
  ok(syncs().length===0,'calendar sync off (the default): nothing is sent to Google');

  // signed in with CRM access; turn it on in Settings
  await p.evaluate(()=>{ CLOUD.role='admin'; localStorage.setItem(CLOUD_TOKEN_KEY,'tok-boss'); });
  await p.evaluate(()=>showPage('settings'));
  ok(await p.isVisible('#calendarCard') && !(await p.isChecked('#setCalEnabled')),'Settings has a Google Calendar section, off by default');
  await p.click('#btnCalRefresh');
  await p.waitForFunction(()=>$('calTeamBody').textContent.includes('Yura'));
  const calReq=svc.requests.find(r=>r.path==='/calendar/calendars');
  ok(calReq && calReq.headers.Authorization==='Bearer tok-boss' && calReq.body.appId===CONFIG.base44AppId,'the calendars are loaded from the service with this person\'s CRM sign-in');
  ok((await p.locator('#setCalMain option').allTextContents()).join('|')==='Main calendar of the company account|Yura|Oleg' && await p.locator('#calTeamBody tr').count()===2,'the team calendars are listed: choose the main calendar, add other spellings per person');
  await p.check('#setCalEnabled');
  await p.locator('#calTeamBody tr[data-cal="'+YURA+'"] .cal-names').fill('Yurii, Yuriy');
  await p.click('#calendarCard button[type=submit]');
  const st=await p.evaluate(()=>({on:SETTINGS.calendarEnabled,since:SETTINGS.calendarSince,team:JSON.parse(SETTINGS.calendarTeam)}));
  ok(st.on==='on' && st.since && st.team.find(t=>t.id===YURA).names==='Yurii, Yuriy','saving turns the sync on and keeps the team calendars');
  ok(await p.evaluate(()=>CLOUD_SETTINGS_EXTRA.includes('calendarEnabled') && CLOUD_SETTINGS_EXTRA.includes('calendarTeam')),'the calendar settings are shared with the team (cloud settings)');
  await settle();
  ok(syncs().length===0 && await cal(oldId)===null,'a project from before the sync was turned on is not added by itself (no duplicate of a job entered by hand)');

  // 1. a new project with a start date → one event
  await p.evaluate(()=>showPage('crm'));
  await p.click('#btnNewLead');
  await p.fill('#pmClientName','Margo Winnetka');
  await p.evaluate(()=>{ $('pmStage').value='job'; });
  await p.fill('#pmScheduledDate',D1); await p.fill('#pmScheduledTime','09:00'); await p.fill('#pmScheduledEnd',D2);
  await p.fill('#pmTechnician','Yurii + Kirill'); await p.fill('#pmNotes','Gate code 1234');
  await p.click('#projectForm button[type=submit]');
  await settle();
  const id=await p.evaluate(()=>loadProjects().find(x=>x.clientName==='Margo Winnetka').id);
  let s=syncs()[0]||{body:{event:{}},headers:{}};
  ok(syncs().length===1 && s.body.action==='upsert' && s.body.projectId===id && s.headers.Authorization==='Bearer tok-boss','a new project with a start date is sent to the calendar once, with the CRM sign-in');
  ok(s.body.kind==='job' && s.body.event.kind==='job' && s.body.event.name==='Margo Winnetka' && s.body.event.date===D1 && s.body.event.time==='09:00' && s.body.event.endDate===D2 && s.body.event.technician==='Yurii + Kirill' && s.body.event.notes==='Gate code 1234','it carries the name, start date and time, end date, team member and notes');
  ok(s.body.calendarId===YURA,'"Yurii" is one of the names next to Yura\'s calendar: the job goes into Yura\'s calendar');
  let c=await cal(id);
  ok(c.state==='synced' && c.eventId && c.calendarId===YURA && c.link.includes(id),'the event id, calendar and link are saved on the project');

  // the project window shows it
  await p.locator(`.kcard[data-id="${id}"] [data-action=open]`).click();
  let box=await p.innerText('#pmCalendar');
  ok(box.includes('Job:') && box.includes('at 9:00 AM') && box.includes('In Google Calendar') && await p.locator('#pmCalendar a[href*="calendar"]').count()===1,'the project window shows the start date and time, "In Google Calendar" and a link to the event');
  await p.locator('#projectModal .modal-box').screenshot({path:OUT+'/calendar-project.png'}).catch(()=>{});

  // 2. saving again with no change: nothing sent; a new date: the same event is updated
  await p.click('#projectForm button[type=submit]'); await settle();
  ok(syncs().length===1,'saving without a change to the job sends nothing (no repeated syncs)');
  await p.locator(`.kcard[data-id="${id}"] [data-action=open]`).click();
  await p.fill('#pmScheduledDate',D3); await p.fill('#pmScheduledEnd',''); await p.fill('#pmScheduledTime','');
  await p.click('#projectForm button[type=submit]'); await settle();
  s=syncs()[1]||{body:{event:{}}};
  ok(syncs().length===2 && s.body.projectId===id && s.body.event.date===D3 && s.body.event.time==='' && !s.body.prevCalendarId && svc.events.size===1,'a new date updates the same project event (the same project id, no second event); no time = all day');
  ok((await p.innerText(`.kcard[data-id="${id}"]`)).includes('(all day)') && await p.locator(`.kcard[data-id="${id}"] .cal-ok`).count()===1,'the board card shows the date and a "✓ Calendar" mark');

  // 3. another technician → their calendar (the service moves the event)
  await p.evaluate(id=>{ updateProject(id,{assignedTechnician:'Oleg'}); },id); await settle();
  s=syncs()[2]||{body:{}};
  ok(s.body.calendarId==='oleg@group.calendar.google.com' && s.body.prevCalendarId===YURA,'a new technician: the event goes to their calendar, the old calendar is named so it is moved');
  await p.evaluate(id=>{ updateProject(id,{assignedTechnician:'Nobody Known'}); },id); await settle();
  ok((syncs()[3]||{body:{}}).body.calendarId==='primary','a technician without an own calendar: the main calendar');

  // 4. the calendar is down → kept, retried automatically
  svc.down=2;
  await p.evaluate(id=>{ updateProject(id,{address:'1 New Address St'}); },id); await settle();
  c=await cal(id);
  ok(c.state==='error' && /not available/.test(c.error) && c.attempts===1 && c.nextTry>Date.now() && await p.evaluate(id=>getProject(id).address,id)==='1 New Address St','calendar down: the project is saved anyway, the error is kept with the time of the next try');
  await p.locator(`.kcard[data-id="${id}"] [data-action=open]`).click();
  box=await p.innerText('#pmCalendar');
  ok(box.includes('Not synced') && box.includes('not available') && box.includes('next try') && await p.locator('#pmCalendar [data-pm-action=calendar-sync]').count()===1,'the project window shows the error, the next try and a "Sync now" button');
  ok(await p.locator(`.kcard[data-id="${id}"] .cal-error`).count()===1,'the board card shows "⚠ Calendar"');
  const n=syncs().length;
  await p.evaluate(()=>runCalendarSync()); await settle();
  ok(syncs().length===n,'before the wait is over it is not retried (no hammering)');
  await p.evaluate(id=>{ const l=loadProjects(); l.find(x=>x.id===id).calendar.nextTry=Date.now()-1; writeStore(STORAGE_KEYS.crm,l); },id);
  await p.evaluate(()=>runCalendarSync()); await settle();
  c=await cal(id);
  ok(syncs().length===n+1 && c.state==='error' && c.attempts===2 && c.nextTry-Date.now()>60000,'when the wait is over it is retried by itself; failing again waits longer');
  await p.evaluate(()=>window.dispatchEvent(new Event('online'))); await settle();
  c=await cal(id);
  ok(c.state==='synced' && svc.events.get(id).location==='1 New Address St' && svc.events.size===1,'back online: retried at once and synced, still one event');
  box=await p.innerText('#pmCalendar');
  ok(box.includes('In Google Calendar'),'the open project window updates to "In Google Calendar"');
  await p.click('[data-close=projectModal]');

  // 5. canceled
  await p.evaluate(id=>{ updateProject(id,{canceled:true}); },id); await settle();
  s=syncs().at(-1);
  c=await cal(id);
  ok(s.body.action==='remove' && !svc.events.has(id) && c.state==='removed','canceled (setting "delete the event"): the event is removed');
  ok((await p.innerText(`.kcard[data-id="${id}"]`)).includes('Canceled'),'the board card says Canceled');
  await p.evaluate(()=>{ SETTINGS.calendarOnCancel='mark'; persistSettings(); scheduleCalendarScan(); }); await settle();
  s=syncs().at(-1);
  ok(s.body.action==='upsert' && s.body.event.canceled===true && svc.events.has(id),'setting "keep the event, marked CANCELED": the event is kept and marked');
  await p.evaluate(id=>{ updateProject(id,{canceled:false}); },id); await settle();
  ok(syncs().at(-1).body.event.canceled===false && (await cal(id)).state==='synced','reactivated: back to a normal event');

  // 6. moved back to a lead / date cleared → removed; leads are never added
  await p.evaluate(id=>{ updateProject(id,{stage:'prospect'}); },id); await settle();
  ok(syncs().at(-1).body.action==='remove' && !svc.events.has(id),'moved back before Client / Job: the event is removed');
  const before=syncs().length;
  await p.evaluate(D1=>{ const r=newProjectRecord({clientName:'Just A Lead',stage:'lead',scheduledDate:D1}); const l=loadProjects(); l.push(r); saveProjects(l); },D1); await settle();
  ok(syncs().length===before,'a lead with a date is not a project yet: not added');

  // 7. deleted project → its event is removed (and retried if needed)
  await p.evaluate(id=>{ updateProject(id,{stage:'job'}); },id); await settle();
  ok(svc.events.has(id),'back to Client / Job: added again');
  svc.down=1;
  await p.evaluate(id=>deleteProject(id),id); await settle();
  ok(!(await p.evaluate(id=>!!getProject(id),id)) && svc.events.has(id) && await p.evaluate(()=>calendarRemovals().length)===1,'deleting the project while the calendar is down: the removal waits');
  await p.evaluate(()=>runCalendarSync(true)); await settle();
  ok(!svc.events.has(id) && await p.evaluate(()=>calendarRemovals().length)===0,'the waiting removal is retried: the event is gone');

  // 8. estimate visits: a lead moved to Prospects asks for the visit, which goes into the main calendar
  const lead=await p.evaluate(()=>{ const r=newProjectRecord({clientName:'Ann Lee',clientPhone:'818-555-0100',address:'42 Elm St, Reseda, CA',stage:'lead'}); const l=loadProjects(); l.push(r); saveProjects(l); return r.id; });
  await settle();
  const n3=syncs().length;
  ok(syncs().every(x=>x.body.projectId!==lead),'a lead is not in the calendar');
  await p.evaluate(()=>showPage('crm'));
  await p.locator(`.kcard[data-id="${lead}"] [data-action=to-prospect]`).click();
  await p.waitForSelector('#estimateVisitModal.open');
  ok((await p.innerText('#estimateVisitModal')).includes('Ann Lee'),'moving the lead to Prospects asks for the estimate visit date and time');
  await p.fill('#visitDate',D1); await p.fill('#visitTime','10:00');
  await p.click('#estimateVisitForm button[type=submit]'); await settle();
  s=syncs().at(-1)||{body:{event:{}}};
  ok(syncs().length===n3+1 && s.body.kind==='estimate' && s.body.event.kind==='estimate' && s.body.calendarId==='primary','the estimate visit is sent once, as an estimate event in the main calendar');
  ok(s.body.event.name==='Ann Lee' && s.body.event.phone==='818-555-0100' && s.body.event.location==='42 Elm St, Reseda, CA' && s.body.event.date===D1 && s.body.event.time==='10:00','it carries the lead name, phone, address and the visit date and time');
  ok((await p.innerText(`.kcard[data-id="${lead}"]`)).includes('Estimate visit:') && await p.locator(`.kcard[data-id="${lead}"] .cal-ok`).count()===1,'the Prospects card shows the estimate visit with "✓ Calendar"');
  // becomes a job: the job event is added, the estimate event stays
  await p.evaluate(({lead,D2})=>updateProject(lead,{stage:'job',scheduledDate:D2,assignedTechnician:'Yura'}),{lead,D2}); await settle();
  s=syncs().at(-1);
  ok(s.body.kind==='job' && s.body.calendarId===YURA && svc.events.has(lead) && svc.events.has(lead+':estimate') && syncs().filter(x=>x.body.projectId===lead && x.body.kind==='estimate').length===1,'as a job it gets its own job event in the technician\'s calendar; the estimate event stays as it was');
  await p.locator(`.kcard[data-id="${lead}"] [data-action=open]`).click();
  box=await p.innerText('#pmCalendar');
  ok(box.includes('Estimate visit:') && box.includes('at 10:00 AM') && box.includes('Job:') && (box.match(/In Google Calendar/g)||[]).length===2 && await p.inputValue('#pmVisitTime')==='10:00','the project window shows both events, and the visit date and time can be changed there');
  await p.click('[data-close=projectModal]');
  await p.evaluate(lead=>deleteProject(lead),lead); await settle();
  ok(!svc.events.has(lead) && !svc.events.has(lead+':estimate'),'deleting the project removes both events');
  // calendar sync off: moving to Prospects does not ask
  await p.evaluate(()=>{ SETTINGS.calendarEnabled=''; const r=newProjectRecord({clientName:'No Ask',stage:'lead'}); const l=loadProjects(); l.push(r); saveProjects(l); window.__noask=r.id; });
  await p.evaluate(()=>moveProject(window.__noask,'prospect')); await p.waitForTimeout(200);
  ok(!(await p.isVisible('#estimateVisitModal')),'with the calendar sync off, moving to Prospects does not ask');
  await p.evaluate(()=>{ SETTINGS.calendarEnabled='on'; });

  // 9. log in Settings
  await p.evaluate(()=>showPage('settings'));
  const log=await p.innerText('#calLog');
  ok(log.includes('Margo Winnetka') && log.includes('Event saved.') && log.includes('not available') && log.includes('remove (project deleted)'),'Settings shows a log of syncs and errors on this device');
  ok((await p.innerText('#calWaiting')).includes('Nothing waiting'),'and says nothing is waiting');
  await p.locator('#calendarCard').screenshot({path:OUT+'/calendar-settings.png'}).catch(()=>{});

  // signed out: nothing is sent, the project shows it is waiting
  await p.evaluate(()=>{ localStorage.removeItem(CLOUD_TOKEN_KEY); });
  const n2=syncs().length;
  const id2=await p.evaluate(D1=>{ const r=newProjectRecord({clientName:'Offline Job',stage:'job',scheduledDate:D1}); const l=loadProjects(); l.push(r); saveProjects(l); return r.id; },D1); await settle();
  ok(syncs().length===n2 && (await cal(id2)).state==='pending','signed out: the project waits (nothing sent)');
  await p.evaluate(()=>localStorage.setItem(CLOUD_TOKEN_KEY,'tok-boss'));
  await p.evaluate(()=>runCalendarSync()); await settle();
  ok((await cal(id2)).state==='synced','signed in again: the waiting project is synced');

  ok(errs.length===0,'no page errors '+JSON.stringify(errs));
  console.log(`\n${pass} passed, ${fail} failed`); await b.close(); process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(2);});
