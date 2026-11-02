// Clients → Properties (addresses) → Projects (js/clients.js): linking existing projects (report
// first), the client profile, Add Address, property details, creating projects at an address,
// the client → property choice in the project window, and archiving. Realistic fixtures only.
const { launch, FILE, OUT } = require('../helpers');
let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m);};

(async()=>{
  const b=await launch(); const p=await b.newPage({viewport:{width:1360,height:1000}});
  const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{ if(m.type()==='error') errs.push(m.text()); });
  let answer=true; const dialogs=[];
  p.on('dialog',d=>{ dialogs.push(d.message()); answer ? d.accept() : d.dismiss(); });
  await p.goto(FILE);
  await p.evaluate(()=>{ if(typeof CLOUD!=='undefined' && cloudActive()) { CLOUD.role='owner'; } });
  const ev=(fn,a)=>p.evaluate(fn,a);
  const closeAll=()=>ev(()=>document.querySelectorAll('.modal.open').forEach(m=>closeModal(m.id)));

  // ---------- existing data, from before clients and addresses ----------
  const old=await ev(()=>{
    const est={id:'est-old-1',estimateNumber:'EST-2026-0901',date:'2026-09-01',clientName:'John Smith',items:[],status:'accepted',subtotal:3000,taxAmount:0,customerTotal:3000,
      categoryTotals:{painting:3000},crmProjectId:'crm-old-1'};
    saveEstimates([...loadEstimates(),est]);
    const mk=(id,x)=>{ const r=newProjectRecord(x); r.id=id; r.updatedAt='2026-09-15T12:00:00.000Z'; return r; };
    const list=[
      mk('crm-old-1',{clientName:'John Smith',clientPhone:'(818) 555-0101',clientEmail:'john@example.com',address:'123 Main St, Los Angeles, CA 90012',stage:'completed',estimateId:'est-old-1',estimateNumber:'EST-2026-0901',
        calendar:{state:'synced',eventId:'evc1',calendarId:'primary',link:'https://cal/1',hash:'h',want:'h'}}),
      mk('crm-old-2',{clientName:'John Smith',clientPhone:'+1 818 555 0101',address:'123 Main St., Los Angeles, CA 90012',stage:'started'}),
      mk('crm-old-3',{clientName:'J. Smith',clientEmail:'JOHN@example.com',address:'456 Oak Ave, Beverly Hills, CA 90210',stage:'lead'}),
      mk('crm-old-4',{clientName:'Mary Jones',clientPhone:'310-555-0199',stage:'lead'}),
      mk('crm-old-5',{clientName:'John Smith',clientPhone:'213-555-0777',address:'789 Sunset Blvd, Los Angeles, CA 90028',stage:'prospect'})
    ];
    saveProjects([...loadProjects(),...list]);
    return list.map(x=>x.id);
  });
  await ev(()=>putPhotos([{id:'ph-old-1',owner:photoOwner('project','crm-old-1'),name:'before.jpg',caption:'Before',blob:new Blob(['x'],{type:'image/jpeg'}),width:1,height:1,createdAt:nowISO()}]));
  const before=await ev(()=>JSON.stringify(loadProjects().map(p=>{ const {client_id,propertyId,...rest}=p; return rest; })));

  // ---------- the report first ----------
  await ev(()=>showPage('clients'));
  ok((await p.textContent('#clientsNote')).includes('5 CRM projects are not linked'),'the Clients page says which projects are not linked yet');
  await p.click('[data-cl-action=report]');
  const rep=await ev(()=>{ const r=buildClientReport(); return {unlinked:r.unlinked,newClients:r.newClients,newProperties:r.newProperties,review:r.review.map(p=>p.id),dupNames:r.dupNames.map(d=>d.name+':'+d.count),dupAddr:r.dupAddresses.length}; });
  ok(rep.unlinked===5 && rep.newClients===3,'report: 5 projects; same email or phone → one client: John (phone + email), Mary, and the other John Smith = 3 new clients');
  ok(rep.newProperties===3,'report: 3 properties ("123 Main St" and "123 Main St." are the same address)');
  ok(rep.review.join()==='crm-old-4','report: the project without an address is flagged for manual review (no address invented)');
  ok(rep.dupNames.includes('john smith:2'),'report: two clients named John Smith with different phones are a possible duplicate, not merged');
  ok(await p.isVisible('#clientReportModal') && (await p.innerText('#crBody')).toLowerCase().includes('need an address') && await ev(()=>loadClients().length)===0,'the report window shows all this and nothing is changed yet');
  const dl=p.waitForEvent('download'); await p.click('#crCsv'); const f=await dl;
  ok(f.suggestedFilename().startsWith('client-address-report-'),'the report can be downloaded (CSV)');
  await p.click('#crApply'); await p.click('#confirmYes');
  await p.waitForFunction(()=>!$('clientReportModal').classList.contains('open'));
  const linked=await ev(()=>loadProjects().filter(p=>p.id.startsWith('crm-old')).map(p=>({id:p.id,c:p.client_id,pr:p.propertyId})));
  const by=Object.fromEntries(linked.map(x=>[x.id,x]));
  ok(linked.every(x=>x.c) && by['crm-old-1'].c===by['crm-old-2'].c && by['crm-old-2'].c===by['crm-old-3'].c && by['crm-old-5'].c!==by['crm-old-1'].c,'linking: every project has its client; the same email / phone → the same client');
  ok(by['crm-old-1'].pr && by['crm-old-1'].pr===by['crm-old-2'].pr && by['crm-old-3'].pr!==by['crm-old-1'].pr && by['crm-old-4'].pr==='','linking: one property per address; the project without an address keeps none');
  const after=await ev(()=>JSON.stringify(loadProjects().map(p=>{ const {client_id,propertyId,...rest}=p; return rest; })));
  ok(after===before,'6./7. linking changes nothing else on the projects (details, estimate, calendar link, dates)');
  ok(await ev(()=>getProject('crm-old-1').estimateId==='est-old-1' && getEstimate('est-old-1').crmProjectId==='crm-old-1' && getProject('crm-old-1').calendar.eventId==='evc1'),'7. the estimate and calendar links are intact');
  ok((await ev(()=>listPhotos('project','crm-old-1'))).length===1,'7. the project photos are intact');
  ok(await ev(()=>buildClientReport().unlinked)===0,'running the report again: nothing left to link');

  // ---------- 1. the client profile with several properties ----------
  const john=by['crm-old-1'].c;
  await ev(()=>renderClientsPage());
  await p.click(`#clientsBody tr[data-client="${john}"]`);
  ok(await p.isVisible('#clientModal'),'clicking a client opens the client profile');
  let props=await p.innerText('#clProperties');
  ok(props.includes('Property 1') && props.includes('Property 2') && props.includes('123 Main St') && props.includes('456 Oak Ave'),'1. the profile lists the client\'s properties');
  ok(props.includes('Painting — Project Completed') && props.includes('Project — Start the Project'),'the projects are listed under their property with their stage');
  // add an address
  await p.click('[data-cl-action=add-address]');
  ok(await p.isVisible('#addressModal') && (await p.textContent('#addrClient'))==='John Smith','+ Add Address opens a compact form for this client');
  await p.fill('#addrStreet','789 Canyon Dr'); await p.fill('#addrUnit','Unit 4'); await p.fill('#addrCity','Los Angeles'); await p.fill('#addrState','CA'); await p.fill('#addrZip','90046');
  ok(await p.inputValue('#addrCountry')==='US','the country starts as US');
  await p.click('#addressForm button[type=submit]');
  props=await p.innerText('#clProperties');
  ok(!(await p.isVisible('#addressModal')) && props.includes('789 Canyon Dr Unit 4, Los Angeles, CA 90046') && props.includes('Property 3'),'1. Save Address adds a third property to this client');
  await p.click('[data-cl-action=add-address]');
  await p.fill('#addrStreet','123 Main St'); await p.fill('#addrCity','Los Angeles'); await p.fill('#addrState','CA'); await p.fill('#addrZip','90012');
  await p.click('#addressForm button[type=submit]');
  ok(await p.isVisible('#addressModal') && (await p.textContent('#addrStatus')).includes('already saved for this client'),'the same address twice for one client is refused');
  await p.click('[data-close=addressModal]');
  await p.click('[data-cl-action=add-address]'); await p.click('#addressForm button[type=submit]');
  ok((await p.textContent('#addrStatus')).includes('street address and the city'),'the street and city are required');
  await p.click('[data-close=addressModal]');
  await p.locator('#clientModal').screenshot({path:OUT+'/client-profile.png'}).catch(()=>{});

  // ---------- property details, 2./3. projects at an address ----------
  const canyon=await ev(id=>clientProperties(id).find(r=>r.address.startsWith('789 Canyon')).id,john);
  await p.click(`[data-property="${canyon}"] [data-cl-action=property]`);
  ok(await p.isVisible('#propertyModal') && (await p.textContent('#propClient')).includes('John Smith') && (await p.innerText('#propProjects')).includes('No projects'),'clicking an address opens the property: address, client, notes, projects');
  await p.click('#propNewProject');
  ok(await p.isVisible('#projectModal') && await p.inputValue('#pmClientPick')===john && await p.inputValue('#pmClientName')==='John Smith' && await p.inputValue('#pmPropertyPick')===canyon && (await p.inputValue('#pmAddress')).startsWith('789 Canyon'),
    '3. + Create Project: the client and the address are filled in (no need to choose the client again)');
  await p.fill('#pmNotes','Repaint garage');
  await p.click('#projectForm button[type=submit]');
  await ev(id=>{ openPropertyDetail(id); },canyon);
  await p.click('#propNewProject');
  await p.fill('#pmNotes','Fence stain'); await p.click('#projectForm button[type=submit]');
  const atCanyon=await ev(id=>propertyProjects(id).map(p=>({c:p.client_id,addr:p.address,notes:p.notes})),canyon);
  ok(atCanyon.length===2 && atCanyon.every(x=>x.c===john && x.addr.startsWith('789 Canyon')),'2./3. two projects at one address, both linked to the client and that property');
  ok(await ev(()=>loadClients().length)===3 && await ev(id=>clientProperties(id).length,john)===3,'no extra client or property was created');
  await closeAll();

  // ---------- 4./5. the project window: client → property, + Add Address keeps the form ----------
  await ev(()=>showPage('crm'));
  await p.click('#btnNewLead');
  await p.selectOption('#pmClientPick',john);
  const opts=await p.locator('#pmPropertyPick option').allTextContents();
  ok(opts.length===5 && opts[0]==='Choose the property…' && opts.some(o=>o.startsWith('456 Oak')) && !opts.some(o=>o.startsWith('789 Sunset')),'4. only the chosen client\'s addresses are offered (not the other John Smith\'s)');
  await p.click('#projectForm button[type=submit]');
  ok(dialogs.at(-1).includes('several addresses') && await p.isVisible('#projectModal'),'a client with several addresses: the property must be chosen');
  // 5. add an address without losing what was typed
  await p.fill('#pmNotes','Kitchen ceiling'); await p.fill('#pmScheduledDate','2026-12-01'); await p.fill('#pmTechnician','Yura');
  await p.click('#pmAddAddress');
  await p.fill('#addrStreet','55 Hill St'); await p.fill('#addrCity','Pasadena'); await p.fill('#addrState','CA'); await p.fill('#addrZip','91101');
  await p.click('#addressForm button[type=submit]');
  ok(await p.inputValue('#pmNotes')==='Kitchen ceiling' && await p.inputValue('#pmScheduledDate')==='2026-12-01' && await p.inputValue('#pmTechnician')==='Yura' && await p.inputValue('#pmClientPick')===john,'5. adding an address keeps everything typed in the project form');
  ok((await p.inputValue('#pmAddress')).startsWith('55 Hill St') && (await p.locator('#pmPropertyPick option:checked').textContent()).startsWith('55 Hill St'),'5. the new address is chosen for the project');
  await p.click('#projectForm button[type=submit]');
  const hill=await ev(()=>loadProjects().find(p=>p.notes==='Kitchen ceiling'));
  ok(hill && hill.client_id===john && await ev(id=>getProperty(id).address.startsWith('55 Hill St'),hill.propertyId),'3. the project is saved with the client and the new property');
  ok(await ev(p=>getProperty(p.propertyId).clientId===p.client_id,hill),'the property belongs to the project\'s client');

  // one address: chosen automatically
  const mary=by['crm-old-4'].c;
  await ev(id=>addProperty(id,{address:'12 Pine Rd, Glendale, CA 91201'}),mary);
  await p.click('#btnNewLead'); await p.selectOption('#pmClientPick',mary);
  ok((await p.inputValue('#pmPropertyPick'))!=='' && (await p.inputValue('#pmAddress')).startsWith('12 Pine Rd'),'a client with one address: it is chosen automatically');
  await p.click('[data-close=projectModal]');

  // a new lead typed with the phone of an existing client: suggested, confirmed
  await p.click('#btnNewLead');
  await p.fill('#pmClientName','Johnny'); await p.fill('#pmClientPhone','818.555.0101');
  ok(await p.isVisible('#pmClientMatch') && (await p.textContent('#pmClientMatch')).includes('John Smith') && (await p.textContent('#pmClientMatch')).includes('same phone'),'typing the phone of an existing client suggests that client');
  answer=false;
  await p.fill('#pmAddress','999 New Pl, Burbank, CA 91501');
  await p.click('#projectForm button[type=submit]');
  answer=true;
  const johnny=await ev(()=>loadProjects().find(p=>p.clientName==='Johnny'));
  ok(dialogs.at(-1).includes('already has this phone') && johnny.client_id!==john,'not confirmed: saved as a new client (never linked silently)');
  await p.click('#btnNewLead');
  await p.fill('#pmClientName','John'); await p.fill('#pmClientEmail','john@example.com');
  await p.click('#pmClientMatch [data-pm-client]');
  ok(await p.inputValue('#pmClientPick')===john && await p.inputValue('#pmClientName')==='John Smith','"Use this client" picks the existing client');
  await p.click('[data-close=projectModal]');

  // ---------- 8. archiving an address keeps its projects ----------
  const main=by['crm-old-1'].pr;
  await ev(id=>openPropertyDetail(id),main);
  await p.click('#propArchive');
  ok((await p.textContent('#confirmDetails')).includes('stay exactly as they are'),'archiving asks first and says the projects are kept');
  await p.click('#confirmYes');
  ok(await ev(id=>getProperty(id).archived,main) && await ev(()=>['crm-old-1','crm-old-2'].every(id=>!!getProject(id) && getProject(id).propertyId)),'8. an archived address keeps its projects (nothing deleted)');
  await closeAll(); await p.click('#btnNewLead'); await p.selectOption('#pmClientPick',john);
  ok(!(await p.locator('#pmPropertyPick option').allTextContents()).some(o=>o.startsWith('123 Main')),'an archived address is not offered for new projects');
  await p.click('[data-close=projectModal]');
  await ev(id=>openClientProfile(id),john);
  ok((await p.innerText('#clProperties')).includes('1 archived address'),'the client profile keeps it under "archived"');
  await p.click('.cl-archived summary'); await p.click('[data-cl-action=restore]');
  ok(!(await ev(id=>getProperty(id).archived,main)),'an archived address can be restored');
  await closeAll();

  // ---------- 6. existing projects stay accessible ----------
  await ev(()=>showPage('crm'));
  ok(await p.locator('.kcard[data-id="crm-old-4"]').count()===1 && await p.locator('.kcard[data-id="crm-old-1"]').count()===1,'6. existing projects are on the board as before');
  await ev(()=>openProjectModal('crm-old-4'));
  ok(await p.inputValue('#pmClientPick')===mary && await p.inputValue('#pmClientName')==='Mary Jones','6. an existing project opens with its client chosen');
  await p.click('[data-close=projectModal]');
  await ev(()=>openProjectModal('crm-old-1'));
  await p.click('#projectForm button[type=submit]');
  ok(await ev(()=>getProject('crm-old-1').propertyId)===main && await ev(id=>clientProperties(id,true).length,john)===4,'saving an existing project keeps its property (no duplicate address)');

  ok(errs.length===0,'no page errors '+JSON.stringify(errs));
  console.log(`\n${pass} passed, ${fail} failed`); await b.close(); process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(2);});
