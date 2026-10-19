// EverCraft CRM mail service (Cloudflare Worker).
// Sends estimates and invoices from the company Gmail account, so every email goes out from the
// same address no matter who is signed in on the computer.
//
//   GET  /status          is Gmail connected? (no secrets)
//   GET  /setup           the address to register in Google Cloud and the connect link
//   GET  /oauth/start     connect the company Gmail (needs ?key=MAIL_SETUP_KEY)
//   GET  /oauth/callback  Google returns here; only ALLOWED_SENDER is accepted
//   POST /send            send one email (Authorization: Bearer <Base44 sign-in token>)
//   /sign/*, /s/<token>   electronic signatures (see sign.js)
//
// Only signed-in CRM team members (Base44 crm_role owner/admin/member) can send. The Gmail
// permission (refresh token) is kept in this Worker's KV storage and never reaches the browser.

import { signRoutes } from "./sign.js";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GMAIL_SEND = "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media";
const SCOPES = "openid email https://www.googleapis.com/auth/gmail.send";
const ROLES = ["owner", "admin", "member"];
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_TEXT = 100000;
const EMAIL_RE = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[A-Za-z]{2,}$/;

let ACCESS = { token: "", exp: 0 }; // short-lived Gmail access token, reused while valid

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (e) {
      return json({ error: "The mail service had a problem. Try again." }, 500, corsHeaders(request, env));
    }
  }
};

async function route(request, env) {
  const url = new URL(request.url);
  const cors = corsHeaders(request, env);
  if (request.method === "OPTIONS") return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
  if (url.pathname === "/" || url.pathname === "/status") {
    const saved = await savedGmail(env);
    return json({ service: "EverCraft CRM mail", connected: !!saved, sender: env.ALLOWED_SENDER }, 200, cors);
  }
  if (url.pathname === "/setup" && request.method === "GET") return setupPage(url, env);
  if (url.pathname === "/oauth/start" && request.method === "GET") return oauthStart(url, env);
  if (url.pathname === "/oauth/callback" && request.method === "GET") return oauthCallback(url, env);
  if (url.pathname === "/send" && request.method === "POST") return send(request, env, cors);
  const signed = await signRoutes(request, env, url, cors, { json, esc, teamMember, gmailSend, EMAIL_RE });
  if (signed) return signed;
  return json({ error: "Not found" }, 404, cors);
}

/* ---------- helpers ---------- */

function json(data, status = 200, cors = null) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...(cors || {}) } });
}

function html(body, status = 200) {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>EverCraft CRM mail</title><body style="font:16px system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.5">${body}</body>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
}

// CORS headers for the CRM's web addresses; null for any other site.
function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin || !allowedOrigins(env).includes(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin"
  };
}

function sameText(a, b) {
  a = String(a || ""); b = String(b || "");
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

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

function base44Apps(env) {
  try { return JSON.parse(env.BASE44_APPS || "{}"); } catch (e) { return {}; }
}

async function savedGmail(env) {
  const raw = await env.MAIL_KV.get("gmail");
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

/* ---------- connecting the company Gmail ---------- */

function setupPage(url, env) {
  return html(`<h2>EverCraft CRM mail: setup</h2>
<p>In Google Cloud, add this <b>Authorized redirect URI</b> to the OAuth client:</p>
<p><code>${esc(url.origin)}/oauth/callback</code></p>
<p>Then open <code>${esc(url.origin)}/oauth/start?key=YOUR_SETUP_KEY</code> and sign in as <b>${esc(env.ALLOWED_SENDER)}</b>.</p>`);
}

async function oauthStart(url, env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return html("<h2>Not ready</h2><p>The Google client id and secret are not set on this service yet.</p>", 503);
  if (!sameText(url.searchParams.get("key"), env.MAIL_SETUP_KEY)) return html("<h2>Wrong or missing setup key</h2><p>Use the link with the setup key from the instructions.</p>", 403);
  const state = crypto.randomUUID();
  await env.MAIL_KV.put("state:" + state, "1", { expirationTtl: 600 });
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: url.origin + "/oauth/callback",
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    login_hint: env.ALLOWED_SENDER,
    state
  });
  return Response.redirect(GOOGLE_AUTH + "?" + q, 302);
}

async function oauthCallback(url, env) {
  const state = url.searchParams.get("state") || "";
  if (!state || !(await env.MAIL_KV.get("state:" + state))) return html("<h2>This link expired</h2><p>Start again from the setup link.</p>", 400);
  await env.MAIL_KV.delete("state:" + state);
  if (url.searchParams.get("error")) return html(`<h2>Not connected</h2><p>Google said: ${esc(url.searchParams.get("error"))}</p>`, 400);
  const r = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: url.searchParams.get("code") || "",
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: url.origin + "/oauth/callback",
      grant_type: "authorization_code"
    })
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.id_token) return html("<h2>Not connected</h2><p>Google did not accept the sign-in. Start again from the setup link.</p>", 400);
  let claims = {};
  try { claims = JSON.parse(atob(t.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch (e) {}
  const email = String(claims.email || "");
  if (!claims.email_verified || email.toLowerCase() !== String(env.ALLOWED_SENDER).toLowerCase()) {
    return html(`<h2>Wrong account</h2><p>You signed in as <b>${esc(email || "unknown")}</b>. Sign in as <b>${esc(env.ALLOWED_SENDER)}</b>.</p>`, 403);
  }
  if (!t.refresh_token) return html("<h2>Not connected</h2><p>Google did not give a lasting permission. In the Google account, remove this app's access (Security → Third-party connections), then start again.</p>", 400);
  await env.MAIL_KV.put("gmail", JSON.stringify({ refresh_token: t.refresh_token, email, connectedAt: new Date().toISOString() }));
  ACCESS = { token: "", exp: 0 };
  return html(`<h2>Connected ✓</h2><p>The CRM now sends emails from <b>${esc(email)}</b>. You can close this page.</p>`);
}

async function gmailAccessToken(env, saved) {
  if (ACCESS.token && ACCESS.exp > Date.now() + 60000) return ACCESS.token;
  const r = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: saved.refresh_token, grant_type: "refresh_token" })
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) return "";
  ACCESS = { token: t.access_token, exp: Date.now() + (Number(t.expires_in) || 3600) * 1000 };
  return ACCESS.token;
}

