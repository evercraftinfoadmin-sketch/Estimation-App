// Pencil on a service line: change its name and description (size, rooms, color…), for this
// estimate only or also in the Services list; the change is on the PDF and survives saving.
const { launch, FILE, OUT } = require('../helpers');
let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m);};
(async()=>{
  const b=await launch(); const p=await b.newPage({viewport:{width:1360,height:1000}});
  const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
  p.on('dialog',d=>d.accept());
  await p.addInitScript(()=>{ window.print=()=>{}; });
  const services=()=>p.evaluate(()=>loadServices());
  const line=n=>p.locator('#items-drywall .line-item').nth(n);
  await p.goto(FILE);

  // a saved service line and a custom line
  await p.fill('#clientName','Pencil Client');
  await p.click('[data-action=add-service][data-category=drywall]');
  await line(0).locator('select').selectOption({label:'Drywall Replacement'});
  await line(0).locator('[data-field=quantity]').fill('1'); await line(0).locator('[data-field=price]').fill('700');
  await p.click('[data-action=custom-service][data-category=drywall]');
  await p.fill('#csName','Replace drywall'); await p.fill('#csPrice','500'); await p.fill('#csDescription','Remove and dispose old drywall');
  await p.click('#customServiceForm button[type=submit]');
  const svcCount=(await services()).length;
  ok(await line(0).locator('[data-action=edit-item]').count()===1 && await line(1).locator('[data-action=edit-item]').count()===1,'every service line has a pencil (edit) button');

  // 1. this estimate only
  await line(1).locator('[data-action=edit-item]').click();
  ok(await p.isVisible('#lineEditModal') && await p.inputValue('#leName')==='Replace drywall' && await p.inputValue('#leDescription')==='Remove and dispose old drywall' && !(await p.isChecked('#leSave')) && (await p.textContent('#leSaveLabel'))==='Also save to my Services list','the pencil opens the line\'s name and description; "save to Services" is off by default');
  await p.fill('#leDescription','Remove and dispose old drywall\nBathroom wall 12 x 8 ft (96 sq ft)\nMoisture resistant drywall');
  await p.click('#lineEditForm button[type=submit]');
  ok(await p.isHidden('#lineEditModal') && (await line(1).locator('.li-desc').innerText()).includes('Bathroom wall 12 x 8 ft (96 sq ft)'),'the new description (with the size) shows on the line');
  ok((await services()).length===svcCount && await p.evaluate(()=>BUILDER.items.find(i=>i.name==='Replace drywall').description.split('\n').length)===3,'only this estimate changed: no new service; line breaks kept');
  ok(await p.textContent('#sumTotal')==='$1,200.00','prices and totals are unchanged by editing the text');

  // 2. also update the saved service
  await line(0).locator('[data-action=edit-item]').click();
  ok((await p.textContent('#leSaveLabel'))==='Also update "Drywall Replacement" in my Services list','for a saved service the box offers to update that service');
  await p.fill('#leDescription','Includes tape, mud and primer'); await p.check('#leSave');
  await p.click('#lineEditForm button[type=submit]');
  let svc=(await services()).find(s=>s.name==='Drywall Replacement');
  ok(svc && svc.description==='Includes tape, mud and primer' && (await line(0).locator('.li-desc').innerText())==='Includes tape, mud and primer','ticked: the line and the service in the Services list are both updated');

  // 3. a custom line saved to the Services list
  await line(1).locator('[data-action=edit-item]').click();
  await p.fill('#leName','Replace drywall (moisture resistant)'); await p.check('#leSave');
  await p.click('#lineEditForm button[type=submit]');
  svc=(await services()).find(s=>s.name==='Replace drywall (moisture resistant)');
  ok(svc && svc.category==='drywall' && svc.defaultPrice===500 && svc.description.includes('96 sq ft') && await p.evaluate(id=>BUILDER.items.some(i=>i.serviceId===id),svc.id),'a custom line can be saved as a new service (name, description, price)');
  // a name already in the list is refused
  await line(0).locator('[data-action=edit-item]').click();
  await p.fill('#leName','Drywall Repair'); await p.check('#leSave');
  await p.click('#lineEditForm button[type=submit]');
  ok(await p.isVisible('#lineEditModal') && (await services()).filter(s=>s.name==='Drywall Repair').length===1,'renaming a service to a name that already exists is refused');
  await p.click('#lineEditModal [data-close=lineEditModal]');

  // the PDF shows the edited text; it survives saving and reopening
  await p.click('#btnSaveEstimate');
  const id=await p.evaluate(()=>BUILDER.id);
  await p.evaluate(()=>renderPrintView(getEstimateData()));
  const pv=await p.innerText('#printView');
  ok(pv.includes('Replace drywall (moisture resistant)') && pv.includes('Bathroom wall 12 x 8 ft (96 sq ft)') && pv.includes('Includes tape, mud and primer'),'the PDF shows the edited names and descriptions');
  await p.evaluate(()=>newEstimate()); await p.evaluate(id=>openEstimate(id),id);
  await line(1).locator('[data-action=edit-item]').click();
  await p.fill('#leDescription','Changed after saving'); await p.click('#lineEditForm button[type=submit]');
  await p.click('#btnSaveEstimate');
  ok((await p.evaluate(id=>getEstimate(id).items.find(i=>i.name==='Replace drywall (moisture resistant)').description,id))==='Changed after saving','a saved estimate can be reopened, edited with the pencil and saved again');

  // phone: pencil and delete fit, no sideways scrolling
  await p.setViewportSize({width:390,height:844});
  ok(await line(0).locator('[data-action=edit-item]').isVisible() && await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'phone: the pencil is visible and the page does not scroll sideways');
  await line(1).screenshot({path:OUT+'/line-edit-mobile.png'});

  ok(errs.length===0,'no console errors '+JSON.stringify(errs));
  console.log(`\n${pass} passed, ${fail} failed`); await b.close(); process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(2);});
