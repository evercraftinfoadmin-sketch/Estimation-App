// Electronic signatures for estimates, work authorizations and certificates of completion.
//
//   POST /sign/create   (CRM team)  store a document, get the client's signing link
//   POST /sign/status   (CRM team)  status of several documents
//   POST /sign/get      (CRM team)  one document with its signature and audit trail
//   POST /sign/cancel   (CRM team)  withdraw a document that is not signed yet
//   GET  /s/<token>     (client)    the signing page (or the signed copy)
//   POST /s/<token>     (client)    sign: typed name, drawn signature, consent
//
// Options: several estimates sent together as choices (Option A, B, C) share a group. The client
// signs one; the others are withdrawn at that moment, so two options can never both be signed.
//
// The link token is the only key to the page; storage uses its SHA-256 as the document id, so the
// id the CRM keeps cannot be turned back into a working link. The audit trail keeps the time, IP
// address, browser and a SHA-256 fingerprint of the exact document that was signed.

const TYPES = {
  estimate: "Estimate",
  work_authorization: "Work Authorization",
  completion: "Certificate of Completion"
};
const MAX_HTML = 600 * 1024;
const MAX_CSS = 120 * 1024;
const MAX_SIGNATURE = 300 * 1024;
const CONSENT = "I agree to sign this document electronically. My electronic signature has the same legal effect as my handwritten signature, and I can download or print a copy of this document.";

const enc = new TextEncoder();
async function sha256Hex(text) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const stripScripts = html => String(html)
  .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
  .replace(/<\/?(?:script|iframe|object|embed|link|meta|base|form)\b[^>]*>/gi, "")
  .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
const cleanCss = css => String(css).replace(/<\/?style[^>]*>/gi, "").replace(/@import[^;]*;/gi, "").replace(/url\s*\([^)]*\)/gi, "none");

