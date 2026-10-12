# Shared cloud data: Base44

The app can share its data (estimates, CRM projects, services, categories, company settings)
between employees through a **Base44** backend. The app code stays in GitHub. Base44 is used
only as the database and for sign-in.

Without a Base44 app id in `js/config.js`, the app works exactly as before (browser only).

## Status

| | |
|---|---|
| Base44 app | **EverCraft CRM (dev)**, id `6acd6d429d6ed1576d7696b7`, **fake data only** |
| Production app | not created yet (needs a paid Base44 plan, see *Limits*) |
| Real company data | not uploaded |

## Tables (Base44 entities)

| Entity | App data | Notes |
|---|---|---|
| `CompanySettings` | Settings (company, markup, tax, terms) | one record, `legacy_id = "company"`; **no Google Maps key** |
| `Category` | custom categories | Drywall / Stucco / Painting are fixed in the app and not stored |
| `Service` | services list | `category` = `drywall`, `stucco`, `painting` or `cat-…` |
| `Client` | client directory | estimates and projects keep their own copy of the client details; `client_id` links them |
| `Estimate` | saved estimates | same field names as the app; `estimateNumber` must be unique |
| `CrmProject` | CRM pipeline | stage values as stored by the app: `lead`, `prospect`, `job`, `started`, `completed`, `followup` |
| `ProjectPhoto` | CRM photos (private file + caption) | prepared; photo sync comes in a later step |
| `EstimateCounter` | next estimate number | one record, `legacy_id = "estimates"` |

Every record has:
- `legacy_id`: the app's own id (`est-…`, `crm-…`, `svc-…`, `cat-…`), so links between estimates and projects keep working;
- `version`: a change counter, used to detect conflicts;
- `extra`: any field the table doesn't define, so nothing is lost;
- `deletedAt`: the soft-delete date (admins only).

## Access (enforced by Base44, server-side)

Access depends on the **`crm_role`** field of each Base44 user:

| crm_role | Read | Create / edit | Delete (soft) | Company settings |
|---|---|---|---|---|
| `owner` | ✔ | ✔ | ✔ | ✔ |
| `admin` | ✔ | ✔ | ✔ | ✔ |
| `member` | ✔ | ✔ | ✖ | read only |
| *(empty)* | ✖ | ✖ | ✖ | ✖ |

- The rules are Base44 row-level security rules on each entity. `crm_role` and `deletedAt` have
  field rules so only admins can change them. Users cannot give themselves access.
- A new account has **no access** until an admin sets its `crm_role`. In Base44: *Dashboard →
  Data → User → (user) → crm_role*.
- The app hides what the server would refuse. For example, when a member deletes a record, the
  app restores it with a message.

## How syncing works

- **Sign in:** the ☁ button in the top bar opens the Base44 login (email + password, or Google),
  then returns to the app.
- **Your changes:** saving uploads the change about 1.5 s later.
- **Other people's changes:** they arrive immediately through Base44 realtime events when
  available, and in any case every **20 seconds**, when the tab becomes visible, or when the
  connection comes back. Updates are *near* real time, not instant.
- **Conflicts:** a record is written only if nobody changed it since this browser last saw it.
  Otherwise the cloud version is kept and your version is saved in the browser under
  `constructionEstimatorCloudConflicts`. Nothing is overwritten silently.
- **Estimate numbers:** the app never offers a number below the shared counter or below a number
  already used. An estimate whose number already exists in the cloud is not uploaded, and you are
  asked to change the number.
- **Existing data in a browser:** the first sync only *downloads*. Records that exist only in
  that browser are uploaded when you click **⬆ Upload local data (N)**, which asks first and
  downloads a backup file. Default services with the same name as a cloud service are merged
  into it.
- **Not synced:** the Google Maps key (per browser), CRM photos (still in the browser; cloud photos
  come next).

## Limits of the current (free) plan

- **Anyone can register** on a *public with login* app, but without a `crm_role` they see no data.
  A **private app** (only invited users can sign in) needs a paid plan, and is recommended for
  production.
- **Backend functions are off.** Without them:
  - the estimate counter and the version check run in the browser, so two saves of the *same*
    record within about a second can still collide;
  - a bulk import cannot run in one server-side step.

  Backend functions (paid plan) would make both atomic.

## Testing

- An automated test runs the sync against a fake Base44 server that enforces the same rules,
  with a signed-out user, an outsider, two members and an owner (46 checks). It covers:
  - download and upload of data;
  - conflicts;
  - member delete refused and restored;
  - admin soft delete;
  - settings changes (members refused, admins allowed);
  - duplicate estimate numbers;
  - realtime events.
- **Still to do on the real dev app:** sign in as real test users (owner, member, outsider) and
  confirm the same results.

## Moving to production (needs approval)

1. Choose the plan, then create the production app (private).
2. Copy the entity schemas from the dev app.
3. Set the owner's `crm_role`.
4. Put the production app id and URL in the deployed `js/config.js`.
5. Upload the real data from one browser with **Upload local data** (a backup is downloaded first).
6. Check the counts.
