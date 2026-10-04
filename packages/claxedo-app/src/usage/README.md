# usage

Owns: how much the user's agents used, read from the server's usage summary (`server.queries.usage.summary`), and quota windows: the words for a window and the meter that shows it. Settings' accounts name their windows with `useWindowName` from here.

## Concepts

- **Usage limits** (`view: "quota"`): each account's quota windows (`session`, `weekly`, `weekly_opus` and whatever else the provider reports), how much of each is used and when it resets. `groupQuotaAccounts` (`quota-groups.ts`) orders them for the reader:
  - **In use**: the accounts the user's agents run their next turn on.
  - **Also signed in**: every other account Claxedo can run on, and any other agent on this machine that reports a plan.
  - **Not connected**: other agents on this machine that report no plan (not signed in, not running, or their probe failed). They are one collapsed group, and the probe's reason is shown quietly inside it; it is an expected state, not an error.
- **Window risk** (`windowRisk`): every window shows the percentage used and its reset. Colour means risk only: from 80% used it is a warning, at 100% the limit is reached.
- **Usage through Claxedo** (`view: "claxedo"`): the turns Claxedo ran in the last 7, 30 or 90 local days. The chosen measure (tokens or cost) leads the totals and draws one bar per local day of the range, a day without turns being a measured zero (`daily-series.ts`). Tokens are split into the context the model read (cache read, cache write, new input) and what it generated (output, reasoning) (`token-composition.ts`). The breakdown groups by provider or by model, 25 rows a page.
- **Cost estimate** (`costEstimate`): `none` when nothing was measured, `unknown` when no token has a price, `partial` (a lower bound) when some tokens have none, `complete` otherwise. An unknown cost is never drawn as $0.00.
- **Refresh** sends a `refresh_nonce`, so the server checks the quotas again instead of answering from its last read; a refresh it declines because the last one was too recent reports `throttledUntil`, shown as the time the next check can run.
- There is no "Total" view: counting usage Claxedo didn't run was dropped.

## Data

The summary is fetched data: it lives in the TanStack Query cache under the adapter's `usage` keys, and the adapter's `usageChanged` event invalidates it, so a quota refresh on the server reaches an open view without polling. The view's choices (view, range, measure, grouping, page cursor) are component state; changing a choice other than the page starts again at the first page.

## Machine

The read is `loading → ready(summary) | failed(error)`, derived from the query (`api.ts`). The loading text shows only after 150 ms.

## Screens

The Usage settings section (`/settings/usage`, `usageSettingsSection`).

## Flows

16 (per-turn usage and quota windows).
