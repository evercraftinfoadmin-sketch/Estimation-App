/* Sending estimates and invoices from the company Gmail through the CRM mail service
   (worker/ on Cloudflare). The PDF is made here from the print layout and attached.
   Without the service (or signed out) the Email button opens Gmail as before (openMailto). */

const HTML2PDF_CDN = "https://cdn.jsdelivr.net/npm/html2pdf.js@0.14.0/dist/html2pdf.bundle.min.js";
let SEND_MAIL = null; // the email being sent: {to, subject, text, filename, render, attach, sign, fallback, onSent}
// mail.sign (optional): {label, create:async()=>({url}|{error}), text:url=>string} adds a document to sign.

function mailServiceUrl(){
  return String((window.EVERCRAFT_CONFIG || {}).mailServiceUrl || "").trim().replace(/\/+$/,"");
}

function cloudSignInToken(){
  try{ return localStorage.getItem(CLOUD_TOKEN_KEY) || ""; }catch(e){ return ""; }
}

// The CRM can send by itself when the mail service is set up and this person is signed in with CRM access.
function canSendFromCrm(){
  return !!(mailServiceUrl() && cloudConfig().appId && CLOUD.role && cloudSignInToken());
}

// The PDF library draws the whole document as one tall picture, then slices it into pages.
// Phones (iPhone Safari above all) cannot make very large pictures: they hand back an empty
// one and the PDF comes out blank or cannot be opened. So the picture is kept within a safe
// size, checked before it goes into the PDF, and made again at a lower resolution if needed.
const PDF_MAX_CANVAS_AREA = 12e6;   // pixels; iOS refuses canvases above ~16.7 million
const PDF_MAX_CANVAS_SIDE = 16000;  // pixels per side

function pdfCanvasScale(width, height, max=2){
  const w=Math.max(1,width), h=Math.max(1,height);
  // The size limits always win: a low-resolution PDF can be read, a blank one cannot.
  return Math.min(max, Math.sqrt(PDF_MAX_CANVAS_AREA/(w*h)), PDF_MAX_CANVAS_SIDE/h, PDF_MAX_CANVAS_SIDE/w);
}

// Does this strip of the canvas have anything on it (not just white)? Checked on a small copy.
function pdfCanvasHasInk(canvas, y=0, height){
  try{
    const h=Math.max(0,Math.min(height ?? canvas.height, canvas.height-y));
    if(!canvas.width || !h) return false;
    const small=document.createElement("canvas");
    small.width=120; small.height=Math.max(1,Math.min(600,Math.round(120*h/canvas.width)));
    const ctx=small.getContext("2d");
    ctx.fillStyle="#fff"; ctx.fillRect(0,0,small.width,small.height);
    ctx.drawImage(canvas,0,y,canvas.width,h,0,0,small.width,small.height);
    const px=ctx.getImageData(0,0,small.width,small.height).data;
    for(let i=0;i<px.length;i+=4) if(px[i]<235 || px[i+1]<235 || px[i+2]<235) return true;
    return false;
  }catch(e){ return false; }
}

async function renderPdf(el, scale, title){
  let worker=window.html2pdf().set({
    margin:[12,12,12,12],
    image:{type:"jpeg",quality:0.92},
    html2canvas:{scale,backgroundColor:"#ffffff",logging:false},
    jsPDF:{unit:"mm",format:"letter",orientation:"portrait"},
    pagebreak:{mode:["css","legacy"],avoid:[".pv-section",".pv-totals",".pv-message","tr"]}
  }).from(el).toCanvas();
  const canvas=await worker.get("canvas");
  if(!pdfCanvasHasInk(canvas)) return null; // the device could not draw it
  worker=worker.toPdf();
  const pdf=await worker.get("pdf");
  // A last page that is only a few empty pixels (the document ran just past a page) is dropped.
  const pageSize=await worker.get("pageSize");
  const pagePx=Math.floor(canvas.width*pageSize.inner.ratio);
  const rest=canvas.height%pagePx, pages=pdf.getNumberOfPages();
  if(pages>1 && rest>0 && rest<pagePx*0.04 && !pdfCanvasHasInk(canvas,canvas.height-rest,rest)) pdf.deletePage(pages);
  pdf.setProperties({title, subject:title, author:companyName(), creator:companyName()});
  return String(pdf.output("datauristring")).split(",")[1] || "";
}

