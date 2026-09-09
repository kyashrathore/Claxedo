# Claxedo launch audit: manual checks

Snapshot: 9 September 2026. Launch qualification is incomplete. Run unsigned local core first, then Cloudflare/Daytona workspaces, then signed-in web and shared remote devices. Onboarding is last. Start with Claude and Codex; record each separately.

Saved implementation commits: `8b1e49671d` (permission checks) and `ed04b0cbde` (terminal hooks and stronger lifecycle tests). Final commit-time verification: 125 focused route/hook tests passed; all four real native parent-child restart cases passed, including prompt overrides; E2E typecheck and architecture ratchets passed. No new desktop package or hosted deployment was built for this wrap-up.

## What the stronger tests prove

| Flow | Added evidence beyond a visible success message |
|---|---|
| Permissions | File absent before approval; exact write after Allow; no write after Deny/Stop; wrong-session and late replies rejected. |
| Questions | Exact answers reach the provider; Unicode drafts, Back/Next and selections survive reload/restart; failed Submit can retry; simultaneous questions remain isolated. |
| Stop/Delete | Real command PID exits, no delayed write occurs, deleted sessions stay deleted, and a fresh/follow-up conversation works. |
| Lost Delete response | Server performs the real deletion, then the response is dropped; reload cannot restore the session or accept an old approval. This does not cover reload before deletion commits. |
| Desktop restart | Fully quit and reopen the packaged app; verify the same terminal PID, retained output, pending interaction identity and continued input. Browser reload alone is insufficient. |
| Terminal hooks | Check full received prompts, provider lifecycle events, actual background-child start/stop, and one completed audio playback. Playback evidence does not establish physical audibility. |
| Child restrictions | Create children without explicitly assigning their modes; test all four Claude/Codex parent-child pairs, broad mode changes, existing-ID retries, prompt overrides and server restart. |
| Files/Git | Read actual file bytes and Git state; check neighboring workspaces remain unchanged. |

Controlled-provider tests make faults deterministic. Real native-adapter checks verify integration/configuration. Real model turns and packaged-app checks verify further boundaries. None of these alone proves hosted behavior.

## Manual setup and recording

Use a disposable Git project with a clean baseline. Run the current source build: an older installed desktop app will not contain the latest permission changes. Authenticate Claude/Codex and select a usable model (recent tests used Claude Opus and Codex Sol).

Record: app build/commit, local or hosted, harness/model, action, expected result, actual result, screenshot/log, and pass/fail. Use unique filenames for every attempt. A pass requires the entire row, including recovery and isolation.

## 1. Local core

| Check | Manual steps | Pass condition / current limitation |
|---|---|---|
| Approval | In an approval-required session, ask the agent to create `approval-check.txt` containing `APPROVED`. Before responding, inspect the project in a separate terminal. Reload; then Allow once. Repeat with fresh filenames using Deny and Stop. | No early write; exactly the approved contents after Allow; no write on Deny/Stop; another prompt works. Core Claude/Codex paths passed. |
| Questions | Ask the agent to use its native question tool with two questions. Enter a Unicode custom answer, navigate Back/Next, reload, then submit. Repeat with a pending question across full desktop quit/reopen. | Drafts/selections remain; agent receives exact answers once. Claude multi-select passed; Codex native question contract is single-select. |
| Concurrent questions | Open two workspaces/windows and trigger different questions. Answer one, leave the other pending; reload both. | Answers never cross sessions. Concurrent multi-select and full desktop restart still need qualification. |
| Running chat tool | Ask the chat agent to run `sleep 30` in the foreground. Reload or fully restart desktop while running. Repeat and use Stop; then ask a simple follow-up. | Completion survives restart; Stop actually ends the process; no late output/write; follow-up works. Tested scoped chat paths passed. |
| Native TUI cancellation | In the Claxedo terminal running Claude/Codex, ask: `Run sh -c 'echo $$ > .cancel-started; sleep 60; touch .cancel-finished' in the foreground. Do not run other commands.` Once `.cancel-started` exists, press Escape. From a separate shell in the same disposable project run `kill -0 "$(cat .cancel-started)"` after 15 seconds, then check for `.cancel-finished` after 65 seconds. | PID must no longer exist, delayed file must not appear, status must settle without success sound, next prompt must work. **Known failure for both TUIs.** Only inspect/clean up the process created by this test. |
| Terminal restart | Run a shell or real coding TUI. Note its PID/cwd; start output, fully quit desktop, then reopen and continue typing. | Same live process; unseen output restored once; readable screen; no duplicate launch. Core paths passed; daemon-crash variant remains. |
| Sound/status | Start a slow turn, switch to another tab and wait. Repeat foreground, muted, denied, cancelled, failed, and with two simultaneous agents. | Working/pending/idle accurately reflect the provider; one appropriate completion sound; no success sound for cancellation/error. Full sound matrix and physical audibility pending. |
| Delete | Delete a disposable session during a question/approval/running command. Reload and restart desktop; open a fresh session. | No resurrection, old replies rejected, no delayed writes, fresh session usable. Lost-response cases passed; rapid reload before Delete commits remains open. |
| Files/Git | Edit two files; stage only one and commit through the UI. Check `git status` and `git show`. Save a document, externally edit it, then attempt another UI save. | Correct staged bytes; other file remains unstaged; external edit conflict is surfaced. Conflicts, push, binary files, renames/deletions and complete platform parity pending. |
| Layout/input | Use tabs/splits/two windows; paste multiline/Unicode text, attach context, resize and reload during output. | Full prompt submitted once; focus/layout preserved; reply stays above the composer. Intermittent reply overlap remains open. |

