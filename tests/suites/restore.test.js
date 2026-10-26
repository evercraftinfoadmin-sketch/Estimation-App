// Restoring a backup reloads the page. The reloaded page can read this browser's storage before
// the restore's last writes have arrived (Chromium delivers them separately). The restore writes a
// token last and reloads with ?restore=<token>; the page waits (saving nothing) until it sees it.
const { launch, FILE } = require('../helpers');
let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m);};
(async()=>{
  const b=await launch(); const p=await b.newPage({viewport:{width:1200,height:900}});
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  const dialogs=[]; p.on('dialog',d=>{dialogs.push(d.message()); d.accept();});
  await p.goto(FILE);

  // 1. the normal restore: data replaced, page reloads with the token, the token is then removed
  await p.evaluate(()=>{
    const data={}; for(const [n,k] of Object.entries(STORAGE_KEYS)) data[n]=readStore(k,null);
    data.estimates=[{id:'est-from-backup',estimateNumber:'EST-2020-0001',date:'2020-01-01',clientName:'From Backup',items:[],status:'draft'}];
    window.__bk=new File([JSON.stringify({app:BACKUP_APP,version:1,exportedAt:new Date().toISOString(),data})],'b.json');
  });
  await Promise.all([p.waitForURL(/restore=/), p.evaluate(()=>restoreBackupFile(window.__bk))]);
  await p.waitForFunction(()=>!location.search.includes('restore') && typeof BUILDER_ADDRESS!=='undefined' && BUILDER_ADDRESS);
  ok(dialogs.some(d=>d.includes('Backup restored')) && await p.evaluate(()=>loadEstimates().map(e=>e.clientName).join())==='From Backup','restore: the backup data is there after the reload');
  ok(!(await p.evaluate(()=>location.href)).includes('restore') && await p.evaluate(()=>!RESTORE_WAITING),'the reload token is removed from the address once the data is confirmed');

  // 2. the race: the page loads before the restore's token has arrived → it saves nothing and waits
  const mark=await p.evaluate(()=>RESTORE_MARK_KEY);
  await p.evaluate(k=>localStorage.setItem(k,'older-token'),mark);
  const before=await p.evaluate(()=>localStorage.getItem(STORAGE_KEYS.estimates));
  await p.goto(FILE.replace(/#.*$/,'')+'?restore=new-token#builder');
  ok(await p.evaluate(()=>RESTORE_WAITING) && await p.evaluate(()=>document.body.classList.contains('restore-waiting')),'when the token has not arrived yet the app waits ("Finishing the restore…") and does not start');
  ok(await p.evaluate(()=>writeStore(STORAGE_KEYS.estimates,[])===false) && await p.evaluate(()=>localStorage.getItem(STORAGE_KEYS.estimates))===before,'while waiting nothing can be saved (data from before the restore can never be written back)');
  await p.waitForURL(/restoreTry=\d/,{timeout:5000});
  ok(true,'it reloads by itself to look again');
  // the restore's last write arrives
  await p.evaluate(k=>localStorage.setItem(k,'new-token'),mark);
  await p.waitForFunction(()=>!location.search.includes('restore') && typeof BUILDER_ADDRESS!=='undefined' && BUILDER_ADDRESS,null,{timeout:10000});
  ok(await p.evaluate(()=>!RESTORE_WAITING && !document.body.classList.contains('restore-waiting')) && await p.isVisible('#page-builder'),'as soon as the token is visible the app starts normally');

  // 3. the token never arrives: after about 5 seconds the app starts and says so
  const n0=dialogs.length;
  await p.goto(FILE.replace(/#.*$/,'')+'?restore=never-written&restoreTry=20#builder');
  await p.waitForTimeout(1200);
  ok(await p.evaluate(()=>!RESTORE_WAITING) && dialogs.slice(n0).some(d=>d.includes('may not have been saved completely')),'if it never arrives, the app starts anyway and asks to check the data');

  ok(errs.length===0,'no page errors '+JSON.stringify(errs));
  console.log(`\n${pass} passed, ${fail} failed`); await b.close(); process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(2);});
