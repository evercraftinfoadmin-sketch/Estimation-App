"use strict";

/* Deployment configuration.
   Never commit a real API key. Either:
   - replace the placeholder below only in your deployed copy (not in git), or
   - leave it and enter the key in Settings → Address Verification (stored in that browser only).
   See docs/GOOGLE_MAPS_SETUP.md for the required Google Cloud setup. */
window.EVERCRAFT_CONFIG = {
  // Restricted browser key: HTTP-referrer restricted, limited to
  // "Maps JavaScript API" and "Places API (New)".
  googleMapsApiKey: "YOUR_RESTRICTED_API_KEY",
  // Address suggestions are limited to these countries (ISO 3166-1 alpha-2).
  addressRegionCodes: ["us"]
};
