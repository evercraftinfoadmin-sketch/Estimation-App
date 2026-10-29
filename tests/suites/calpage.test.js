// Calendar page (js/calview.js): the company Google Calendar shown inside the CRM. The calendar
// service is faked inside the page (no network).
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
  p.on('dialog',d=>d.accept());

  const pad=n=>String(n).padStart(2,'0');
  const now=new Date(); const Y=now.getFullYear(), M=now.getMonth();
  const day=d=>`${Y}-${pad(M+1)}-${pad(d)}`;
  const reqs=[];
  let projectId='';
  await p.exposeFunction('__mail',(path,method,headers,body)=>{
    const b=body?JSON.parse(body):{}; reqs.push({path,headers,body:b});
    if(path==='/calendar/calendars') return {status:200,body:{calendars:[{id:'evercraft.pro@gmail.com',name:'evercraft.pro@gmail.com',primary:true,color:'#4F57FF'},{id:YURA,name:'Yura',color:'#0b8043'},{id:'oleg@group.calendar.google.com',name:'Oleg',color:''}]}};
    if(path==='/calendar/events'){
      const all={
        'evercraft.pro@gmail.com':[{id:'e1',calendarId:'evercraft.pro@gmail.com',summary:'ESTIMATE (Ann Lee), 818-555-0100',location:'42 Elm St, Reseda, CA',allDay:false,start:`${day(10)}T10:00:00`,end:`${day(10)}T11:00:00`,link:'https://calendar.google.com/e/1',crmProject:projectId,crmKind:'estimate'}],
        [YURA]:[{id:'e2',calendarId:YURA,summary:'Margo painting Yurii + Kirill',location:'19802 Bassett St',allDay:false,start:`${day(10)}T09:00:00`,end:`${day(10)}T17:00:00`,link:'https://calendar.google.com/e/2',crmProject:'',crmKind:''},
                {id:'e3',calendarId:YURA,summary:'JOB (Big Job), 818 · Yura',location:'',allDay:true,start:day(12),end:day(15),link:'https://calendar.google.com/e/3',crmProject:'',crmKind:'job'}],
        'oleg@group.calendar.google.com':[]
      };
      return {status:200,body:{ok:true,calendars:b.calendarIds.map(id=>({calendarId:id,events:all[id]||[]}))}};
    }
    return {status:404,body:{}};
  });
  await p.addInitScript(MAIL=>{ const real=window.fetch; window.fetch=function(url,opts={}){ url=String(url); if(!url.startsWith(MAIL)) return real.apply(this,arguments);
    return window.__mail(url.slice(MAIL.length),opts.method||'GET',opts.headers||{},opts.body||'').then(r=>new Response(JSON.stringify(r.body),{status:r.status,headers:{'Content-Type':'application/json'}})); }; },MAIL);
  await p.goto(FILE);
  await p.waitForFunction(()=>typeof CLOUD!=='undefined' && CLOUD.state!=='syncing');

  ok(await p.isVisible('#mainNav [data-page=calendar]'),'there is a Calendar page in the menu');
  await p.click('#mainNav [data-page=calendar]');
  ok((await p.textContent('#calViewStatus')).includes('Sign in'),'signed out: it says to sign in (nothing is loaded)');
  ok(reqs.length===0,'signed out: the calendar is not asked for');

  // signed in
  projectId=await p.evaluate(()=>{ CLOUD.role='member'; localStorage.setItem(CLOUD_TOKEN_KEY,'tok-ann'); const r=newProjectRecord({clientName:'Ann Lee',stage:'prospect'}); const l=loadProjects(); l.push(r); saveProjects(l); return r.id; });
  await p.click('#calViewRefresh');
  await p.waitForFunction(()=>$('calViewStatus').textContent.includes('events'));
  const evReq=reqs.find(r=>r.path==='/calendar/events');
  ok(evReq && evReq.headers.Authorization==='Bearer tok-ann' && evReq.body.calendarIds.length===3,'signed in: the events of all team calendars are loaded with the CRM sign-in');
  const span=(Date.parse(evReq.body.timeMax)-Date.parse(evReq.body.timeMin))/86400000;
  ok(span>=41 && span<=43 && new Date(evReq.body.timeMin).getDay()===0,'the month is shown as 6 weeks from a Sunday');
  ok((await p.textContent('#calViewMonth')).includes(String(Y)) && await p.locator('#calViewGrid .calv-cell').count()===42,'a month grid with the month name');
  ok((await p.innerText('#calViewLegend')).includes('Main calendar') && (await p.innerText('#calViewLegend')).includes('Yura'),'the calendars are listed with their colors');
  const cell10=p.locator(`#calViewGrid [data-day="${day(10)}"]`);
  ok(await cell10.locator('.calv-chip').count()===2 && (await cell10.innerText()).includes('ESTIMATE (Ann Lee)') && (await cell10.innerText()).includes('Margo painting'),'events show on their day: CRM ones and ones entered by hand in Google');
  ok(await p.locator(`#calViewGrid [data-day="${day(12)}"] .calv-chip`).count()===1 && await p.locator(`#calViewGrid [data-day="${day(14)}"] .calv-chip`).count()===1 && await p.locator(`#calViewGrid [data-day="${day(15)}"] .calv-chip`).count()===0,'an all-day job over several days shows on each of its days (not the day after)');
  ok(await p.locator('#calViewGrid .calv-today').count()===1,'today is marked');
  await p.locator('#page-calendar').screenshot({path:OUT+'/calendar-page.png'});

  // a day's list
  await cell10.click({position:{x:5,y:5}});
  const dayText=await p.innerText('#calViewDay');
  ok(dayText.includes('9:00') && dayText.includes('Margo painting') && dayText.includes('42 Elm St, Reseda, CA') && dayText.includes('from the CRM (estimate visit)'),'clicking a day lists its events with time, address and calendar');
  ok(await p.locator('#calViewDay a[href*="google.com/maps"]').count()===2 && await p.locator('#calViewDay a[href="https://calendar.google.com/e/2"]').count()===1 && await p.locator('#calViewDay [data-calv-project]').count()===1,'with a map link, "Open in Google Calendar", and "Open CRM project" for CRM events');
  // a CRM event opens its project
  await cell10.locator('.calv-chip',{hasText:'ESTIMATE'}).click();
  ok(await p.isVisible('#projectModal') && (await p.textContent('#projectModalTitle'))==='Ann Lee','clicking a CRM event opens its CRM project');
  await p.click('[data-close=projectModal]');

  // hide a calendar
  const n=reqs.length;
  await p.locator(`#calViewLegend input[data-cal="${YURA}"]`).uncheck();
  await p.waitForFunction(()=>!$('calViewStatus').textContent.includes('Loading'));
  ok(reqs.length===n+1 && !reqs.at(-1).body.calendarIds.includes(YURA) && await cell10.locator('.calv-chip').count()===1,'unticking a calendar hides its events');
  ok(await p.evaluate(()=>calViewHidden().has('yura@group.calendar.google.com')),'the choice is remembered on this device');
  await p.locator(`#calViewLegend input[data-cal="${YURA}"]`).check();
  await p.waitForFunction(()=>!$('calViewStatus').textContent.includes('Loading'));

  // next month
  const before=reqs.filter(r=>r.path==='/calendar/events').length;
  await p.click('#calViewNext');
  await p.waitForFunction(()=>!$('calViewStatus').textContent.includes('Loading'));
  const nextReq=reqs.filter(r=>r.path==='/calendar/events').at(-1);
  ok(reqs.filter(r=>r.path==='/calendar/events').length===before+1 && Date.parse(nextReq.body.timeMin)>Date.parse(evReq.body.timeMin)+20*86400000,'› shows the next month (its events are loaded)');
  await p.click('#calViewToday');
  await p.waitForFunction(()=>!$('calViewStatus').textContent.includes('Loading'));
  ok((await p.textContent('#calViewMonth'))===now.toLocaleDateString([], {month:'long',year:'numeric'}),'Today goes back to this month');

  // phone
  await p.setViewportSize({width:390,height:844});
  await p.waitForTimeout(200);
  ok(await p.locator(`#calViewGrid [data-day="${day(10)}"] .calv-dots .calv-dot`).count()===2 && !(await cell10.locator('.calv-chip').first().isVisible()),'on a phone the days show colored dots; the day list has the details');
  const overflow=await p.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1);
  ok(!overflow,'no sideways scrolling on a phone');
  await p.locator('#page-calendar').screenshot({path:OUT+'/calendar-page-phone.png'});

  ok(errs.length===0,'no page errors '+JSON.stringify(errs));
  console.log(`\n${pass} passed, ${fail} failed`); await b.close(); process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(2);});
