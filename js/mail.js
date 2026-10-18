/* Sending estimates and invoices from the company Gmail through the Base44 server function
   "sendEmail" (base44/functions/sendEmail.js; Gmail connected in Base44). The PDF is made here from
   the print layout and attached. When it is off (config emailFromCrm) or the person is signed out,
   the Email button opens Gmail as before (openMailto). */

const HTML2PDF_CDN = "https://cdn.jsdelivr.net/npm/html2pdf.js@0.14.0/dist/html2pdf.bundle.min.js";
let SEND_MAIL = null; // the email being sent: {to, subject, text, filename, render, fallback, onSent}

// The CRM can send by itself when it is switched on and this person is signed in with CRM access.
function canSendFromCrm(){
  return !!((window.EVERCRAFT_CONFIG || {}).emailFromCrm && CLOUD.client && CLOUD.client.functions && CLOUD.role);
}

// Calls the Base44 "sendEmail" function; returns its answer, or {error} with the reason.
async function callSendEmail(payload){
  try{
    const r=await CLOUD.client.functions.invoke("sendEmail",payload);
    return (r && r.data !== undefined) ? r.data : (r || {});
  }catch(e){
    const data=e && e.response && e.response.data;
    const status=(e && (e.status || (e.response && e.response.status))) || 0;
    return {error:(data && (data.error || data.message)) || (status ? `The email was not sent (${status}).` : "The email was not sent: Base44 could not be reached. Check the internet connection, or use \"Open in Gmail instead\".")};
  }
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
  callSendEmail({action:"status"}).then(s=>{
    if(SEND_MAIL!==mail) return;
    if(s && s.connected){
      $("smFrom").textContent=`From: ${s.sender} (company Gmail)`;
    }else{
      $("smFrom").textContent="From: the company Gmail";
      $("smSend").disabled=true;
      setSendStatus("The company Gmail is not connected to the CRM yet. Use \"Open in Gmail instead\".",true);
    }
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
    const res=await callSendEmail({action:"send",to,subject,text,fromName:SETTINGS.companyName,attachment});
    if(!res || !res.ok){ setSendStatus((res && res.error) || "The email was not sent.",true); return; }
    closeModal("sendMailModal");
    SEND_MAIL=null;
    showToast(`Sent to ${res.to || to} from ${res.from || "the company Gmail"}.`);
    if(mail.onSent) mail.onSent();
  }catch(e){
    setSendStatus("The email was not sent: the PDF could not be made. Use \"Open in Gmail instead\".",true);
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
