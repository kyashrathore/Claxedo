# feat: Onboarding asks where work runs, then collects only what that needs

Status: PLANNED · 2026-07-31

---

## Goal Capsule

- **Outcome:** setup establishes *where the user's agents will run* before it asks
  for anything else, then collects exactly what that destination requires — in an
  order where each step is answerable with what the previous one produced.
- **Governing rule:** Claxedo stores a credential only when it can keep that
  credential working indefinitely. Everything else is read at the moment of use,
  or minted by the user for the environment that needs it.
- **Non-goals:** the full-page setup shell, the cloud/collection split, and the
  discovery probe pass are already built and working; this plan does not revisit
  them.
- **Stop conditions:** stop A2 if the sandbox image cannot run Claude Code (§5.3).
  Stop B2 if a private repository cannot be cloned into a sandbox without a
  connection (§4.4).

---

## 1. The problem

Onboarding today asks for a project, then a credential, then optionally offers
cloud. Three things are wrong with that order.

**The first question does not serve the destination.** "Open a project" means
*pick a local folder*. But a cloud workspace is cloned from a git remote —
`create-cloud-project.tsx:36` accepts `{repoUrl}` or `{connectionId, repo}` and
never a local path. A user who intends to work in the cloud answers question one
with something the cloud path cannot use.

**We collect credentials the local case never needs.** A local harness spawns the
user's own binary: `harnesses/claude/auth.ts:9` returns `{}` when Claxedo holds no
credential, and `harnesses/claude/driver.ts:174` spawns with
`{...process.env, ...claudeAuthEnv(...)}`. With nothing stored we set no auth
variables and the `claude` binary uses its own login — exactly as it does in a
terminal. The same holds for `codex`. Every credential we store for local use is a
second copy of something that already worked.

**Copies rot, and rotting copies fail late.** A Claude access token lives ~8 hours
and is refreshed in the background by Claude Code (measured: the Keychain item was
rewritten mid-session while this plan was being written). A refresh token lives
~23 days and is single-use — Anthropic issues a new one on each refresh and
invalidates the old. Two processes holding the same refresh token is not a race to
tune: whichever refreshes last wins, and the other is left with a credential the
provider rejects. A copy in Claxedo's store can therefore log the user out of
their own Claude Code.

---

## 2. The rule: store only what you can keep working

Provider-agnostic, and it decides every question below.

| Credential | Can Claxedo keep it working? | Store it? |
|---|---|---|
| Local Claude Code login (macOS Keychain) | No — Claude Code owns rotation, and we cannot write back | **No.** Read at use. |
| Local Codex login (`~/.codex/*.json`) | Yes for cloud — refreshable *and* mirrored back to the file (§3.3) | Cloud only; local reads its own |
| `claude setup-token` output | Yes — ~1 year, minted for headless use | Yes |
| Cursor dashboard API key | Yes — no rotation, no other owner | Yes |
| API key (any provider) | Yes — no rotation, no other owner | Yes |
| OAuth grant Claxedo obtained itself | Yes — sole owner | Yes |

Codex is the instructive case: the constraint is not "OAuth is unsafe to hold" but
"can we keep the *other* holder in step?" For Codex we can, because the credential
lives in a file we can atomically rewrite. For Claude we cannot.

Two consequences worth stating plainly, because they shrink the work:

**Local needs no credential plumbing at all.** The AI step's job for a local-only
user is not "collect a credential" — it is **"confirm a usable login exists on this
machine."** Detect, probe, report, move on. The discovery probe already produces
exactly that verdict.

**Cloud is the only place storage is required.** A sandbox has no Keychain, no
`~/.codex`, and no local login. It can only use what we send it.

---

## 3. Credentials by destination

### 3.1 Local

Read the machine's own login at spawn time; store nothing.

Reading the Keychain is a plain `security find-generic-password -s
"Claude Code-credentials" -w`. Two constraints on that read:

- **Extract `claudeAiOauth` and nothing else.** The item also holds an `mcpOAuth`
  map containing unrelated third-party tokens (observed: a PostHog MCP entry with
  its own access token and client id). The raw blob must never be logged, stored,
  or returned.
- **Never prompt in the background.** A scan the user initiated may trigger a
  macOS Keychain dialog; a status check or a background refresh must not. Gate it
  on an explicit `allowKeychainPrompt`, defaulting off for non-interactive paths.

### 3.2 Cloud

A sandbox needs a credential it can hold for the life of the session, and our
sandboxes are ephemeral — they die when the session ends. Anything requiring
per-boot setup is unusable.

