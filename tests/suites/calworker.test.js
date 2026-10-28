// Calendar part of the mail service (worker/src/calendar.js) without network: Google (token and
// Calendar API) and Base44 are faked, KV is kept in memory. The fake calendar behaves like Google:
// a deleted event keeps its id (insert → 409), an unknown one is 404.
const path = require('path');
const { pathToFileURL } = require('url');
let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m);};

const PROD='6aceadfed0aa786c7c2934ff';
const ORIGIN='https://evercraftinfoadmin-sketch.github.io';
const W='https://evercraft-mail.example.workers.dev';
const SEND='https://www.googleapis.com/auth/gmail.send';
const CAL_SCOPES='https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly';

function kv(){ const m=new Map(); return { m, async get(k){ return m.has(k)?m.get(k):null; }, async put(k,v){ m.set(k,String(v)); }, async delete(k){ m.delete(k); } }; }
const env=()=>({ MAIL_KV:kv(), ALLOWED_SENDER:'EverCraft.pro@gmail.com', ALLOWED_ORIGINS:ORIGIN,
  BASE44_APPS:JSON.stringify({[PROD]:'https://base44.app'}), GOOGLE_CLIENT_ID:'cid', GOOGLE_CLIENT_SECRET:'cs', MAIL_SETUP_KEY:'k', CALENDAR_TIMEZONE:'America/Los_Angeles' });