async function load(env, id) {
  if (!/^[0-9a-f]{64}$/.test(id)) return null;
  const raw = await env.MAIL_KV.get("sig:" + id);
  try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
const save = (env, rec) => env.MAIL_KV.put("sig:" + rec.id, JSON.stringify(rec));
const summary = r => ({ id: r.id, type: r.type, title: r.title, status: r.status, createdAt: r.createdAt, signedAt: r.signedAt || "", signerName: r.signerName || "", cancelledAt: r.cancelledAt || "", group: r.group || "", option: r.option || "", chosenOption: r.chosenOption || "" });
const groupKey = (appId, group) => `sgroup:${appId}:${group}`;
async function groupIds(env, appId, group) {
  try { const v = JSON.parse((await env.MAIL_KV.get(groupKey(appId, group))) || "[]"); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}

export async function signRoutes(request, env, url, cors, h) {
  const p = url.pathname;
  const m = p.match(/^\/s\/([A-Za-z0-9_-]{30,64})$/);
  if (m) {
    const token = m[1];
    const rec = await load(env, await sha256Hex(token));
    if (request.method === "GET") return page(rec, token, env, h);
    if (request.method === "POST") return clientSign(request, rec, token, env, url, h);
    return null;
  }
  if (!p.startsWith("/sign/") || request.method !== "POST") return null;
  if (!cors) return h.json({ error: "This site may not use the signing service." }, 403, null);
  let body;
  try { body = await request.json(); } catch (e) { return h.json({ error: "Bad request." }, 400, cors); }
  const who = await h.teamMember(request, env, body);
  if (who.error) return h.json({ error: who.error }, who.status, cors);

  if (p === "/sign/create") {
    const type = String(body.type || "");
    if (!TYPES[type]) return h.json({ error: "Unknown document type." }, 400, cors);
    const title = String(body.title || TYPES[type]).replace(/[\r\n]+/g, " ").trim().slice(0, 200);
    const html = stripScripts(body.html || "");
    const css = cleanCss(body.css || "");
    const clientEmail = String(body.clientEmail || "").trim();
    if (!html.trim() || html.length > MAX_HTML) return h.json({ error: "The document is empty or too large." }, 400, cors);
    if (css.length > MAX_CSS) return h.json({ error: "The document style is too large." }, 400, cors);
    if (clientEmail && !h.EMAIL_RE.test(clientEmail)) return h.json({ error: "The client's email address is not valid." }, 400, cors);
    const group = /^[A-Za-z0-9_-]{6,64}$/.test(String(body.group || "")) ? String(body.group) : "";
    const option = group ? String(body.option || "").replace(/[\r\n<>]+/g, " ").trim().slice(0, 40) : "";
    const token = randomToken();
    const rec = {
      id: await sha256Hex(token), type, title, html, css,
      docHash: await sha256Hex(html),
      clientName: String(body.clientName || "").slice(0, 200), clientEmail,
      company: String(body.company || env.SENDER_NAME || "").slice(0, 200),
      ref: body.ref && typeof body.ref === "object" && JSON.stringify(body.ref).length <= 2000 ? JSON.parse(JSON.stringify(body.ref)) : {},
      appId: who.appId, createdBy: String(who.user.email || who.user.id || ""), createdAt: new Date().toISOString(),
      status: "pending",
      ...(group ? { group, option } : {})
    };
    await save(env, rec);
    if (group) {
      const ids = await groupIds(env, rec.appId, group);
      if (!ids.includes(rec.id)) ids.push(rec.id);
      await env.MAIL_KV.put(groupKey(rec.appId, group), JSON.stringify(ids.slice(-20)));
    }
    return h.json({ ok: true, id: rec.id, url: `${url.origin}/s/${token}`, createdAt: rec.createdAt, docHash: rec.docHash }, 200, cors);
  }
  if (p === "/sign/status") {
    const ids = Array.isArray(body.ids) ? body.ids.slice(0, 200).map(String) : [];
    const items = [];
    for (const id of ids) { const r = await load(env, id); if (r && r.appId === who.appId) items.push(summary(r)); }
    return h.json({ items }, 200, cors);
  }
  if (p === "/sign/get" || p === "/sign/cancel") {
    const r = await load(env, String(body.id || ""));
    if (!r || r.appId !== who.appId) return h.json({ error: "Document not found." }, 404, cors);
    if (p === "/sign/get") return h.json({ ...r, consent: CONSENT }, 200, cors);
    if (r.status !== "pending") return h.json({ error: "Only a document that is not signed yet can be withdrawn." }, 409, cors);
    r.status = "cancelled"; r.cancelledAt = new Date().toISOString(); r.cancelledBy = String(who.user.email || "");
    await save(env, r);
    return h.json({ ok: true, ...summary(r) }, 200, cors);
  }
  return h.json({ error: "Not found" }, 404, cors);
}

async function clientSign(request, rec, token, env, url, h) {
  const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  if (!rec) return reply({ error: "This signing link is not valid." }, 404);
  if (rec.status === "signed") return reply({ error: "This document is already signed." }, 409);
  if (rec.status !== "pending") return reply({ error: "This document was withdrawn. Contact us for a new link." }, 410);
  let b;
  try { b = await request.json(); } catch (e) { return reply({ error: "Bad request." }, 400); }
  const name = String(b.name || "").replace(/\s+/g, " ").trim();
  const sig = String(b.signature || "");
  if (name.length < 2 || name.length > 100) return reply({ error: "Type your full name." }, 400);
  if (b.agree !== true) return reply({ error: "Tick the box to agree to sign electronically." }, 400);
  if (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(sig) || sig.length > MAX_SIGNATURE || !atob(sig.slice(22, 34)).startsWith("\x89PNG")) {
    return reply({ error: "Draw your signature in the box." }, 400);
  }
  // Another option of the same offer already signed: this one is no longer available.
  const siblings = [];
  if (rec.group) {
    for (const id of await groupIds(env, rec.appId, rec.group)) {
      if (id === rec.id) continue;
      const other = await load(env, id);
      if (!other) continue;
      if (other.status === "signed") return reply({ error: `${other.option || "Another option"} was already chosen and signed, so this option is no longer available.` }, 409);
      siblings.push(other);
    }
  }
  rec.status = "signed";
  rec.signedAt = new Date().toISOString();
  rec.signerName = name;
  rec.signature = sig;
  rec.ip = request.headers.get("CF-Connecting-IP") || "";
  rec.userAgent = String(request.headers.get("User-Agent") || "").slice(0, 300);
  rec.consent = CONSENT;
  await save(env, rec);
  for (const other of siblings) {
    if (other.status !== "pending") continue;
    Object.assign(other, { status: "cancelled", cancelledAt: rec.signedAt, cancelledBy: "client chose another option", chosenOption: rec.option || "another option" });
    await save(env, other);
  }

  // Notify the company and send the client a link to the signed copy (best effort).
  const link = `${url.origin}/s/${token}`;
  const when = new Date(rec.signedAt).toUTCString();
  try {
    const saved = JSON.parse((await env.MAIL_KV.get("gmail")) || "null");
    if (saved && saved.email) {
      await h.gmailSend(env, { to: saved.email, subject: `Signed: ${rec.title} - ${rec.clientName || name}`,
        text: `${name} signed "${rec.title}" on ${when}.\n\nSigned copy: ${link}\n\nThe CRM shows it as signed and can download the signed PDF.` });
      if (rec.clientEmail) {
        await h.gmailSend(env, { to: rec.clientEmail, subject: `Your signed copy: ${rec.title}`,
          text: `Hello ${name},\n\nThank you for signing "${rec.title}" on ${when}.\nYou can view, print or save your signed copy here:\n${link}\n\nBest regards,\n${rec.company || env.SENDER_NAME || ""}` });
      }
    }
  } catch (e) { /* the signature is saved either way */ }
  return reply({ ok: true, signedAt: rec.signedAt });
}

function page(rec, token, env, h) {
  const nonce = randomToken();
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
  };
  const shell = (title, body, css = "") => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h.esc(title)}</title><style>
body{margin:0;background:#f3f4f6;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111827}
.wrap{max-width:860px;margin:0 auto;padding:16px}
.doc{background:#fff;border-radius:12px;padding:28px;box-shadow:0 1px 3px rgba(0,0,0,.08);overflow-x:auto}
.card{background:#fff;border-radius:12px;padding:20px;margin-top:16px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h1{font-size:20px;margin:8px 0 14px} .muted{color:#6b7280;font-size:13px}
label{display:block;font-weight:600;margin:12px 0 6px} input[type=text]{width:100%;box-sizing:border-box;padding:10px;border:1px solid #d1d5db;border-radius:8px;font:inherit}
canvas{width:100%;height:180px;border:1px dashed #9ca3af;border-radius:8px;background:#fff;touch-action:none}
.row{display:flex;gap:10px;align-items:flex-start;margin-top:12px} .row input{margin-top:4px}
button{font:inherit;border:0;border-radius:8px;padding:11px 18px;cursor:pointer} .primary{background:#2563eb;color:#fff;font-weight:700} .primary:disabled{background:#93c5fd;cursor:default}
.light{background:#e5e7eb} .err{color:#b91c1c;font-weight:600} .ok{color:#166534;font-weight:700}
.sigimg{max-width:320px;max-height:120px;border-bottom:1px solid #111;display:block}
.audit td{padding:3px 12px 3px 0;vertical-align:top;font-size:13px} .audit td:first-child{color:#6b7280;white-space:nowrap}
@media print{body{background:#fff}.card,.doc{box-shadow:none}.noprint{display:none}}
${css}
</style></head><body><div class="wrap">${body}</div></body></html>`, { status: 200, headers });

  if (!rec) return shell("Link not valid", `<div class="card"><h1>This signing link is not valid</h1><p>Check that the whole link was copied, or ask us for a new one.</p></div>`);
  if (rec.status === "cancelled" && rec.chosenOption) return shell("Option not available", `<div class="card"><h1>${h.esc(rec.option || "This option")} is no longer available</h1><p>You chose and signed <b>${h.esc(rec.chosenOption)}</b>. The link in your email for that option shows your signed copy. Questions? Contact ${h.esc(rec.company || "us")}.</p></div>`);
  if (rec.status === "cancelled") return shell("Document withdrawn", `<div class="card"><h1>This document was withdrawn</h1><p>Please contact ${h.esc(rec.company || "us")} for a new link.</p></div>`);
  const doc = `<div class="doc">${rec.html}</div>`;
  if (rec.status === "signed") {
    return shell(`Signed: ${rec.title}`, `<p class="ok">✓ Signed by ${h.esc(rec.signerName)} on ${h.esc(new Date(rec.signedAt).toUTCString())}</p>${doc}
<div class="card"><h1>Electronic signature</h1><img class="sigimg" alt="Signature of ${h.esc(rec.signerName)}" src="${h.esc(rec.signature)}">
<p><b>${h.esc(rec.signerName)}</b></p><table class="audit">
<tr><td>Signed</td><td>${h.esc(new Date(rec.signedAt).toUTCString())}</td></tr>
<tr><td>Document</td><td>${h.esc(rec.title)}</td></tr>
<tr><td>Fingerprint (SHA-256)</td><td style="word-break:break-all">${h.esc(rec.docHash)}</td></tr>
<tr><td>IP address</td><td>${h.esc(rec.ip || "")}</td></tr>
<tr><td>Agreement</td><td>${h.esc(rec.consent || CONSENT)}</td></tr></table>
<p class="noprint"><button class="light" id="print">Print / save as PDF</button></p></div>
<script nonce="${nonce}">document.getElementById("print").onclick=()=>print();</script>`, rec.css);
  }
  return shell(`Please sign: ${rec.title}`, `<p class="muted">${h.esc(rec.company || "")} asks you to review and sign this document.</p>${doc}
<div class="card" id="signCard"><h1>Sign</h1>
<label for="name">Your full name</label><input type="text" id="name" autocomplete="name" value="${h.esc(rec.clientName || "")}" maxlength="100">
<label>Draw your signature</label><canvas id="pad" width="800" height="180" aria-label="Signature box"></canvas>
<p><button class="light" id="clear" type="button">Clear</button></p>
<div class="row"><input type="checkbox" id="agree"><label for="agree" style="margin:0;font-weight:400">${h.esc(CONSENT)}</label></div>
<p class="err" id="msg" role="alert"></p>
<button class="primary" id="sign" type="button" disabled>Sign document</button></div>
<script nonce="${nonce}">
(function(){
  var pad=document.getElementById("pad"),ctx=pad.getContext("2d"),drawn=false,down=false,last=null;
  var name=document.getElementById("name"),agree=document.getElementById("agree"),btn=document.getElementById("sign"),msg=document.getElementById("msg");
  function size(){var r=pad.getBoundingClientRect(),d=window.devicePixelRatio||1;pad.width=Math.round(r.width*d);pad.height=Math.round(r.height*d);ctx.setTransform(d,0,0,d,0,0);ctx.lineWidth=2.4;ctx.lineCap="round";ctx.lineJoin="round";ctx.strokeStyle="#111827";drawn=false;check();}
  function pos(e){var r=pad.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top};}
  function check(){btn.disabled=!(drawn&&agree.checked&&name.value.trim().length>=2);}
  pad.addEventListener("pointerdown",function(e){down=true;last=pos(e);pad.setPointerCapture(e.pointerId);});
  pad.addEventListener("pointermove",function(e){if(!down)return;var p=pos(e);ctx.beginPath();ctx.moveTo(last.x,last.y);ctx.lineTo(p.x,p.y);ctx.stroke();last=p;drawn=true;check();});
  ["pointerup","pointercancel","pointerleave"].forEach(function(t){pad.addEventListener(t,function(){down=false;});});
  document.getElementById("clear").onclick=function(){ctx.clearRect(0,0,pad.width,pad.height);drawn=false;check();};
  name.oninput=check;agree.onchange=check;
  btn.onclick=function(){
    btn.disabled=true;msg.textContent="";
    fetch(location.pathname,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:name.value,agree:agree.checked,signature:pad.toDataURL("image/png")})})
      .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j};});})
      .then(function(x){if(x.ok){location.reload();}else{msg.textContent=x.j.error||"Not signed. Try again.";check();}})
      .catch(function(){msg.textContent="Not signed: no connection. Try again.";check();});
  };
  size();window.addEventListener("resize",function(){if(!drawn)size();});
})();
</script>`, rec.css);
}

export { TYPES, CONSENT, stripScripts };