**Claude subscription → `claude setup-token`.** An official Anthropic feature
([authentication docs](https://code.claude.com/docs/en/authentication)): the user
runs it once, it mints a long-lived (~1 year) `sk-ant-oat01-…` token for headless
environments, delivered via `CLAUDE_CODE_OAUTH_TOKEN`, billed against their
subscription. Because it is not tied to any sandbox, sandbox ephemerality stops
mattering — one paste covers every future session.

This is legitimate for the shape Claxedo has: we spawn the *user's own* Claude Code
(`driver.ts:153`, `pathToClaudeCodeExecutable: requireClaudeExecutable()`, via
`@anthropic-ai/claude-agent-sdk`), so a subscription token is presented by the
genuine Claude Code identity that Anthropic's server-side check expects.

**Claude usage billing → API key** from `platform.claude.com`, for users without a
subscription or who prefer per-token billing.

**Codex subscription → OAuth.** `provider-auth/openai-oauth.ts` holds a real client
id and OpenAI permits the flow; refresh with write-back into `~/.codex` is
implemented and live-verified.

### 3.3 Per-harness detail

The three harnesses behave differently enough that a single "connect your AI"
answer would be wrong for at least two of them.

#### Claude

Local reads the Keychain (§3.1); cloud uses `setup-token` or an API key (§3.2).
`claudeAuthEnv()` picks the env var from the secret's shape —
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or `CLAUDE_CODE_OAUTH_TOKEN` — so a
`setup-token` value lands as `CLAUDE_CODE_OAUTH_TOKEN` without special casing.

#### Codex — the one harness that manages its own credential

Codex is the exception to §2, and deliberately so. `harnesses/codex/driver.ts`
does not merely consume a token:

- It respects `CODEX_HOME` (line 149) and spawns with it (line 408), so the CLI
  reads its own `auth.json` exactly as it would in a terminal.
- It **refreshes ChatGPT tokens itself** (`refreshChatgptAuthTokens`, line 500)
  against `${OPENAI_ISSUER}/oauth/token` with `OPENAI_CLIENT_ID`.
- It **writes the renewed pair back** to `auth.json` at `0600` (line 530), so the
  user's `codex` CLI is never stranded holding a superseded refresh token.

This is the write-back contract that makes refreshing safe here and unsafe for
Claude: OpenAI's tokens live in a plain file we can rewrite atomically, not in a
store owned by another process. `OPENAI_API_KEY` is injected only when Claxedo
holds a key (line 409); otherwise the CLI's own login is used.

**Consequences for onboarding:**

- **Local:** nothing to collect — `CODEX_HOME` plus the user's existing
  `codex login`. Same rule as Claude.
- **Cloud:** the ChatGPT subscription path works, because a sandbox can carry the
  OAuth pair and refresh it in place. This is the one subscription that survives
  ephemeral sandboxes without a separately minted token.
- **Two accounts are normal.** `~/.codex/auth.json` and
  `~/.codex/accounts/*.auth.json` can hold the *same* account with different
  tokens; discovery ranks by `last_refresh` and keeps the freshest. Rows must stay
  distinguishable by account id.

#### Cursor — API key only, by construction

`sync.ts:31` records why, and it is not an oversight: `cursor-agent` requires a
**dashboard-issued `CURSOR_API_KEY`**, and the only credential on disk (the IDE's
`state.vscdb` entry) is a *cursor.com web-session JWT* — not a valid API key.
Discovery would find a token that cannot authenticate.

`harnesses/cursor/driver.ts:103` passes `apiKey` only when Claxedo holds one, and
falls back to the SDK's own `CURSOR_API_KEY` resolution otherwise.

**Consequences for onboarding:**

- **No discovery.** The AI step must not offer to detect Cursor credentials; the
  current copy already says "Cursor credentials aren't discoverable yet," and a
  test pins it.
- **Same answer for local and cloud:** paste a key from the Cursor dashboard. A
  dashboard key has no rotation and no other owner, so §2 permits storing it — and
  it is the only shape that works in either destination.
- **Nothing to share.** The cloud step has no separate decision for Cursor: a
  stored key is already usable in a sandbox.

#### Summary

| Harness | Local | Cloud | Discoverable? | Claxedo stores? |
|---|---|---|---|---|
| Claude | Machine's Keychain login | `setup-token` or API key | Yes (Keychain) | Cloud only |
| Codex | Machine's `codex login` (`CODEX_HOME`) | Subscription OAuth — refreshed and written back | Yes (`~/.codex`) | Cloud only |
| Cursor | Dashboard API key | Same key | **No** — on-disk token is a web session, not an API key | Yes, both |

### 3.4 What Claxedo will not build

**No Anthropic OAuth client flow, and no "Sign in with Claude."** Anthropic's
[legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) page:
OAuth authentication "is intended exclusively for purchasers of Claude Free, Pro,
Max, Team, and Enterprise subscription plans"; developers building products
"should use API key authentication," and Anthropic "does not permit third-party
developers to offer Claude.ai login or to route requests through Free, Pro, or Max
plan credentials on behalf of their users." There is no third-party client-id
registration, and consumer OAuth tokens in non-genuine harnesses have been blocked
server-side since January 2026.

The distinction this plan holds to: **a user minting a token for their own
environment is their act; Claxedo brokering Claude access would be ours.**
`setup-token` is the former. Lifting a Keychain token the user did not choose to
export would edge toward the latter — and is independently the wrong artifact,
since it expires in 8 hours and belongs to another process.

---

## 4. Flow

```
0. Where should agents run?     local · cloud · both
1. Which project?               one folder — the repo is derived from it
2. Sandbox provider + key       cloud only
3. Connect your AI              method depends on step 0
4. Share with cloud             cloud only, and only if step 3 produced something shareable
```

### 4.1 Step 0 — a question, not an inference

The shipped flow shows cloud steps only when a sandbox provider token is already
configured. That is right for a returning user and circular for a new one, who
cannot configure a provider from a step hidden until they configure a provider.
Asking breaks the cycle, and the answer is a *goal* rather than a fact we can
observe.

Copy states consequences, including the fact that cloud needs no account:

| Choice | Consequence |
|---|---|
| On this machine | "Agents run here, using this machine's CPU and your existing logins. Nothing leaves the machine." |
| In the cloud | "Agents run on a sandbox you pay for. Needs a git repo and a sandbox provider key — no Claxedo account required." |
| Both | "Start locally, move work to the cloud when you want it to keep running." |

### 4.2 Step 1 — one project, repo derived

The user picks a folder. If it has an `origin` remote, the cloud path is already
satisfied — no second question.

`workspace-runtime/src/git.ts` exports `optionalGit(args, cwd)`: bounded
concurrency, 10s timeout, returns `""` rather than throwing outside a repository.
Verified against a real project (`https://github.com/kyashrathore/formlink.git`)
and against a non-repo directory.

**Show the derived remote before anything is created.** A wrong guess clones the
wrong codebase into a paid sandbox, so deriving is a convenience, never a licence
to skip confirmation.

| Case | Behaviour |
|---|---|
| No `origin` | Cloud unavailable for this folder; say so, offer a repo URL field |
| Multiple remotes | Prefer `origin`; ask rather than guess when absent |
| SSH remote | Normalize for display; clone transport resolved in B2 |
| Remote with embedded credentials | Strip the userinfo component; never display or store it |
| Dirty or unpushed worktree | The clone gets what the remote has — warn that local-only work will not be there |

### 4.3 Steps 2–4

**Sandbox provider key** is an in-flow step for cloud users rather than a Settings
detour. The server rejects workspace creation with
`sandbox_driver_credentials_missing` when the active driver has no credentials, so
this must be satisfied before compute can succeed.

**Connect your AI** offers the method appropriate to the destination (§3), with the
full provider catalog behind it.

**Share with cloud** offers only credentials that can legitimately and durably run
in a sandbox — see §5.1, which is a defect today.

### 4.4 Open: private repository clone rights

Deriving a remote URL is not the same as having rights to clone it. For a private
repository the sandbox needs either a connection or an explicit token. Resolve
during B2; the copy must say which is required rather than failing at clone time.

---

## 5. Work

### 5.1 A1 · Cloud sharing must exclude what cannot be shared

**This is a live defect.** `state.ts:66` computes `localOnlyCredentials` by
filtering on scope and machine only — nothing filters on credential kind or
provider. The cloud-credentials step will therefore offer a discovered Claude Code
subscription token for materialization into a sandbox, which is both the wrong
artifact (8-hour lifetime) and the shape §3.3 rules out.

Not currently reachable without a configured sandbox provider, so no user has hit
it; fix before it becomes reachable.

- **Change:** carry `kind` through `credential-query.ts` into `OnboardingCredential`;
  offer only durable, transferable credentials. A discovered subscription login is
  shown as *not shareable*, with the reason and a pointer to `setup-token`.
- **Accept:** a discovered Claude Code login never appears with a Share action; a
  `setup-token`, Codex OAuth, or API-key credential does.
- **Per harness:** Claude Keychain login → not shareable. Codex OAuth → shareable
  (refreshable in place, §3.3). Cursor key → shareable, and in practice already
  shared since one key serves both destinations.

### 5.2 A0 · Local AI step confirms instead of collects

- **Change:** when the destination is local-only, the AI step detects, probes,
  reports, and stores nothing. The save path becomes cloud-only.
- **Accept:** after completing local setup, the credential registry holds nothing
  for that provider, asserted by test.

### 5.3 A2 · `setup-token` as the cloud subscription path

- **Change:** cloud + Claude offers `claude setup-token` with copy explaining that
  it is minted once and survives sandbox restarts; API key offered alongside.
- **Verify first:** `requireClaudeExecutable()` throws when Claude Code is absent,
  so confirm a `setup-token`-authenticated Claude Code actually runs inside the
  sandbox image before the copy promises it. **Stop condition** if it does not.

### 5.4 A3 · One login, one row

`claude-acp` and `claude-sdk` are two harness bindings of one credential and
currently occupy two rows. Collect as a single row naming both bindings; the save
fans out. Presentation only — after A0 and A1.

### 5.5 B · Flow phases

| Phase | Scope | Depends on |
|---|---|---|
| **B0** | Remote derivation behind a route, with the §4.2 case table | — |
| **B1** | Step 0 destination question; navigation and registry | B0 |
| **B2** | Step 1 shows the derived remote; private-clone rights resolved | B0, B1 |
| **B3** | Sandbox provider key as an in-flow step | B1 |
| **B4** | Credential method ordered by destination (§3) | B1, A2 |
| **B5** | Evidence: screenshots per destination, light and dark, vision-reviewed | all |

---

## 6. Definition of Done

- [ ] A local-only run stores no provider credential; the harness inherits the
      machine's own auth. Asserted by test.
- [ ] Claxedo never writes to the `Claude Code-credentials` Keychain item and never
      presents its refresh token to Anthropic. Pinned by test so a later change
      cannot reintroduce it.
- [ ] A Keychain read extracts `claudeAiOauth` only, with no trace of the
      `mcpOAuth` sibling. Asserted by test.
- [ ] Background and status paths never trigger a macOS Keychain prompt; only a
      user-initiated scan may.
- [ ] A discovered Claude Code login is never offered for cloud sharing, and the UI
      says what cloud needs instead.
- [ ] Cloud + Claude offers `setup-token` and an API key; no Anthropic OAuth client
      flow exists in the tree.
- [ ] A local Codex run uses the machine's own `codex login` via `CODEX_HOME` and
      stores nothing; a cloud Codex credential refreshes and mirrors back to
      `~/.codex` so the user's CLI is never stranded.
- [ ] Cursor is never offered for discovery, and its step asks for a dashboard key
      in both destinations — the on-disk IDE token is a web session and would fail
      to authenticate.
- [ ] Two Codex accounts remain independently selectable and distinguishable by
      account id.
- [ ] `setup-token` auth is proven to work inside the sandbox image before the copy
      promises it.
- [ ] Picking a folder with an `origin` satisfies the cloud path with no repo
      prompt, and the derived remote is shown before anything is created.
- [ ] A folder with no remote explains why cloud is unavailable rather than
      silently blocking.
- [ ] A remote carrying embedded credentials is never displayed or stored with its
      userinfo component.
- [ ] A local-only user never sees a cloud step, a repo field, or a sandbox key
      prompt.
- [ ] Setup completes with no Claxedo account, for both destinations.
- [ ] Every credential row still carries a live probe verdict.

---

## 7. Open questions

**Self-host and remote hosts.** A Claxedo running on a box the user reaches over
SSH executes harnesses on *that* machine, which may have no local login. §2's rule
implies it needs its own credential, like cloud. Reasonable, but it should be an
explicit product decision rather than a regression discovered after the fact.

**Codex write-back concurrency.** `credentials/codex-auth-file.ts` mirrors renewed
tokens into `~/.codex` with no lock, so two Claxedo processes — or Claxedo and the
Codex CLI — can interleave. Pre-existing, out of scope here, worth filing.

---

## 8. Working agreements

- **Verify by looking.** Vision-review every screen before calling it done. Four
  real defects in the current flow were found this way and by none of the 4530
  passing unit tests.
- **Absent, not disabled.** A step that cannot succeed is not rendered.
- **Never surface a raw server code** — map it to a sentence and a repair action.
- **No stash on the shared worktree**; baseline comparisons happen in a separate
  clone.
- **Stage by explicit path** (`git commit --only`) — the index is shared with other
  agents.
