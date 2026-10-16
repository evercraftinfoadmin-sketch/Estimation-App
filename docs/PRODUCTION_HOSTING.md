# Production web address (GitHub Pages)

| Environment | Code | Web address | Base44 app |
|---|---|---|---|
| Production | branch `main` | `https://evercraftinfoadmin-sketch.github.io/Estimation-App/` | EverCraft CRM `6aceadfed0aa786c7c2934ff` |
| Dev | branch `feature/integrated-crm` | `https://raw.githack.com/evercraftinfoadmin-sketch/Estimation-App/feature/integrated-crm/index.html` | EverCraft CRM (dev) `6acd6d429d6ed1576d7696b7` |

The old production address `https://raw.githack.com/evercraftinfoadmin-sketch/Estimation-App/main/index.html`
still shows `main` and uses the same Base44 app; keep it only for checks during the switch.

## Why

- On `raw.githack.com` production and dev share the browser's storage (photos, the original
  pre-sync data). Keys ending in `@<app id>` keep the CRM data apart, but not the photos.
  A separate web address for production separates everything.
- raw.githack.com is a development proxy without uptime guarantees. GitHub Pages is a real host.

## How it works

`.github/workflows/pages.yml` publishes **only `main`**. Before publishing it checks that `main`
uses the production Base44 app, scans for secrets and runs all browser tests; any failure stops
the publish and the site keeps the previous version. Only `index.html`, `css/` and `js/` are published.
`.github/workflows/tests.yml` runs the same checks on every push and pull request.

## Switching

1. **Before switching:** every browser that has records not yet on Base44 uploads them on the old
   address (☁ → *Upload local data*). Browser data does not move to a new web address by itself;
   after the switch the app downloads the shared data from Base44 at sign-in.
   **Photos** are stored only in the browser that added them; they stay on the old address until
   cloud photos are built.
2. Owner, in GitHub: *Settings → Pages → Build and deployment → Source: GitHub Actions*.
3. Merge into `main`; the workflow publishes the site (Actions tab → *Publish production site*).
4. Change the production Base44 sign-in page (`src/components/EvercraftRedirect.jsx`, `TARGET`) to
   the new address and publish the Base44 app, so Google sign-in returns to the new address.
5. Google Maps key: add `https://evercraftinfoadmin-sketch.github.io/*` to its allowed websites
   (HTTP referrers) in Google Cloud.
6. Check: sign in with email and with Google (computer and phone), counts match, then tell
   employees the new address.

**Rollback:** point `EvercraftRedirect.jsx` back to the githack address. No data is involved:
both addresses use the same Base44 app.
