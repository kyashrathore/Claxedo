# Cloud project onboarding: name, repository, environment

**Status:** in progress · 2026-09-05
**Owner:** codex/refactor-agent-plugins branch
**Depends on:** `docs/plans/2026-09-05-001-feat-local-signed-web-dev-plan.md`

## Problem

The web app's New Project action is the desktop's: a local folder picker, with the cloud
dialog reachable only behind the build's `sandboxEnabled` flag and a loopback check. A signed
web user has no local filesystem to pick from. The cloud dialog itself asks for a repository
and a sandbox provider and nothing else: no project name, no environment variables, so the
first thing a provisioned sandbox needs (its `.env`) has no home.

## Design

- **One flow on the web.** `platform === "web"` always opens the cloud project onboarding;
  the folder picker stays the desktop's and the local product's. The `sandboxEnabled` gate no
  longer decides which dialog a web user gets. (Owner: "remove entirely the new project flow
  which is for desktop", "enable onboarding flow".)
- **Three steps, one dialog.** Name → Repository → Environment, then the existing provisioning
  pipeline. The name is the project's display name (`projectName` on the create route, which
  already exists). The repository step is the existing picker (connected GitHub repositories,
  or a public URL, with Connect GitHub inside). The environment step is a key/value editor for
  the variables the sandbox should start with; values are shown as entered, since they are
  readable inside the sandbox by design (`SandboxHostInput.env` is the plaintext channel;
  brokered secrets are a different thing and stay out of this form).
- **Server contract.** `POST /api/workspace` (self-hosted) accepts
  `env: Record<string, string>` for cloud workspaces: names match `[A-Za-z_][A-Za-z0-9_]*`,
  at most 64 entries and 32 KiB total. The workspace record persists it (`Workspace.env`,
  additive field in the JSON state; no migration) so a re-provisioned sandbox gets the same
  environment, and the supervisor injects it as the sandbox's `env` at `ensure`.
- **Hosted plane.** Out of this slice. Its create route is a separate implementation over D1
  rows with no environment column; the client sends `env` only when non-empty, and the hosted
  route's strict schema answers 400, which the dialog shows. Hosted persistence and injection
  is the next slice.

## Definition of done

- [x] Web New Project opens the onboarding dialog regardless of `sandboxEnabled` or transport
      (`home.tsx`, `project-actions.tsx`); desktop keeps the folder picker. Existing action tests pass.
- [x] Dialog: Name (defaults from the repository), Repository (unchanged; existing tests pass),
      Environment (add/remove rows, name validation, duplicates, orphan values, empty rows dropped);
      the create request carries `projectName` and `env`, and omits `env` when empty (vitest ×3).
- [x] Self-hosted create route validates `env` (names, 64 entries, 32 KiB), persists it on the
      workspace record, and the route's provisioning call and the supervisor's re-provision both pass
      it to the sandbox manager's `ensure` (route tests ×3).
- [~] Live on the local signed stack through the HTTPS origin: an invalid environment is refused 400
      with the environment message; a valid create stops at `sandbox_driver_credentials_missing`
      (400, Daytona) BEFORE the record is written, because the route checks the driver first and no
      sandbox provider is configured on this box. Persistence and injection are proven by the route
      tests; the end-to-end provision needs a configured provider.

Also fixed on the way: the branch had moved the dialog onto a "create authority" that the browser
never bound (the web's account port has no transport), so signed web creation threw; the authority
is now bound to the one transport-aware create function (`createCloudWorkspace`: Electron main on
the desktop, the session cookie in the browser), and the dialog keeps the authority seam. The
environment editor keys rows by index so typing does not recreate the input under the caret.

## Progress log

- 2026-09-05 01:15: plan written from the code (create route schema, supervisor `env: {}`,
  JSON workspace store, dialog and action call sites).
- 2026-09-05 01:40: slice implemented and verified as above.
- 2026-09-05 02:00 (owner correction, adopted): the product is decided by the SERVER's mode, not the
  client's platform or URL. Unsigned local server = the local product (the same frontend the desktop
  wraps; New Project is a folder on this machine, also in a browser tab). Signed server (the hosted
  plane, or the self-host binary with accounts on, on a VM or on a laptop for development) = the
  hosted product (New Project is the cloud onboarding). "Web is always cloud" overshot and is
  reverted: both the home route and the rail action now key off `centralTransportForDeployment`
  (auth-enabled build/server → signed-web), with action tests for both modes. The sandbox provider
  picker is its own step. The hosted browser build sets `VITE_SANDBOX_ENABLED=true`. Connect GitHub
  offers the OAuth device flow whenever the server has a `GITHUB_CLIENT_ID`; the local launch entry
  carries the staging client id.
- 2026-09-05 02:30 (owner correction, adopted): a server with its own filesystem (the self-host
  binary, which is the desktop's server) offers "a folder on this machine" as a project whether or not
  an account is signed in — only the hosted plane has no folders. New Project now reads
  `localExecution` from the server's health document plus the signed state
  (`features/workspaces/actions/new-project-flow.ts`): filesystem only → folder picker, accounts
  only → cloud onboarding, both → `DialogNewProjectKind` chooser. The rail action receives the health
  as an injected port (`ActionProps.serverHealth`, built in `app-shell-actions.ts`) because features
  may not import the app layer. Landed as `1a86583dad` + `844d491b18`.

