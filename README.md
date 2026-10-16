# Estimate Builder + Construction CRM

A standalone web app for Drywall, Stucco and Painting contractors: build commercial
estimates from a service list and track every client through a CRM pipeline.
Plain HTML, CSS and JavaScript, with no frameworks and no build step.

**Open the CRM:** https://evercraftinfoadmin-sketch.github.io/Estimation-App/ (published from `main`;
see [docs/PRODUCTION_HOSTING.md](docs/PRODUCTION_HOSTING.md)).

## Features

**Estimate Builder**: client details plus the three main categories (Drywall, Stucco, Painting).
**+ Add Category** adds your own categories (Roofing, Flooring, Tile, …) as extra sections;
they are saved, can hold services, and are managed on the Services page.
Each category holds unlimited line items: *Service, Quantity, Price, Total*.
There are no units: line total = quantity × price.
Totals: category totals, subtotal, markup, sales tax and grand total.
Save, Print / PDF, Email Client, Reset.

**Saved Estimates**: search (client, address, estimate #), status filter
(draft, sent, accepted, rejected, completed), and Open / Edit, Duplicate, Print, Email,
Create / Open CRM Project and Delete. Estimate numbers (EST-2026-1001, 1002, …) are never duplicated.

**Services**: the service database with search, category filter, add, edit, delete and
enable / disable. The Estimate Builder loads a service's name and default price; changing the
price in an estimate never changes the default. Custom services can be used once or saved to the list.

**CRM**: a Kanban pipeline:
Leads / Clients → Prospects → Client / Job → Start the Project → Project Completed → Follow-up.
It covers prospect quote status, job scheduling and technician, the start-project and completion
checklists (X / Y completed), follow-ups, and **photos** for each project (job photos, before / after,
reports; with captions). A project can create an estimate pre-filled with the
client, and a saved estimate can create (or open) its single CRM project. The estimate stays the
source of truth for pricing.

**Settings**: company details (phone, email, license #), default markup, sales tax, what the tax applies to,
the next estimate #, and the **Terms & Conditions** that are added to every estimate PDF and email.

**Address verification (Google Places)**: the client address fields in the Estimate Builder and
the CRM project / new-lead window suggest real addresses as you type. Selecting a suggestion saves
the standardized address, its parts (number, street, unit, city, state, ZIP, country), coordinates
and Google place id, and marks it **Verified**. Typing in a verified address removes the verification
until a suggestion is chosen again. Results without a street number can be confirmed as
**Needs review**, and "Keep Entered Address" keeps your own text (also *Needs review*).
Units (Apt 4B, Suite 200, #12) are kept, and nothing is invented. "Open in Google Maps" appears when
coordinates exist. Address filters on Saved Estimates and CRM (Missing / Unverified / Needs review /
Incomplete / Verified) find records to fix one by one; old records are never changed automatically.
Linked estimates and CRM projects share the address saved last, but a verified address is never
replaced by an unverified one. Setup: [docs/GOOGLE_MAPS_SETUP.md](docs/GOOGLE_MAPS_SETUP.md)
(no key = addresses are simply typed and stay *Unverified*).

**Import & Backup**: ⬆ Import (CRM, Saved Estimates, Settings) reads leads and estimates from a
previous system as **Excel (.xlsx) or CSV**: columns are matched automatically and can be changed,
rows with the same Estimate # become one estimate, and existing estimate numbers / CRM clients are
not duplicated. Imported estimates keep their totals (0% markup and tax). Settings → Download Backup
saves all data (except photos) as a JSON file; Restore Backup loads it again.
Excel files are read with SheetJS, loaded from cdnjs only when an .xlsx file is chosen.

**Shared cloud data (Base44)**: when `js/config.js` has a Base44 app id, employees sign in
with the ☁ button. Estimates, CRM projects, services, categories and company settings are then
shared, with access enforced by Base44 (owner / admin / member). Changes sync near real time
(realtime events + a check every minute), and conflicts never overwrite anyone's work. Setup and rules:
[docs/BASE44_SETUP.md](docs/BASE44_SETUP.md). On `main` the app uses the **production** Base44 app
"EverCraft CRM"; feature branches use the test app (fake data).

## Data

Everything is stored in the browser's `localStorage`:

| Key | Contents |
|---|---|
| `constructionEstimatorSettings` | company & pricing settings, estimate counter |
| `constructionEstimatorServices` | service list |
| `constructionEstimatorSavedEstimates` | saved estimates |
| `constructionEstimatorCRM` | CRM projects |
| `constructionEstimatorCategories` | custom service categories |

Estimates and CRM projects also store the structured address fields
`addressStatus` (verified / unverified / needs_review), `addressStreetNumber`, `addressRoute`, `addressUnit`,
`addressCity`, `addressState`, `addressPostalCode`, `addressCountry`, `addressLatitude`, `addressLongitude`,
`addressPlaceId` and `addressLastVerifiedAt`. Older records with only `address` keep working (*Unverified*).

With shared cloud data, each Base44 app keeps its own copy of these keys (`…@<app id>`), plus its
sign-in (`base44_access_token@<app id>`), sync bookkeeping (`constructionEstimatorCloudMeta@…`) and
conflict copies (`constructionEstimatorCloudConflicts@…`); see docs/BASE44_SETUP.md.

CRM photos are stored in the browser's IndexedDB (database `constructionEstimatorPhotos`),
resized to at most 1600 px as JPEG.

## Structure

```
index.html          page layout (5 pages + modals + print template)
css/styles.css      styles, responsive layout, print layout
js/core.js          shared helpers (escaping, money, dates, storage, modals)
js/calc.js          the single calculation engine
js/config.js        deployment config (Google Maps key placeholder, address region)
js/settings.js      settings + estimate numbering
js/address.js       address verification (Google Places loader, autocomplete, status, data model)
js/categories.js    main + custom service categories
js/services.js      services database & Services page
js/estimates.js     Estimate Builder, Saved Estimates, Print/PDF, Email
js/crm.js           CRM pipeline and Estimate ↔ CRM links
js/photos.js        CRM project photos (IndexedDB, resizing, gallery)
js/cloud.js         shared cloud data: Base44 sign-in and sync (off without an app id)
js/importer.js      CSV / Excel import, backup export & restore
js/app.js           navigation and start-up
```

## Run

Open `index.html` in a browser. It is a static site, so it can be deployed directly to
GitHub Pages or Vercel.