function isValidPdfBase64(b64){
  try{
    if(!b64 || b64.length<1000 || b64.length%4) return false;
    return atob(b64.slice(0,8)).startsWith("%PDF-") && atob(b64.slice(-64)).includes("%%EOF");
  }catch(e){ return false; }
}

// PDF of the print layout that render() puts into #printView, as base64.
async function makePdfBase64(render, title){
  render();
  if(!window.html2pdf) await loadScript(HTML2PDF_CDN);
  const holder=document.createElement("div");
  holder.className="pdf-holder";
  holder.innerHTML=`<div class="pdf-page">${$("printView").innerHTML}</div>`;
  document.body.appendChild(holder);
  try{
    const el=holder.firstElementChild;
    const docTitle=title || (document.title || "Document");
    const scale=pdfCanvasScale(el.offsetWidth,el.scrollHeight);
    let b64=await renderPdf(el,scale,docTitle);
    if(!isValidPdfBase64(b64) && scale>1) b64=await renderPdf(el,1,docTitle);
    if(!isValidPdfBase64(b64)) throw new Error("The PDF could not be made on this device.");
    return b64;
  }finally{
    holder.remove();
  }
}

// Hands a PDF to the person: on a phone or tablet the share sheet (Save to Files, Mail,
// open in Books…), which works in more phone browsers than a download link; elsewhere a download.
async function savePdfFile(base64, filename){
  const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
  const blob=new Blob([bytes],{type:"application/pdf"});
  const touch=window.matchMedia && matchMedia("(pointer:coarse)").matches;
  if(touch && navigator.share && typeof File==="function"){
    const file=new File([blob],filename,{type:"application/pdf"});
    if(!navigator.canShare || navigator.canShare({files:[file]})){
      try{ await navigator.share({files:[file],title:filename}); return "shared"; }
      catch(e){ if(e && e.name==="AbortError") return "cancelled"; } // otherwise: download instead
    }
  }
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=url; a.download=filename; a.rel="noopener";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60000);
  return "downloaded";
}

// Saves the print layout that render() puts into #printView as a PDF file.
async function downloadPdf(render, filename){
  showToast("Making the PDF…");
  let base64;
  try{
    base64=await makePdfBase64(render,filename.replace(/\.pdf$/i,""));
  }catch(e){
    alert("The PDF could not be made on this device. Use Print / PDF instead.");
    return;
  }
  const how=await savePdfFile(base64,filename);
  if(how!=="cancelled") showToast(how==="shared" ? `${filename} is ready.` : `Saved ${filename}`);
}

function setSendStatus(text, isError){
  const el=$("smStatus");
  el.textContent=text || "";
  el.classList.toggle("import-error",!!isError);
}

// Opens the "Send email" window. mail: {title, to, subject, text, filename, render, fallback, onSent}
// The short text goes with the PDF; without the PDF the full text is used (mail.textWithoutPdf).
function sendMailAutoText(mail, withPdf){
  return (!withPdf && mail.textWithoutPdf) ? mail.textWithoutPdf : (mail.text || "");
}

// Ticking or unticking "Attach PDF" swaps the text, unless the person has edited it.
function handleSendMailAttachChange(){
  const mail=SEND_MAIL;
  if(!mail || !mail.textWithoutPdf) return;
  const withPdf=$("smAttach").checked;
  if($("smText").value===sendMailAutoText(mail,!withPdf)) $("smText").value=sendMailAutoText(mail,withPdf);
}

