# usage

Owns: how much the user's agents used, read from the server's usage summary (`server.queries.usage.summary`), what each account paid for (`server.queries.usage.accountSpend`), what their cloud sandboxes cost (`server.queries.usage.machineTime`), and quota windows: the words for a window and the meter that shows it. Settings' accounts name their windows with `useWindowName` from here.

## Concepts

Three settings pages, one per question, each its own entry in the settings sidebar's Account group (`usageLimitsSettingsSection`, `aiUsageSettingsSection`, `sandboxUsageSettingsSection` in `index.ts`):

- **Usage limits** (`/settings/usage-limits`, `UsageLimitsSection`, the summary's `view: "quota"`): each account's quota windows (`session`, `weekly`, `weekly_opus` and whatever else the provider reports), how much of each is used and when it resets. `groupQuotaAccounts` (`quota-groups.ts`) orders them for the reader:
  - **In use**: the accounts the user's agents run their next turn on.
  - **Also signed in**: every other account Claxedo can run on, and any other agent on this machine that reports a plan.
  - **Not connected**: other agents on this machine that report no plan (not signed in, not running, or their probe failed). They are one collapsed group, and the probe's reason is shown quietly inside it; it is an expected state, not an error.
  The account menu's Usage item opens this page (`USAGE_LIMITS_SECTION`).
- **Window risk** (`windowRisk`): every window shows the percentage used and its reset. Colour means risk only: from 80% used it is a warning, at 100% the limit is reached.
- **A card is never bare**: an account draws its windows, or the server's one-line reason it has none (`usageError`: the vendor refused the login, did not answer, the stored login is gone, or a setup-token cannot read its plan), or, when the vendor answered and named no window, "This account reported no usage limits." (`quotaAccountBody`). While a check runs (`refreshing`), a card with neither says "Checking your agents…" and the page claims no empty or unavailable answer until the check settles. On a hosted plane the server reads each account's windows from its vendor before answering, so the first open already shows them; on a machine they land through `usageChanged`.
- **AI usage** (`/settings/ai-usage`, `AiUsageSection`, the summary's `view: "claxedo"`): the turns Claxedo ran in the last 7, 30 or 90 local days. The chosen measure (tokens or cost) leads the totals and draws one bar per local day of the range, a day without turns being a measured zero (`daily-series.ts`). Tokens are split into the context the model read (cache read, cache write, new input) and what it generated (output, reasoning) (`token-composition.ts`). The breakdown groups by provider or by model, 25 rows a page.
- **By account** (`account-spend-section.tsx`, `server.queries.usage.accountSpend`): below the summary, wherever the server offers cloud workspaces (`capabilities().features.cloud`; only the hosted plane answers the route), what each payer of the range's cloud turns spent, costliest first as the server orders them, priced per model by the server. A row (`spendRow`, `account-spend.ts`) is one of the person's own accounts (its name and vendor, and Plan or API key), a team key, "A teammate's account" (another member's own account the person's turns spent on a shared session, which the server names by nothing of theirs), "Your machine's own login", "An account that is no longer available", or "Not recorded" (the runtime named no account). An own or team account whose stored row was deleted keeps its kind and is named "Removed account". Tokens are "Unknown" only when every turn on the row reported none (`spendTokens`).
  - **Scope**: "Yours" (`mine`) always; "Team keys" (`org`, every member's turns on the organization's team keys) is offered only to a person the server reports as managing the organization's accounts, the same `accounts.manageOrg` fact Team accounts reads from the account sources (`useManagesTeamKeys`). Everyone else never reads it, and a chosen Team keys falls back to Yours when the fact says otherwise (`spendScope`). Under Team keys a team key's name is a disclosure (`AccountRows`, `account-spend-table.tsx`) that lists, below it, each member who sent turns on it with their own turns, tokens and cost, costliest first: their name from the organization's members list as the server gives it, "Member without a name" when that list has none, or "Former member" for one who has since left. Under Yours a team key has no members to list.
  - The read is `loading → ready(report) | failed(error)`, keyed by range and scope under the `usage` prefix, so `usageChanged` invalidates it with the summary; the range is the page's range choice and the scope is component state.
- **Cost estimate** (`costEstimate`): `none` when nothing was measured, `unknown` when no token has a price, `partial` (a lower bound) when some tokens have none, `complete` otherwise. An unknown cost is never drawn as $0.00.
- **Refresh** (both summary pages) sends a `refresh_nonce`, so the server checks the quotas again instead of answering from its last read; a refresh it declines because the last one was too recent reports `throttledUntil`, shown as the time the next check can run.
- **Sandbox usage** (`/settings/sandbox-usage`, `SandboxUsageSection`): what the signed person's own cloud sandboxes cost in the last 7, 30 or 90 local days (`machineTimeSince`), and the ones running now. The page exists only where the server offers cloud workspaces (`capabilities().features.cloud`, the section's `available`).
  - **Totals** (`sandbox-totals.tsx`, `sandboxTotals`): the range's estimated cost, its machine time, and, while any sandbox runs, how many run and what the machines serving now cost per hour at their published rates. Minutes are whole (`wholeMinutes`), shown as hours and minutes from an hour up.
  - **Workspaces** (`sandbox-table.tsx`, `sandboxRows`): one row per workspace, however many machine sizes it ran on in the range (each size is one of the server's rows, listed in the row's detail), with its time and cost (`CostEstimate`: a row with an unpriced size costs "at least" its priced part). Its status is the cloud domain's word for its one machine (`useCloudStatusText`) while it is on, or "Asleep since" the end of its latest boot (`lastStoppedAt`); Stop is the cloud domain's command. Running rows come first, then the most recently stopped. A workspace the cloud domain lists as running that has no minutes yet (still starting) is a row with no time. Once the cloud domain's running list has loaded it decides what runs: a machine-time read taken before a stop still carries `runningSince` until it refetches, so a workspace the list no longer has is shown stopped, and every placement refresh (a stop included) invalidates machine time. The All / Running filter is component state. Rows are told apart by name, branch, project and size, never by id alone; the id is the name's tooltip.
  - **Prices** (`sandbox-prices.tsx`): one line per provider naming where and when its rates were read, and what its price leaves out; time on a size with no published rate is counted, not priced, and one line says so.
  - The read is `loading → ready(time) | failed(error)`; `cloudWorkspaceChanged`, `placementsChanged` and a stream gap invalidate it, and nothing polls, so an open view shows the minutes as of its last read.
- There is no "Total" view: counting usage Claxedo didn't run was dropped.

## Data

The summary is fetched data: it lives in the TanStack Query cache under the adapter's `usage` keys, and the adapter's `usageChanged` event invalidates it, so a quota refresh on the server reaches an open view without polling. Each page's choices (range, measure, grouping, page cursor, sandbox filter) are component state; changing a choice other than the page starts again at the first page.

## Machine

The read is `loading → ready(summary) | failed(error)`, derived from the query (`api.ts`), which runs only while a summary view is open. The loading text shows only after the placeholder delay.

## Screens

The Usage limits, AI usage and Sandbox usage settings sections (`/settings/usage-limits`, `/settings/ai-usage`, `/settings/sandbox-usage`).

## Flows

16 (per-turn usage and quota windows).
