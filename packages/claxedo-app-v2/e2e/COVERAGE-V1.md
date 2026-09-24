# v1 → v2 coverage map

Today's app has 58 Playwright specs in `packages/claxedo-app/e2e/playwright/`, 39,556 lines. 38 of them import `mock-runtime.ts`, the hand-written fake of the server (measured on this tree; the plan's 32 predates six more). Every user-visible behavior those specs assert is listed here against the v2 flow that must assert it, or as dropped with the reason. v2 flows run on the real stack only, so a behavior a mocked spec reached by faking a server answer is asserted in v2 by producing that answer for real: a scripted model reply, a scripted ACP step, the local sandbox driver, or the Worker.

Flow numbers are the plan's flow table. "On feat/app-v2" means the flow file exists there today; the owning lane still has to assert every behavior listed against it.

## By v1 spec

| v1 spec | Lines | Server | v2 flows | Behaviors carried | Dropped, and why |
| --- | --- | --- | --- | --- | --- |
| a11y-sweep | 226 | mocked | 26, 33 | axe on home (no projects), a settled session, settings, the palette, the focused composer | |
| core-assistant-image-preview | 70 | mocked | 3, 30 | image previews follow streamed source changes; thumbnails open by keyboard | |
| core-boot-deep-links-home | 774 | mocked | 1, 2, 5, 12 | empty-home boot; the wizard fits every step; deep links by id materialize the pane and drop stale tabs; a 404 session closes its pane and leaves the list; failing health shows "could not reach" and recovers without a retry button | the bare `/s/:sessionId` link and old persisted layouts: v2 routes by id only and reads no old browser keys |
| core-busy-abort-errors | 938 | mocked | 4, 5, 30 | "Thinking" stays with the new prompt; Stop keeps the last reported execution and shows the cancelled outcome; an unanswered cancel leaves Stop offered; a lost Stop response keeps the composer usable; Interrupted divider; blank Enter while busy is a no-op; a mid-turn send queues; retry banner then recovery; an error card with the envelope unwrapped; admission conflict as status text; silent server escalates pending → long → failed with Cancel and Retry | |
| core-claude-native-sdk-rail | 430 | mocked | 10, 31 | a native-SDK session appears in the list on its lifecycle event and keeps its status | |
| core-cloud-offline-roles | 830 | mocked | 24, 36, 22 | mint 403 → access denied, 5xx → offline with Retry; a machine-placed offline host; reconnect without a toast or reload; the workspace panel's own pending state; a viewer's composer locks, and unlocks when the role flips live | |
| core-cloud-provisioning | 1012 | mocked | 24, 32 | the provisioning pipeline unlocks on ready and a send completes; reload resumes at the current step; a rejected create shows the failure, creates nothing and keeps the draft; the hosted wizard creates the first cloud workspace | |
| core-codex-theme-contract | 213 | mocked | 29 | Codex surface and geometry tokens in both schemes; forced colors keep a visible edge | |
| core-composer-hosted-chips | 242 | mocked | 32 | project, environment (cloud only on web), workspace and branch chips; a branch prepares a new cloud workspace | |
| core-composer-modes | 717 | mocked | 6 | `!` enters shell mode and backspace on empty leaves it; builtin slash commands fire, custom ones insert; Escape closes a popover, then stops a turn; Shift+Enter newline; `@` pills reach the payload; attachments, image marks with numbered regions, paste and drop; opaque files by harness; image-only prompts; drafts, pills and images survive reload and stay scoped to their surface | |
| core-dead-workspace-sessions | 440 | mocked | 10, 2 | a workspace whose runtime is gone still lists and opens its stored sessions; project-scoped lists by id; an empty inventory shows its notice, not a spinner | |
| core-deployment-posture | 156 | mocked | 1, 21 | a daemon that issues no sessions renders the workbench unsigned; a signed node or central sends a visitor to sign-in; a refused declaration holds the gate | |
| core-docks | 896 | mocked | 8, 3 | the permission dock blocks the composer; Allow once, Deny, Allow always with the danger gate; answered requests stay gone across session switches and replays; the question wizard: single, multi with Back/Next, multiple choice, custom answer, minimize, Dismiss/Escape, keyboard; the todo dock survives reload | |
| core-first-prompt-local | 444 | mocked | 1, 3, 14 | the draft composer is usable before a send; the first send renders the session; a base branch provisions from that ref; no directory, no compose surface | |
| core-harness-ownership-cloud | 374 | mocked | 6, 24 | the harness owns label, model and payload through a cloud draft, sends and reload, locked after creation; Pi's model options come over the relay; per-harness option requests | |
| core-harness-ownership-local | 961 | mocked | 6 | one picker owns harness and model; a resolved model shows until picked and the pick survives reload; a busy native session keeps its harness and model; an unavailable harness shows one notice, blocks submit and never falls back; Connecting keeps the picker inspectable | |
| core-harness-rendering-matrix | 1760 | mocked | 30, 9, 3 | every harness's rendering cases (Claude, Codex, Cursor, Pi, ACP and native), tool renderers, lifecycle states, folding, dedup, interrupted commands after reload and replay, subagent chips and read-only children, file-type parts | |
| core-host-tunnel-workspace | 1340 | mocked | 22 | a machine-placed workspace's 3-step pipeline; a send through the relay; the offline host copy; transient 409/503 still reach ready; enabling remote access publishes the machine; attaching to a running session streams it | |
| core-machines-named | 193 | mocked | 15, 22 | a machine is listed under its derived name with its workspaces on every client; a rename reaches the control plane | |
| core-model-effort-agent-controls | 537 | mocked | 6 | model, effort and agent picks reach the payload; a mid-session change is written at once and survives reload; a missing model blocks submit and opens the picker; Settings → Models visibility reaches the composer; the 409 on a harness identity change | |
| core-panes-split-tabs | 848 | mocked | 12, 28 | drag a tab onto a pane; resize; focus dims the other pane; focus and split shortcuts; MRU cycling; stable tab order; background status dots and the idle sound; split restore; the empty workbench opens a draft; the palette; toggle the sidebar | |
| core-permission-mode-picker | 196 | mocked | 6, 8 | modes per harness; switching harness replaces them; a mode chosen before the first message rides on it; a live change is written to the runtime | |
| core-processes | 1045 | mocked | — | | the Processes pane goes (decided A3) |
| core-queued-messages | 179 | mocked | 4, 11 | queued bubbles with edit-in-place and Escape; they leave virtual rows and the reader's position alone | |
| core-session-actions | 807 | mocked | 10, 9, 11 | fork a message into a new session with its draft restored; revert prefills the composer and shows the revert dock, restoring the row unreverts (flow 11 owns message actions); rename inline and from the menu, Escape cancels, a failed rename keeps the editor; archive navigates away; delete confirms by name; a child session has a read-only composer, a breadcrumb back, and its permissions bubble to the parent; tab titles follow | |
| core-session-rendering-navigation | 325 | mocked | 12, 11, 1 | Back/Forward keep a visit; a new terminal keeps focus; one steady logo through boot; the permission control keeps composer geometry; a file selection returns per session; a human turn elsewhere reorders the list | |
| core-session-share-levels | 276 | mocked | 23, 36 | follow grants need no disclosure; send grants do, and reach the server only after it; downgrade and revoke from the row; a send grantee composes as a workspace viewer; a follow grantee cannot send as an owner | |
| core-settings-auth | 1672 | mocked | 15, 21, 17 | sections and mobile nav; account and sign-out; appearance preview and commit; notifications; shortcut search, rebind, conflict, reset; provider connect and disconnect, env-locked providers; the Models catalog; GitHub and MCP connections with OAuth and secret hygiene; sandbox providers and credentials; `/login` and `/cli-login`; the init error page | update checks on web (desktop only, flow 25); network-policy settings: pending owner decision 4 |
| core-sidebar-tree | 1047 | mocked | 10, 31, 33 | status dots working → done from events and after reload; activation; pagination without duplicates; archive from the row; archiving the only session; a harness session appears on its lifecycle event; collapse, peek and resize; the phone drawer | project/workspace tree, Group by and view filters: the flat list is decided |
| core-source-control | 1257 | mocked | 14 | the Changes navigator; stage, unstage, commit (⌘⏎); review modes; compare and base pickers; graph commits; Create PR link; a rejected push; maximize and restore | |
| core-terminal | 956 | mocked | 13 | the creator offers installed agents and custom commands; typing and output; refit on split; lifecycle status dots survive reload and clear on focus; auto-rename spares user titles; reload reattaches the PTY | |
| core-timeline-rendering-scroll | 1826 | mocked | 30, 11 | tool default-open states; context-tool grouping; the diff summary; jump to bottom; Show all keeps the line; Home/End on heavy transcripts; restoring the reading position; stable user rows; stationary composer on short replies; streamed tables; pinned while streaming; `#message-` deep links | |
| core-turns-reload-recovery | 629 | mocked | 4, 6, 11 | later sends survive reload without duplicates; prompt history recall and persistence; a failed dispatch restores text, attachments and context chips; older turns load with the anchor kept | |
| core-usage-dashboard | 360 | mocked | 16 | usage opens, reconciles cards and restores focus; full viewport on phone | the "Total" figure (decided A4) |
| core-workspace-lifecycle | 665 | mocked | 2, 14, 24 | an invalid path creates nothing; rename and remove a project; delete a worktree with the dirty check; destroy a cloud main workspace; missing-workspace recovery | |
| desktop-live-sessions | 1005 | real, live accounts | 25, 7 | a packaged app completes a harness session | real vendor accounts: v2 flows use the scripted model endpoint only |
| desktop-live-terminal-tui | 570 | real, live accounts | 13 | a packaged terminal completes a TUI turn, pause and child cases | real vendor accounts, as above |
| desktop-repository-document | 97 | real | 19 | a repository document survives restart and protects competing disk edits | |
| desktop-signed-embedded-shared | 52 | real | 21 | the packaged renderer reaches the signed control plane | |
| desktop-terminal-launch-once | 163 | real | 13, 25 | a custom terminal launches once across reload and restart | |
| desktop-u8-package-boundary | 293 | real | 25 | unsigned start loads no optional activation; fixture OAuth activates the hosted renderer once | |
| desktop-unsigned-embedded | 1632 | real | 25, 17, 16, 27, 10, 13 | file:// renderer; boot without error toasts or non-2xx; Marketplace installs a plugin for Claude and Codex; usage views; new sessions, re-prompt ordering, reload keeps title, order and status; the browser keeps its page; a clipboard image stays out of new sessions; model kept through a busy first turn; a real terminal row | |
| desktop-worktree-recovery | 107 | real | 14, 25 | a recovered worktree runs a shell in its checkout across restart | |
| documents-core | 1221 | mocked | 19 | exact Markdown round trips across restart; repository files edited in place; no write on open-close; autosave retries then manual Retry; rich editing and slash commands; CAS conflicts across tabs and external writes; version restore; `/docs` mentions; hosted reconstruction | |
| live-real-harness-smoke | 1834 | real, live accounts | 7, 8, 9, 10, 2, 13, 14, 19 | three turns per harness with reload; permission ceilings across restart; goals; questions; todos; fork refusal; rename and restart; stopping children; project rename and removal; documents; source control; terminal reattach and history | real vendor accounts: the same journeys run on the scripted model |
| marketing-screenshots | 352 | mocked | — | | captures for the public site, not a behavior test |
| mobile-smoke | 414 | mocked | 33 | the drawer; the full-width panel; no review auto-open; timeline scroll; touch drag to split | |
| real-cloud-relay | 250 | real | 24, 22 | a cloud workspace completes turns across the relay and reload; pausing the relay fails a turn and resuming restores it | |
| real-connect-host | 1127 | real | 22 | an enrolled host's workspace comes online, is shared, and is revoked | enrollment exit codes, leases, state-dir copies, outages and service install are CLI and server behaviors; they belong in those packages' tests |
| real-desktop-signed-cloud | 430 | real | 21, 22 | the main-process credential refreshes and survives restart; remote access is single-flight and revocation wins | |
| real-harness-local | 3227 | real | 3, 6, 7, 8, 9, 10, 13, 16, 31 | Pi, Claude and Codex turns with reload and usage; goals with continuation, pause, resume and delete; concurrent questions isolated per workspace; rename across restart; subagents from provider calls; permissions gating a real write; todos; errors that survive reload; two tabs converge on one order | |
| real-host-tunnel-relay | 631 | real | 22 | register and tunnel up; file reads and PTYs through the relay; a host-started turn streams; viewer tokens refused writes; pause and resume | |
| real-server-mediated-core | 218 | real | 10, 2, 13 | rename, archive and delete through the real session owner; workspace delete and re-resolve; PTY ownership; the session's permission ruleset; inventory survives runtime removal | process config CRUD (the Processes pane goes) |
| real-session-directory-isolation | 146 | real | 2, 36 | a cross-directory session id claim is refused and routing keeps ownership | |
| real-session-rendering-harnesses | 311 | real | 3, 30 | OpenCode steering keeps the reply through reload; the default agent answers a browser prompt; a local image restores as a tile; a shell command and result restore | |
| web-signed-cloud | 182 | real | 21, 24, 10, 13 | signed web: reload mid-session, cold deep link, new sessions and ordering, background status dots, list and switcher agree, harness switch across reload, a real terminal | |
| web-signed-host-tunnel | 191 | real | 22, 10, 13 | the same journeys over a host tunnel | |
| web-signed-org-team-multiplayer | 462 | real | 23, 36 | a member follows and drives a shared session; revoke ends it | |