const USERS={ 'tok-member':{id:'u1',email:'m@x.com',crm_role:'member'}, 'tok-none':{id:'u2',email:'n@x.com',crm_role:'none'} };
// calendars: id → Map(eventId → event)
const CALS={ 'primary':new Map(), 'yura@group.calendar.google.com':new Map(), 'oleg@group.calendar.google.com':new Map() };
let failNext=[]; // statuses the Calendar API answers next
let calls=[];
global.fetch=async(url,opts={})=>{
  url=String(url); const method=opts.method||'GET'; calls.push({url,method,body:opts.body});
  const res=(status,body)=>new Response(body===undefined?'':JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
  if(/\/entities\/User\/me$/.test(url)){ const u=USERS[(opts.headers.Authorization||'').replace('Bearer ','')]; return u?res(200,u):res(401,{}); }
  if(url==='https://oauth2.googleapis.com/token') return res(200,{access_token:'acc',expires_in:3600});
  if(!url.startsWith('https://www.googleapis.com/calendar/v3/')) throw new Error('unexpected fetch '+url);
  if(failNext.length){ const s=failNext.shift(); return res(s,{error:{message:s===403?'Request had insufficient authentication scopes.':'Backend Error'}}); }
  const u=new URL(url); const parts=u.pathname.split('/').slice(3).map(decodeURIComponent); // after /calendar/v3
  if(parts[0]==='users') return res(200,{items:[{id:'evercraft.pro@gmail.com',summary:'evercraft.pro@gmail.com',primary:true},{id:'yura@group.calendar.google.com',summary:'Yura'},{id:'gone',summary:'Old',deleted:true}]});
  const cal=CALS[parts[1]]; if(!cal) return res(404,{error:{message:'Not Found'}});
  const id=parts[3];
  if(method==='POST' && parts.length===3){ const ev=JSON.parse(opts.body); if(cal.has(ev.id)) return res(409,{error:{message:'The requested identifier already exists.'}}); cal.set(ev.id,{...ev,htmlLink:'https://calendar.google.com/event?eid='+ev.id}); return res(200,cal.get(ev.id)); }
  if(parts[4]==='move'){ const ev=cal.get(id); if(!ev||ev.status==='cancelled') return res(404,{error:{message:'Not Found'}}); const dest=CALS[u.searchParams.get('destination')]; if(!dest) return res(404,{}); cal.delete(id); dest.set(id,ev); return res(200,ev); }
  if(method==='PUT'){ const ev=cal.get(id); if(!ev) return res(404,{error:{message:'Not Found'}}); cal.set(id,{...JSON.parse(opts.body),htmlLink:ev.htmlLink}); return res(200,cal.get(id)); }
  if(method==='DELETE'){ const ev=cal.get(id); if(!ev) return res(404,{}); if(ev.status==='cancelled') return res(410,{}); ev.status='cancelled'; return new Response(null,{status:204}); }
  return res(400,{});
};

(async()=>{
  const mod=await import(pathToFileURL(path.resolve(__dirname,'../../worker/src/index.js')).href);
  const cal=await import(pathToFileURL(path.resolve(__dirname,'../../worker/src/calendar.js')).href);
  const worker=mod.default;
  const E=env();
  const post=(p,body,{token='tok-member',origin=ORIGIN}={})=>worker.fetch(new Request(W+p,{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{}),...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify({appId:PROD,...body})}),E);
  const live=c=>[...CALS[c].values()].filter(e=>e.status!=='cancelled');
  const job={kind:'job',name:'Margo Winnetka',phone:'818-555-0100',service:'Painting',location:'19802 Bassett St, Winnetka, CA',technician:'Yura',notes:'Gate code 1234',date:'2026-11-02',time:'09:00',endDate:'2026-11-04'};

  // connecting asks Google for the calendar too
  let r=await worker.fetch(new Request(W+'/oauth/start?key=k'),E);
  const scope=new URL(r.headers.get('Location')).searchParams.get('scope');
  ok(scope.includes(SEND) && scope.includes('calendar.events') && scope.includes('calendar.calendarlist.readonly'),'the connect link asks for "send email" and the calendar');

  // not connected / old connection without calendar
  r=await post('/calendar/sync',{projectId:'crm1',action:'upsert',event:job}); let j=await r.json();
  ok(r.status===503 && /not connected/.test(j.error) && j.retry===true,'before the Google account is connected: refused, the CRM will retry');
  await E.MAIL_KV.put('gmail',JSON.stringify({refresh_token:'r',email:'evercraft.pro@gmail.com'}));
  r=await post('/calendar/sync',{projectId:'crm1',action:'upsert',event:job}); j=await r.json();
  ok(r.status===503 && /allow the calendar/.test(j.error) && calls.every(c=>!c.url.includes('/calendar/v3/')),'a Gmail connection made before the calendar existed: says to connect again and allow the calendar (Google is not called)');
  j=await (await worker.fetch(new Request(W+'/status'),E)).json();
  ok(j.connected===true && j.calendar===false,'status: email connected, calendar not allowed yet');
  await E.MAIL_KV.put('gmail',JSON.stringify({refresh_token:'r',email:'evercraft.pro@gmail.com',scope:'openid email '+SEND+' '+CAL_SCOPES}));
  j=await (await worker.fetch(new Request(W+'/status'),E)).json();
  ok(j.calendar===true,'status: calendar allowed after connecting again');

  // who may sync
  r=await post('/calendar/sync',{projectId:'crm1',action:'upsert',event:job},{token:''});
  ok(r.status===401,'without a CRM sign-in: refused');
  r=await post('/calendar/sync',{projectId:'crm1',action:'upsert',event:job},{token:'tok-none'});
  ok(r.status===403,'a signed-in person without CRM access: refused');
  r=await post('/calendar/sync',{projectId:'crm1',action:'upsert',event:job},{origin:'https://evil.example'});
  ok(r.status===403,'another web site: refused');
  r=await post('/calendar/sync',{projectId:'crm1',action:'upsert',event:{...job,date:'tomorrow'}});
  ok(r.status===400 && /start date/.test((await r.json()).error),'a project without a valid start date: refused with the reason');
  r=await post('/calendar/sync',{projectId:'crm1',action:'upsert',event:{...job,endDate:'2026-11-01'}});
  ok(r.status===400,'an end date before the start: refused');

  // calendars list
  r=await post('/calendar/calendars',{}); j=await r.json();
  ok(r.status===200 && j.calendars.length===2 && j.calendars[0].primary && j.calendars[1].name==='Yura','the calendars the company account can write to (deleted ones left out)');

  // 1. a new project → one event
  const eid=await cal.projectEventId(PROD,'crm1');
  r=await post('/calendar/sync',{projectId:'crm1',action:'upsert',calendarId:'yura@group.calendar.google.com',event:job}); j=await r.json();
  let ev=CALS['yura@group.calendar.google.com'].get(eid);
  ok(r.status===200 && j.ok && j.eventId===eid && j.link.includes(eid) && live('yura@group.calendar.google.com').length===1,'a project with a start date becomes one event, with its link back');
  ok(ev.summary==='JOB (Margo Winnetka), 818-555-0100 · Yura' && ev.description.includes('Phone: 818-555-0100') && ev.location==='19802 Bassett St, Winnetka, CA' && ev.description.includes('Service: Painting') && ev.description.includes('Team: Yura') && ev.description.includes('Gate code 1234'),'job events are named "JOB (name), phone · technician", the address is the location, service and notes in the description');
  ok(ev.start.dateTime==='2026-11-02T09:00:00' && ev.start.timeZone==='America/Los_Angeles' && ev.end.dateTime==='2026-11-04T17:00:00','a start time: a timed event in the company time zone, until 5 PM on the end date');
  ok(ev.extendedProperties.private.evercraftProject==='crm1' && /^[a-v0-9]{5,}$/.test(ev.id),'the event carries the project id and a Google-valid fixed id');

  // 2. repeated sync: no second event
  r=await post('/calendar/sync',{projectId:'crm1',action:'upsert',calendarId:'yura@group.calendar.google.com',event:job});
  r=await post('/calendar/sync',{projectId:'crm1',action:'upsert',calendarId:'yura@group.calendar.google.com',event:job});
  ok(r.status===200 && live('yura@group.calendar.google.com').length===1,'syncing the same project again updates the one event (no duplicate)');

  // 3. date changed → the same event moves
  r=await post('/calendar/sync',{projectId:'crm1',action:'upsert',calendarId:'yura@group.calendar.google.com',event:{...job,date:'2026-11-09',endDate:'',time:''}});
  ev=CALS['yura@group.calendar.google.com'].get(eid);
  ok(live('yura@group.calendar.google.com').length===1 && ev.start.date==='2026-11-09' && ev.end.date==='2026-11-10' && !ev.start.dateTime,'a new date updates the event; no start time makes it an all-day event');
  r=await post('/calendar/sync',{projectId:'crm1',action:'upsert',calendarId:'yura@group.calendar.google.com',event:{...job,date:'2026-11-09',endDate:'',time:'18:30'}});
  ev=CALS['yura@group.calendar.google.com'].get(eid);
  ok(ev.start.dateTime==='2026-11-09T18:30:00' && ev.end.dateTime==='2026-11-09T20:30:00','a late start with no end date lasts 2 hours');

  // 4. another team member → the event moves to their calendar
  r=await post('/calendar/sync',{projectId:'crm1',action:'upsert',calendarId:'oleg@group.calendar.google.com',prevCalendarId:'yura@group.calendar.google.com',event:{...job,technician:'Oleg'}}); j=await r.json();
  ok(r.status===200 && j.calendarId==='oleg@group.calendar.google.com' && live('yura@group.calendar.google.com').length===0 && live('oleg@group.calendar.google.com').length===1 && CALS['oleg@group.calendar.google.com'].get(eid).summary.endsWith('· Oleg'),'a new technician moves the same event into their calendar (not copied)');

  // 5. canceled: marked
  r=await post('/calendar/sync',{projectId:'crm1',action:'upsert',calendarId:'oleg@group.calendar.google.com',event:{...job,technician:'Oleg',canceled:true}});
  ev=CALS['oleg@group.calendar.google.com'].get(eid);
  ok(ev.summary.startsWith('CANCELED: ') && ev.description.startsWith('THIS PROJECT WAS CANCELED') && ev.transparency==='transparent','"keep it, marked canceled": the event says CANCELED and no longer blocks the time');
  // canceled: removed (twice is fine), then the project comes back
  r=await post('/calendar/sync',{projectId:'crm1',action:'remove',calendarId:'oleg@group.calendar.google.com'}); j=await r.json();
  ok(r.status===200 && j.removed && live('oleg@group.calendar.google.com').length===0,'"delete": the event is removed');
  r=await post('/calendar/sync',{projectId:'crm1',action:'remove',calendarId:'oleg@group.calendar.google.com'});
  ok(r.status===200,'removing again (a retry) is fine');
  r=await post('/calendar/sync',{projectId:'crm1',action:'upsert',calendarId:'oleg@group.calendar.google.com',event:job});
  ok(r.status===200 && live('oleg@group.calendar.google.com').length===1,'the project back on: its removed event comes back (same id, no duplicate)');
  r=await post('/calendar/sync',{projectId:'crm-never',action:'remove',calendarId:'primary'});
  ok(r.status===200,'removing an event that was never made is fine');

  // 6. Google down / refusing
  failNext=[503];
  r=await post('/calendar/sync',{projectId:'crm2',action:'upsert',calendarId:'primary',event:job}); j=await r.json();
  ok(r.status===502 && j.retry===true && /not available/.test(j.error) && live('primary').length===0,'Google Calendar down: an error the CRM retries later');
  r=await post('/calendar/sync',{projectId:'crm2',action:'upsert',calendarId:'primary',event:job});
  ok(r.status===200 && live('primary').length===1,'the retry then adds the event once');
  failNext=[403];
  r=await post('/calendar/sync',{projectId:'crm2',action:'upsert',calendarId:'primary',event:job}); j=await r.json();
  ok(r.status===502 && /connect the company Google account again/.test(j.error) && /insufficient/.test(j.error),'Google refusing (403): the reason and what to do');
  r=await post('/calendar/sync',{projectId:'crm3',action:'upsert',calendarId:'nobody@group.calendar.google.com',event:job}); j=await r.json();
  ok(r.status===502 && j.retry===false && /Settings/.test(j.error),'a calendar that does not exist: says to check Settings, not retried quickly');
  r=await post('/calendar/sync',{projectId:'../x',action:'upsert',event:job});
  ok(r.status===400,'a bad project id is refused');

  // estimate visits: their own event, in the main calendar
  const visit={kind:'estimate',name:'Ann Lee',phone:'818-555-0100',service:'Painting',location:'42 Elm St, Reseda, CA',notes:'Call first',date:'2026-11-05',time:'10:00',technician:'Yura'};
  const vid=await cal.projectEventId(PROD,'crm2','estimate');
  r=await post('/calendar/sync',{projectId:'crm2',kind:'estimate',action:'upsert',calendarId:'primary',event:visit}); j=await r.json();
  ev=CALS['primary'].get(vid);
  ok(r.status===200 && j.eventId===vid && vid!==await cal.projectEventId(PROD,'crm2') && live('primary').length===2,'the estimate visit is its own event (another fixed id than the job of the same project)');
  ok(ev.summary==='ESTIMATE (Ann Lee), 818-555-0100' && ev.location==='42 Elm St, Reseda, CA' && ev.description.startsWith('Estimate visit') && ev.description.includes('Call first') && !ev.description.includes('Team:'),'named "ESTIMATE (name), phone", the address in the location line');
  ok(ev.start.dateTime==='2026-11-05T10:00:00' && ev.end.dateTime==='2026-11-05T11:00:00' && ev.extendedProperties.private.evercraftKind==='estimate','a visit with a time lasts one hour');
  r=await post('/calendar/sync',{projectId:'crm2',kind:'estimate',action:'upsert',calendarId:'primary',event:{...visit,time:''}});
  ev=CALS['primary'].get(vid);
  ok(live('primary').length===2 && ev.start.date==='2026-11-05' && ev.end.date==='2026-11-06','synced again without a time: the same event, all day');
  r=await post('/calendar/sync',{projectId:'crm2',kind:'estimate',action:'remove',calendarId:'primary'});
  ok(r.status===200 && live('primary').length===1 && CALS['primary'].get(await cal.projectEventId(PROD,'crm2')).status!=='cancelled','removing the estimate visit leaves the job event alone');
  r=await post('/calendar/sync',{projectId:'crm9',action:'upsert',calendarId:'primary',event:{...job,name:'Bob (Jr.)',phone:''}});
  ok(CALS['primary'].get(await cal.projectEventId(PROD,'crm9')).summary==='JOB (Bob Jr.) · Yura','no phone: left out; brackets in the name do not break the title');

  // projects of different apps never share an event
  ok((await cal.projectEventId(PROD,'crm1'))!==(await cal.projectEventId('6acd6d429d6ed1576d7696b7','crm1')),'the same project id in the dev app gets a different event');

  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(2);});
