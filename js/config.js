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
  addressRegionCodes: ["us"],
  // Shared cloud data (Base44). Empty = off (data stays in this browser only).
  // The app id is a public identifier, not a secret; access is controlled by Base44 sign-in
  // and the access rules on the Base44 side. See docs/BASE44_SETUP.md.
  // PRODUCTION app "EverCraft CRM" (real company data). Feature branches use the dev app.
  base44AppId: "6aceadfed0aa786c7c2934ff",
  base44AppBaseUrl: "https://ever-craft-crm-7c2934ff.base44.app",
  // API address. Empty = Base44's default (https://base44.app); the production app is published.
  base44ServerUrl: "",
  // CRM mail service (worker/ on Cloudflare): sends estimates and invoices from the company Gmail.
  // Empty = the Email button opens Gmail instead. A public address, not a secret.
  mailServiceUrl: ""
};