function openSendMail(mail){
  SEND_MAIL=mail;
  $("smTitle").textContent=mail.title || "Send email";
  $("smTo").value=mail.to || "";
  $("smSubject").value=mail.subject || "";
  $("smAttach").checked=mail.attach!==false;
  $("smText").value=sendMailAutoText(mail,$("smAttach").checked);
  $("smSignRow").hidden=!mail.sign;
  if(mail.sign){ $("smSignLabel").textContent=mail.sign.label; $("smSign").checked=true; }
  $("smFile").textContent=mail.filename;
  $("smFrom").textContent="From: the company Gmail (checking…)";
  $("smSend").disabled=false;
  setSendStatus("");
  openModal("sendMailModal");
  fetch(mailServiceUrl()+"/status").then(r=>r.json()).then(s=>{
    if(SEND_MAIL!==mail) return;
    if(s && s.connected){
      $("smFrom").textContent=`From: ${s.sender} (company Gmail)`;
    }else{
      $("smFrom").textContent="From: the company Gmail";
      $("smSend").disabled=true;
      setSendStatus("The company Gmail is not connected to the CRM yet. Use \"Open in Gmail instead\".",true);
    }
  }).catch(()=>{
    if(SEND_MAIL===mail) $("smFrom").textContent="From: the company Gmail";
  });
}

// Creates the signing link when "include for signature" is ticked; returns the text to add, or null (status shown).
async function sendMailSignText(mail){
  if(!mail.sign || !$("smSign").checked) return "";
  setSendStatus("Preparing the document for signature…");
  const res=await mail.sign.create();
  if(!res || !res.url){ setSendStatus((res && res.error) || "The document for signature could not be prepared.",true); return null; }
  return mail.sign.text(res.url);
}

async function submitSendMail(event){
  event.preventDefault();
  const mail=SEND_MAIL;
  if(!mail) return;
  const to=$("smTo").value.trim(), subject=$("smSubject").value.trim();
  let text=$("smText").value;
  if(!to || !$("smTo").checkValidity()){ setSendStatus("Enter the client's email address.",true); $("smTo").focus(); return; }
  if(!subject){ setSendStatus("Enter a subject.",true); $("smSubject").focus(); return; }
  const btn=$("smSend");
  btn.disabled=true;
  try{
    const signText=await sendMailSignText(mail);
    if(signText===null) return;
    text+=signText;
    let attachment=null;
    if($("smAttach").checked){
      setSendStatus("Making the PDF…");
      let base64;
      try{ base64=await makePdfBase64(mail.render,String(mail.filename||"").replace(/\.pdf$/i,"")); }
      catch(e){ setSendStatus("The PDF could not be made on this device. Try again on a computer, or untick \"Attach PDF\".",true); return; }
      attachment={filename:mail.filename,base64};
    }
    setSendStatus("Sending…");
    const r=await fetch(mailServiceUrl()+"/send",{
      method:"POST",
      headers:{"Content-Type":"application/json",Authorization:"Bearer "+cloudSignInToken()},
      body:JSON.stringify({appId:cloudConfig().appId,to,subject,text,fromName:SETTINGS.companyName,attachment})
    });
    const res=await r.json().catch(()=>({}));
    if(!r.ok || !res.ok){ setSendStatus(res.error || `The email was not sent (${r.status}).`,true); return; }
    closeModal("sendMailModal");
    SEND_MAIL=null;
    showToast(`Sent to ${res.to || to} from ${res.from || "the company Gmail"}.`);
    if(mail.onSent) mail.onSent();
  }catch(e){
    setSendStatus("The email was not sent: the mail service could not be reached. Check the internet connection, or use \"Open in Gmail instead\".",true);
  }finally{
    btn.disabled=false;
  }
}

function wireMailEvents(){
  $("sendMailForm").addEventListener("submit",submitSendMail);
  $("smAttach").addEventListener("change",handleSendMailAttachChange);
  $("smGmail").addEventListener("click",async()=>{
    const mail=SEND_MAIL;
    if(!mail) return;
    const signText=await sendMailSignText(mail);
    if(signText===null) return;
    closeModal("sendMailModal");
    SEND_MAIL=null;
    if(mail.fallback) mail.fallback({to:$("smTo").value.trim(),subject:$("smSubject").value.trim(),extraText:signText});
  });
}
