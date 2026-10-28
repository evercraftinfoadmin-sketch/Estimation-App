# Google Calendar sync (CRM projects)

CRM projects are added to the company Google Calendar (evercraft.pro@gmail.com) automatically and
kept up to date. The CRM is the only source of truth: change jobs in the CRM, not in the calendar.
Changes made in the calendar are replaced the next time the project changes in the CRM.
Only the CRM writes to the calendar; nothing is read back.

## How it works

- The CRM sends the project to the CRM mail service (`worker/src/calendar.js`, Cloudflare). The
  service writes the event with the same Google account that already sends the email. The Google
  permission stays on the service, never in the browser.
- **Estimate visits:**
  - When a lead moves to *Prospects*, the CRM asks for the estimate visit date and time. They
    can also be set in the project, under Pipeline.
  - The visit goes into the **main calendar** as `ESTIMATE (name), phone`, with the address in
    the location line. With a time it lasts one hour; without one it is all day.
  - It stays when the project becomes a job, which gets its own job event.
- **Jobs, which projects:** stage *Client / Job* or later (Start the Project, Completed, Follow-up),
  with a *Scheduled Date*, not in a folder (old CRM leads), and not over yet.
- **Projects from before the sync was turned on** are added only once they are changed (they
  may already be in the calendar by hand, and this avoids duplicates).
- **The event:**
  - The title is `JOB (name), phone · technician`.
  - The location is the job address.
  - The description has the phone, the service (from the estimate), the team member and the notes.
  - With a *Start Time*, the event is timed (until 5 PM on the end date, or 2 hours after a late
    start). Without one, it is an all-day event. *End Date* is optional.
- **Which calendar:**
  - The team member's own calendar when *Assigned Technician* names them. That means the
    calendar's name (e.g. "Yura"), or one of the other spellings written next to it in Settings
    (e.g. "Yurii").
  - Otherwise, the calendar chosen in Settings.
  - Changing the technician moves the event to the new calendar.
- **No duplicates:** each project has one fixed event id, so a repeated or retried sync always
  updates that one event.
- **Changes:** a new date, time, end date, address, technician, notes or service updates the
  event. Moving the project back before Client / Job, or clearing its date, removes the event.
- **Canceled** (the *Project canceled* box): depending on Settings, the event is deleted, or kept
  and marked "CANCELED:" (grey, no longer blocking the time). Unticking the box brings it back.
- **Deleted project:** its event is deleted.
- **Errors and retries:**
  - If the calendar can't be reached, the project is saved anyway.
  - The project shows "⚠ Not synced" with the reason.
  - It is retried by itself, waiting 1, 2, 5, 15, 30, then 60 minutes between tries. It is also
    retried as soon as the device is back online, and right away with *Sync now* in the project
    or *Retry waiting syncs now* in Settings.
  - Retries happen while the CRM is open on any signed-in device.
- **Status:**
  - The project window shows the start date and time and the sync status, with a link to the
    event.
  - The board card shows ✓ / ⏳ / ⚠ Calendar.
  - Settings → Google Calendar shows the log of syncs and errors on this device.

## Setup (one time, admin)

1. **Google Cloud** (the project that has the CRM's OAuth client):
   - Open *APIs & Services → Library*, find **Google Calendar API**, and press **Enable**.
   - On the OAuth consent screen, under scopes, add `.../auth/calendar.events` and
     `.../auth/calendar.calendarlist.readonly`. In testing mode this is optional, but it avoids a
     warning.
2. **Merge the pull request.** The mail service is deployed automatically. Email keeps working
   with the current connection.
3. **Connect the company Google account again**, so it also allows the calendar:
   - Open `https://evercraft-mail.moldevercraft.workers.dev/oauth/start?key=<MAIL_SETUP_KEY>`.
   - Sign in as evercraft.pro@gmail.com.
   - Tick **all** boxes: send email, *View and edit events on all your calendars* and *See the list
     of Google calendars you're subscribed to*.
   - The page should say "CRM projects are added to this account's Google Calendar".
   - `/status` then shows `"calendar": true`.
4. **CRM → Settings → Google Calendar** (as an admin, signed in):
   - Press **Load calendars from Google**.
   - Choose the *Calendar for projects* (the main calendar by default).
   - Write other spellings next to each team member's calendar if needed (e.g. "Yurii, Yuriy"
     next to Yura).
   - Choose what happens when a project is canceled.
   - Tick **Add projects to Google Calendar automatically**, then **Save Settings**.

Test it on the dev app first: make a test project in stage Client / Job with a date in the future,
then check the calendar, change the date, cancel it and delete it.
