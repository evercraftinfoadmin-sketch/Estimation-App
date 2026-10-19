"use strict";

/* Electronic signatures through the CRM signing service (worker/src/sign.js):
   - Estimate: "Send for Signature" in the Estimate Builder (the estimate + an acceptance text).
   - Work Authorization: offered when a job moves to "Start the Project" (and a card button).
   - Certificate of Completion: included with the invoice email (and a card button).
   The client gets a link, reads the document, draws a signature and signs. The CRM keeps each
   request in the estimate's / project's "signatures" list, checks its status and downloads the
   signed PDF (document + signature + audit trail). Off while config signServiceUrl is empty. */

const SIGN_TYPES = {
  estimate:{label:"Estimate", short:"Estimate"},
  work_authorization:{label:"Work Authorization", short:"Work Auth."},
  completion:{label:"Certificate of Completion", short:"Completion"}
};
const SIGN_REFRESH_MS = 60000;
let SIGN_LAST_REFRESH = 0;
let SIGN_REFRESHING = false;

function signServiceUrl(){
  return String((window.EVERCRAFT_CONFIG || {}).signServiceUrl || "").trim().replace(/\/+$/,"");
}

function canSign(){
  return !!(signServiceUrl() && cloudConfig().appId && CLOUD.role && cloudSignInToken());
}

function normalizeSignatures(list){
  if(!Array.isArray(list)) return [];
  return list.filter(s=>s && /^[0-9a-f]{64}$/.test(String(s.id)) && SIGN_TYPES[s.type]).slice(-20).map(s=>({
    id:String(s.id), type:s.type, title:String(s.title ?? ""),
    status:["pending","signed","cancelled"].includes(s.status) ? s.status : "pending",
    url:String(s.url ?? ""), sentTo:String(s.sentTo ?? ""),
    createdAt:String(s.createdAt ?? ""), signedAt:String(s.signedAt ?? ""), signerName:String(s.signerName ?? "")
  }));
}

// The newest request of a type (signed ones win over later withdrawn ones).
function latestSignature(list, type){
  const of=(list || []).filter(s=>s.type===type && s.status!=="cancelled");
  return of.find(s=>s.status==="signed") || of[of.length-1] || null;
}

/* ---------- Documents ---------- */

function signValues({estimate, project, invoice}){
  const e=estimate || {}, p=project || {}, inv=invoice || {};
  const totals=invoice ? computeInvoice(invoice) : null;
  return {
    client:inv.clientName || e.clientName || p.clientName || "",
    address:inv.address || e.address || p.address || "",
    company:companyName(),
    license:SETTINGS.licenseNumber || "",
    phone:SETTINGS.companyPhone || "",
    email:SETTINGS.companyEmail || "",
    estimateNumber:e.estimateNumber || p.estimateNumber || inv.estimateNumber || "",
    estimateDate:e.date ? formatDate(e.date) : "",
    total:e.customerTotal!==undefined ? money(e.customerTotal) : (p.estimateTotal ? money(p.estimateTotal) : ""),
    startDate:p.scheduledDate ? formatDate(p.scheduledDate) : "as scheduled",
    invoiceNumber:inv.invoiceNumber || "",
    balance:totals ? money(totals.balance) : "",
    date:formatDate(new Date().toISOString().slice(0,10))
  };
}

function fillSignText(text, values){
  return String(text || "").replace(/\{\{(\w+)\}\}/g,(m,k)=>k in values ? (values[k] || "—") : m);
}

// Plain text → document HTML: blank lines separate paragraphs; an all-capitals first line is the heading.
function signTextHtml(text){
  return String(text).trim().split(/\n\s*\n/).map((para,i)=>{
    const t=para.trim();
    if(i===0 && t===t.toUpperCase() && /[A-Z]/.test(t) && !t.includes("\n")) return `<h3>${escapeHtml(t)}</h3>`;
    return `<p>${escapeHtml(t).replace(/\n/g,"<br>")}</p>`;
  }).join("");
}

