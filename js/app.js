"use strict";

/* Navigation, event wiring and start-up. */

const PAGES = ["builder","estimates","services","crm","invoices","settings"];

function showPage(name){
  if(!PAGES.includes(name)) name="builder";
  PAGES.forEach(p=>{ $(`page-${p}`).hidden=p!==name; });
  document.querySelectorAll("#mainNav [data-page]").forEach(btn=>{
    btn.classList.toggle("active",btn.dataset.page===name);
    btn.setAttribute("aria-current",btn.dataset.page===name ? "page" : "false");
  });
  if(location.hash!=="#"+name) history.replaceState(null,"","#"+name);

  if(name==="estimates") renderSavedEstimates();
  else if(name==="services") renderServicesPage();
  else if(name==="crm") renderCrmBoard();
  else if(name==="invoices") renderInvoicesPage();
  else if(name==="settings") loadSettingsForm();
  else if(name==="builder") updateBuilderMeta();
  window.scrollTo(0,0);
}

function wireEvents(){
  $("mainNav").addEventListener("click",e=>{
    const btn=e.target.closest("[data-page]");
    if(btn) showPage(btn.dataset.page);
  });

  // Estimate Builder
  $("builderSections").addEventListener("click",handleBuilderClick);
  $("builderSections").addEventListener("input",handleBuilderInput);
  $("builderSections").addEventListener("change",handleBuilderInput);
  ["estMarkup","estTaxRate"].forEach(id=>$(id).addEventListener("input",updateBuilderTotals));
  $("builderMeta").addEventListener("click",e=>{
    const btn=e.target.closest("[data-action]");
    if(!btn) return;
    if(btn.dataset.action==="open-crm" && BUILDER.crmProjectId){ showPage("crm"); openProjectModal(BUILDER.crmProjectId); }
    if(btn.dataset.action==="create-crm" && BUILDER.id){
      // The CRM project takes its estimate number and total from the saved estimate.
      if(hasUnsavedChanges() && !saveEstimate()) return;
      createOrOpenCrmFromEstimate(BUILDER.id);
    }
  });
  $("btnSaveEstimate").addEventListener("click",saveEstimate);
  $("btnPrint").addEventListener("click",printEstimate);
  $("btnPdf").addEventListener("click",downloadEstimatePdf);
  $("btnSign").hidden=!signServiceUrl();
  $("btnSign").addEventListener("click",sendEstimateForSignature);
  $("btnEmail").addEventListener("click",emailEstimate);
  $("btnReset").addEventListener("click",resetBuilder);
  $("pmPhotos").addEventListener("photos-changed",()=>fillCrmPhotoCounts());
  $("customServiceForm").addEventListener("submit",e=>{ e.preventDefault(); submitCustomService(); });
  $("categoryForm").addEventListener("submit",e=>{ e.preventDefault(); submitAddCategory(); });
  $("catExisting").addEventListener("change",()=>{ $("catNewField").hidden=!!$("catExisting").value; });

  // Saved Estimates
  $("estimateSearch").addEventListener("input",renderSavedEstimates);
  $("estimateStatusFilter").addEventListener("change",renderSavedEstimates);
  $("estimateAddressFilter").addEventListener("change",renderSavedEstimates);
  $("estimatesBody").addEventListener("click",handleEstimatesAction);
  $("estimatesBody").addEventListener("change",handleEstimatesAction);
  $("btnNewEstimate").addEventListener("click",()=>{
    if(!confirmDiscardChanges()) return;
    newEstimate();
    showPage("builder");
  });

  // Services
  $("serviceSearch").addEventListener("input",renderServicesPage);
  $("serviceCategoryFilter").addEventListener("change",renderServicesPage);
  $("servicesBody").addEventListener("click",handleServicesAction);
  $("btnAddService").addEventListener("click",()=>openServiceForm(null));
  $("btnAddCategory").addEventListener("click",addCategoryFromServicesPage);
  $("categoriesList").addEventListener("click",handleCategoriesCard);
  $("serviceForm").addEventListener("submit",e=>{ e.preventDefault(); submitServiceForm(); });

  // CRM
  $("crmSearch").addEventListener("input",renderCrmBoard);
  $("crmAddressFilter").addEventListener("change",renderCrmBoard);
  $("crmFolder").addEventListener("change",renderCrmBoard);
  $("crmBoard").addEventListener("click",handleCrmBoard);
  $("crmBoard").addEventListener("change",handleCrmBoard);
  $("btnNewLead").addEventListener("click",()=>openProjectModal(null));
  $("projectForm").addEventListener("submit",e=>{ e.preventDefault(); saveProjectForm(); });
  $("projectModal").addEventListener("click",handleProjectModalClick);
  $("projectModal").addEventListener("change",handleProjectModalChange);
  $("pmDelete").addEventListener("click",()=>{ if(EDITING_PROJECT_ID) deleteProject(EDITING_PROJECT_ID); });

  // Settings
  $("settingsForm").addEventListener("submit",e=>{ e.preventDefault(); saveSettings(); });
  $("btnResetSettings").addEventListener("click",resetSettings);
  $("btnDefaultTerms").addEventListener("click",restoreDefaultTerms);
  $("btnDefaultSignTexts").addEventListener("click",restoreDefaultSignTexts);

  // Modals: close buttons and Escape
  document.querySelectorAll("[data-close]").forEach(btn=>btn.addEventListener("click",()=>closeModal(btn.dataset.close)));
  document.addEventListener("keydown",e=>{
    if(e.key==="Escape") document.querySelectorAll(".modal.open").forEach(m=>closeModal(m.id));
  });

  window.addEventListener("hashchange",()=>showPage(location.hash.slice(1)));
  window.addEventListener("beforeunload",e=>{
    if(!MAILTO_OPENING && hasUnsavedChanges()){ e.preventDefault(); e.returnValue=""; }
  });
}

// Address fields with Google Places verification (one controller per field).
let BUILDER_ADDRESS = null;
let PROJECT_ADDRESS = null;

function init(){
  BUILDER_ADDRESS=new AddressField($("projectAddress"));
  PROJECT_ADDRESS=new AddressField($("pmAddress"));
  renderBrand();
  loadServices(); // creates the default services on first run
  loadCustomCategories(); // migrates the old fixed "Other Services" category if it was used
  wireEvents();
  wirePhotoEvents();
  wireImportEvents();
  wireInvoiceEvents();
  wireMailEvents();
  wireCloudEvents();
  newEstimate();
  showPage(location.hash.slice(1) || "builder");
  cleanupOrphanPhotos();
  initCloud(); // shared cloud data (only when configured)
}

init();
