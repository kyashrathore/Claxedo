# Provider accounts: one provider, many logins, one active

Status: proposed; not started
Date: 2026-09-12
Owner: Yash Rathore
Decision 2026-09-12: the active account is chosen per provider in Settings,
not per session. An earlier draft of this document proposed a per-session
picker; that model is recorded under Non-goals.
Revised 2026-09-12, evening: Settings → Providers changed underneath this
plan the same day (commit `85f1d007c8`). The three native harnesses now
connect inline in an inset card with the server's methods, Claude's
subscription token is one of those methods, and a login found on the
machine is saved from its row. Sections 5 and 7 describe the accounts UI on
that surface; the phase lists mark what already landed.

## Summary

Today Claxedo can remember several logins for the same provider (two ChatGPT
accounts for Codex, two Anthropic logins for Claude) but only *uses* one of
them: whichever sorts first in a preference order the user never sees. Adding
a second login can silently change which one every session runs on.

This document makes the choice explicit and visible. Every stored login is an
**account**. In **Settings → Providers**, each set-up harness lists its
accounts, and one of them carries an **Active** mark with a **Make active**
button on the others. Every session, in every workspace, runs on the active
account for its provider. Switching takes effect at each session's next turn.
Nothing else in the product changes for a user with one login per provider.

The change is small. The database already stores multiple accounts per
provider. The harness drivers already re-authenticate a running process when
their configuration changes. What is missing is an explicit "active" flag,
a button that sets it, and two hygiene fixes: refreshed tokens are written to
the wrong place, and ambient environment variables can silently beat the
account the user chose.

## Goals

1. A user with two or more logins for one provider chooses which one is in
   use, from one place, with the result visible before and after.
2. The choice is explicit and persisted. It never changes because of an
   environment variable, a file on disk, or a newer login being added.
3. Switching applies to running sessions at their next turn boundary without
   restarting anything the user can see.
4. Refreshed tokens are written back to where the credential came from, so a
   restart does not resurrect a stale token.
5. Works the same on the local machine and in a cloud sandbox, using the
   existing credential scope and consent rules.
6. A user with one login per provider sees no new UI.

## Non-goals

- **Per-session accounts.** Two sessions in one workspace running on two
  accounts of the same provider concurrently. Rejected for this iteration:
  it needs one harness process per account, a routing key on every session,
  and a picker in the composer. The active account is resolved in exactly
  one function, so a later per-session override would be a change at that
  one point plus the adapter key, not a redesign.
- **Automatic failover** when an account hits a rate limit. The `rate-limit`
  events it needs already exist in
  `packages/agent-event-runtime/src/contracts/agent-runtime-event.ts`; no
  policy ships here.
- **An OAuth client for Anthropic.** The endpoints Claude Code uses are not a
  published contract.
- **User-defined provider instances** in the t3code sense (a slug plus a bag
  of environment variables). Accounts here are real logins and keys.
- Cursor and Pi. Pi projects credentials through its own path
  (`pi-provider-projection.ts`); Cursor's driver has no explicit-auth path.
  Both keep working on the active account and gain the account list only
  when their drivers accept explicit auth.

## Background: how it works today

For a reader who has not touched the code in a while, in plain terms first.

A **harness** is one of the coding agents Claxedo drives: Claude Code, Codex,
Cursor, Pi. A **driver** is our code that starts that agent as a child
process and talks to it. A **credential** is a stored secret: an API key or an
OAuth login (access token plus refresh token). Credentials live in one SQLite
table, `claxedo_provider_credential`; the secret itself lives in a
keychain-backed store referenced by `secure_ref`.

The flow when a session starts a turn:

- A. The server builds a **runtime config snapshot**
  (`getRuntimeConfigSnapshot`, `packages/claxedo-server-core/src/agent-config/index.ts:507`).
  - A.1 It calls `resolveSecretsForScope` (`credentials/registry.ts:602`),
    which lists every credential in preference order and then runs
    `preferredCredentialPerProvider` (`registry.ts:564`), keeping **the first
    row per provider and discarding the rest**. The order is
    `providerPreference` (`registry.ts:228`): available first, then not
    expired, then latest expiry, then most recently written. The user cannot
    see or change it.
  - A.2 The result is a flat map `auth: { openai: "<secret>", anthropic: "<secret>", … }`
    inside a `version: 3` snapshot.
