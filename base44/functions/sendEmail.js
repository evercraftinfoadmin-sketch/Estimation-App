// Base44 backend function "sendEmail" (Builder plan). Deployed to the Base44 apps from this file.
// Sends estimates and invoices from the company Gmail (Base44 Gmail connector), so every email goes
// out from the same address no matter who is signed in on the computer.
//
//   {action:"status"}  → {connected, sender}
//   {action:"send", to, subject, text, fromName?, attachment?:{filename, base64}} → {ok, id, from, to}
//
// Only signed-in CRM team members (crm_role owner/admin/member) may call it. The Gmail permission
// stays in Base44; only EverCraft.pro@gmail.com is accepted as the sender.

const ALLOWED_SENDER = "evercraft.pro@gmail.com";
const ROLES = ["owner", "admin", "member"];
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_TEXT = 100000;
const EMAIL_RE = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[A-Za-z]{2,}$/;
const GMAIL_SEND = "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media";
const USERINFO = "https://www.googleapis.com/oauth2/v3/userinfo";

function bytesToBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const utf8Base64 = text => bytesToBase64(new TextEncoder().encode(text));
const wrap76 = b64 => b64.replace(/.{1,76}/g, "$&\r\n");

// RFC 2047 encoded words (UTF-8, base64), split on character boundaries.
function encodeHeader(text) {
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const words = [];
  let part = "";
  for (const ch of text) {
    if (new TextEncoder().encode(part + ch).length > 45) { words.push(part); part = ""; }
    part += ch;
  }
  if (part) words.push(part);
  return words.map(w => `=?UTF-8?B?${utf8Base64(w)}?=`).join("\r\n ");
}

function buildMessage({ from, fromName, to, subject, text, filename, pdfBase64 }) {
  const boundary = "evercraft-" + crypto.randomUUID();
  const head = [
    `From: ${fromName ? encodeHeader(fromName) + " " : ""}<${from}>`,
    `To: <${to}>`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    "MIME-Version: 1.0"
  ];
  const textPart = ["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap76(utf8Base64(text))];
  if (!pdfBase64) return [...head, ...textPart].join("\r\n");
  return [
    ...head,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    ...textPart,
    `--${boundary}`,
    `Content-Type: application/pdf; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(pdfBase64),
    `--${boundary}--`,
    ""
  ].join("\r\n");
}

const reply = (data, status = 200) => Response.json(data, { status });

// The connected Gmail: {token, email}, or null when it is not connected.
async function companyGmail(base44) {
  let token = "";
  try { token = await base44.asServiceRole.connectors.getAccessToken("gmail"); } catch (e) { return null; }
  if (!token) return null;
  const r = await fetch(USERINFO, { headers: { Authorization: "Bearer " + token } });
  const info = r.ok ? await r.json().catch(() => ({})) : {};
  return { token, email: String(info.email || "").toLowerCase() };
}

async function handle(req, base44) {
  if (req.method !== "POST") return reply({ error: "Use POST." }, 405);
  let user = null;
  try { user = await base44.auth.me(); } catch (e) { user = null; }
  if (!user) return reply({ error: "Sign in to the CRM again, then send." }, 401);
  const role = user.crm_role || (user.data && user.data.crm_role);
  if (!ROLES.includes(role)) return reply({ error: "Your account has no CRM access." }, 403);

  let body;
  try { body = await req.json(); } catch (e) { return reply({ error: "Bad request." }, 400); }

  const gmail = await companyGmail(base44);
  if (body.action === "status") {
    return reply({ connected: !!gmail && gmail.email === ALLOWED_SENDER, sender: gmail && gmail.email ? gmail.email : ALLOWED_SENDER });
  }
  if (body.action !== "send") return reply({ error: "Unknown action." }, 400);
  if (!gmail) return reply({ error: "The company Gmail is not connected to the CRM yet." }, 503);
  if (gmail.email !== ALLOWED_SENDER) return reply({ error: `Gmail is connected as ${gmail.email || "an unknown account"}, not ${ALLOWED_SENDER}. An admin must connect ${ALLOWED_SENDER}.` }, 503);

  const to = String(body.to || "").trim();
  const subject = String(body.subject || "").replace(/[\r\n]+/g, " ").trim();
  const text = String(body.text || "");
  const fromName = String(body.fromName || "").replace(/[\r\n"<>]+/g, " ").trim().slice(0, 100);
  if (!EMAIL_RE.test(to) || to.length > 254) return reply({ error: "The client's email address is not valid." }, 400);
  if (!subject || subject.length > 300) return reply({ error: "The subject is empty or too long." }, 400);
  if (!text.trim() || text.length > MAX_TEXT) return reply({ error: "The message is empty or too long." }, 400);
  let pdfBase64 = "", filename = "";
  if (body.attachment) {
    pdfBase64 = String(body.attachment.base64 || "").replace(/\s+/g, "");
    filename = String(body.attachment.filename || "document.pdf").replace(/[^\w .-]+/g, "_").slice(0, 100);
    if (!/\.pdf$/i.test(filename)) filename += ".pdf";
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(pdfBase64) || pdfBase64.length * 3 / 4 > MAX_PDF_BYTES) return reply({ error: "The PDF is missing or too large." }, 400);
    if (!atob(pdfBase64.slice(0, 8)).startsWith("%PDF-")) return reply({ error: "The attachment is not a PDF." }, 400);
  }

  const raw = buildMessage({ from: gmail.email, fromName, to, subject, text, filename, pdfBase64 });
  const r = await fetch(GMAIL_SEND, { method: "POST", headers: { Authorization: "Bearer " + gmail.token, "Content-Type": "message/rfc822" }, body: raw });
  if (!r.ok) return reply({ error: `Gmail did not send the email (${r.status}). Try again.` }, 502);
  const g = await r.json().catch(() => ({}));
  return reply({ ok: true, id: g.id || "", from: gmail.email, to });
}

if (typeof Deno !== "undefined" && Deno.serve) {
  Deno.serve(async req => {
    try {
      const { createClientFromRequest } = await import("npm:@base44/sdk@0.8.52");
      return await handle(req, createClientFromRequest(req));
    } catch (e) {
      return reply({ error: "The email service had a problem. Try again." }, 500);
    }
  });
}

export { handle, buildMessage, encodeHeader };