/* ---------- sending ---------- */

// Asks Base44 who the sign-in token belongs to. Returns the user, or null.
async function base44User(appId, token, env) {
  const server = base44Apps(env)[appId];
  if (!server || !token) return null;
  const r = await fetch(`${server.replace(/\/$/, "")}/api/apps/${appId}/entities/User/me`, {
    headers: { Authorization: "Bearer " + token, "X-App-Id": appId }
  });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

function buildMessage({ from, fromName, to, replyTo, subject, text, filename, pdfBase64 }) {
  const boundary = "evercraft-" + crypto.randomUUID();
  const head = [
    `From: ${fromName ? encodeHeader(fromName) + " " : ""}<${from}>`,
    `To: <${to}>`,
    ...(replyTo ? [`Reply-To: <${replyTo}>`] : []),
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

async function send(request, env, cors) {
  if (!cors) return json({ error: "This site may not use the mail service." }, 403, null);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "Bad request." }, 400, cors); }
  const who = await teamMember(request, env, body);
  if (who.error) return json({ error: who.error }, who.status, cors);
  const { user, appId } = who;

  const to = String(body.to || "").trim();
  const subject = String(body.subject || "").replace(/[\r\n]+/g, " ").trim();
  const text = String(body.text || "");
  const replyTo = String(body.replyTo || "").trim();
  const fromName = String(body.fromName || env.SENDER_NAME || "").replace(/[\r\n"<>]+/g, " ").trim().slice(0, 100);
  if (!EMAIL_RE.test(to) || to.length > 254) return json({ error: "The client's email address is not valid." }, 400, cors);
  if (replyTo && !EMAIL_RE.test(replyTo)) return json({ error: "The reply-to address is not valid." }, 400, cors);
  if (!subject || subject.length > 300) return json({ error: "The subject is empty or too long." }, 400, cors);
  if (!text.trim() || text.length > MAX_TEXT) return json({ error: "The message is empty or too long." }, 400, cors);
  let pdfBase64 = "", filename = "";
  if (body.attachment) {
    pdfBase64 = String(body.attachment.base64 || "").replace(/\s+/g, "");
    filename = String(body.attachment.filename || "document.pdf").replace(/[^\w .-]+/g, "_").slice(0, 100);
    if (!/\.pdf$/i.test(filename)) filename += ".pdf";
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(pdfBase64) || pdfBase64.length * 3 / 4 > MAX_PDF_BYTES) return json({ error: "The PDF is missing or too large." }, 400, cors);
    if (!atob(pdfBase64.slice(0, 8)).startsWith("%PDF-")) return json({ error: "The attachment is not a PDF." }, 400, cors);
  }

  const day = new Date().toISOString().slice(0, 10);
  const countKey = `count:${appId}:${user.id || user.email}:${day}`;
  const sent = Number(await env.MAIL_KV.get(countKey)) || 0;
  if (sent >= (Number(env.DAILY_LIMIT) || 300)) return json({ error: "Too many emails sent today from this account." }, 429, cors);

  const g = await gmailSend(env, { fromName, to, replyTo, subject, text, filename, pdfBase64 });
  if (g.error) return json({ error: g.error }, g.status, cors);
  await env.MAIL_KV.put(countKey, String(sent + 1), { expirationTtl: 2 * 86400 });
  return json({ ok: true, id: g.id, from: g.from, to }, 200, cors);
}

// Is the caller a signed-in CRM team member? {user, appId} or {error, status}.
async function teamMember(request, env, body) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const appId = String((body && body.appId) || "");
  const user = await base44User(appId, token, env);
  const role = user && (user.crm_role || (user.data && user.data.crm_role));
  if (!user) return { error: "Sign in to the CRM again, then try again.", status: 401 };
  if (!ROLES.includes(role)) return { error: "Your account has no CRM access.", status: 403 };
  return { user, appId };
}

// Sends one email from the connected company Gmail. {id, from} or {error, status}.
async function gmailSend(env, { fromName, to, replyTo, subject, text, filename, pdfBase64 }) {
  const saved = await savedGmail(env);
  if (!saved) return { error: "The company Gmail is not connected to the CRM yet.", status: 503 };
  const access = await gmailAccessToken(env, saved);
  if (!access) return { error: "The Gmail connection expired. An admin must connect it again.", status: 503 };
  const raw = buildMessage({ from: saved.email, fromName: fromName || env.SENDER_NAME || "", to, replyTo, subject, text, filename, pdfBase64 });
  const r = await fetch(GMAIL_SEND, { method: "POST", headers: { Authorization: "Bearer " + access, "Content-Type": "message/rfc822" }, body: raw });
  if (!r.ok) {
    if (r.status === 401) ACCESS = { token: "", exp: 0 };
    return { error: `Gmail did not send the email (${r.status}). Try again.`, status: 502 };
  }
  const g = await r.json().catch(() => ({}));
  return { id: g.id || "", from: saved.email };
}

export { buildMessage, encodeHeader };