- B. The workspace runtime (`packages/workspace-runtime/src/workspace/runtime.ts`)
  receives the snapshot.
  - B.1 It keeps one adapter per harness kind, keyed `native:<harness id>`
    (`adapterKey`, line 744). All sessions in the workspace that use Codex
    share one Codex app-server process.
  - B.2 It pushes the `auth` map into that adapter with `applyConfig`
    (lines 780 and 1334). For ACP connections it first waits for active
    turns to finish (line 1318); for native harnesses it applies at once.
- C. The driver logs its process in.
  - C.1 Codex (`harnesses/codex/driver.ts:175`) reads `auth["codex-app-server"] ?? auth.openai`,
    bumps `authRevision`, and `syncProcessAuth` sends `account/login/start`
    to the running app-server. Login is per process.
  - C.2 Claude (`harnesses/claude/driver.ts:233`) reads `auth["claude-sdk"] ?? auth.anthropic`
    and turns it into an environment variable for the CLI it spawns per
    query (`claudeAuthEnv`, `harnesses/claude/auth.ts:9`): an API key becomes
    `ANTHROPIC_API_KEY`, an OAuth token becomes `CLAUDE_CODE_OAUTH_TOKEN`.
- D. When Codex's token expires, the app-server asks the driver to refresh
  (`refreshTokens`, `driver.ts:700`). The driver calls OpenAI's token endpoint
  and **writes the new tokens to `CODEX_HOME/auth.json`** (`auth-file.ts:151`),
  the user's own `~/.codex/auth.json`. The registry is not updated.

What the storage layer already supports and the fanout throws away:

- `putCredential` upserts on `(org, provider_id, kind, account_id)`
  (`registry.ts:95-104`). Two Codex accounts are two rows.
- The local sync (`credentials/operations/sync.ts:148`) imports every
  `~/.codex/accounts/*.auth.json` with its `account_id`.
- The Claude sync (`sync.ts:295`) stores only the access token with **no
  `account_id`**, so two Claude Code logins collapse into one row at write
  time, before the fanout runs.

Two defects exist independently of multi-account and get worse with it:

