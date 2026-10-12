# Shared team database (Supabase): setup, migrations and data import

Status: **prepared, not applied.** No Supabase project has been changed. The migrations have only
been run and tested on a temporary local PostgreSQL 16 database, using a stand-in for Supabase's
auth and storage parts (`supabase/tests/`).

## 1. Files

| File | Purpose |
|---|---|
| `supabase/migrations/20261014000100_core_schema.sql` | tables, keys, constraints, indexes |
| `supabase/migrations/20261014000200_functions_triggers.sql` | membership checks, audit/version triggers, soft-delete guard, last-owner guard, atomic estimate numbering |
| `supabase/migrations/20261014000300_rls.sql` | Row Level Security policies |
| `supabase/migrations/20261014000400_storage_realtime.sql` | private photo bucket `crm-photos` + storage policies, realtime publication |
| `supabase/migrations/20261014000500_import_local_data.sql` | insert-only import function `import_local_data(org, data)` |
| `supabase/manual/bootstrap_organization.sql` | run once by hand: creates the organization and its owner |
| `supabase/tests/local_supabase_stub.sql` | test only: stand-in for Supabase on plain PostgreSQL |
| `supabase/tests/rls_and_import_test.sql` | test only: permission, soft-delete, numbering, storage and import checks |

Run the local checks: start PostgreSQL, apply the stub, then the migrations in order, then the test.
The last line printed is `ALL PASSED`.

## 2. Tables, mapped 1:1 from the app's current data

All tables have `org_id` (the company) and keep the app's existing text IDs as keys `(org_id, id)`.
That is what keeps estimate ↔ CRM links, services' categories and line-item references working.

| App storage today | Table | Notes |
|---|---|---|
| `constructionEstimatorSettings` | `org_settings` | `googleMapsApiKey` is **not** uploaded: it stays in each browser. Unknown old keys go to `extra`. |
| `constructionEstimatorCategories` | `categories` | Custom categories only; `drywall`/`stucco`/`painting` stay fixed in code. IDs such as `cat-…` and the migrated `other` are kept. |
| `constructionEstimatorServices` | `services` | `category` = main key or custom category ID. |
| `constructionEstimatorSavedEstimates` | `estimates` | Line items, custom categories and category totals as JSON; all 13 address fields as columns; old-calculator fields and `imported` go to `extra`. |
| `constructionEstimatorCRM` | `crm_projects` | Stages stored **exactly** as the app stores them (see §6); checklist `tasks` as JSON; one active project per estimate (unique index). |
| IndexedDB `constructionEstimatorPhotos` | `project_photos` + Storage `crm-photos/<org>/<project>/<photo>.jpg` | Files are uploaded without overwriting; captions are kept. |
| (new) | `organizations`, `team_members` | Roles: owner, admin, member. |

Common columns: `created_at`, `updated_at`, `created_by`, `updated_by`, `deleted_at` / `deleted_by`
(soft delete), and `version` (estimates, CRM projects) for edit-conflict detection.

## 3. Security model (tested locally)

- **Not logged in:** no access to anything.
- **Members:** read, add and edit their company's estimates, CRM projects, services, categories and photos.
  They cannot delete, change business Settings, manage the team or import.
- **Owner / admin:** additionally soft-delete and restore records, change Settings and import.
  Photo *files* can only be purged by owner/admin.
- **Owner only:** add, change and remove team members. The last owner cannot be removed;
  ownership can be handed over.
- **No hard deletes from the app** (there is no DELETE policy). Deleting sets `deleted_at`, and the
  record can be restored.
- **Edits:** records cannot be moved to another company, and IDs and creation data cannot be changed.
- **Estimate numbers:** `next_estimate_number(org, year)` hands out numbers in one step
  (`EST-<year>-<NNNN>`, same format as the app), so two people never get the same number. The
  database also rejects duplicates.
- **Keys:** the browser only ever uses the project URL and the **publishable/anon** key. The
  `service_role` key is never put in app code or GitHub.

