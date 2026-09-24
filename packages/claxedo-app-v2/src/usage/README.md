# usage

Owns: how much the user's agents used, read from the server's usage summary (`server.queries.usage.summary`), and quota windows: the words for a window and the meter that shows it. Settings' accounts show their windows with `QuotaWindowMeter` from here.

## Concepts

- **Usage limits** (`view: "quota"`): each connected account's quota windows (`session`, `weekly`, `weekly_opus` and whatever else the provider reports), how much of each is used and when it resets. An account the user's agents run on is marked in use.
- **Usage through Claxedo** (`view: "claxedo"`): the turns Claxedo ran in the last 7 or 30 local days, their tokens (input, output, reasoning, cache) and estimated cost, grouped by provider or by model, 25 rows a page.
- There is no "Total" view: counting usage Claxedo didn't run was dropped.

## Data

The summary is fetched data: it lives in the TanStack Query cache under the adapter's `usage` keys, and the adapter's `usageChanged` event invalidates it, so a quota refresh on the server reaches an open view without polling. The view's choices (view, range, measure, grouping, page cursor) are component state; changing a choice other than the page starts again at the first page.

## Machine

The read is `loading → ready(summary) | failed(error)`, derived from the query (`api.ts`). The loading text shows only after 150 ms.

## Screens

The Usage settings section (`/settings/usage`, `usageSettingsSection`).

## Flows

16 (per-turn usage and quota windows).
