# Clients, properties (addresses) and projects

```
CLIENT (the person, primary contact)
├── PROPERTY 1 (a physical address)
│   ├── PROJECT (a job at that address)
│   └── PROJECT
└── PROPERTY 2
    └── PROJECT
```

- **Clients page** (menu): every client with their properties and projects. Click a client to open
  the profile:
  - contact details and notes;
  - **Properties / Addresses**, each with its projects and stages, **+ Create Project** and
    **+ Add Address**;
  - projects without an address are listed apart;
  - archived addresses are kept at the bottom.
- **Property window** (click an address):
  - the full address, the client and the property notes;
  - the projects at that address and **+ Create Project**, with the client and address already
    filled in;
  - **Archive** / **Restore**.
- **Add Address**:
  - Google suggestions (optional) fill in street, unit, city, state, ZIP and country;
  - property notes;
  - the same address twice for one client is refused.
- **Project window**:
  - **Client**: choose an existing client, or "New client" and type the details. Typing the phone
    or email of an existing client suggests that client (**Use this client**). Saving with a
    matching phone or email asks before linking; nothing is merged silently.
  - **Property**: only the chosen client's addresses are offered.
    - One address: it is chosen automatically.
    - Several addresses: one must be chosen.
    - **+ Add Address**: adds one without losing what is typed in the project form.
  - The project keeps its own copy of the client details and the address, as before. Estimates,
    PDFs, maps, the calendar and photos are unchanged.

## Data

| Record | Base44 table | Key fields |
|---|---|---|
| Client | `Client` (existing table, now used) | `clientName`, `clientEmail`, `clientPhone`, `notes`; archived in `extra` |
| Property | `Property` (new, `docs/base44-property-entity.json`) | `clientId`, the address fields (as on projects), `notes`, `archived` |
| CRM project | `CrmProject` (unchanged table) | `client_id` (existing field, now filled), `propertyId` (in `extra`) |

**Access rules** are the same as for projects: members read, create and change; owners and admins
delete. **Addresses are archived, never deleted**, and their projects are never touched.

**Same client** means the same email or the same phone (compared by digits, so "(818) 555-0101" and
"+1 818 555 0101" match). The same name alone is only shown as a possible duplicate, never merged.

**Same address** means the same Google place, or the same address text (ignoring case, punctuation
and "USA").

**Limitation:** "the address belongs to the selected client" is checked by the CRM. Base44 has no
backend functions here, so the server cannot check it across tables.

## Existing projects (migration)

**Settings → Import & Backup → Link Projects to Clients & Addresses…**, or the link on the Clients
page (owners and admins only).

1. **The report first.** Nothing changes until **Link projects** is pressed. The report lists:
   - existing clients and projects;
   - the clients and properties that would be created;
   - projects **without an address**: they are linked to their client and flagged for a manual
     address (no address is invented);
   - possible duplicates: the same name with a different phone or email, and similar addresses of
     one client.

   **Download report (CSV)** saves it.
2. **Link projects.** It creates the clients and properties and fills in `client_id` and
   `propertyId`. Nothing else on the projects changes, not even their "last changed" date, so the
   calendar sync does not treat them as new. Estimates, photos and calendar links stay as they are.
   It can be run again: projects already linked are skipped.

**Production:** first create the `Property` table from `docs/base44-property-entity.json`. The
`Client` table already exists. Then an owner runs the report, reads it, and presses Link projects.
**Both steps need approval.** They are tested on the Dev app only.

## Reset buttons

Both Reset buttons now ask in a dialog:
- **Title:** "Are you sure you want to reset?"
- **Buttons:** Cancel (the default) and **Yes, Reset**.
- Escape, a click outside the dialog, or Enter on Cancel all cancel.

They show "Resetting…" while running, a success or error message afterwards, and never run twice.
Neither button deletes saved data, so there is no "type RESET" step.

- **Estimate Builder → Reset:** clears the form and starts a new estimate. Saved estimates,
  projects and clients are kept.
- **Settings → Reset Defaults:** company details, terms, signature texts, pricing defaults, the
  Google Calendar settings (the sync is turned off) and the Maps key go back to the defaults. The
  dialog now says so.
