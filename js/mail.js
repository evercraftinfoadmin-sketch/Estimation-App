/* Sending estimates and invoices from the company Gmail through the CRM mail service
   (worker/ on Cloudflare). The PDF is made here from the print layout and attached.
   Without the service (or signed out) the Email button opens Gmail as before (openMailto). */

const HTML2PDF_CDN = "https://cdn.jsdelivr.net/npm/html2pdf.js@0.14.0/dist/html2pdf.bundle.min.js";
let SEND_MAIL = null; // the email being sent: {to, subject, text, filename, render, fallback, onSent}

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

// PDF of the print layout that render() puts into #printView, as base64.
async function makePdfBase64(render){
  render();
  if(!window.html2pdf) await loadScript(HTML2PDF_CDN);
  const holder=document.createElement("div");
  holder.className="pdf-holder";
  holder.innerHTML=`<div class="pdf-page">${$("printView").innerHTML}</div>`;
  document.body.appendChild(holder);
  try{
    const uri=await window.html2pdf().set({
      margin:[12,12,12,12],
      image:{type:"jpeg",quality:0.92},
      html2canvas:{scale:2,backgroundColor:"#ffffff",logging:false},
      jsPDF:{unit:"mm",format:"letter",orientation:"portrait"},
      pagebreak:{mode:["css","legacy"],avoid:[".pv-section",".pv-totals",".pv-message","tr"]}
    }).from(holder.firstElementChild).outputPdf("datauristring");
    return String(uri).split(",")[1] || "";
  }finally{
    holder.remove();
  }
}

// Saves the print layout that render() puts into #printView as a PDF file.
async function downloadPdf(render, filename){
  showToast("Making the PDF…");
  try{
    const base64=await makePdfBase64(render);
    const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
    const url=URL.createObjectURL(new Blob([bytes],{type:"application/pdf"}));
    const a=document.createElement("a");
    a.href=url; a.download=filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),10000);
    showToast(`Saved ${filename}`);
  }catch(e){
    alert("The PDF could not be made. Use Print / PDF instead.");
  }
}

function setSendStatus(text, isError){
  const el=$("smStatus");
  el.textContent=text || "";
  el.classList.toggle("import-error",!!isError);
}

// Opens the "Send email" window. mail: {title, to, subject, text, filename, render, fallback, onSent}
function openSendMail(mail){
  SEND_MAIL=mail;
  $("smTitle").textContent=mail.title || "Send email";
  $("smTo").value=mail.to || "";
  $("smSubject").value=mail.subject || "";
  $("smText").value=mail.text || "";
  $("smAttach").checked=true;
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

async function submitSendMail(event){
  event.preventDefault();
  const mail=SEND_MAIL;
  if(!mail) return;
  const to=$("smTo").value.trim(), subject=$("smSubject").value.trim(), text=$("smText").value;
  if(!to || !$("smTo").checkValidity()){ setSendStatus("Enter the client's email address.",true); $("smTo").focus(); return; }
  if(!subject){ setSendStatus("Enter a subject.",true); $("smSubject").focus(); return; }
  const btn=$("smSend");
  btn.disabled=true;
  try{
    let attachment=null;
    if($("smAttach").checked){
      setSendStatus("Making the PDF…");
      attachment={filename:mail.filename,base64:await makePdfBase64(mail.render)};
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
  $("smGmail").addEventListener("click",()=>{
    const mail=SEND_MAIL;
    closeModal("sendMailModal");
    SEND_MAIL=null;
    if(mail && mail.fallback) mail.fallback({to:$("smTo").value.trim(),subject:$("smSubject").value.trim()});
  });
}
