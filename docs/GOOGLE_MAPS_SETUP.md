# Address verification: Google Cloud setup

The app checks client addresses with **Google Places** (Estimate Builder, CRM project / new lead
window). Without a key everything still works: addresses can be typed and saved, they are just
marked *Unverified*.

## What the app uses

| Google product | Used for |
|---|---|
| **Maps JavaScript API** | loads the Google library in the browser (`libraries=places&loading=async`) |
| **Places API (New)** | address suggestions (`AutocompleteSuggestion.fetchAutocompleteSuggestions`) and place details (`Place.fetchFields`: formatted address, address components, location, id) |

The app uses the current *Autocomplete Data API* of Places API (New), not the legacy
`google.maps.places.Autocomplete` widget: the legacy widget is not available to Google Cloud
projects created after March 1, 2025, and the Data API lets the app keep its own input fields.

No map is displayed, and no server or server-side credentials are needed. "Open in Google Maps"
is a plain link (`https://www.google.com/maps/search/?api=1&query=<lat>,<lng>`).

## Steps

1. **Project and billing:** in the [Google Cloud Console](https://console.cloud.google.com/), create
   or choose a project and link a **billing account**. Places requests are billed; check Google's
   current pricing and free monthly usage.
2. **Enable APIs:** go to *APIs & Services → Library* and enable:
   - **Maps JavaScript API**
   - **Places API (New)**
3. **Create a browser key:** go to *APIs & Services → Credentials → Create credentials → API key*.
4. **Restrict the key.** This is required, because a browser key is visible to anyone using the page.
   - *Application restrictions* → **Websites (HTTP referrers)**, and add only your app's addresses, e.g.
     - `https://your-domain.com/*`
     - `https://evercraftinfoadmin-sketch.github.io/*` (the CRM)
     - `https://raw.githack.com/evercraftinfoadmin-sketch/Estimation-App/*` (test version)
     - `http://localhost/*` (local testing, optional)
   - *API restrictions* → **Restrict key** → select only **Maps JavaScript API** and **Places API (New)**.
5. **Optional, quotas:** in *APIs & Services → Places API (New) → Quotas*, set a daily request cap
   to limit costs.
6. **Give the key to the app:** choose one of these.
   - **Settings → Address Verification → Google Maps API key → Save Settings.** The key is stored
     only in that browser (localStorage) and is included in the app's backup file.
   - **Deployment config:** in the *deployed copy* of `js/config.js`, replace
     `YOUR_RESTRICTED_API_KEY` with the restricted key. Do **not** commit a real key to git.

A key entered in Settings takes priority over `js/config.js`.

## Options in `js/config.js`

| Option | Default | Meaning |
|---|---|---|
| `googleMapsApiKey` | `"YOUR_RESTRICTED_API_KEY"` (= not set) | restricted browser key |
| `addressRegionCodes` | `["us"]` | countries for suggestions (ISO codes, max 15) |

## Error handling

| Situation | What the user sees | Saving |
|---|---|---|
| No key | "Address suggestions are off: add a Google Maps API key in Settings…" | works (unverified) |
| Key rejected (wrong key, referrer not allowed, API not enabled, no billing) | "Google rejected the address lookup (check the API key, enabled APIs and billing)…" | works |
| Quota exceeded | "Address lookup limit reached. Try again later, or keep the entered address." | works |
| Network / Google not reachable | "Address suggestions are unavailable (network problem)…" (retried on next focus) | works |
| No results | "No matching addresses found. Check the spelling, or keep the entered address." | works |

Google Maps is loaded **once**, only when an address field is first focused, and only if a key
is configured. If the page already has Google Maps loaded, that copy is reused. After changing
the key in Settings, reload the page if Google Maps was already loaded with the old key.

## Costs, in short

Suggestions use **session tokens**: typing plus the final selection count as one autocomplete
session. Only the fields the app needs are requested. No map is loaded.