## 2. Child permission regression

The stored ceiling is a host/API policy, not merely selecting a restrictive mode in the UI. To reproduce precisely, create a disposable session through the app's runtime API with `permissionCeiling: "ask"`, then create its child using `parentID` without an explicit mode. Use DevTools Network to obtain the actual runtime base URL, workspace/directory scope and session IDs; retain the app's existing authorization headers. Do not copy credentials into reports.

1. Repeat Claude → Claude, Claude → Codex, Codex → Claude, Codex → Codex.
2. PUT `/session/<child>/permission-mode` with `modeId` set to Codex `full-access` or Claude `bypassPermissions`. Expect 403 and unchanged mode.
3. POST `/session` with the existing child ID and the broad `permissionMode`. Expect 403.
4. POST both `/session/<child>/message` and `/session/<child>/prompt_async` with a broad `permissionMode` and harmless text. Expect 403 before provider work starts.
5. Restart the runtime and repeat. The stored ceiling must remain.
6. Switch a restricted session to the other harness through its config UI/API. Inspect `/session/<id>/permission-mode`. It must stay under the ceiling: Codex `read-only`, Claude `default`. **Known failing regression in both directions: target currently uses a broader default.**
7. After that defect is fixed, ask the child for a real write and verify approval/denial and exact side effects. This final enforcement flow is still pending; config readback alone does not prove it.

## 3. Remaining release gates

| Priority | Manual journey | Pending acceptance |
|---|---|---|
| Cloud workspaces | Add Cloudflare, provision a VM/workspace, run section 1; repeat separately with Daytona. Stop/start the VM and reconnect. | Real provisioning, persistence, permissions, terminal/file/Git/plugin parity, isolation and cleanup. Test unsigned local first, then hosted. |
| Signed web | Deploy a working staging release, sign in, run applicable local-core checks. | Staging auth/release configuration is unresolved. Previous newer staging returned `deployment_candidate_unavailable`. |
| Shared remote device | Share a device; sign in from web; open its authorized projects and existing sessions/terminals. Disconnect/restart/reconnect; revoke access; try an unrelated account. | Correct remote data/cwd, no duplicate execution, reconnection and access isolation. Device sharing—not just a workspace link—is required. |
| Agent Plugins | Install Composio in Claxedo, finish real OAuth, ask Claude and Codex separately for a benign read-only account action. Restart, reconnect, revoke and uninstall. | Installation/discovery have scoped passes. Actual account action, auth recovery/revocation and isolation remain. Tool discovery alone is not a pass. |
| Delegation/Goals | Run parallel children; trigger child approval/question/error; Stop or archive parent; restart runtime during work and completion. | Correct ownership, no orphan execution/duplicate wakes, stable child results. OpenCode-supported fork/resume also remains. |
| Other harnesses | Authenticate Antigravity/Droid/Pi and repeat actual turns, tools, status/sound and restart. | Cursor/Amp have scoped passes; remaining advertised harness coverage is incomplete. |
| Onboarding—last | Fresh profile: open a local project, connect provider, first useful result; interrupt/restart setup. Then test cloud and signed-web onboarding separately. | Missing cloud credentials must not block unsigned local work; actionable login/quota/setup errors; completed steps persist. |

Detailed chronological evidence remains in `packages/claxedo-app/.artifacts/launch-flow-audit-evidence.md`; the full nested matrix is `launch-flow-audit.md` beside it. Known failing tests are retained intentionally rather than weakened or marked as passes.
