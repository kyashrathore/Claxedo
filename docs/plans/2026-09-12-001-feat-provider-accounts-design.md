# Provider accounts: one provider, many logins, one active

Status: proposed; slice 1 not started
Date: 2026-09-12
Owner: Yash Rathore
Revision 4, 2026-09-12 (night). Delivery of a chosen account to a harness
is decided by `2026-09-12-002-feat-credential-broker-design.md`; this
document keeps the accounts model and sequences it on top of that one.
The earlier per-session picker, the per-account `CODEX_HOME`, refresh
write-back through the app-server, and the fanout "send the active row"
are gone with the plaintext push they assumed. The Background, Prior art,
stress test and live test sections are unchanged evidence.

## Summary

A provider can hold many accounts for one user: two ChatGPT logins, a
Claude subscription token and an API key. The user marks one **active per
provider** in Settings → Providers, and that choice is global: it follows
the user into every sandbox they create, on every project. An admin can
bind a **team account** to a project, used by any member who has no active
personal account for that provider. With nothing bound, a harness runs on
its own CLI login on the laptop, and Claxedo never imports that login as a
row.

Delivery is the broker doc's: the account's value never enters a sandbox;
the harness gets a base URL and a placeholder. That is what makes a second
Codex account safe at all, because the app-server no longer writes the
account into `~/.codex/auth.json`.

## Goals

- Add a second (or third) account for Claude and Codex through the inline
  Connect card that already exists, and see all of them listed.
- One click makes an account the active one for that provider. New
  sandboxes and the next local turn use it; running sandboxes keep the
  identity they were created with.
- Team accounts an admin binds to a project, used automatically.
- The Providers page shows each account's last live check, usage windows,
  expiry, and which sandboxes it is bound into.

## Non-goals

- Choosing an account per session, per turn, or per project for personal
  accounts. Personal accounts are global. Per-project and per-sandbox-
  creation settings beyond the one default-on switch are future work.
- Failing over to another account when one hits a rate limit.
- Importing the machine's own CLI logins as rows (findings 2 and 13 below).
- Anything about how the value reaches the harness (the broker doc).

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

### Rules

1. **Personal accounts are global.** A row belongs to a user (`owner`), and
   the user marks one row **active per provider**. The mark is on the
   `ControlPlaneCredentials` contract (`setActiveCredential`), unique per
   `(owner, provider)`: SQLite gets `is_active` with a partial unique index
   on `(org_id, owner, provider_id) WHERE is_active = 1`; the replaced
   hosted store enforces the same in its one write.
2. **Team accounts are bound to a project by an admin.** A team row has an
   empty owner. The project binding names one team row per provider.
3. **Resolution at sandbox creation, per provider:** the creating user's
   active personal row, else the project's team binding, else nothing (the
   implicit tier, local only). The result is recorded on the lease and does
   not change for that sandbox's life (broker doc, section 5).
4. **Marking another account active applies to new sandboxes.** A running
   sandbox keeps its account until destroyed. A local workspace's next turn
   uses the new account, because local runtimes are rebound through the
   loopback broker at the turn boundary and the operator is the only
   identity on the laptop.
5. **Removing the active row hands the mark to the oldest account the
   provider can still run on**, in the delete's own transaction; only an
   `available` row qualifies, the same test the save-time yield applies.
   With no such row the provider has no active account: the row in Settings
   reads "Using this computer's login", and a new sandbox falls to the team
   binding, else the implicit tier. Sandboxes already bound to the removed row
   lose it (broker doc, withdraw), and the session says so.
6. **A saved row is active when it is the first for its provider.** A later
   save never steals the mark from a working account; an active row whose
   `status` is not `available` yields it. Without that yield, pasting a
   corrected key after a rejected one leaves the broken row chosen, the
   fanout sends nothing, and the harness falls back to the machine login
   with no sign of why. One-account users see no new UI.
7. **A row is named by the user's email wherever that can be known**, so the
   list is legible. A ChatGPT token carries the address in its JWT claims
   (`emailFromClaims`), and an Anthropic subscription is asked once at
   `GET /api/oauth/profile` beside the usage read — a refusal there names no
   account and is not a verdict on the token. A pasted key, whose provider
   never names it, keeps the fingerprint the registry mints (hash prefix plus
   the last four characters) and a label the connect card requires, because a
   row stored under its provider id names the harness binding rather than the
   account. The derived address is written only over a row that has no name of
   the user's own. A second paste is a second row, never an overwrite.
