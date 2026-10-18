# Sending emails from the company Gmail

The CRM's **Send** window emails estimates and invoices (with the PDF attached) from
**EverCraft.pro@gmail.com**, whoever is signed in on the computer. A copy appears in that account's
*Sent* folder. Everything runs on Base44.

## How it works

| Part | Where | What it does |
|---|---|---|
| Send window, PDF | the CRM (`js/mail.js`) | makes the PDF from the print layout, calls the Base44 function as the signed-in person |
| `sendEmail` function | Base44 backend function (`base44/functions/sendEmail.js`) | checks the person is a CRM team member (owner/admin/member), then sends through Gmail |
| Gmail permission | Base44 Gmail connector | "send email" permission of EverCraft.pro@gmail.com; never reaches a browser |

- Only signed-in team members can send. Only EverCraft.pro@gmail.com is accepted as the sender: if
  another Google account is connected, nothing is sent and the window says so.
- When `emailFromCrm` is `false` in `js/config.js`, or the person is signed out, or Gmail is not
  connected, the Email button opens Gmail as before ("Open in Gmail instead" is also in the window).

## One-time setup

1. Base44 workspace on the **Builder** plan (backend functions need it).
2. Deploy `base44/functions/sendEmail.js` to the Base44 app (dev first, then production).
3. Connect Gmail in Base44 (scopes `gmail.send` and `userinfo.email`): open the connect link while
   signed in to Google as **EverCraft.pro@gmail.com** and allow.
4. Set `emailFromCrm: true` in `js/config.js`.

## Later

- **Reconnect** (password changed, access removed): connect Gmail again in Base44.
- **Stop sending from the CRM:** set `emailFromCrm` to `false`.
