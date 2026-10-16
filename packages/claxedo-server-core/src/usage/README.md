# usage

Owns the turn usage fact (`TurnUsageRevision` in `contracts.ts`): who ran a turn, on which harness, provider and model, how many tokens it spent, and which credential paid for them. The turn meter (`turn-meter.ts`) builds each fact from a runtime's presentation events, the ledgers keep it, and the routes answer it.

## Which credential paid for a turn

A fact names the credential its tokens were spent on as `credential`:

- `{ kind: "stored", credentialId }`: a stored credential row, by its id. Never a secret, a placeholder or a label: the id is the one thing that names the same row across rotations, relabels and deliveries.
- `{ kind: "machine" }`: the harness's own login on its machine (a person's Claude Code or Codex sign-in on their desktop). It is no credential Claxedo holds, so it has no id.
- absent: the runtime named no account for the turn (an OpenCode turn, whose engine binds an account per provider and does not report one yet, or a turn whose harness reported neither usage nor an error).

The value is part of the revision's identity (`usageRevisionHash`): two reports of one revision that name different credentials are a conflict, not a duplicate. It is left out of the hash when absent, so a stored fact filed before facts named credentials keeps its hash.

### Who knows it

Every path reads the account from the delivery that handed the credential to the harness, never from a later lookup:

1. The plane's delivery names the account on every binding it hands a runtime: `ProviderBinding.account` and `ProviderDirect.account` (`@claxedo/agent-runtime-contract`). A cloud sandbox's deliveries all come from the native delivery plan (`credentials/native-delivery-plan.ts`), which names the stored row on each of its three forms: a provider edge's placeholder variable (Cloudflare), a binding on the hosted egress broker (Boat; the broker's placeholder spends exactly that credential id), and a plan login handed over direct (Codex's ChatGPT plan on either). The desktop's local credential broker names it on its bindings, and a Pi session host's direct credential carries the same account.
2. The harness turns the delivery it launched the turn on into a `TurnAccount` (`turnAccountFor`: `selectedTurnAccount` for a binding, Codex's `codexTurnAccount` for the binding or plan it signed in with, the Pi transport's `credentials.account`), `machine` when nothing was handed, and `withTurnAccount` (`harness/src/translate/turn-account.ts`) stamps it on the turn's `usage` events and its own `error`.
3. Session core carries it onto `session.usage` (`properties.account`) and onto `session.error`'s error data.
4. The turn meter reads it from those events into the fact's `credential`.
5. A cloud sandbox runtime and a Pi session host meter through `cloudTurnUsage`, keep the fact in their runtime ledger and report it under the turn's lease (`usage-report.ts`); a desktop meters into its own SQLite ledger (`adapters/sqlite-usage-ledger.ts`, columns `credential` and `credential_id`), and its turns stay on the machine.

### What the plane files

The hosted plane's D1 ledger (`claxedo-server/src/usage/adapters/d1-usage-ledger.ts`) resolves a reported stored credential against its own rows in the same statement that files the fact, and keeps what it found on the row, so the record survives the credential's deletion:

| `credential_source` | When | `credential_id`, `credential_kind`, `credential_owner` |
| --- | --- | --- |
| `personal` | A personal account in the turn's organization owned by the turn's producer, the session's creator or the workspace's owner | the row's id, its stored `kind` (`api_key`, `oauth_token`, `subscription_session`) and its owner |
| `org` | The organization's own account (a team key, owner `null`) | id and kind; no owner |
| `machine` | The harness's own login | none |
| `unresolved` | A stored id the turn could not have spent: another member's account, another organization's, a sandbox driver key, or a row that no longer exists | none |
| `unreported` | No credential named | none |

The table's check constraints hold these shapes.

### Who sees it

`GET /api/claxedo/usage/credentials?since&until&scope` (`cloud-routes.ts`, priced by `credential-spend.ts`) answers spend per credential:

- `scope=mine` (the default): every turn that spent one of the reader's own accounts, whoever sent it on a session they share, and the reader's own turns on anything else. Another person's account that the reader's turns spent on a shared session is `other_member`, with no id, kind or label.
- `scope=org`: every member's turns on the organization's team keys, answered to the organization's owners and admins alone (403 `usage_scope_forbidden` otherwise). No member's personal account is ever in it.
