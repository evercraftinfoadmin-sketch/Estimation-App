const { launch, FILE, OUT, FIXTURES, MODE } = require('../helpers');
let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m);};
(async()=>{
  const b=await launch(); const p=await b.newPage({viewport:{width:1360,height:1000}});
  const printAndWait = async () => { const n = await p.evaluate(() => window.__prints); await p.click('#btnPrint'); await p.waitForFunction(n => window.__prints > n, n, { timeout: 5000 }); };

  const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
  const dialogs=[]; let promptAnswer=null;
  p.on('dialog',d=>{dialogs.push(d.type()+': '+d.message()); d.type()==='prompt' ? d.accept(promptAnswer) : d.accept();});
  await p.addInitScript(() => { window.__prints = 0; window.print = () => { window.__prints++; }; });
  const t=s=>p.textContent(s), v=s=>p.inputValue(s);
  const store=k=>p.evaluate(k=>JSON.parse(localStorage.getItem(storageKey(k))||'null'),k);
  const cats=()=>store('constructionEstimatorCategories');
  const last=()=>dialogs[dialogs.length-1]||'';
  const section=name=>p.locator('.category-card',{has:p.locator('h2',{hasText:name})});
  const addCategory=async name=>{ await p.click('[data-action=add-category]'); await p.fill('#catName',name); await p.click('#categoryForm button[type=submit]'); };

  await p.goto(FILE);
  ok((await p.locator('.category-card').count())===3 && (await cats()).length===0,'fresh start: 3 main sections, no custom categories');

  // create category
  await addCategory('Roofing');
  let c=await cats();
  const roof=c.find(x=>x.name==='Roofing');
  ok(c.length===1 && roof,'Add Category creates "Roofing" and saves it');
  ok(await section('ROOFING').count()===1 && /custom/i.test(await section('ROOFING').locator('h2').innerText()),'Roofing section appears (marked custom)');
  ok((await p.innerText('#sumCategories')).includes('Roofing'),'Roofing row in totals panel');

  // validation
  await p.click('[data-action=add-category]'); ok(await p.isHidden('#catExistingField'),'saved-category list hidden when none are left to add'); await p.fill('#catName','drywall'); await p.click('#categoryForm button[type=submit]');
  ok(last().includes('already exists') && (await cats()).length===1,'cannot create a category named like a main one');
  await p.fill('#catName','  '); await p.click('#categoryForm button[type=submit]');
  ok(last().includes('enter a category name'),'empty category name rejected');
  await p.click('#categoryModal [data-close=categoryModal]');

  // custom service saved into the custom category
  await section('ROOFING').locator('[data-action=custom-service]').click();
  ok(await v('#csCategory')===roof.id,'Custom Service preselects the custom category');
  await p.fill('#csName','Shingle Replacement'); await p.fill('#csPrice','45'); await p.check('#csSave');
  await p.click('#customServiceForm button[type=submit]');
  await section('ROOFING').locator('[data-field=quantity]').fill('20');
  const svc=(await store('constructionEstimatorServices')).find(s=>s.name==='Shingle Replacement');
  ok(svc && svc.category===roof.id,'service saved to the Roofing category');
  ok(await t(`#catTotal-${roof.id}`)==='$900.00','Roofing line: 20 × $45 = $900');

  // second category, one-off service
  await addCategory('Flooring');
  await section('FLOORING').locator('[data-action=custom-service]').click();
  await p.fill('#csName','Tile Install'); await p.fill('#csPrice','300');
  await p.click('#customServiceForm button[type=submit]');
  ok(await t('#sumSubtotal')==='$1,200.00' && await t('#sumTotal')==='$1,500.00','custom categories counted: subtotal $1,200, +25% = $1,500');

  // save
  await p.fill('#clientName','Lee Family'); await p.fill('#clientEmail','lee@x.com');
  await p.click('#btnSaveEstimate');
  const est=(await store('constructionEstimatorSavedEstimates'))[0];
  ok(est.customCategories.map(x=>x.name).join()==='Roofing,Flooring' && est.otherTotal===1200 && est.categoryTotals[roof.id]===900,'saved: customCategories, otherTotal, categoryTotals');
  ok(est.items.every(i=>i.categoryName) && est.items.find(i=>i.name==='Tile Install').categoryName==='Flooring','saved lines keep their category name');

  // print & email
  await printAndWait();
  const pv=await p.innerText('#printView');
  ok(/ROOFING/.test(pv) && /Shingle Replacement/.test(pv) && /FLOORING/.test(pv) && /Flooring total/.test(pv),'print shows custom category sections');
  const body=await p.evaluate(()=>buildEmailBody(getEstimateData()));
  ok(body.includes('ROOFING') && body.includes('Shingle Replacement: Qty 20 x $45.00 = $900.00') && body.includes('Flooring total: $300.00'),'email includes custom categories');

  // new estimate: pick saved category
  await p.click('#btnReset');
  ok(await p.locator('.category-card').count()===3,'new estimate starts with the 3 main sections');
  await p.click('[data-action=add-category]');
  const opts=await p.locator('#catExisting option').allTextContents();
  ok(opts.includes('Roofing') && opts.includes('Flooring'),'Add Category offers saved categories');
  await p.selectOption('#catExisting',{label:'Roofing'});
  ok(await p.isHidden('#catNewField'),'choosing a saved category hides the name field');
  await p.click('#categoryForm button[type=submit]');
  await section('ROOFING').locator('[data-action=add-service]').click();
  ok((await section('ROOFING').locator('select').innerText()).includes('Shingle Replacement'),'saved services of the category are offered');
  await section('ROOFING').locator('select').selectOption({label:'Shingle Replacement'});
  ok(await section('ROOFING').locator('[data-field=price]').inputValue()==='45','selecting loads default price');

  // remove category from estimate
  await section('ROOFING').locator('[data-action=remove-category]').click();
  ok(last().includes('Remove "Roofing"') && await section('ROOFING').count()===0 && (await cats()).length===2,'Remove takes the section out of the estimate, category stays saved');

  // Services page
  await p.click('#mainNav [data-page=services]');
  const chips=await p.innerText('#categoriesList');
  ok(/Drywall/.test(chips) && /Roofing\s*1 services/.test(chips) && /Flooring\s*0 services/.test(chips),'Services page lists categories with service counts');
  await p.selectOption('#serviceCategoryFilter',{label:'Roofing'});
  ok(await p.locator('#servicesBody tr').count()===1,'filter services by custom category');
  await p.selectOption('#serviceCategoryFilter','all');
  await p.click('#btnAddService');
  ok((await p.locator('#svcCategory option').allTextContents()).join()==='Drywall,Stucco,Painting,Roofing,Flooring','Add Service offers custom categories');
  await p.click('#serviceModal [data-close=serviceModal]');
  promptAnswer='Gutters';
  await p.click('#btnAddCategory');
  ok((await cats()).some(x=>x.name==='Gutters'),'add category from Services page');
  promptAnswer='Flooring & Tile';
  await p.locator('.cat-chip',{hasText:'Flooring'}).locator('[data-action=rename-category]').click();
  ok((await cats()).some(x=>x.name==='Flooring & Tile'),'rename category');
  await p.locator('.cat-chip',{hasText:'Roofing'}).locator('[data-action=delete-category]').click();
  ok(last().includes('and its 1 service') && !(await cats()).some(x=>x.name==='Roofing') && !(await store('constructionEstimatorServices')).some(s=>s.name==='Shingle Replacement'),'delete category also deletes its services (with confirmation)');

  // saved estimate after rename/delete
  await p.click('#mainNav [data-page=estimates]');
  await p.locator('[data-action=open]').first().click();
  ok(await section('ROOFING').count()===1 && await t(`#catTotal-${roof.id}`)==='$900.00','deleted category: saved estimate keeps its section and line');
  ok(await section('FLOORING & TILE').count()===1,'renamed category shows its new name');
  ok(await t('#sumTotal')==='$1,500.00','saved total unchanged');

  // migration of the old fixed "Other Services"
  await p.evaluate(()=>{ localStorage.clear(); localStorage.setItem(storageKey('constructionEstimatorServices'),JSON.stringify([{id:'o1',category:'other',name:'Demolition',defaultPrice:100,active:true}])); });
  await p.reload();
  const mc=await cats();
  ok(mc.length===1 && mc[0].id==='other' && mc[0].name==='Other Services','old "Other Services" data becomes a custom category');
  await p.click('[data-action=add-category]'); await p.selectOption('#catExisting','other'); await p.click('#categoryForm button[type=submit]');
  await section('OTHER SERVICES').locator('[data-action=add-service]').click();
  ok((await section('OTHER SERVICES').locator('select').innerText()).includes('Demolition'),'its services still work');

  // mobile
  await p.setViewportSize({width:390,height:844});
  ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'mobile: no horizontal scroll');
  const txt=await p.evaluate(()=>document.querySelector('.app').innerText);
  ok(!/NaN|Infinity/.test(txt),'no NaN / Infinity');
  ok(errs.length===0,'no console errors '+JSON.stringify(errs));
  console.log(`\n${pass} passed, ${fail} failed`); await b.close();
})().catch(e=>{console.error(e);process.exit(2);});