## 4. Data import plan (one time, per browser that has data)

Insert-only. **No cloud record and no local record is overwritten or deleted.**

1. The owner logs in, then goes to Settings → **"Upload this browser's data to the team database"**
   (to be built in phase C).
2. A **backup file of the local data is downloaded first** (the existing backup feature).
3. The app converts the local records to table rows (camelCase → snake_case, `""` dates → null,
   unknown fields → `extra`) and shows a preview with counts.
4. **Photos:** each IndexedDB photo is uploaded to `crm-photos/<org>/<project>/<photo>.jpg` with
   *no overwrite*; a file that already exists is skipped. Photos of projects that don't exist are reported.
5. One call to `import_local_data` (one transaction):
   - existing IDs are skipped, and **existing cloud values stay unchanged**;
   - an estimate whose number is already used by another estimate is skipped and **listed for you**;
   - a second CRM project for an estimate that already has one is skipped and listed;
   - a local custom category whose name already exists in the cloud is merged into the cloud one
     for services;
   - links to records that won't exist are dropped, so no broken links are created;
   - the cloud estimate counter is only ever **raised**;
   - original `created_at` / `updated_at` times are kept.
6. The report is shown and saved. Local data stays in the browser untouched.

Several team members can each upload their own browser's data; anything already uploaded is
skipped. Running the import again changes nothing (tested).

## 5. Manual setup (only you can do this)

1. **Connect the Supabase connector** at https://claude.ai/customize/connectors (Supabase, developed
   by Supabase), then **start a new Claude Code session**. Connectors load when a session starts.
2. **Create a development project**, e.g. `evercraft-dev` (US West). Keep production separate.
3. **Dev project → Authentication:**
   - turn off "Allow new users to sign up" (team access by invitation only);
   - set the Site URL and redirect URLs to where the app is hosted (e.g. GitHub Pages);
   - later, for production: custom SMTP for invitation emails.
4. **Invite yourself** (Authentication → Users → Invite) and accept the email.
5. **Approve the migrations for the dev project.** Then, with the connector:
   1. apply `supabase/migrations/*` to **dev only**;
   2. run `supabase/manual/bootstrap_organization.sql` with your email;
   3. run security advisors and check the tables / policies.
6. **Later:** invite test users (one admin, one member) to try permissions and live sync.

Production: same steps on a separate project, **only after your explicit approval.**

## 6. Open decision: CRM stage values

The values the app actually stores are not the names in the approval message:

| Approval message | Stored by the app today | Label |
|---|---|---|
| `lead` | `lead` | Leads / Clients |
| `prospect` | `prospect` | Prospects |
| `client_job` | `job` | Client / Job |
| `start_project` | `started` | Start the Project |
| `completed` | `completed` | Project Completed |
| `follow_up` | `followup` | Follow-up |

The migrations currently keep the **stored values** (`job`, `started`, `followup`), so no record
changes. The alternative is to store `client_job` / `start_project` / `follow_up` in the database
and convert in the import and sync code (the app UI stays the same).

## 7. Next phases (after approval)

- **B, dev database:** apply the migrations to the dev project, bootstrap the organization, check
  with the Supabase advisors.
- **C, app integration** (branch `feature/supabase-sync`; no rewrite, the screens stay the same):
  - `supabase-js` v2, loaded from jsDelivr with a pinned version; URL and publishable key in `js/config.js`;
  - a login screen; signed-out use keeps working locally;
  - `js/cloud.js`: the existing `load*` / `save*` functions keep using the local cache and also
    write to and read from Supabase;
  - realtime subscriptions refresh the screens, and edit conflicts are detected with `version`;
  - deletes become soft deletes in cloud mode, and delete buttons are shown only to owner/admin;
  - photos through Storage with signed URLs;
  - estimate numbers through `next_estimate_number`;
  - the upload screen described in §4.
- **D, testing on dev** with several users. Then production, only with your approval.
