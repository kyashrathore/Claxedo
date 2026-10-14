# usage

Owns: how much the user's agents used, read from the server's usage summary (`server.queries.usage.summary`), and quota windows: the words for a window and the meter that shows it. Settings' accounts name their windows with `useWindowName` from here.

## Concepts

- **Usage limits** (`view: "quota"`): each account's quota windows (`session`, `weekly`, `weekly_opus` and whatever else the provider reports), how much of each is used and when it resets. `groupQuotaAccounts` (`quota-groups.ts`) orders them for the reader:
  - **In use**: the accounts the user's agents run their next turn on.
  - **Also signed in**: every other account Claxedo can run on, and any other agent on this machine that reports a plan.
  - **Not connected**: other agents on this machine that report no plan (not signed in, not running, or their probe failed). They are one collapsed group, and the probe's reason is shown quietly inside it; it is an expected state, not an error.
- **Window risk** (`windowRisk`): every window shows the percentage used and its reset. Colour means risk only: from 80% used it is a warning, at 100% the limit is reached.
- **A card is never bare**: an account draws its windows, or the server's one-line reason it has none (`usageError`: the vendor refused the login, did not answer, the stored login is gone, or a setup-token cannot read its plan), or, when the vendor answered and named no window, "This account reported no usage limits." On a hosted plane the server reads each account's windows from its vendor before answering, so the first open already shows them; on a machine they land through `usageChanged`.
- **Usage through Claxedo** (`view: "claxedo"`): the turns Claxedo ran in the last 7, 30 or 90 local days. The chosen measure (tokens or cost) leads the totals and draws one bar per local day of the range, a day without turns being a measured zero (`daily-series.ts`). Tokens are split into the context the model read (cache read, cache write, new input) and what it generated (output, reasoning) (`token-composition.ts`). The breakdown groups by provider or by model, 25 rows a page.
- **Cost estimate** (`costEstimate`): `none` when nothing was measured, `unknown` when no token has a price, `partial` (a lower bound) when some tokens have none, `complete` otherwise. An unknown cost is never drawn as $0.00.
- **Refresh** sends a `refresh_nonce`, so the server checks the quotas again instead of answering from its last read; a refresh it declines because the last one was too recent reports `throttledUntil`, shown as the time the next check can run.
- **Cloud** (`view: "cloud"`, `cloud-usage.tsx`): what the signed person's own cloud workspaces cost this month, and the ones running now. It is offered only where the server offers cloud workspaces (`capabilities().features.cloud`).
  - **Machine time** (`machine-time.tsx`, `useMachineTime`): the headline — minutes since the start of the local calendar month (`localMonthStart`), as the server sums them (every boot that ended in the month, clipped to it, and the boots still running, counted up to the read), the estimated cost of the priced minutes, how many workspaces run now, and one line per provider on how it bills, with where and when its rates were read. Minutes are whole (`wholeMinutes`). Minutes on a machine the server has no published rate for are counted but not priced, and the headline says so (`cloudCost`, `cloud-rows.ts`).
  - **Workspace rows** (`cloud-workspace-table.tsx`, `cloudRows`): one row per workspace, provider and machine size this month — a workspace resized within the month is two rows — with its minutes, the provider's published hourly rate for that size (vCPU and RAM in words) or "Unknown", and the cost. Once the cloud domain's list of running workspaces has loaded, it alone says which rows run (`useRunningCloudWorkspaces`): a row it lists says "Running since" its start, the status words are that domain's one machine (`useCloudStatusText`) and Stop is its command; a row it no longer lists is stopped even while the machine-time read still carries a start, because the machine-time query is refetched only after a stop or a placement event. Before that list has loaded, the machine-time read's start is what marks a row running. A workspace the cloud domain lists as running that has no minutes yet (still starting) is a row after the timed ones. Rows are told apart by name, branch, project, size and start time, never by id alone; the id is the name's tooltip.
  - The read is `loading → ready(time) | failed(error)`; `cloudWorkspaceChanged`, `placementsChanged` and a stream gap invalidate it, and nothing polls, so an open view shows the minutes as of its last read.
- **Which views are offered**: Usage limits and Usage through Claxedo always; Cloud where cloud workspaces are offered. The first offered view opens. On a machine the quota windows are the harness CLIs' and the stored accounts' as that machine reads them; on a hosted plane they are the signed person's own stored accounts and the organization's accounts any member may spend, never another member's.
- There is no "Total" view: counting usage Claxedo didn't run was dropped.

## Data

The summary is fetched data: it lives in the TanStack Query cache under the adapter's `usage` keys, and the adapter's `usageChanged` event invalidates it, so a quota refresh on the server reaches an open view without polling. The view's choices (view, range, measure, grouping, page cursor) are component state; changing a choice other than the page starts again at the first page.

## Machine

The read is `loading → ready(summary) | failed(error)`, derived from the query (`api.ts`), which runs only while a summary view is open. The loading text shows only after the placeholder delay.

## Screens

The Usage settings section (`/settings/usage`, `usageSettingsSection`).

## Flows

16 (per-turn usage and quota windows).
