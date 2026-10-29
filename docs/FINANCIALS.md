# Project Financials (job costing): Stage 1

A **💲 Financials** tab in every saved CRM project (the project window). It covers:
- Financial Overview
- Estimate vs. Actual
- Budget
- Labor & Time, including Remaining Labor Cost
- Materials
- All Entries, with filters
- Financial Activity Log

**Settings → Financials: Team & Labor Cost Rates** holds the team, the cost rates and the defaults.

## Where the numbers come from

There is **one calculation**, `computeProjectFinancials()` in `js/finance.js`. Every figure on
screen comes from it. Money is stored in **integer cents**: each line is rounded once, and typed
amounts are converted from their decimal digits, so 1.005 becomes 101 cents.

### Revenue

| Figure | Definition |
|---|---|
| Contract Amount | The signed estimate **before sales tax**. For estimate options A/B/C, the accepted option. |
| Approved Change Orders | Stage 2. It is 0 until then. |
| Adjusted Contract Revenue | Contract + approved change orders. |

### Costs

| Figure | Definition |
|---|---|
| Estimated Total Cost | The project budget, the sum of the budget lines. |
| Actual Cost to Date | Approved costs only, at the amount approved. This includes the project's quick *Materials* list on the Project tab. |
| Pending | Entries waiting for approval. Shown apart; included in the forecast. |
| Remaining forecast, labor | max(0, estimated hours − actual and pending hours) × forecast rate. The forecast rate is the project's own, or the default in Settings. |
| Remaining forecast, other groups (and labor without an hours estimate) | The current budget not yet spent or pending. This is an *assumption*, stated under the table; manager forecast overrides come in Stage 2. A closed project has nothing remaining. |
| Forecast Total Cost | Actual + pending + remaining. |

### Profit and variance

| Figure | Definition |
|---|---|
| Forecast Profit / Margin | Adjusted revenue − forecast total cost; ÷ revenue. When revenue is 0, the margin shows as "—". |
| Final Actual Profit / Margin | Shown only after **Close project financials**: revenue − approved actual costs. This is project **gross** profit, before company overhead. |
| Budget Variance | Current budget − forecast total. Positive = under budget, negative = over budget. The variance % is "—" when the budget is 0. |

## Entries, approvals and no double counting

- **One ledger** (`CostEntry`) holds every cost:
  - **Material**: quantity, unit, estimated and actual unit cost, vendor.
  - **Labor**: who worked, start/end/break or total hours, *or* a fixed or subcontract amount.
  - **Expense**: category, cost classification and amount.
- **Approvals are separate records** (`CostApproval`). Only owners and admins can create them, and the server enforces this.
  - An approval keeps the **approved amount**, the hours and the **cost rate of that day**.
  - Later rate changes, and later edits, never change approved numbers.
  - An entry changed after approval shows **"Changed, waiting"**: the approved amount still counts, and the difference waits for approval.
- **Never deleted.** Entries are **voided** with a reason. Rejected and voided entries stay visible and count nowhere.
- **Duplicates:**
  - The same expense or material on the same day, or labor hours that overlap the same person's hours, asks before saving.
  - Save can't create two entries by double clicking.
- **The quick Materials list** on the Project tab counts as approved actual material cost. Its rows are listed in Financials → Materials as "project Materials list". Enter an item there **or** in the ledger, not both.
- **Labor cost rates** are the company's *cost* of an hour, not the price billed to the client.
  - A rate applies from its date.
  - The labor burden % (payroll taxes, benefits) applies only when it is set, per person or as a default. Nothing is assumed.
- **Budget:** owners and admins set it per category, with estimated hours and a forecast rate, then **approve** it.
  - After approval the original lines can't be changed; budget adjustments come in Stage 2.
  - Forecast inputs can change with a reason.
  - Every change is in the Activity Log.

## Who may do what

The app hides what the server would refuse. The server rules are in
`docs/base44-finance-entities.json` and are what really protects the data.

| | Owner | Admin | Member (employee) | No access |
|---|---|---|---|---|
| See project financials (budget, costs, profit) | ✔ | ✔ | ✔ (as chosen) | ✖ |
| Add entries (hours, materials, expenses) | ✔ approved at once* | ✔ approved at once* | ✔ wait for approval | ✖ |
| Change / void entries | any (reason once approved) | any (reason once approved) | own entries not yet approved | ✖ |
| Approve / reject | ✔ | ✔ | ✖ (server refuses) | ✖ |
| Budget, close / reopen | ✔ | ✔ | ✖ | ✖ |
| Team and **cost rates** | ✔ | ✔ | ✖ (rates never sent to members) | ✖ |
| Change or delete the audit log, approvals, rates | owner only, in the Base44 dashboard | ✖ | ✖ | ✖ |

\* Unless "approved right away" is turned off in Settings.

Members see approved labor **costs** per entry, because they see full project financials. Hours and
cost together reveal the rate, which is the consequence of that choice.

## Base44 setup

There are six new tables. All of them have `legacy_id`, `version`, `extra`, and `deletedAt`
(admins only), like the other tables.

| Table | Read | Create | Update | Delete |
|---|---|---|---|---|
| Employee | members | admins | admins | owner |
| EmployeeRate | **admins** | admins | owner | owner |
| ProjectBudget | members | admins | admins | owner |
| CostEntry | members | members | admins, or the member who created it | owner |
| CostApproval | members | **admins** | owner | owner |
| FinancialAuditLog | members | members | owner | owner |

- "members" means crm_role owner, admin or member; "admins" means owner or admin.
- **Dev app** (`6acd6d429d6ed1576d7696b7`): the six tables were created from
  `docs/base44-finance-entities.json`.
- **Production** (`6aceadfed0aa786c7c2934ff`): **not done.** It needs your approval. Create the
  same six tables from the same file. Until then the CRM works as before, and the Financials tab
  works on each device, but the financial records don't sync. The sync note names the missing table.

**Migration:** nothing to convert. Existing projects, estimates, invoices and the quick Materials
lists are unchanged; the new tables start empty.

## Honest limitations (Stage 1)

- **Calculations run in the browser.** Base44 has no backend functions in this plan. The server
  enforces *who may write what* (the rules above), not the arithmetic. The amounts that count are
  the ones in approvals, which only managers can create.
- **The audit log is append-only from the CRM, not immutable.** The Base44 app owner can still
  change or delete rows in the Base44 dashboard. Base44 also records who created each row.
- **Edits made outside the CRM** (for example directly in the Base44 dashboard) are picked up only
  if they raise the record's `version`. This applies to every table, as before.
- **Receipt photos** are kept on the device that took them, like project photos (not synced).
- **Retries** happen only while the CRM is open on a signed-in device.
- **Not yet built:**
  - Stage 2: change orders, budget adjustments, rework, unaccounted costs, manager forecast overrides.
  - Stage 3: company-wide reports and CSV export, overhead allocation, timeline and delay tracking.
  - Payroll processing isn't part of this work at all.
