const { launch, FILE, OUT, FIXTURES, MODE } = require('../helpers');
let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m);};
(async()=>{
  const b=await launch(); const p=await b.newPage({viewport:{width:1360,height:1000}});
  const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
  let answer=true; const dialogs=[]; p.on('dialog',d=>{dialogs.push(d.message()); answer?d.accept():d.dismiss();});
  await p.addInitScript(()=>{ window.__prints=0; window.print=()=>{window.__prints++;}; });
  await p.goto(FILE);
  // test images: a big 3000x2000 PNG and a small one
  const mk=async(w,h,color)=>Buffer.from(await p.evaluate(([w,h,c])=>{const cv=document.createElement('canvas');cv.width=w;cv.height=h;const x=cv.getContext('2d');x.fillStyle=c;x.fillRect(0,0,w,h);x.fillStyle='#fff';x.font='120px sans-serif';x.fillText('TEST',100,300);return cv.toDataURL('image/png').split(',')[1];},[w,h,color]),'base64');
  const big=await mk(3000,2000,'#2563eb'), small=await mk(400,300,'#059669');
  const count=()=>p.evaluate(async()=>Object.values(await photoCountsByOwner()).reduce((a,b)=>a+b,0));
  const waitPhotos=async(sel,n)=>p.waitForFunction(([s,n])=>document.querySelectorAll(s+' .photo').length===n,[sel,n],{timeout:5000}).then(()=>true,()=>false);

  // estimates have no photos
  ok(await p.locator('#page-builder .photo-gallery').count()===0,'Estimate Builder has no photo section');
  // CRM project photos
  await p.click('#mainNav [data-page=crm]');
  await p.click('#btnNewLead');
  ok((await p.innerText('#pmPhotos')).includes('Save the lead first') && await p.isHidden('#pmPhotos .photo-add'),'new lead: photos available after saving');
  await p.fill('#pmClientName','Photo Lead'); await p.click('#projectForm button[type=submit]');
  await p.locator('.kcard',{hasText:'Photo Lead'}).locator('[data-action=open]').first().click();
  await p.setInputFiles('#pmPhotos [data-photo-input]',[{name:'a.png',mimeType:'image/png',buffer:small},{name:'b.png',mimeType:'image/png',buffer:small},{name:'c.png',mimeType:'image/png',buffer:small}]);
  ok(await waitPhotos('#pmPhotos',3),'3 photos added to CRM project');
  await p.click('#projectModal [data-close=projectModal]');
  await p.waitForTimeout(300);
  ok((await p.locator('.kcard',{hasText:'Photo Lead'}).locator('[data-photo-badge]').textContent())==='📷 3 photos','card shows 📷 3 photos');
  await p.locator('.kcard',{hasText:'Photo Lead'}).locator('[data-photo-badge]').click();
  ok(await p.isVisible('#projectModal') && await waitPhotos('#pmPhotos',3),'clicking 📷 opens the project with its photos');
  await p.locator('#pmPhotos .photo-caption').first().fill('Before: cracked stucco');
  await p.locator('#pmPhotos .photo-caption').first().dispatchEvent('change'); await p.waitForTimeout(200);
  await p.locator('#pmPhotos .photo-view').first().click();
  const viewerOk=await p.waitForFunction(()=>{ const v=document.getElementById('photoViewer'); return v && v.classList.contains('open') && document.getElementById('photoViewerCaption').textContent==='Before: cracked stucco'; },null,{timeout:5000}).then(()=>true,()=>false);
  ok(viewerOk,'photo opens large with caption');
  await p.click('#photoViewer [data-close=photoViewer]');
  await p.locator('#pmPhotos .photo-delete').last().click();
  ok(await waitPhotos('#pmPhotos',2) && dialogs.at(-1)==='Delete this photo?','delete one photo (with confirmation)');
  await p.click('#projectModal [data-close=projectModal]');
  await p.reload();
  await p.locator('.kcard',{hasText:'Photo Lead'}).locator('[data-action=open]').click();
  ok(await waitPhotos('#pmPhotos',2) && await p.locator('#pmPhotos .photo-caption').first().inputValue()==='Before: cracked stucco','photos and captions persist after reload');
  const big2=await p.evaluate(async()=>{const l=await listPhotos('project',EDITING_PROJECT_ID);return l.length;});
  await p.setInputFiles('#pmPhotos [data-photo-input]',[{name:'big.png',mimeType:'image/png',buffer:big}]);
  await waitPhotos('#pmPhotos',3);
  const dims=await p.evaluate(async()=>{const l=await listPhotos('project',EDITING_PROJECT_ID);const x=l[l.length-1];return [x.width,x.height,x.blob.type];});
  ok(dims[0]===1600 && dims[1]===1067 && dims[2]==='image/jpeg','large photo resized to 1600px JPEG');
  await p.click('#projectModal [data-close=projectModal]');
  // bad file
  await p.locator('.kcard',{hasText:'Photo Lead'}).locator('[data-photo-badge]').click();
  await p.setInputFiles('#pmPhotos [data-photo-input]',[{name:'notes.txt',mimeType:'text/plain',buffer:Buffer.from('hello')}]);
  await p.waitForTimeout(400);
  ok(dialogs.at(-1).includes('could not be added') && await p.locator('#pmPhotos .photo').count()===3,'non-image file rejected with a message');
  await p.click('#projectModal [data-close=projectModal]');
  await p.locator('.kcard',{hasText:'Photo Lead'}).locator('.kcard-delete').click();
  await p.waitForTimeout(300);
  // Browser-only mode deletes a project's photos. Shared mode keeps them: the project can come back from the cloud.
  const kept=MODE==='shared'?3:0;
  ok(await count()===kept,MODE==='shared'?'shared mode: deleting a CRM project keeps its photos':'deleting a CRM project deletes its photos');
  // orphan cleanup: photos of a project that no longer exists
  await p.evaluate(()=>putPhotos([{id:'ph-orphan',owner:'project:gone',name:'x',caption:'',blob:new Blob(['x'],{type:'image/jpeg'}),createdAt:new Date().toISOString()}]));
  ok(await count()===kept+1,'orphan photo stored');
  await p.reload(); await p.waitForTimeout(500);
  ok(await count()===(MODE==='shared'?kept+1:0),MODE==='shared'?'shared mode: no automatic photo cleanup on start':'photos of deleted projects are cleaned up on next visit');
  // mobile
  await p.setViewportSize({width:390,height:844});
  ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'mobile: no horizontal scroll');
  ok(errs.length===0,'no console errors '+JSON.stringify(errs));
  console.log(`\n${pass} passed, ${fail} failed`); await b.close();
})().catch(e=>{console.error(e);process.exit(2);});
