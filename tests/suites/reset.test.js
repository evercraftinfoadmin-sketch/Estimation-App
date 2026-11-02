// The Reset buttons ask first: the Estimate Builder's Reset (clears the form, starts a new
// estimate; saved data is kept) and Settings → Reset Defaults.
const { launch, FILE } = require('../helpers');
let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m);};

(async()=>{
  const b=await launch(); const p=await b.newPage({viewport:{width:1300,height:900}});
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  const alerts=[]; p.on('dialog',d=>{ alerts.push(d.message()); d.accept(); });
  await p.goto(FILE);
  const open=()=>p.evaluate(()=>$('confirmModal').classList.contains('open'));
  const fillForm=async()=>{ await p.fill('#clientName','Ann Lee'); await p.fill('#projectAddress','1 Main St'); await p.fill('#clientMessage','Thanks!'); };

  // a saved estimate that must survive every reset
  await fillForm();
  await p.click('#btnSaveEstimate');
  const saved=await p.evaluate(()=>loadEstimates().length);
  ok(saved===1,'fixture: one saved estimate');
  await p.fill('#clientMessage','Edited, not saved');

  // 1. Reset opens the confirmation
  await p.click('#btnReset');
  ok(await open(),'1. clicking Reset opens a confirmation (nothing happens yet)');
  ok((await p.textContent('#confirmTitle'))==='Are you sure you want to reset?' && (await p.textContent('#confirmMessage'))==='Are you sure you want to delete/reset this data? This action may not be reversible.',
    '1. title and message as specified');
  ok((await p.textContent('#confirmCancel'))==='Cancel' && (await p.textContent('#confirmYes'))==='Yes, Reset','1. the buttons are Cancel and Yes, Reset');
  ok(await p.evaluate(()=>document.activeElement.id)==='confirmCancel','Cancel is the default (focused): Enter does not reset');
  ok((await p.textContent('#confirmDetails')).includes('Saved estimates, CRM projects and clients are not deleted') && (await p.textContent('#confirmDetails')).includes('not saved yet will be lost'),
    'the dialog says what Reset does (only the form) and that unsaved changes are lost; no "type RESET" because no saved data is deleted');

  // 2. Cancel / Escape / click outside / Enter change nothing
  await p.click('#confirmCancel');
  ok(!(await open()) && await p.inputValue('#clientName')==='Ann Lee' && await p.inputValue('#clientMessage')==='Edited, not saved','2. Cancel closes the dialog; the form is unchanged');
  await p.click('#btnReset'); await p.keyboard.press('Escape');
  ok(!(await open()) && await p.inputValue('#clientName')==='Ann Lee','2. Escape cancels');
  await p.click('#btnReset'); await p.mouse.click(5,5);
  ok(!(await open()) && await p.inputValue('#clientName')==='Ann Lee','2. a click outside the dialog cancels');
  await p.click('#btnReset'); await p.keyboard.press('Enter');
  ok(!(await open()) && await p.inputValue('#clientName')==='Ann Lee','2. Enter (on the default Cancel) cancels');

  // 4. double click: one dialog, one reset
  await p.evaluate(()=>{ window.__resets=0; const real=window.newEstimate; window.newEstimate=(...a)=>{ window.__resets++; return real(...a); }; });
  await p.evaluate(()=>{ $('btnReset').click(); $('btnReset').click(); });
  ok(await open() && await p.evaluate(()=>document.querySelectorAll('#confirmModal.open').length)===1,'4. two quick clicks open one dialog');
  await p.evaluate(()=>{ $('confirmYes').click(); $('confirmYes').click(); });
  await p.waitForTimeout(100);
  ok(await p.evaluate(()=>window.__resets)===1,'4. two clicks on Yes, Reset reset once');
  // 3. the reset happened, saved data is kept
  ok(await p.inputValue('#clientName')==='' && await p.inputValue('#clientMessage')==='' && await p.evaluate(()=>BUILDER.id===null),'3. Yes, Reset clears the form and starts a new estimate');
  ok(await p.evaluate(()=>loadEstimates().length)===saved && (await p.innerText('.toast')).includes('Reset done'),'3. saved estimates are kept; success is shown');
  ok(!(await p.isDisabled('#btnReset')) && (await p.textContent('#btnReset'))==='Reset','the button is usable again afterwards');

  // loading state while running
  await fillForm();
  await p.evaluate(()=>{ window.__state=null; const real=window.newEstimate; window.newEstimate=(...a)=>{ window.__state={disabled:$('btnReset').disabled,text:$('btnReset').textContent}; return real(...a); }; });
  await p.click('#btnReset'); await p.click('#confirmYes');
  ok(await p.evaluate(()=>window.__state && window.__state.disabled && window.__state.text==='Resetting…'),'while resetting the button shows "Resetting…" and cannot be clicked');

  // 5. a failing reset says so (and never reports success)
  await fillForm();
  await p.evaluate(()=>{ window.newEstimate=()=>{ throw new Error('storage is full'); }; $('toast').textContent=''; });
  await p.click('#btnReset'); await p.click('#confirmYes');
  await p.waitForTimeout(100);
  ok(alerts.at(-1).includes('did not work') && alerts.at(-1).includes('storage is full'),'5. a failed reset shows an error with the reason');
  ok(!(await p.textContent('#toast')).includes('Reset done') && await p.inputValue('#clientName')==='Ann Lee','5. no success message, the form is as it was');
  await p.reload(); // real newEstimate back

  // Settings → Reset Defaults
  await p.evaluate(()=>showPage('settings'));
  await p.fill('#setCompanyName','My Test Company'); await p.click('#settingsForm button[type=submit]');
  await p.click('#btnResetSettings');
  ok(await open() && (await p.textContent('#confirmDetails')).includes('Google Calendar settings (the sync is turned off)'),'Settings → Reset Defaults also asks, and says exactly what goes back to defaults (including the calendar sync)');
  await p.click('#confirmCancel');
  ok(await p.evaluate(()=>SETTINGS.companyName)==='My Test Company','Cancel keeps the settings');
  await p.evaluate(()=>{ window.__realPersist=window.persistSettings; window.persistSettings=()=>false; });
  await p.click('#btnResetSettings'); await p.click('#confirmYes');
  ok(alerts.at(-1).includes('did not work') && await p.evaluate(()=>SETTINGS.companyName)==='My Test Company','a failed settings reset says so and changes nothing');
  await p.evaluate(()=>{ window.persistSettings=window.__realPersist; });
  await p.click('#btnResetSettings'); await p.click('#confirmYes');
  ok(await p.evaluate(()=>SETTINGS.companyName)===await p.evaluate(()=>DEFAULT_SETTINGS.companyName) && await p.evaluate(()=>loadEstimates().length)===saved,'Yes, Reset restores the defaults; estimates are kept');

  // the dialog closes only itself: an open window under it stays
  await p.evaluate(()=>showPage('crm'));
  await p.click('#btnNewLead');
  await p.evaluate(()=>{ confirmAction({title:'t',message:'m',confirmLabel:'Yes'}); });
  await p.keyboard.press('Escape');
  ok(!(await open()) && await p.evaluate(()=>$('projectModal').classList.contains('open')),'Escape closes only the confirmation, not the window under it');

  ok(errs.length===0,'no page errors '+JSON.stringify(errs));
  console.log(`\n${pass} passed, ${fail} failed`); await b.close(); process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(2);});
