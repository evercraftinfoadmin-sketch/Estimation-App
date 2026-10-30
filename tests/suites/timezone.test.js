// Pacific time everywhere: the company works in Los Angeles time (PST in winter, PDT in summer),
// so a device in another time zone (here Kyiv, 10 hours ahead) must still see and save the
// Los Angeles date and time. The clock is fixed at moments where the two dates differ.
const { launch, FILE, MODE } = require('../helpers');
let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m);};

(async()=>{
  const b=await launch();
  const ctx=await b.newContext({viewport:{width:1300,height:900},timezoneId:'Europe/Kyiv'});
  const p=await ctx.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  p.on('dialog',d=>d.accept());
  // Thursday Nov 5, 2026, 07:30 in Kyiv = Wednesday Nov 4, 9:30 PM in Los Angeles (PST).
  await p.clock.setFixedTime(new Date('2026-11-05T05:30:00Z'));
  await p.goto(FILE);
  const ev=fn=>p.evaluate(fn);

  ok(await ev(()=>new Date().getDate())===5,'the device itself (Kyiv) is already on Nov 5');
  ok(await ev(()=>localISODate())==='2026-11-04','"today" in the CRM is the Los Angeles date: Nov 4');
  ok(await p.inputValue('#estimateDate')==='2026-11-04','a new estimate is dated Nov 4 (Los Angeles), not Nov 5');
  ok(await ev(()=>formatDateTime(new Date().toISOString()))==='Nov 4, 2026, 9:30 PM PST','times are shown in Pacific time with the zone: "Nov 4, 2026, 9:30 PM PST"');
  ok(await ev(()=>formatTimeOfDay(new Date()))==='9:30 PM','the time of day (e.g. "Synced 9:30 PM") is Pacific time');
  ok(await ev(()=>formatDate('2026-11-04'))==='Nov 4, 2026','a date is shown as written, never moved by the device\'s time zone');
  ok(await ev(()=>[addDays('2026-11-04',30),addDays('2026-12-31',1),addDays('2026-03-08',1),weekdayOf('2026-11-04')].join())==='2026-12-04,2027-01-01,2026-03-09,3',
    'date arithmetic (invoice due dates, calendar weeks) is plain calendar days, also across the clock change');
  ok(await ev(()=>[parseImportDate('2026-11-04'),parseImportDate('11/04/2026'),parseImportDate('46330')].join())==='2026-11-04,2026-11-04,2026-11-04','imported dates stay the date written (also Excel date numbers)');
  ok(await ev(()=>nextInvoiceNumber([]).startsWith('INV-2026-') && formatEstimateNumber(1001)==='EST-2026-1001'),'invoice and estimate numbers use the Los Angeles year');

  // New Year's Eve: Jan 1 in Kyiv, still Dec 31 in Los Angeles → numbers keep the old year
  await p.clock.setFixedTime(new Date('2027-01-01T03:00:00Z'));
  ok(await ev(()=>localISODate())==='2026-12-31' && await ev(()=>formatEstimateNumber(1001))==='EST-2026-1001','New Year: until midnight in Los Angeles, numbers keep the old year');

  // summer: Pacific Daylight Time
  await p.clock.setFixedTime(new Date('2026-07-01T18:00:00Z'));
  ok(await ev(()=>formatDateTime(new Date().toISOString()))==='Jul 1, 2026, 11:00 AM PDT','in summer the zone is PDT (the clock change is automatic)');

  // the calendar page: today and the event days are Los Angeles days
  await p.clock.setFixedTime(new Date('2026-11-05T05:30:00Z'));
  const days=await ev(()=>({
    timed:calViewEventDays({allDay:false,start:'2026-11-04T19:00:00-08:00',end:'2026-11-04T21:00:00-08:00'}).join(),
    allDay:calViewEventDays({allDay:true,start:'2026-11-04',end:'2026-11-06'}).join(),
    time:calViewTime({allDay:false,start:'2026-11-04T19:00:00-08:00'})
  }));
  ok(days.timed==='2026-11-04' && days.time==='7:00 PM','a 7 PM Los Angeles job stays on Nov 4 at 7:00 PM (in Kyiv it would already be Nov 5, 5 AM)');
  ok(days.allDay==='2026-11-04,2026-11-05','an all-day job keeps its days');
  ok(await ev(()=>{ CALVIEW.month=''; CALVIEW.day=''; return calViewRange(localISODate().slice(0,7)).start; })==='2026-11-01','the calendar month grid starts on the Sunday of the Los Angeles month');
  // project times are Los Angeles wall-clock times, labeled as such
  ok(await ev(()=>projectStartText({scheduledDate:'2026-11-06',scheduledTime:'09:00',scheduledEndDate:''}))==='Nov 6, 2026 at 9:00 AM PT','job start times are Pacific time and say so ("9:00 AM PT")');
  ok((await p.textContent('label[for=pmScheduledTime]')).includes('Pacific time'),'the Start Time field says it is Pacific time');

  ok(errs.length===0,'no page errors '+JSON.stringify(errs));
  console.log(`\n${pass} passed, ${fail} failed`); await b.close(); process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(2);});
