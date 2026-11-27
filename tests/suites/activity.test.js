// Lead activity history and lead links (js/activity.js).
// History: every change to a lead, its estimates and invoices is recorded automatically (who, when,
// what, details), newest first, kept when the lead changes later; signing and payments are recorded
// once even when noticed twice. Lead links: Share Lead / Copy Link; "#lead=<id>" shows only that
// lead; with the shared CRM only signed-in users with CRM access see it.
const { launch, FILE, OUT, MODE } = require('../helpers');
let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m);};

(async()=>{
  const b=await launch();
  const ctx=await b.newContext({viewport:{width:1300,height:900}});
  const p=await ctx.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  p.on('dialog',d=>d.accept());
  await p.goto(FILE+'#crm');
  await p.waitForFunction(()=>typeof CLOUD!=='undefined' && CLOUD.state!=='syncing');
  // Shared mode is signed out in the tests: act as a signed-in member (the CRM data is visible).
  if(MODE==='shared') await p.evaluate(()=>{ CLOUD.role='member'; CLOUD.user={email:'ann@test',full_name:'Ann Manager'}; });
  const who=MODE==='shared' ? 'Ann Manager' : 'This device (not signed in)';
  const hist=id=>p.evaluate(id=>activityForProject(id),id);
  const titles=async id=>(await hist(id)).map(a=>a.title);

  // 1. a new lead through the "New Lead" window
  await p.click('#btnNewLead');
  ok(await p.isHidden('#pmHistorySection') && await p.isHidden('#pmShare'),'a new lead (not saved yet) has no history or share buttons');
  await p.fill('#pmClientName','Ann Lee');
  await p.fill('#pmClientEmail','ann@example.com');
  await p.click('#projectForm button[type=submit]');
  const id=await p.evaluate(()=>loadProjects()[0].id);
  let h=await hist(id);
  ok(h.length===1 && h[0].title==='Lead created' && h[0].details.includes('Ann Lee') && h[0].kind==='created','1. "Lead created" is recorded automatically');
  ok(/^\d{4}-\d\d-\d\dT/.test(h[0].at) && h[0].actor===(MODE==='shared' ? 'Ann Manager' : ''),'each event has the exact time and who did it');

  // 2. customer information, status, notes, assigned employee, schedule
  await p.evaluate(id=>openProjectModal(id),id);
  await p.fill('#pmClientPhone','(818) 555-0101');
  await p.fill('#pmClientEmail','ann.lee@example.com');
  await p.fill('#pmNotes','Wants a quote for the living room.');
  await p.click('#projectForm button[type=submit]');
  h=await hist(id);
  const cust=h.find(a=>a.title==='Customer information updated');
  ok(cust && cust.details.includes('Phone: — → (818) 555-0101') && cust.details.includes('Email: ann@example.com → ann.lee@example.com'),'2. customer information changes are recorded with old → new values');
  ok(h.some(a=>a.title==='Note added' && a.details==='Wants a quote for the living room.'),'2. a note added is recorded with its text');
  await p.evaluate(id=>moveProject(id,'prospect'),id);
  await p.evaluate(id=>moveProject(id,'job'),id);
  await p.evaluate(id=>updateProject(id,{assignedTechnician:'Yura',scheduledDate:'2026-12-03',scheduledTime:'09:00',notes:'Wants a quote for the living room.\nGate code 1234'}),id);
  h=await hist(id);
  const st=h.find(a=>a.title==='Status changed to Prospects' || a.title.startsWith('Status changed to Prospect'));
  ok(st && st.details.startsWith('Status: Leads') || (st && st.details.includes('→')),'2. a status change is recorded with the previous and new status ('+(st&&st.details)+')');
  ok(h.some(a=>a.title==='Assigned to Yura' && a.details==='Assigned employee: — → Yura' && a.kind==='assigned'),'2. assigning an employee is recorded');
  ok(h.some(a=>a.title==='Job scheduled' && a.details.includes('Dec 3, 2026 at 9:00 AM')),'2. scheduling the job is recorded');
  ok(h.some(a=>a.title==='Note added' && a.details==='Gate code 1234'),'2. a note added to existing notes records only the new text');

  // 3. estimate: created, sent, sent for signature, signed (noticed twice → recorded once)
  const est=await p.evaluate(id=>{
    const e=normalizeEstimate({id:'est-a1',estimateNumber:'EST-2026-5001',clientName:'Ann Lee',crmProjectId:id,status:'draft',items:[],customerTotal:4200});
    const l=loadEstimates(); l.push(e); saveEstimates(l); updateProject(id,{estimateId:e.id,estimateNumber:e.estimateNumber,estimateTotal:4200});
    return e.id;
  },id);
  await p.evaluate(e=>updateEstimate(e,{status:'sent'}),est);
  const sig={id:'a'.repeat(64),type:'estimate',title:'Estimate',status:'pending',url:'https://s/x',sentTo:'ann.lee@example.com',createdAt:'2026-11-20T18:00:00.000Z'};
  await p.evaluate(([e,s])=>updateEstimate(e,{signatures:[s]}),[est,sig]);
  const signed={...sig,status:'signed',signedAt:'2026-11-21T19:30:00.000Z',signerName:'Ann Lee'};
  await p.evaluate(([e,s])=>updateEstimate(e,{signatures:[s],status:'accepted'}),[est,signed]);
  // the same signature noticed again (e.g. by a second device before syncing): no second event
  await p.evaluate(([e,s])=>{ updateEstimate(e,{signatures:[{...s,status:'pending',signedAt:''}]}); updateEstimate(e,{signatures:[s]}); },[est,signed]);
  h=await hist(id);
  ok(h.some(a=>a.title==='Estimate EST-2026-5001 created') && h.some(a=>a.title==='Estimate EST-2026-5001: Sent' && a.details==='Status: Draft → Sent'),'3. estimate created and sent are recorded');
  ok(h.some(a=>a.title==='Estimate EST-2026-5001 sent for signature' && a.details.includes('ann.lee@example.com')),'3. sending the estimate for signature is recorded');
  const sgn=h.filter(a=>a.title==='Estimate EST-2026-5001 signed by the client');
  ok(sgn.length===1 && sgn[0].at==='2026-11-21T19:30:00.000Z' && sgn[0].actor==='Client: Ann Lee' && sgn[0].kind==='signed','3. the client signing is recorded once, at the signing time, by the client');

  // 4. the contract (Work Authorization) signed
  const wa={id:'b'.repeat(64),type:'work_authorization',title:'WA',status:'pending',url:'https://s/y',sentTo:'ann.lee@example.com',createdAt:'2026-11-22T17:00:00.000Z'};
  await p.evaluate(([id,s])=>updateProject(id,{signatures:[s]}),[id,wa]);
  await p.evaluate(([id,s])=>updateProject(id,{signatures:[{...s,status:'signed',signedAt:'2026-11-22T20:00:00.000Z',signerName:'Ann Lee'}]}),[id,wa]);
  h=await hist(id);
  ok(h.some(a=>a.title==='Work Authorization (contract) sent for signature') && h.some(a=>a.title==='Work Authorization (contract) signed by the client' && a.at==='2026-11-22T20:00:00.000Z'),'4. the contract (Work Authorization) sent and signed are recorded');

  // 5. invoice created, sent, partial payment, full payment
  const inv=await p.evaluate(([id,est])=>{
    const i=computeInvoice(normalizeInvoice({id:'inv-a1',invoiceNumber:'INV-2026-1001',estimateId:est,crmProjectId:id,clientName:'Ann Lee',taxRate:0,
      items:[{id:'li1',category:'painting',name:'Painting',quantity:1,price:4200,total:4200}],payments:[],status:'draft'}));
    const l=loadInvoices(); l.push(i); saveInvoices(l); return i.id;
  },[id,est]);
  const editInv=fn=>p.evaluate(([i,f])=>{ const l=loadInvoices(); const x=l.find(v=>v.id===i); (new Function('x',f))(x); saveInvoices(l.map(v=>v.id===i ? computeInvoice(x) : v)); },[inv,fn]);
  await editInv(`x.status='sent'`);
  await editInv(`x.payments.push({id:'pay-1',date:'2026-11-24',amount:1000,method:'Zelle',note:'Deposit'})`);
  await editInv(`x.payments.push({id:'pay-2',date:'2026-11-26',amount:3200,method:'Check',note:''})`);
  h=await hist(id);
  ok(h.some(a=>a.title==='Invoice INV-2026-1001 created' && a.details.includes('$4,200.00')) && h.some(a=>a.title==='Invoice INV-2026-1001 sent to the client'),'5. invoice created and sent are recorded');
  const part=h.find(a=>a.title==='Partial payment received: Invoice INV-2026-1001');
  ok(part && part.details.includes('$1,000.00 · Zelle') && part.details.includes('Deposit') && part.details.includes('Remaining balance $3,200.00') && part.kind==='payment','5. a partial payment is recorded with amount, method and remaining balance');
  const full=h.find(a=>a.title==='Full payment received: Invoice INV-2026-1001 Paid in Full');
  ok(full && full.details.includes('$3,200.00 · Check') && full.details.includes('Paid in total $4,200.00') && full.kind==='paid','5. the final payment is recorded as Paid in Full');
  await editInv(`x.payments=x.payments.slice()`); // saving again records nothing new
  ok((await hist(id)).length===h.length,'saving without a change records nothing');

  // 6. history stays when the lead changes; newest first
  await p.evaluate(id=>moveProject(id,'started'),id);
  h=await hist(id);
  ok(h.length>20 && h.some(a=>a.title==='Lead created') && h.some(a=>a.kind==='paid'),'6. earlier events stay when the status changes later ('+h.length+' events)');
  ok(h.every((a,i)=>i===0 || h[i-1].at>=a.at),'6. newest first');

  // 7. the history in the lead window, with the summary at the top
  await p.evaluate(id=>openProjectModal(id),id);
  ok(await p.isVisible('#pmHistorySection') && await p.isVisible('#pmShare'),'7. the lead window has a History section and Share / Copy Link');
  const boxTop=await p.evaluate(()=>{ const f=$('projectForm'); const s=$('pmHistorySection'); return s.getBoundingClientRect().top>$('pmPhotos').getBoundingClientRect().top; });
  ok(boxTop,'7. the history is at the bottom of the lead card');
  const pmText=await p.innerText('#pmHistory');
  ok(pmText.includes('Estimate signed ✓') && pmText.includes('Contract (Work Authorization) signed ✓') && pmText.includes('Paid in Full ✓ $4,200.00'),'7. at a glance: estimate signed, contract signed, paid in full');
  ok(pmText.includes('Full payment received') && pmText.includes(who) && pmText.includes('PST'),'7. each event shows its name, Pacific date and time and who did it');
  const first=await p.locator('#pmHistory .hist-item .hist-title').first().innerText();
  ok(first===h[0].title,'7. the newest event is on top ('+first+')');

  // 8. Copy Link / Share Lead
  await p.evaluate(()=>{ window.__copied=null; window.copyText=async t=>{ window.__copied=t; return true; }; });
  await p.click('#pmShare [data-pm-copy]');
  const link=await p.evaluate(()=>window.__copied);
  ok(link && link.endsWith('#lead='+id) && link.startsWith('file://'),'8. Copy Link copies a direct link to this lead ('+link+')');
  await p.evaluate(()=>{ window.__shared=null; navigator.share=async d=>{ window.__shared=d; }; });
  await p.click('#pmShare [data-pm-share]');
  const shared=await p.evaluate(()=>window.__shared);
  ok(shared && shared.url===link && shared.title==='Lead: Ann Lee','8. Share Lead opens the phone\'s share menu with the link');
  await p.evaluate(()=>{ navigator.share=undefined; window.__copied=null; });
  await p.click('#pmShare [data-pm-share]');
  ok(await p.evaluate(()=>window.__copied)===link,'8. without a share menu (computer), Share Lead copies the link');
  await p.evaluate(()=>closeModal('projectModal'));

  // a second lead that must not show on the first lead's page
  await p.evaluate(()=>{ const l=loadProjects(); l.push(newProjectRecord({clientName:'Bob Other',stage:'lead'})); saveProjects(l); });

  // 9. the link opens only this lead (a fresh page load, as when the link is opened from a message)
  await p.goto(link); await p.reload();
  await p.waitForFunction(()=>typeof CLOUD!=='undefined' && CLOUD.state!=='syncing');
  if(MODE==='shared'){
    const gate=await p.innerText('#leadView');
    ok(gate.includes('Sign in to open this lead') && !gate.includes('Ann Lee') && await p.isVisible('#leadView [data-lead-action=sign-in]'),'10. signed out: the link asks to sign in and shows nothing of the lead');
    await p.evaluate(()=>{ CLOUD.user={email:'new@test'}; setCloudState('no_access'); });
    const noAcc=await p.innerText('#leadView');
    ok(noAcc.includes('No access to this lead') && noAcc.includes('new@test') && !noAcc.includes('Ann Lee') && await p.isVisible('#leadView [data-lead-action=request-access]'),'10. signed in without CRM access: no data, "Request access" offered');
    await p.evaluate(()=>{ CLOUD.role='member'; CLOUD.user={email:'ann@test',full_name:'Ann Manager'}; setCloudState('synced'); });
  }
  ok(await p.isVisible('#page-lead') && await p.isHidden('#page-crm') && await p.isHidden('#page-builder'),'9. the link opens the lead page, not the CRM board or the dashboard');
  const page=await p.innerText('#page-lead');
  ok(page.includes('Ann Lee') && page.includes('(818) 555-0101') && /history/i.test(page) && page.includes('Lead created'),'9. it shows the lead card with its details and history');
  ok(!page.includes('Bob Other') && await p.locator('.kcard:visible').count()===0,'9. no other leads, no leads list');
  ok(await p.isVisible('#leadView [data-share-lead]') && await p.isVisible('#leadView [data-copy-lead]'),'9. Share Lead and Copy Link are on the lead page too');
  await p.click('#leadView [data-lead-action=edit]');
  ok(await p.evaluate(()=>$('projectModal').classList.contains('open') && $('pmClientName').value==='Ann Lee'),'9. Edit opens this lead');
  await p.fill('#pmClientPhone','(818) 555-0199'); await p.click('#projectForm button[type=submit]');
  ok((await p.innerText('#page-lead')).includes('(818) 555-0199') && (await p.innerText('#leadView .hist-item >> nth=0')).includes('Customer information updated'),'9. after saving, the lead page shows the change and its history entry');
  await p.goto(FILE+'#lead=crm-does-not-exist'); await p.reload();
  await p.waitForFunction(()=>typeof CLOUD!=='undefined' && CLOUD.state!=='syncing');
  if(MODE==='shared') await p.evaluate(()=>{ CLOUD.role='member'; CLOUD.lastSync=new Date(); setCloudState('synced'); });
  const nf=await p.innerText('#leadView');
  ok(nf.includes('Lead not found') && !nf.includes('Ann Lee') && !nf.includes('Bob Other'),'9. a wrong id shows "Lead not found", never another lead');

  // 11. phone
  await p.goto(link); await p.reload();
  await p.waitForFunction(()=>typeof CLOUD!=='undefined' && CLOUD.state!=='syncing');
  if(MODE==='shared') await p.evaluate(()=>{ CLOUD.role='member'; setCloudState('synced'); });
  await p.setViewportSize({width:390,height:844});
  await p.waitForTimeout(200);
  ok(!(await p.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1)) && await p.isVisible('#leadView [data-share-lead]'),'11. the lead page fits a phone screen');
  await p.screenshot({path:OUT+'/lead-page-phone.png',fullPage:true});
  await p.setViewportSize({width:1300,height:900});
  await p.screenshot({path:OUT+'/lead-page.png',fullPage:true});

  // 12. deleting the lead keeps its history
  await p.evaluate(id=>{ const l=loadProjects().filter(x=>x.id!==id); saveProjects(l); },id);
  h=await hist(id);
  ok(h[0].title==='Lead deleted' && h.some(a=>a.title==='Lead created'),'12. deleting a lead keeps its history (with "Lead deleted")');

  ok(errs.length===0,'no page errors '+JSON.stringify(errs));
  console.log(`\n${pass} passed, ${fail} failed`); await b.close(); process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(2);});