## By v2 flow

| Flow | On feat/app-v2 | Fed by |
| --- | --- | --- |
| 1 First run | yes | boot-deep-links-home, first-prompt-local, deployment-posture, session-rendering-navigation |
| 2 Projects, local | yes | workspace-lifecycle, dead-workspace-sessions, boot-deep-links-home, server-mediated-core, session-directory-isolation, live-real-harness-smoke |
| 3 Send a turn | yes | assistant-image-preview, first-prompt-local, harness-rendering-matrix, docks (todos), real-harness-local, session-rendering-harnesses |
| 4 Stop, queue, reload | yes | busy-abort-errors, queued-messages, turns-reload-recovery |
| 5 Errors by class | yes | busy-abort-errors, boot-deep-links-home |
| 6 Composer | yes | composer-modes, harness-ownership-local and -cloud, model-effort-agent-controls, permission-mode-picker, turns-reload-recovery |
| 7 Goal mode | yes | real-harness-local, live-real-harness-smoke, desktop-live-sessions |
| 8 Permissions and questions | yes | docks, permission-mode-picker, real-harness-local, live-real-harness-smoke |
| 9 Subagents | yes | harness-rendering-matrix, session-actions (child sessions), real-harness-local |
| 10 Session list | yes | sidebar-tree, claude-native-sdk-rail, session-actions, dead-workspace-sessions, server-mediated-core, web-signed-* |
| 11 Long transcript | yes | timeline-rendering-scroll, queued-messages, turns-reload-recovery |
| 12 Workbench and shell | yes | panes-split-tabs, session-rendering-navigation, boot-deep-links-home |
| 13 Terminal | yes | terminal, desktop-live-terminal-tui, desktop-terminal-launch-once, server-mediated-core |
| 14 Review | yes | source-control, first-prompt-local (base branch), workspace-lifecycle (worktrees), desktop-worktree-recovery |
| 15 Settings | no | settings-auth, machines-named |
| 16 Usage | no | usage-dashboard, desktop-unsigned-embedded, real-harness-local |
| 17 Marketplace | no | desktop-unsigned-embedded, settings-auth (connections) |
| 18 Tasks | no | new in v2 as a plugin; v1 had no spec |
| 19 Pages | no | documents-core, desktop-repository-document |
| 20 Plugins on and off | no | new in v2 |
| 21 Sign-in on a used machine | no | deployment-posture, settings-auth (`/login`, `/cli-login`), desktop-signed-embedded-shared, real-desktop-signed-cloud, web-signed-cloud |
| 22 Remote access | no | host-tunnel-workspace, machines-named, real-host-tunnel-relay, real-connect-host, real-cloud-relay, web-signed-host-tunnel |
| 23 Team | no | session-share-levels, web-signed-org-team-multiplayer |
| 24 Cloud workspace | no | cloud-provisioning, cloud-offline-roles, harness-ownership-cloud, workspace-lifecycle, real-cloud-relay, web-signed-cloud |
| 25 Desktop | no | desktop-u8-package-boundary, desktop-unsigned-embedded, desktop-live-sessions, desktop-terminal-launch-once |
| 26 Language and accessibility | yes | a11y-sweep |
| 27 Browser tab | yes | desktop-unsigned-embedded (native browser) |
| 28 Compact tabs | no | panes-split-tabs (switcher, status dots) |
| 29 Codex theme | no | codex-theme-contract |
| 30 Transcript corpus | no | harness-rendering-matrix, timeline-rendering-scroll, busy-abort-errors, assistant-image-preview |
| 31 Session-list races | yes | sidebar-tree, claude-native-sdk-rail, real-harness-local (two tabs converge) |
| 32 Add a project, hosted first | no | cloud-provisioning (hosted wizard), composer-hosted-chips |
| 33 Phone | yes | mobile-smoke, a11y-sweep, sidebar-tree (drawer), usage-dashboard (phone) |
| 34, 35 Live plugins | no | new in v2 |
| 36 Access | no | cloud-offline-roles (roles), session-share-levels, web-signed-org-team-multiplayer, session-directory-isolation |

## Gaps v2 must close

Behaviors v1 asserts that stay (they are not on the plan's "Goes" list) and v2 does not have yet. Each belongs to session-screen:
- the composer's `!` shell mode, entered by `!` and left by backspace on an empty draft (flow 6);
- message fork into a new session, and revert/unrevert with the revert dock (flow 11).

Pending owner decision 4: network-policy settings (core-settings-auth).
