# Sending emails from the company Gmail

The CRM's **Send** window emails estimates and invoices (with the PDF attached) from
**EverCraft.pro@gmail.com**, whoever is signed in on the computer. A copy appears in that account's
*Sent* folder.

## How it works

| Part | Where | What it does |
|---|---|---|
| Send window, PDF | the CRM (`js/mail.js`) | makes the PDF from the print layout, sends it with the person's Base44 sign-in |
| Mail service | Cloudflare Worker `evercraft-mail` (`worker/`) | checks with Base44 that the person is a CRM team member (owner/admin/member), then sends through Gmail |
| Gmail permission | the Worker's KV storage `evercraft-mail` | "send email" permission for EverCraft.pro@gmail.com only; never reaches a browser |

- Only the CRM's web addresses may call the service, only signed-in team members can send, at most
  300 emails per person per day. Only EverCraft.pro@gmail.com can be connected.
- If the service is not set up, not connected, or the person is signed out, the Email button opens
  Gmail as before ("Open in Gmail instead" is also in the Send window).
- Everything else (sign-in, leads, estimates, invoices) stays on Base44.

## One-time setup

1. **Cloudflare key → GitHub.** In Cloudflare: *My Profile → API Tokens → Create Token →
   "Edit Cloudflare Workers" → Use template*, choose the EverCraft account, *Create*. Copy the token.
   Copy the **Account ID** (*Workers & Pages*, right column). In GitHub: *Settings → Secrets and
   variables → Actions → New repository secret*: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
2. **Setup key → GitHub.** Make up a long password (20+ characters) and save it as the secret
   `MAIL_SETUP_KEY`. It is needed once, to connect Gmail.
3. **Merge** the pull request. *Actions → Deploy mail service* publishes the service at
   `https://evercraft-mail.<your-subdomain>.workers.dev` (the address is in the deploy log).
4. **Google Cloud** (the same project as the Maps key):
   - *APIs & Services → Library → Gmail API → Enable*.
   - *Google Auth Platform → Branding*: app name "EverCraft CRM Mail", support email EverCraft.pro@gmail.com.
     *Audience*: External, then **Publish app** (status "In production"; otherwise Google cancels
     the permission after 7 days).
   - *Data Access → Add or remove scopes*: `https://www.googleapis.com/auth/gmail.send`.
   - *Clients → Create client → Web application*. Authorized redirect URI:
     `https://evercraft-mail.<your-subdomain>.workers.dev/oauth/callback`. Copy the Client ID and secret.
   - In GitHub, add the secrets `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then
     *Actions → Deploy mail service → Run workflow*.
5. **Connect Gmail.** Open `https://evercraft-mail.<your-subdomain>.workers.dev/oauth/start?key=<MAIL_SETUP_KEY>`,
   sign in as **EverCraft.pro@gmail.com**. Google shows "Google hasn't verified this app" (it is
   your own app): *Advanced → Go to EverCraft CRM Mail → Continue*. The page says **Connected ✓**.
6. **Turn it on in the CRM:** `mailServiceUrl` in `js/config.js` = the service address.

## Later

- **Reconnect** (password changed, access removed): repeat step 5.
- **Stop sending from the CRM:** set `mailServiceUrl` to `""`, or remove the app's access in the
  Google account (*Security → Third-party connections*).
- Status: `https://evercraft-mail.<your-subdomain>.workers.dev/status`.