8. **Reconnecting replaces the token on the row it was clicked on.**
   `POST /:id/reconnect` writes the new secret through `updateCredentialSecret`,
   which bumps the revision and clears the verdict reached against the material
   it replaced, then verifies and stores the new one. The row keeps its id, its
   name and its position, so repairing a login is not the same act as adding an
   account. The verifier judges the pasted material rather than the expiry the
   replaced secret carried — left in place that reads a fresh API key as
   expired. Rule 6's yield is untouched and still governs the Add path.

### Claude accounts

Unchanged from revision 3: a second Claude account is a `claude
setup-token` pasted in the inline card (the `token` method landed
2026-09-12). It lasts a year and nothing renews it; the row shows its
expiry, and the live check (usage read) shows when it stops working. The
option table and the token's documented properties are kept below in the
stress-test section's evidence.

### Codex accounts

A second ChatGPT login through the existing OAuth flow, upserted by account
id so it never wipes the provider's other rows. **Codex accounts cannot
ship before the broker:** on today's delivery the app-server writes whatever
it is logged in with into the operator's `~/.codex/auth.json` (finding 12),
so every switch would rewrite that file. Slice 4 below waits for broker
feasibility item 4 (a ChatGPT token used through a base URL the app-server
never holds the token for).

### Settings → Providers

Rebuilt 2026-09-13 to the owner-approved shape. The governing rule is that the
**account rows are the only answer to "which login runs next"**, because the old
row carried a Connected/Detected tag, an "In use" line, a machine-login verdict
and a per-account verdict at once, and four answers to one question can
disagree. A header sentence restating the checked row was the same defect in
miniature — it read as a second account — so there is none.

- **Header line** per harness: the brand mark, the name, and at most one button.
  **Connect** when the harness has no login to run on, **Reconnect** when the
  login it runs on was refused, nothing otherwise. No sentence, no dot, no
  credential kind words.
- **Accounts as a radio list** indented under the name, always drawn, one row
  per account including the single-account case. The checked radio is the
  account in use, read from the server's effective credentials — the row a
  session will actually be handed — falling back to the stored mark where the
  host cannot enumerate its store. Choosing a radio activates that account, for
  every harness whose registry provider is fanout-eligible, which today is all
  three. The radio is the kit's themed control (`RadioList` in `packages/ui`),
  so the checked state carries the app's tokens rather than the browser's
  accent, and it sits on the label's first text line rather than in the middle
  of a row that wrapped.
