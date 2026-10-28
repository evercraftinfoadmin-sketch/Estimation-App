// Google Calendar for CRM projects (part of the EverCraft CRM mail service).
// The CRM is the source of truth: it sends the project, this service writes the event into the
// company Google Calendar (the same Google account that sends the email).
//
//   POST /calendar/calendars  the calendars the company account can write to
//   POST /calendar/sync       add / update / remove the event of one CRM project
//
// Each project always gets the same event id (made from the app and project id), so a repeated
// or retried sync updates that one event and never makes a second one.

const CAL_API = "https://www.googleapis.com/calendar/v3";
const CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.calendarlist.readonly"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const CAL_ID_RE = /^[A-Za-z0-9._%+#@-]{1,200}$/;
const DAY_END = "17:00"; // a timed job with no end time ends at 5 PM (or 2 hours after a late start)

// The fixed event id for a project. Google allows the letters a-v and digits; hex is a subset.
async function projectEventId(appId, projectId) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${appId}:${projectId}`)));
  return "evc" + [...bytes].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}

function clean(s, max) {
  return String(s ?? "").replace(/\r\n?/g, "\n").trim().slice(0, max);
}

function nextDay(date) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// date + time (wall clock in the calendar's time zone) plus minutes, still as wall clock.
function addMinutes(date, time, minutes) {
  const d = new Date(`${date}T${time}:00Z`);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) };
}

// The CRM's project → a Google Calendar event, or {error}.
function buildEvent(p, { eventId, appId, projectId, timeZone }) {
  const date = String(p.date || "");
  const time = String(p.time || "");
  const endDate = String(p.endDate || "") || date;
  if (!DATE_RE.test(date)) return { error: "The project has no valid start date." };
  if (time && !TIME_RE.test(time)) return { error: "The start time is not valid." };
  if (!DATE_RE.test(endDate) || endDate < date) return { error: "The end date is before the start date." };

  const title = clean(p.title, 150) || "CRM project";
  const service = clean(p.service, 150);
  const technician = clean(p.technician, 150);
  const summary = [p.canceled ? "CANCELED:" : "", title, service ? "– " + service : "", technician ? "· " + technician : ""].filter(Boolean).join(" ");
  const description = [
    p.canceled ? "THIS PROJECT WAS CANCELED in the CRM." : "",
    service ? "Service: " + service : "",
    technician ? "Team: " + technician : "",
    clean(p.notes, 3000) ? "Notes: " + clean(p.notes, 3000) : "",
    "",
    "Added by EverCraft CRM. Change this job in the CRM: changes made here in the calendar are replaced by the CRM."
  ].filter((l, i, a) => l || (i > 0 && a[i - 1])).join("\n").trim();

  let start, end;
  if (!time) {
    start = { date };
    end = { date: nextDay(endDate) }; // all-day: Google's end date is the day after
  } else {
    let stop = { date: endDate, time: DAY_END };
    if (`${stop.date}T${stop.time}` <= `${date}T${time}`) stop = addMinutes(date, time, 120);
    start = { dateTime: `${date}T${time}:00`, timeZone };
    end = { dateTime: `${stop.date}T${stop.time}:00`, timeZone };
  }
  return {
    event: {
      id: eventId,
      summary,
      location: clean(p.location, 500),
      description,
      start,
      end,
      status: "confirmed",
      transparency: p.canceled ? "transparent" : "opaque",
      ...(p.canceled ? { colorId: "8" } : {}),
      extendedProperties: { private: { evercraftApp: appId, evercraftProject: projectId } }
    }
  };
}

async function calendarRoutes(request, env, url, cors, h) {
  if (!url.pathname.startsWith("/calendar/")) return null;
  if (request.method !== "POST") return h.json({ error: "Not found" }, 404, cors);
  if (!cors) return h.json({ error: "This site may not use the calendar service." }, 403, null);
  let body;
  try { body = await request.json(); } catch (e) { return h.json({ error: "Bad request." }, 400, cors); }
  const who = await h.teamMember(request, env, body);
  if (who.error) return h.json({ error: who.error }, who.status, cors);

  const g = await h.googleAccess(env);
  if (g.error) return h.json({ error: g.error, retry: true }, g.status, cors);
  if (!h.hasCalendarScopes(g.scope)) {
    return h.json({ error: "Google Calendar is not allowed yet. An admin must connect the company Google account again and allow the calendar.", retry: true }, 503, cors);
  }
  const api = (path, init = {}) => fetch(CAL_API + path, {
    ...init,
    headers: { Authorization: "Bearer " + g.token, ...(init.body ? { "Content-Type": "application/json" } : {}) }
  });

  if (url.pathname === "/calendar/calendars") {
    const r = await api("/users/me/calendarList?minAccessRole=writer&maxResults=250");
    if (!r.ok) return h.json(await googleError(r, h), r.status === 401 || r.status === 403 ? 503 : 502, cors);
    const list = ((await r.json().catch(() => ({}))).items || [])
      .filter(c => !c.deleted)
      .map(c => ({ id: c.id, name: c.summaryOverride || c.summary || c.id, primary: !!c.primary, timeZone: c.timeZone || "" }));
    return h.json({ calendars: list }, 200, cors);
  }

  if (url.pathname === "/calendar/sync") {
    const projectId = String(body.projectId || "");
    const calendarId = String(body.calendarId || "primary");
    const prevCalendarId = String(body.prevCalendarId || "");
    const action = String(body.action || "");
    if (!/^[\w.-]{1,100}$/.test(projectId)) return h.json({ error: "The project id is not valid." }, 400, cors);
    if (!CAL_ID_RE.test(calendarId) || (prevCalendarId && !CAL_ID_RE.test(prevCalendarId))) return h.json({ error: "The calendar id is not valid." }, 400, cors);
    if (!["upsert", "remove"].includes(action)) return h.json({ error: "Unknown calendar action." }, 400, cors);
    const eventId = await projectEventId(who.appId, projectId);
    const at = cal => `/calendars/${encodeURIComponent(cal)}/events/${eventId}`;

    if (action === "remove") {
      // The event may still be in the calendar the project used before.
      for (const cal of [...new Set([calendarId, prevCalendarId].filter(Boolean))]) {
        const r = await api(at(cal) + "?sendUpdates=none", { method: "DELETE" });
        if (!r.ok && r.status !== 404 && r.status !== 410) return h.json(await googleError(r, h), 502, cors);
      }
      return h.json({ ok: true, removed: true, eventId }, 200, cors);
    }

    const built = buildEvent(body.event || {}, { eventId, appId: who.appId, projectId, timeZone: env.CALENDAR_TIMEZONE || "America/Los_Angeles" });
    if (built.error) return h.json({ error: built.error }, 400, cors);
    // The assigned team member changed: move the event to their calendar (keeps the same event).
    if (prevCalendarId && prevCalendarId !== calendarId) {
      const r = await api(at(prevCalendarId) + "/move?sendUpdates=none&destination=" + encodeURIComponent(calendarId), { method: "POST" });
      if (!r.ok && r.status !== 404 && r.status !== 410) return h.json(await googleError(r, h), 502, cors);
    }
    const payload = JSON.stringify(built.event);
    // Update the project's event; if it does not exist yet, add it with the fixed id.
    let r = await api(at(calendarId) + "?sendUpdates=none", { method: "PUT", body: payload });
    if (r.status === 404 || r.status === 410) {
      r = await api(`/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=none`, { method: "POST", body: payload });
      // 409: the id is taken by an event deleted earlier: bring that one back.
      if (r.status === 409) r = await api(at(calendarId) + "?sendUpdates=none", { method: "PUT", body: payload });
    }
    if (!r.ok) return h.json(await googleError(r, h), 502, cors);
    const ev = await r.json().catch(() => ({}));
    return h.json({ ok: true, eventId: ev.id || eventId, calendarId, link: ev.htmlLink || "" }, 200, cors);
  }
  return h.json({ error: "Not found" }, 404, cors);
}

// Google's answer → {error, retry}. retry: worth trying again later by itself.
async function googleError(r, h) {
  if (r.status === 401) h.resetAccess();
  const reason = String(((await r.json().catch(() => ({}))).error || {}).message || "").slice(0, 200);
  const why = `${r.status}${reason ? ": " + reason : ""}`;
  if (r.status === 401 || r.status === 403) {
    return { error: `Google Calendar refused (${why}). An admin may need to connect the company Google account again and allow the calendar.`, retry: true };
  }
  if (r.status === 404) return { error: `The calendar was not found (${why}). Check the calendar choice in Settings.`, retry: false };
  if (r.status === 400) return { error: `Google Calendar did not accept the event (${why}).`, retry: false };
  return { error: `Google Calendar is not available right now (${why}).`, retry: true };
}

export { calendarRoutes, buildEvent, projectEventId, CALENDAR_SCOPES };
