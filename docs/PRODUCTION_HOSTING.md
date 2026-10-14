# Production web address (GitHub Pages) — prepared, not active

| Environment | Code | Web address | Base44 app |
|---|---|---|---|
| Production | branch `main` | **planned:** `https://evercraftinfoadmin-sketch.github.io/Estimation-App/` (today: `https://raw.githack.com/evercraftinfoadmin-sketch/Estimation-App/main/index.html`) | EverCraft CRM `6aceadfed0aa786c7c2934ff` |
| Dev | branch `feature/integrated-crm` | `https://raw.githack.com/evercraftinfoadmin-sketch/Estimation-App/feature/integrated-crm/index.html` | EverCraft CRM (dev) `6acd6d429d6ed1576d7696b7` |

## Why

- Today both environments are on `raw.githack.com`, so they share the browser's storage
  (photos, the original pre-sync data). Keys ending in `@<app id>` keep the CRM data apart, but
  not the photos. A different web address for production separates everything.
- raw.githack.com is a development proxy without uptime guarantees. GitHub Pages is a real host.

## How it works

`.github/workflows/pages.yml` publishes **only `main`**. Before publishing it checks that `main`
uses the production Base44 app, scans for secrets and runs all browser tests; any failure stops
the publish. Only `index.html`, `css/` and `js/` are published.

## Switching (each step needs the owner's approval)

1. **Before switching:** the real data must already be in the production Base44 app (uploaded
   from the browser that holds it, on the old address). Browser data does not move to a new web
   address by itself; after the switch the app downloads it from Base44 at sign-in.
   Photos stay in the old browser address until cloud photos are built.
2. Owner, in GitHub: *Settings → Pages → Build and deployment → Source: GitHub Actions*.
3. Merge the approved changes into `main`; the workflow publishes the site.
4. Change the production Base44 sign-in page (`EvercraftRedirect.jsx`) to send sign-ins to the
   new address, and publish the Base44 app.
5. Google Maps key: add `https://evercraftinfoadmin-sketch.github.io/*` to its allowed websites
   (HTTP referrers) in Google Cloud.
6. Check: sign in with email and with Google (computer and phone), counts match, then tell
   employees the new address. Keep the old address working for one week for checks only.

**Rollback:** point `EvercraftRedirect.jsx` back to the githack address and turn Pages off.
No data is involved: both addresses use the same Base44 app.