function signDocHtml(docTitle, values, metaRows, text){
  const contact=companyContactParts().map(escapeHtml).join(" · ");
  return `<div class="pv pv-signdoc">
    <header class="pv-header">
      <div><div class="pv-company">${escapeHtml(companyName())}</div><div class="pv-muted">${contact}</div></div>
      <div class="pv-title"><div class="pv-doc">${escapeHtml(docTitle.toUpperCase())}</div>
        <table class="pv-meta">${metaRows.filter(r=>r[1]).map(([k,v])=>`<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join("")}</table></div>
    </header>
    <div class="pv-parties">
      <div><h4>Client</h4><div><b>${escapeHtml(values.client || "—")}</b></div></div>
      <div><h4>Project Address</h4><div>${escapeHtml(values.address || "—")}</div></div>
    </div>
    <section class="pv-sign-text">${signTextHtml(fillSignText(text,values))}</section>
  </div>`;
}

function estimateSignHtml(d, est){
  renderPrintView(d);
  const v=signValues({estimate:{...est, customerTotal:d.grandTotal, date:d.date, estimateNumber:d.estimateNumber, address:d.address, clientName:d.clientName}});
  return $("printView").innerHTML+`<section class="pv pv-sign-text">${signTextHtml(fillSignText(SETTINGS.signTextEstimate,v))}</section>`;
}

function workAuthorizationHtml(p){
  const est=getEstimate(p.estimateId);
  const v=signValues({estimate:est, project:p});
  return signDocHtml("Work Authorization",v,[["Estimate #",v.estimateNumber],["Total",v.total],["Start",p.scheduledDate?formatDate(p.scheduledDate):""],["Date",v.date]],SETTINGS.signTextWork);
}

function completionHtml(p, inv){
  const est=getEstimate((inv && inv.estimateId) || (p && p.estimateId));
  const v=signValues({estimate:est, project:p, invoice:inv});
  return signDocHtml("Certificate of Completion",v,[["Invoice #",v.invoiceNumber],["Estimate #",v.estimateNumber],["Balance due",v.balance],["Date",v.date]],SETTINGS.signTextCompletion);
}

// The document-layout styles the signing page needs (js/docstyles.js).
function signDocCss(){ return DOC_CSS; }

/* ---------- Service calls ---------- */

async function signCall(path, payload){
  try{
    const r=await fetch(signServiceUrl()+path,{method:"POST",
      headers:{"Content-Type":"application/json",Authorization:"Bearer "+cloudSignInToken()},
      body:JSON.stringify({appId:cloudConfig().appId,...payload})});
    const res=await r.json().catch(()=>({}));
    return r.ok ? res : {error:res.error || `The signing service answered ${r.status}.`};
  }catch(e){
    return {error:"The signing service could not be reached. Check the internet connection."};
  }
}

// Creates a signing request and records it on the estimate or project. {url, entry} or {error}.
async function createSignRequest({type, title, html, clientName, clientEmail, ref, estimateId, projectId}){
  const res=await signCall("/sign/create",{type,title,html,css:signDocCss(),clientName,clientEmail,company:companyName(),ref});
  if(res.error) return res;
  const entry={id:res.id,type,title,status:"pending",url:res.url,sentTo:clientEmail||"",createdAt:res.createdAt,signedAt:"",signerName:""};
  if(estimateId){ const e=getEstimate(estimateId); if(e) updateEstimate(estimateId,{signatures:[...e.signatures,entry],updatedAt:nowISO()}); }
  if(projectId){ const p=getProject(projectId); if(p) updateProject(projectId,{signatures:[...p.signatures,entry]}); }
  return {url:res.url, entry};
}

function signEmailText(name, docLabel, url){
  return `Hello ${name || "there"},\n\nPlease review and sign the ${docLabel} from ${companyName()} here:\n${url}\n\n`+
    `Open the link, check the details, draw your signature and press "Sign document". It takes about a minute, on a phone or a computer. `+
    `You will receive a copy of the signed document.\n\nBest regards,\n${[SETTINGS.companyName,...companyContactParts()].join("\n")}`;
}

function signLinkLine(docLabel, url){
  return `\n\nPlease also review and sign the ${docLabel}:\n${url}\n`;
}

// Emails a signing link: Send window when the CRM sends email itself, otherwise Gmail / the mail app.
function sendSignLink({to, subject, text, title, pdfName, render}){
  const viaGmail=(t=to,s=subject)=>openMailto(t,s,text);
  if(canSendFromCrm()){
    openSendMail({title, to, subject, text, filename:pdfName, render, attach:!!render, fallback:({to:t,subject:s})=>viaGmail(t,s)});
  }else{
    viaGmail();
  }
}

/* ---------- The three flows ---------- */

function signNotReadyMessage(){
  if(!signServiceUrl()) return "Electronic signatures are not switched on yet.";
  return "Sign in to the shared CRM (☁ button) to send documents for signature.";
}

async function sendEstimateForSignature(){
  if(!canSign()){ alert(signNotReadyMessage()); return; }
  const d0=getEstimateData();
  if(!d0.clientEmail){ alert("Please enter the client's email address."); showPage("builder"); $("clientEmail").focus(); return; }
  if(!BUILDER.id || hasUnsavedChanges()){
    if(!confirm("The estimate is saved first, so the client signs exactly what is saved. Save now?")) return;
    if(!saveEstimate()) return;
  }
  const d=getEstimateData(), est=getEstimate(BUILDER.id);
  const prior=latestSignature(est.signatures,"estimate");
  if(prior && prior.status==="signed" && !confirm(`This estimate was already signed by ${prior.signerName} on ${formatDate(prior.signedAt.slice(0,10))}. Send a new copy for signature anyway?`)) return;
  showToast("Preparing the estimate for signature…");
  const title=`Estimate ${d.estimateNumber}${d.address?` - ${d.address}`:""}`;
  const res=await createSignRequest({type:"estimate",title,html:estimateSignHtml(d,est),clientName:d.clientName,clientEmail:d.clientEmail,
    ref:{estimateId:est.id,estimateNumber:d.estimateNumber,projectId:est.crmProjectId||""},estimateId:est.id});
  if(res.error){ alert(res.error); return; }
  issueEstimateNumber(d.estimateNumber);
  sendSignLink({to:d.clientEmail,subject:`Please sign: ${companyName()} Estimate ${d.estimateNumber}`,
    text:signEmailText(d.clientName,`estimate ${d.estimateNumber}`,res.url),title:`Send estimate ${d.estimateNumber} for signature`,
    pdfName:estimatePdfName(d),render:()=>renderPrintView(d)});
  renderCrmBoard();
}

async function sendProjectDocument(projectId, type){
  if(!canSign()){ alert(signNotReadyMessage()); return; }
  const p=getProject(projectId);
  if(!p) return;
  const inv=invoicesForProject(p.id)[0] || null;
  const email=p.clientEmail || (getEstimate(p.estimateId)||{}).clientEmail || (inv||{}).clientEmail || "";
  if(!email){ alert("Add the client's email address to this lead first (Edit)."); return; }
  if(type==="completion" && !inv && !confirm("There is no invoice for this job yet. Send the Certificate of Completion without an invoice number?")) return;
  showToast(`Preparing the ${SIGN_TYPES[type].label}…`);
  const html=type==="work_authorization" ? workAuthorizationHtml(p) : completionHtml(p,inv);
  const title=`${SIGN_TYPES[type].label}${p.estimateNumber?` - ${p.estimateNumber}`:""}${p.address?` - ${p.address}`:""}`;
  const res=await createSignRequest({type,title,html,clientName:p.clientName,clientEmail:email,
    ref:{projectId:p.id,estimateNumber:p.estimateNumber,invoiceNumber:(inv||{}).invoiceNumber||""},projectId:p.id});
  if(res.error){ alert(res.error); return; }
  sendSignLink({to:email,subject:`Please sign: ${SIGN_TYPES[type].label} - ${companyName()}`,
    text:signEmailText(p.clientName,SIGN_TYPES[type].label,res.url),title:`Send ${SIGN_TYPES[type].label} for signature`,
    pdfName:"",render:null});
  renderCrmBoard();
}

// Offered right after a job moves to "Start the Project".
function offerWorkAuthorization(projectId){
  const p=getProject(projectId);
  if(!p || !canSign()) return;
  const prior=latestSignature(p.signatures,"work_authorization");
  if(prior && prior.status==="signed") return;
  if(confirm(`Send the Work Authorization to ${p.clientName || "the client"} for signature now?`)) sendProjectDocument(projectId,"work_authorization");
}

// For the invoice Send window: adds the Certificate of Completion link to the email.
function completionSignOption(inv){
  const p=getProject(inv && inv.crmProjectId);
  if(!p || !canSign()) return null;
  const prior=latestSignature(p.signatures,"completion");
  if(prior && prior.status==="signed") return null;
  return {
    label:"Include the Certificate of Completion for signature",
    create:async()=>{
      const title=`Certificate of Completion - ${inv.invoiceNumber}${p.address?` - ${p.address}`:""}`;
      return createSignRequest({type:"completion",title,html:completionHtml(p,inv),clientName:inv.clientName||p.clientName,
        clientEmail:inv.clientEmail||p.clientEmail,ref:{projectId:p.id,invoiceNumber:inv.invoiceNumber,estimateNumber:p.estimateNumber},projectId:p.id});
    },
    text:url=>signLinkLine("Certificate of Completion (it confirms the work is finished)",url)
  };
}

/* ---------- Status and signed copies ---------- */

// Checks pending requests with the service (at most once a minute) and saves any change.
async function refreshSignatures(force){
  if(!canSign() || SIGN_REFRESHING || (!force && Date.now()-SIGN_LAST_REFRESH<SIGN_REFRESH_MS)) return false;
  const pending=[];
  loadProjects().forEach(p=>p.signatures.forEach(s=>{ if(s.status==="pending") pending.push(s.id); }));
  loadEstimates().forEach(e=>e.signatures.forEach(s=>{ if(s.status==="pending") pending.push(s.id); }));
  SIGN_LAST_REFRESH=Date.now();
  if(!pending.length) return false;
  SIGN_REFRESHING=true;
  try{
    const res=await signCall("/sign/status",{ids:[...new Set(pending)]});
    if(res.error || !Array.isArray(res.items)) return false;
    const byId=new Map(res.items.filter(i=>i.status!=="pending").map(i=>[i.id,i]));
    if(!byId.size) return false;
    const apply=list=>{ let changed=false; const out=list.map(s=>{ const i=byId.get(s.id); if(!i || s.status!=="pending") return s; changed=true; return {...s,status:i.status,signedAt:i.signedAt||"",signerName:i.signerName||""}; }); return changed ? out : null; };
    let any=false;
    loadProjects().forEach(p=>{ const n=apply(p.signatures); if(n){ updateProject(p.id,{signatures:n}); any=true; } });
    loadEstimates().forEach(e=>{ const n=apply(e.signatures); if(n){ updateEstimate(e.id,{signatures:n,updatedAt:nowISO()}); any=true; } });
    if(any){
      const signed=[...byId.values()].filter(i=>i.status==="signed");
      if(signed.length) showToast(signed.map(i=>`✍ ${i.signerName} signed ${i.title}`).join(" · "));
      if(!$("page-crm").hidden) renderCrmBoard();
    }
    return any;
  }finally{
    SIGN_REFRESHING=false;
  }
}

function signedCopyHtml(rec){
  const when=new Date(rec.signedAt);
  return `${rec.html}
    <section class="pv pv-signature">
      <h3>ELECTRONIC SIGNATURE</h3>
      <img src="${escapeHtml(rec.signature)}" alt="Signature">
      <div><b>${escapeHtml(rec.signerName)}</b> · signed ${escapeHtml(when.toLocaleString())} (${escapeHtml(when.toUTCString())})</div>
      <table class="pv-audit">
        <tr><td>Document</td><td>${escapeHtml(rec.title)}</td></tr>
        <tr><td>Fingerprint (SHA-256)</td><td>${escapeHtml(rec.docHash)}</td></tr>
        <tr><td>IP address</td><td>${escapeHtml(rec.ip || "")}</td></tr>
        <tr><td>Browser</td><td>${escapeHtml(rec.userAgent || "")}</td></tr>
        <tr><td>Sent to</td><td>${escapeHtml(rec.clientEmail || "")} · ${escapeHtml(new Date(rec.createdAt).toUTCString())}</td></tr>
        <tr><td>Agreement</td><td>${escapeHtml(rec.consent || "")}</td></tr>
      </table>
    </section>`;
}

async function downloadSignedPdf(id){
  const rec=await signCall("/sign/get",{id});
  if(rec.error){ alert(rec.error); return; }
  if(rec.status!=="signed"){ alert("This document is not signed yet."); return; }
  const name=`${rec.title} - signed.pdf`.replace(/[\\/:*?"<>|]+/g,"-");
  return downloadPdf(()=>{ $("printView").innerHTML=signedCopyHtml(rec); },name);
}

// Badges on a CRM card: estimate, Work Authorization, Certificate of Completion.
function signBadgesHtml(p){
  const est=getEstimate(p.estimateId);
  const rows=[["estimate",est ? est.signatures : []],["work_authorization",p.signatures],["completion",p.signatures]]
    .map(([type,list])=>{
      const s=latestSignature(list,type);
      if(!s) return "";
      const signed=s.status==="signed";
      return `<button type="button" class="sign-badge ${signed?"sign-done":"sign-wait"}" data-action="sign-doc" data-sign-id="${escapeHtml(s.id)}" data-sign-url="${escapeHtml(s.url)}"
        title="${escapeHtml(signed?`Signed by ${s.signerName}. Click to download the signed PDF.`:"Waiting for the client's signature. Click to copy the link.")}">✍ ${escapeHtml(SIGN_TYPES[type].short)}: ${signed?"signed ✓":"waiting"}</button>`;
    }).join("");
  return rows ? `<div class="kcard-signs">${rows}</div>` : "";
}

function handleSignBadge(btn){
  const id=btn.dataset.signId;
  if(btn.classList.contains("sign-done")){ downloadSignedPdf(id); return; }
  const url=btn.dataset.signUrl;
  try{ navigator.clipboard && navigator.clipboard.writeText(url).catch(()=>{}); }catch(e){}
  showToast("Signing link copied. Paste it in a message to the client if they did not get the email.");
  refreshSignatures(true);
}