- **A row is its label**, and a muted second line only where there is something
  to say: the login's origin ("from ~/.codex/auth.json"), the plan's usage
  windows ("Weekly 58% used"), and when the provider was last asked ("Checked
  2 h ago"). An unchecked account says nothing — "Not checked" is the absence of
  news and every row would carry it. An account id the reader cannot match to an
  account — every real Codex row carries a ChatGPT UUID — is the row's tooltip,
  never a line.
- **A refused account** (rejected, expired, no billing, not working) is drawn as
  a **ring on its own radio** in the danger token, with the verdict in the row's
  tooltip and in a screen-reader-only description. Nothing else: no red text, no
  sentence. Its repair is a Reconnect on its own row, whether or not it is the
  account in use; the header says nothing about it.
- **"This computer's login" is the last entry** whenever the scan found one, and
  its origin is its second line. It is last by construction: every stored
  account is a choice the user made, and this login is the standing fallback
  underneath all of them. Choosing it saves the scanned login through
  `save-discovered` and then marks what was saved — saving alone would leave the
  harness on the entry the user just clicked away from. A saved scan row the
  provider never named is still shown as this computer's login; one the provider
  did name (every Codex account) is shown by that name, because a machine can
  hold several of them.
- **Saving runs no second check**: `save-discovered` writes the verdict the
  discovery probe already reached onto the row it saved, so a freshly saved
  account reads as checked without spending another request against the user's
  own quota.
- **Per-row actions arrive on hover or keyboard focus**, right-aligned icon
  buttons with accessible names: **Check** (reload) and **Remove** (trash).
  A refused row carries its Reconnect beside them, so a rejected account can be
  repaired or forgotten from the row it is on.
  Remove asks inline before it forgets, and the confirming row holds its actions
  on screen so the question cannot vanish under the pointer.
- **"Add an account"** is a text button in the harness header, right-aligned,
  shown whether or not the harness already has accounts, and it opens the inline
  connect card. It is the header's only action; nothing is nested under the
  rows. Reconnect opens that card in reconnect mode against one row (rule 8).
- **The connect card explains the methods before it asks for anything.** Each of
  the vendor's sign-in methods is an option with three lines — what it is, who
  it is for, and how to obtain it — and picking one reveals its field with the
  explanation still on screen. A method minted in a terminal shows the command
  in a copyable field; a method that needs a key from the vendor links its key
  page, opened outside the app. `platform/identity/connect-methods.ts` is the
  single owner of that table: per vendor, the methods in display order, their
  i18n keys, the command, and the URL. A vendor it does not carry is explained
  in generic words naming the vendor, never a registry id.
- **The scan is automatic**: it runs when the section mounts and after every
  write, so the rows are derived from one read. The section header reads
  "Scanned just now · Rescan".
- The only state colour is the refused ring. There are no status tags, no dots,
  no "Use this login" button, no header-level Check, and no Make active button.
- For admins, on a project's settings page: **Team account** per provider and
  the one default-on switch "attach my AI provider accounts on every sandbox
  creation". Not built.

Known gap: a row imported before the fingerprint mint landed has neither a label
of its own nor an `account_id`, so it lists by its kind ("api_key") until it is
renamed. New rows cannot reach that state — the connect card requires a label
and discovery carries the account id.

## Sequencing

Four slices, each usable on its own. Slices 1 and 2 need nothing from the
broker doc; slices 3 and 4 are the broker doc's steps 3 to 6 seen from the
accounts side.

### Slice 1: accounts and the active mark, Claude, local

- `owner` and `is_active` on the local registry; `setActiveCredential`;
  identity per row; the first-save rule; deletion leaves no active.
- The accounts list, Active, Make active, Add account on the Claude row.
- Claude switches on today's delivery: the next local turn spawns with the
  new account's token. No file is written, the operator's login is untouched.

Acceptance (checked 2026-09-13 against the branch's server on a copy of the desktop app's registry, which held the owner's real Claude token; commands and outputs in the session transcript):
- [x] Two Claude rows (the real token and a placeholder API key) with
      distinct fingerprint identities; the migration backfilled the real
      token as active; `POST /credentials/activate` flips it and `GET
      /credentials/effective` follows; one active row per `claude-sdk`.
- [ ] A local Claude turn after the switch runs on the new account. **Not
      proven.** On 2026-09-13 the switch flipped "In use" both ways and the
      turns behaved differently ("OK" in 4 s on the stored token, no answer
      in 170 s on the placeholder, "OK" in 4 s again), but the broker slice's
      live proof then showed Claude Code prefers the account in its config
      dir over `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`, so which account
      answered is unknown; and the stored value was a short-lived access
      token that Anthropic rejected by 03:00. The broker slice isolates the
      config dir for a brokered turn, which is the only reliable way to run
      on a selected account. Re-run with a real `claude setup-token` through
      the broker. Finding kept: Claude Code with an invalid key hangs rather
      than failing, and on 401 falls back to the OS keychain.
- [ ] Removing the active row: the mark moves to the oldest remaining
      account, and with none left the row reads "In use: this computer's
      login" and the next turn runs on the machine login.
      (Not run live: the owner's machine Claude login is expired; covered by
      `registry.test.ts` and `providers.vitest.tsx`.)
- [x] Inserting two active rows for one `(owner, provider)` fails at the
      database, asserted by a test (`registry.test.ts`).
- [x] `bun run test:architecture-ratchets` green; the affected packages'
      own typecheck and tests green (rerun by the reviewer on `896ddc4b64`).

### Slice 2: the hosted store

- Replace the one-row-per-provider KV adapter with a store that holds many
  rows per provider, an owner per row, enumeration, and the active mark
  (broker doc, step 3). No migration of existing rows.
- Slice 1's UI works signed in against it.

Acceptance:
- [ ] Slice 1's first two boxes pass on a signed deployment.
- [ ] Two users in one org each hold their own active Claude account and
      neither can list or activate the other's.

### Slice 3: team accounts and sandbox binding

- Team rows (empty owner), the project's team binding, the default-on
  switch, and the resolution order at sandbox creation; the identity
  recorded on the lease (broker doc, steps 4 and 5).
- The accounts list shows which sandboxes each account is bound into.

Acceptance:
- [ ] A member with no personal Claude account gets a sandbox bound to the
      project's team account; a member with one gets their own; each is
      verified by the vendor-side account id.
- [ ] Marking another account active does not change a running sandbox;
      the list names that sandbox as still on the old account.

### Slice 4: Codex accounts

- Gated on the broker doc's Appendix E item 4. Then: OAuth upsert by
  account id, the accounts list on the Codex row, Make active, and the
  app-server pointed at the broker or the provider's edge.

Acceptance:
- [ ] Two ChatGPT accounts listed; Make active flips; the next new sandbox
      and the next local turn run on the chosen one, verified by
      `account/read` on the app-server reporting that account.
- [ ] `~/.codex/auth.json` on the operator's machine is byte-identical
      before and after every step above.

### Definition of done

All four slices' boxes ticked with the command and its output recorded next
to each; `preferredCredentialPerProvider` and `providerPreference` deleted;
this document rewritten in the present tense as the architecture note.

## Stress test (2026-09-12, evening)

Every flow the sections above lean on was traced in the code. What held,
what did not, and what each miss changes.

### Held

- A Claude turn is one `query()` with the auth in its spawn environment
  (`harnesses/claude/driver.ts:509`), so a switch applies at the next turn.
- A Codex login is per app-server process and `syncProcessAuth` re-logs a
  live process (`driver.ts:640`).
- Native turns are already tracked in `activeTurns` (`workspace/runtime.ts:1119`);
  only the wait is gated to ACP connections (`:770`). Pi throws "Cannot
  rotate Pi credentials during an active turn" on a mid-turn apply, so the
  gate removal fixes Pi as well.
- `putCredential` upserts on `(org, provider, kind, account_id)`; the Codex
  sync imports every `~/.codex/accounts/*.auth.json` with an account id.
- The snapshot's `auth` shape is unchanged, so no version bump.
- Model visibility is independent of accounts.

### Did not hold

1. **The machine login is implicit and the design never modelled it.** With
   nothing stored, Claude spawns with the server's environment and the CLI
   uses its own `/login` credential; Codex sends no `account/login/start`
   and the app-server reads its own `~/.codex/auth.json`. Onboarding says
   so in words (`destinationStoresCredentials`: a local run stores nothing).
   This is why the app works locally without ever connecting a harness.
   "No active row means not connected" would break that. Change: the
   active choice has an implicit member, **this computer's login**, which
   is the default whenever no stored row is active. Removing the last stored
   account returns the harness to it, visibly, rather than failing closed.
2. **Importing the Claude machine login makes it worse, not better.** The
   sync stores only the access token, with no refresh token and no expiry
   (`sync.ts:295`), nothing re-syncs it (the only callers are the explicit
   sync route), and `isRefreshableCredential` covers Codex only. Once
   imported, the explicit copy is sent as `CLAUDE_CODE_OAUTH_TOKEN`, outranks
   the CLI's own login, and dies when the access token expires while the
   keychain copy keeps refreshing. Change: the Claude keychain login is
   never imported as an account; it is only ever the implicit machine
   login. Claude's stored accounts are pasted tokens and keys.
3. **A second ChatGPT login deletes the first.** The OAuth callback runs
   `deleteCredentialsByProvider` before `putCredential`
   (`provider-auth/service.ts:233`). Change: upsert by `account_id`.
4. **There are three winner rules, not one.** The fanout's
   `preferredCredentialPerProvider`, `getCredentialByProvider` (first row by
   its own order; behind `GET /credentials/:providerId` and the Pi
   projection), and the embedded OpenCode bridge's own choice in
   `reconcileCredentialsIntoSdk` (`opencode/sdk-credential-bridge.ts:81`).
   Change: all three read the active mark; none keeps a private order.
5. **The hosted control plane has its own store.** Worker hosts compose an
   envelope-encrypted KV adapter and must never load the SQLite registry.
   A column and index cover one of two stores. Change: section 1 now makes
   the mark a contract operation with two implementations.
6. **Credential changes do not fan out.** Only MCP and connection routes
   call `fanOutConfig`; a saved key reaches a sandbox on its next restart.
   Section 3 said otherwise and is corrected: the credential routes call
   it.
7. **The refresh mirror is deliberate.** `mirrorRenewedLocalTokens` writes
   renewed Codex tokens into `~/.codex/auth.json` for `local_only` imports
   so the user's CLI is not stranded by refresh-token rotation. "Never
   touch the file" would have stranded it. Section 4 is corrected.
8. **Disconnect wipes every account.** The Providers page's disconnect is
   `DELETE /credentials/provider/:providerId`. The accounts list must delete
   by id (`DELETE /credentials/:id` exists) and keep the per-provider wipe
   off the row.
9. **Claude is two provider ids.** One login is stored under `claude-acp`
   and `claude-sdk` (`claudeHarnessBindings`). The list groups them as
   discovery does, and Make active marks both bindings in one write.
10. **`config.auth` is a fourth source.** The user config's `auth` block is
    merged under registry rows for local scope (`agent-config/index.ts:527`).
    It belongs to the implicit machine tier and is documented as such; it
    never competes with an active row.
11. **Sandbox consent changes behaviour.** Today the collapse takes the
    first consented row for `shared` scope, which may not be local's winner.
    "Active row or nothing" is stricter: a user whose active account is not
    shared but whose other one is loses sandbox auth until they consent.
    Kept, with the Settings row saying why.

### Live explicit-path test (2026-09-12, Codex)

Run against the local server with a scratch workspace, one prompt per step,
the machine's `~/.codex/auth.json` backed up first.

| Step | Registry | Result |
| --- | --- | --- |
| Baseline | no Codex rows | turn answers "OK" on the machine login |
| Invalid key stored (`codex-app-server`, `api_key`) | one row | 401 "Codex authentication failed": the stored key is used, the machine login is not |
| Machine login imported through discovery, invalid key still present | three rows | still 401 |
| All rows deleted | none | still 401 |
| Server restarted after restoring the backup | none | "OK" again |

What the steps mean:

12. **The app-server persists an explicit login into the CLI's own file.**
    After `account/login/start` with the stored key, `~/.codex/auth.json`
    read `{"auth_mode": "apikey", "OPENAI_API_KEY": "sk-explicit-…"}`; the
    ChatGPT tokens were gone. Deleting the rows did not bring them back:
    `account/logout` left the file as it was, and the app-server kept the
    API-key login in memory until its process was restarted. The two
    copies under `~/.codex/accounts/` carry refresh tokens the CLI had
    since rotated, so without the backup the machine login was lost.
    Change: every explicit Codex login runs with a Claxedo-owned
    `CODEX_HOME` (one directory per stored account, `config.toml` linked
    from the user's), never the user's `~/.codex`. This reverses section 4's
    "no per-account home": the file the app-server writes must be ours.
    The `codexHome` option the factory never passes is the seam. Returning
    to the machine login means restarting the app-server on the user's
    home, not sending `account/logout`.
13. **Importing the Codex machine login does not work either.** Both
    discovered copies probed "expired and couldn't be renewed": our refresh
    call gets 401 because the CLI has rotated the refresh token since those
    copies were written, and the rows land with `expires_at` in the past,
    which `credentialAvailableForScope` excludes, so the fanout never sends
    them. Finding 2 therefore covers Codex too: the machine login is the
    implicit tier for every harness and is never imported as a row.
14. **The preference order favours a row with no expiry**
    (`coalesce(expires_at, max) desc`), so a pasted key outranks an OAuth
    login. Moot once the active mark replaces the order; noted so the
    backfill does not enshrine it.
15. **The Codex machine-login probe was inconclusive on a working login.**
    The scan probed a ChatGPT login with a streamed completion against
    `chatgpt.com/backend-api/codex/responses`; that endpoint answered
    something other than 200/401/402/429 and the verifier mapped it to
    "Couldn't reach the provider", so the implicit tier could never be
    shown working. Replaced by the usage read (section 7); the same login
    now reports "Working · Weekly 1% used". Both tiers were then exercised
    live through the Providers page: the machine login through the scan,
    and a stored placeholder Cursor key through `verify`, which the real
    `api.cursor.com/v1/me` rejected ("Rejected by the provider") and which
    the fanout then dropped. A stored subscription token was not exercised
    live: none exists on this machine (see the Claude note above).

The Claude leg is blocked on this machine: the CLI's own `/login` has
expired ("OAuth session expired and could not be refreshed" in a bare
shell), and only the user can mint a `claude setup-token`. Once one is
pasted in Settings → Claude → Connect, the same four steps apply.

### Still unverified

- `account/logout` leaves `auth.json` as the last login wrote it (seen
  live: the API-key login stayed). What is still unverified is whether a
  ChatGPT login through the app-server also rewrites the file; the
  per-account home in finding 12 makes the answer irrelevant.
- Whether a Codex thread started under one account resumes under another.
- Whether the app-server honours `account/login/start` over an ambient
  `OPENAI_API_KEY`; moot for our spawns after the env strip.
- The field names in Claude Code's `~/.claude.json` account record; only
  needed if the keychain login is ever listed, which finding 2 rules out.
- The usage read for a *stored* subscription token end to end (a pasted
  `claude setup-token`, or a ChatGPT login synced as a row). The request
  shapes are pinned by tests against what the CLIs themselves send; the
  live run needs a real token on this machine.

## Glossary

- **Account:** one stored credential row for a provider, with an identity.
- **Active:** the one row per `(owner, provider)` a user's new sandboxes and
  next local turn use.
- **Team account:** a row with no owner, bound to a project by an admin.
- **Implicit tier:** a harness with nothing bound uses its own CLI login on
  the laptop. Never imported as a row.
- **Binding, projection, broker:** see the broker doc.