- **Refresh writes to the wrong place** (step D).
- **Ambient environment beats the chosen account.** `harnessSpawnEnv`
  (`harnesses/shared/spawn-env.ts`) strips nine Claxedo-internal variables
  and passes everything else through. The Claude CLI's documented precedence
  ranks `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` from the environment
  **above** `CLAUDE_CODE_OAUTH_TOKEN`
  (https://code.claude.com/docs/en/authentication#authentication-precedence),
  so a stray API key in the server's environment wins over the subscription
  account the user chose.

## Prior art

### Orca (as reported by the earlier session; not verified here)

One globally active account per provider, switched for the whole app.
Account state is materialised as files into a per-account config directory
so the CLI's own login and refresh machinery runs unchanged, and provider
environment variables are stripped when an account is pinned.

What is right about it, and what this design adopts: one active account,
chosen in one place, and the environment strip.

Issues for us: materialising secret files on disk is the wrong shape for a
sandbox that receives its config over a channel and should hold secrets in
memory; and delegating refresh to the CLI means the app never learns the new
token, so a second machine or a restart from stored state is stale.

### t3code: `ProviderInstanceId`

`~/test/t3code/packages/contracts/src/providerInstance.ts` splits "provider"
into a driver kind (codex, claudeAgent) and a user-chosen instance slug
(`codex_work`) that threads reference. Each instance carries a display name,
an optional list of environment variables (`{ name, value, sensitive }`) and
an opaque driver config blob. Unknown instances are marked unavailable rather
than crashing.

What is right about it: the routing key is separate from the driver kind and
an unavailable instance fails closed.

Issues for us: identity is typed by the user and secrets are pasted as
environment variables, so nothing knows which real account an instance is;
no expiry, health, refresh, or discovery of logins already on the machine.
Our registry has all four. Per-instance environment variables are the
ambient-leak mechanism made deliberate. And per-thread routing is the
per-session model this design declines.

### The CLIs themselves

- Codex keeps one active login per `CODEX_HOME` (`auth.json`) plus remembered
  logins in `accounts/<email>.auth.json`. Switching is a CLI command; the
  app-server's login is process-wide and can be changed at runtime with
  `account/login/start`.
- Claude Code keeps one login per config directory (`CLAUDE_CONFIG_DIR`),
  refreshes it internally, and offers `claude setup-token` to mint a
  one-year token for headless use. Given `CLAUDE_CODE_OAUTH_TOKEN` in the
  environment it uses that token as-is.

Both give us an explicit login per process, which is all a global-active
model needs.

### Claxedo today

Multiple rows, one winner, chosen by an invisible sort order.

## Proposed design

### The concept

An **account** is one row of `claxedo_provider_credential`. For each
`(org, provider)` at most one row is **active**. The fanout sends the active
row's secret and nothing else. The user sets which row is active from
Settings → Providers. There is no other rule.

### 1. Storage: an explicit active flag, one per provider

Owner: `packages/claxedo-server-core/src/credentials/provider-credential.sql.ts`,
a new migration under `platform/db/claxedo-migration/`, `credentials/registry.ts`.

- New column `is_active integer NOT NULL DEFAULT 0`.
- Partial unique index on `(org_id, provider_id) WHERE is_active = 1`, so
  two active accounts for one provider are unrepresentable, not merely
  checked.
- Migration backfill: for each `(org_id, provider_id)`, mark active the row
  that `providerPreference` orders first among fanout-eligible rows. The
  invisible rule runs exactly once, at migration, and becomes a visible mark.
- `putCredential`: when a provider has no active row in the org, the row
  being written becomes active. A later write never steals the mark. This
  is the "one login per provider sees no new UI" guarantee.
- `setActiveCredential(id, org)`: one transaction that clears the provider's
  mark and sets it on `id`. Refuses a row that is not fanout-eligible
  (`fanoutEligible`, `registry.ts:560`).
- `deleteCredential` of the active row leaves the provider with **no active
  account**. It does not promote another. The provider shows as needing a
  choice in Settings and its harness reports "not connected" until the user
  clicks. A running session must never move to a different account because
  a row was deleted.
- `preferredCredentialPerProvider` and `providerPreference` are deleted
  after the migration ships. Nothing else may pick a winner.

Identity per login, so the list is legible:

- Codex: unchanged. `account_id` is the ChatGPT account id from the token
  claims; the label carries the email when the sync saw one.
- Claude Code login sync: set `account_id` from the CLI's own account record
  (`~/.claude.json` carries `oauthAccount.accountUuid` and `emailAddress`).
  Evidence-based inference; verify the field names on a real install.
  Without an id, two Claude logins cannot coexist as rows.
- API keys: `account_id` is a stable fingerprint of the key (a hash prefix
  plus the last four characters) and the user's label is the display name.

### 2. Fanout: send the active row

Owner: `credentials/registry.ts`, `agent-config/index.ts`.

`resolveSecretsForScope` filters to `is_active = 1` instead of collapsing.
The snapshot's `auth: Record<providerId, secret>` shape and `version: 3`
are unchanged; no consumer changes.

Scope and consent are unchanged and apply to the active row: for a sandbox
(`scope: "shared"`), if the active account has not been consented for
sharing, the sandbox receives no credential for that provider. The Settings
row shows "not shared with sandboxes" on such an account so the user sees
why a cloud session is unauthenticated, instead of the sandbox silently
using a different account.

### 3. Switching: apply at the next turn boundary

Owner: `packages/workspace-runtime/src/workspace/runtime.ts`.

Clicking **Make active** calls `POST /credentials/:id/activate`, the registry
flips the mark, and the server republishes the runtime config snapshot the
way it already does for any credential change. The workspace runtime's
existing apply path pushes the new `auth` into the adapter.

One change in that path: the wait for active turns at line 1318 today covers
only ACP connections. It extends to native adapters. A Codex process that is
mid-turn on account A finishes that turn, then `syncProcessAuth` logs it in
as account B before the next turn starts. The Claude driver spawns a CLI per
query with the auth in its environment, so a running turn keeps its process
and the next turn picks up the new token with no driver change.

No adapter re-keying. One adapter per harness, as today. No extra processes.

Codex thread continuity across accounts: the thread rollout lives in the
shared `CODEX_HOME/sessions`, so a thread started under A should resume
under B. Verify with two real accounts before Phase 1 closes; if it does not,
the session shows "restart this session to use the new account" rather than
failing mid-turn.

### 4. Codex driver: refresh writes back to its source

Owner: `harnesses/codex/driver.ts`, `harnesses/codex/auth-file.ts`.

Rule: **tokens go back where they came from.**

- Auth supplied by the registry (`this.codexAuth` set from `applyConfig`):
  the driver does not touch `auth.json`. It emits the refreshed bundle
  through the driver host; the workspace runtime forwards it to the server,
  which calls `putCredential` on the same row (same `account_id`, so the
  upsert keeps the id and the active mark). A restart replays a live
  credential.
- No registry auth (the process is using the CLI's own login): unchanged,
  the file is the source and is rewritten.

`CODEX_HOME` stays the user's `~/.codex`, so `config.toml`, skills and
session rollouts are untouched. The `codexHome` option the factory never
passes stays unused; this design never writes account state to disk.

### 5. Claude: second accounts through `claude setup-token`

Owner: `packages/claxedo-local-server/src/credentials/provider-auth/service.ts`.

Three ways to give the Claude CLI a second login were weighed:

| Option | Refresh | Works in sandbox | Verdict |
| --- | --- | --- | --- |
| a. `claude setup-token` one-year token stored as an `oauth_token` credential | not needed | yes | **adopted** |
| b. `CLAUDE_CONFIG_DIR` per account, CLI refreshes itself | by the CLI | no, needs files on disk | not adopted |
| c. Our own OAuth client against Claude Code's endpoints | by us | yes | not adopted, unpublished contract |

Landed 2026-09-12: the provider-auth service offers a `token` method for
`anthropic` and `claude-sdk` ahead of the API-key method, carrying the
command that mints it, and the inline connect card renders it with a
copyable `claude setup-token` field. The pasted value is stored as
`kind: "api_key"`; the driver reads the secret's shape and sends an
`sk-ant-oat…` value as `CLAUDE_CODE_OAUTH_TOKEN` (`auth.ts:30`), and the
verifier does the same. What Phase 2 adds is identity: the paste path
writes an `account_id` fingerprint (a hash prefix plus the last four
characters), so a second pasted token is a second row rather than an
overwrite, and the row's label names it.

What the docs say about the token
(https://code.claude.com/docs/en/authentication#generate-a-long-lived-token):
minted through the same browser flow as `/login`, lasts one year, printed
once and saved nowhere, requires Pro, Max, Team or Enterprise, tied to the
subscription of the person who ran the command, model requests only (no
Remote Control, no claude.ai connectors), ignored in bare mode. Our driver
does not pass `--bare`. Revocation is undocumented.

The machine's own `claude login` remains an account too, refreshed by the
CLI outside our control; its expiry is shown in the list.

### 6. Environment hygiene

Owner: `harnesses/shared/spawn-env.ts` and the two drivers' spawn sites.

When an adapter has explicit auth, the spawn environment drops that
provider's ambient variables before the driver adds its own:
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` for
Claude; `OPENAI_API_KEY` for Codex. Given the CLI precedence quoted above,
this is the only way the active account is guaranteed to be the one used.
When an adapter has no explicit auth the environment passes through as
today, because that is the only way a user who relies on ambient variables
is authenticated at all. The denylist shape stays: a stripped list is
easier to audit than an allowlist that must anticipate every variable a
harness legitimately reads.

### 7. Settings → Providers

Owner: `packages/claxedo-app/src/features/settings/ui/agents-section.tsx`,
`provider-setup-row.tsx`, `provider-detect.ts`,
`packages/claxedo-local-server/src/credentials/routes/credential.ts`.

Today the Agents section renders one row per native harness (Claude, Codex,
Cursor) with a single status (connected, detected, broken, missing). Connect
opens an inset card in the row, named "Connect Codex", with the server's
methods as a segmented control and one close control; a login the scan found
on this machine is saved from the row with **Use this login**. Pi and
OpenCode keep their per-provider rows in their own sections. A harness with
one credential looks exactly like that.

When a harness has two or more credentials across its bound provider ids,
the row lists them under its status: each account shows its label, account
id or email, health, expiry, and whether it is shared with sandboxes. The
active one carries an **Active** tag; every other one has a **Make active**
button. **Add account** opens the same inset card, so a second ChatGPT login
or a second Claude token arrives through the flow the row already has. A
harness whose active row was deleted shows "Choose an account" in place of
its status, and its Connect button stays.

Accounts do not touch Settings → Models: visibility is per provider/model
pair and follows the pair whichever account runs it.

New route: `POST /credentials/:id/activate`. `GET /credentials` already
returns `account_id`, `label`, `health`, `expires_at`, `scope`; it adds
`is_active`.

Nothing changes in the composer or on the session screen.

### End-to-end flow after the change

- A. In Settings → Providers, under the Codex row, the user clicks
  **Make active** on the work account.
  - A.1 `POST /credentials/<work id>/activate` → `setActiveCredential`
    clears and sets the mark in one transaction.
  - A.2 The server rebuilds the snapshot; `resolveSecretsForScope` returns
    the work secret under `codex-app-server`.
- B. Every workspace runtime receives the snapshot.
  - B.1 A Codex adapter with a turn in flight waits for it to finish, then
    `applyConfig` → `authRevision++` → `syncProcessAuth` →
    `account/login/start` with the work tokens. Next turn runs as work.
  - B.2 A Claude adapter records the new auth; the next query spawns with it.
- C. The Settings row now shows work as Active. The session screen shows
  nothing new.
- D. On refresh, the Codex driver emits the new bundle; the server upserts
  the work row. `~/.codex/auth.json` is untouched.
- E. The user deletes the work row. Codex shows "Choose an account"; the
  next Codex turn in any session fails with "no active account for Codex"
  until the user clicks on the personal row.

## Tradeoffs

- **Global means global.** Switching changes every session in every
  workspace at its next turn. That is the requested behaviour and it is the
  simplest one to reason about, but a user who wants a work session and a
  personal session side by side cannot have it.
- **No silent promotion.** Deleting the active account stops that provider
  until the user chooses again. One click, visible, and it never moves a
  session to an account the user did not pick.
- **Mid-turn switch is deferred, not immediate.** A long Codex turn keeps
  the old account until it ends. The Settings row can show "switching after
  the current turn" if it matters; not in scope for Phase 1.
- **Claude second accounts are a paste, not a login.** One-time
  `claude setup-token` per extra account. The per-directory alternative
  auto-discovers but puts secret files on disk and does not fit sandboxes.
- **Sandbox refresh write-back arrives in Phase 3.** Until then a shared
  Codex account that refreshes inside a sandbox replays stale after a
  restart, the same defect as today, now named.
- **Migration runs the old rule once.** The backfill picks the same winner
  the fanout picks today, so no user's account changes on upgrade.

## Unverified assumptions and how to verify them

| Assumption | How to verify |
| --- | --- |
| Codex app-server honours `account/login/start` over an ambient `OPENAI_API_KEY` | Spawn with both, call `account/read`, compare account id. Made moot by section 6 for our own spawns, but check once |
| `account/login/start` on a live app-server between turns does not disturb existing threads | Two real accounts, one thread, switch between turns, continue the thread |
| A Codex thread started under account A resumes under account B from the shared rollout | Same experiment, assert the thread id is unchanged and the response comes from B's account |
| A `claude setup-token` token minted on a second subscription account runs a turn through our driver | Mint one on a second account, run a turn, record `expires_at` |
| Claude Code's `~/.claude.json` carries a stable account id and email | Read it on a real install; if absent, derive the id from the token's `sub` claim if it is a JWT, else from a hash |

## Phases and acceptance criteria

Each phase is a reviewable slice with its own gate.

### Phase 1: active flag, Codex, local

- Column, partial unique index, migration with backfill; `setActiveCredential`;
  activate route; fanout on the active row; `preferredCredentialPerProvider`
  and `providerPreference` deleted.
- Native adapters wait for active turns before `applyConfig`.
- Codex refresh writes back to the registry when the registry supplied auth.
- Env strip for Codex.
- The account list under the Codex row with Make active, Active tag, Choose
  an account; Add account reusing the inset card.

Acceptance:
- [ ] Two ChatGPT accounts synced; Settings lists both under Codex with one
      Active; Make active on the other flips the mark, `GET /credentials`
      shows exactly one `is_active` row for the provider.
- [ ] A session mid-turn on A finishes that turn on A; its next turn runs on
      B (`account/read` on the process reports B).
- [ ] Forcing a token refresh on the active account updates the row's secret
      and leaves `~/.codex/auth.json` byte-identical.
- [ ] Restarting the server replays the refreshed credential; the next turn
      succeeds without re-login.
- [ ] Deleting the active row: Settings shows Choose an account; the next
      Codex turn fails with a named error; no turn runs on the other row.
- [ ] Inserting two `is_active = 1` rows for one provider fails at the
      database, asserted by a test.
- [ ] Upgrade test: a database with several rows per provider and no mark
      migrates to the same winner the old fanout returned.
- [ ] `bun run test:architecture-ratchets` green; the affected packages' own
      `scripts.typecheck` and test scripts green.
Progress:

### Phase 2: Claude accounts

- Claude sync sets `account_id`; the paste path fingerprints a token or key
  into `account_id`; env strip for Claude; the account list under the
  Claude row. (The provider-auth `token` method and its inline card landed
  2026-09-12 in `85f1d007c8`.)

Acceptance:
- [ ] Machine login plus one `setup-token` account listed under Claude; Make
      active flips; the next turn's CLI reports the expected organisation.
- [ ] With `ANTHROPIC_API_KEY` set in the server's environment, a turn on an
      active OAuth account runs on the OAuth account.
- [ ] The expiring machine login shows its expiry in the list before it fails.
Progress:

### Phase 3: sandbox parity

- Refresh write-back over the workspace-runtime to control-plane channel;
  consent rule on the active row proven on a cloud sandbox.

Acceptance:
- [ ] A shared-scope active Codex account refreshes inside a sandbox and the
      control plane's row updates.
- [ ] An active account without sharing consent yields no credential in the
      sandbox snapshot (assert on the wire payload) and the Settings row
      says so.
Progress:

### Definition of done

- [ ] All three phases' boxes ticked, with the command and its output
      recorded next to each.
- [ ] `grep` finds no `preferredCredentialPerProvider`, no `providerPreference`.
- [ ] The unverified-assumptions table has every row resolved.
- [ ] This document rewritten in the present tense as the architecture note
      for the feature; execution logs kept out of the PR.
Progress:

## Execution: parallelise with agents

Phase 1 splits into three lanes with disjoint file ownership, run as `opus`
subagents; the orchestrator reads each diff and re-runs its gate before
accepting:

1. **Registry lane**: schema, migration and backfill, `setActiveCredential`,
   fanout, route, deletion of the old preference code, and their tests.
2. **Runtime lane**: workspace-runtime turn-boundary deferral for native
   adapters, Codex refresh write-back through the driver host,
   `spawn-env.ts` strip, and their tests.
3. **Settings lane**: account list in `ProviderSetupRow`, Make active, Choose
   an account, the `is_active` field on the client type, and their tests.

Lane 3 depends on lane 1's route shape only; publish the route contract as a
one-file commit first. The two-real-accounts verification is one serial lane
after merge, because it needs the user's own logins.

## Glossary

- **Provider**: the company whose model is used (OpenAI, Anthropic).
- **Harness**: the coding-agent program we run (Codex, Claude Code).
- **Driver**: our code that starts and talks to a harness.
- **Account / credential row**: one stored login or key. "Account" is the
  user-facing word; "row" is the storage.
- **Active**: the one account per provider whose secret is sent to harnesses.
- **Fanout**: the step that hands secrets from the server to the place that
  spawns harnesses.
- **Snapshot**: the config document the server sends to a workspace runtime.
- **Sandbox**: a cloud machine running a workspace runtime, which receives
  secrets only over the snapshot and only with per-account consent.
