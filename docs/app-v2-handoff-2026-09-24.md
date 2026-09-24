# App v2 rebuild — handoff (2026-09-24)

**Where it stands.** `packages/claxedo-app-v2` runs on today's server next to today's app. It boots into v1's rail with v1's look. Ported onto v2's own data layer are v1's:
- shell;
- workspace panel;
- composer;
- project surfaces.

It is **not** at the plan's "Ready for you" (P6):
- some of the owner's bugs are still open (see [Owner-reported bugs](#owner-reported-bugs));
- the owner deferred several v1 surfaces at 19:08: settings sections, onboarding, Marketplace and Tasks;
- 10 of the app's 17 checks fail;
- app plus kit is over the line budget;
- the benchmark has never run against v2.

Nothing is pushed, `packages/claxedo-app` is untouched, and there is no swap.

The plan is `docs/plans/2026-09-24-001-refactor-app-rebuild-first-proof-plan.md`. Where it disagrees with the owner's parity rule, the rule wins (see [Better](#1-better-v2-looks-and-behaves-exactly-like-v1)).

## The goal in four parts

The owner's words: better, performant, easy code, less LOC. Each part gives the rule, where it stands (observed on `feat/app-v2`), and what is next.

### 1. Better: v2 looks and behaves exactly like v1

**The rule (owner, 13:58):** "make sure there is no change in look and behaviour or ui". v1, today's app, is the spec. The only exceptions are the owner's approvals.

**The spec lives in this repo:**
- **Inventory:** `docs/app-v2-parity/inventory/<area>.md`, 733 rows across shell, session, composer, projects, tools, settings and extras. Each row gives v1's behavior, its v1 source and v2's status.
- **Rulings:** `docs/app-v2-parity/DECISIONS.md`, every approval, rejection and later ruling, with times.
- **The status column is stale.** It was written before the parity fixes. The commit subjects on `feat/app-v2` name what each slice closed. Re-derive the status with `bun run e2e:parity` before trusting either.
- **Screenshots aren't in the repo.** `bun run e2e:parity` regenerates them from one seeded stack.

**The method every parity slice followed:**
1. **Port, don't restyle.** `git mv` v1's component out of `packages/claxedo-app-v2/src/legacy/` into its v2 domain. Change only its data access, which goes to `@/server` (the adapter) and `@/session` (the stores). Markup, CSS, copy, keyboard handling and timing stay as v1 has them. v2's rebuilt version is deleted in the same commit.
2. **v1's look is the kit.** `@opencode-ai/ui` and `@opencode-ai/session-ui` render as they do in v1: the Codex theme by default, a 16px root.
3. **Never port v1's performance patches:** held API calls on session switch, fast-tier switching, hydration delays, deferral timers.
4. **Never port v1's global providers:** sync contexts, `useLanguage`, `authFetch`/`getClaxedoServerUrl`, global SDK clients, layout and route providers.
   - Strings come from v2's i18n: `useTranslator`, with v1's keys copied into the domain's `i18n.ts`.
   - Layout comes from the shell's registries.
5. **Verify each surface** against v1 at 1280×800 and 390×844, then run the flows it touches.

**Kept from v2 (owner, 16:45):**
- the @-mention popover that shows files;
- ~~the "Settings" row in the rail~~: removed by the owner at 21:10. A Usage button now sits beside the account card;
- v2's settings sidebar and content layout. Every v1 settings feature still has to exist in that style.

**Merged.** Lanes verified these against v1 with side-by-side screenshots; the orchestrator checked the boot and the rail live on 4480.

- **Look:**
  - v1's global CSS and `app-shell.css`, the kit's themes, Codex by default;
  - the Codex contrast look: one background, cards and dialogs derived from a Contrast value, and Light/Dark Contrast sliders in Appearance.
- **Shell:**
  - v1's URLs: `/w/<ws>/session/<id>`, `/w/<ws>/session` for a draft, `/w/<ws>/terminal/<id>`;
  - v1's rail: Tasks, Marketplace, the Projects tree with nested sessions, pin and resize;
  - the workbench header, phone drawer, landing and boot splash;
  - compact tabs, shown only while the sidebar is unpinned;
  - the palette, which is v1's `DialogSelectFile`;
  - New Terminal in the header and on a project's hover.
- **Panel and tools:**
  - v1's workspace panel, where every file opens as a panel tab;
  - Review, with its toolbar in the panel and the Changes column beside it;
  - v1's Files navigator and tree;
  - the Browser tab's chrome;
  - terminal colors, font and phone keys;
  - the terminal creator.
- **Composer:**
  - v1's frame, toolbar, + menu and Send control;
  - v1's default rule for a new session's harness, model and effort;
  - the permission chip;
  - drafts and history that survive a reload;
  - the goal, permission and question docks, and the todo tray;
  - type-to-focus;
  - `#message` links with Previous/Next;
  - the loading skeleton and "Session unavailable";
  - the image mark editor;
  - drop a file anywhere on the session pane.
- **Session screen:** no title bar (owner, 17:15). The session shares the app's background.
- **Projects:**
  - one project source, `/api/claxedo/projects`, with v1's names and an `available` field;
  - Settings → Projects with v1's Edit dialog, in place of a project page (owner, 17:26);
  - v1's folder dialog on web and desktop;
  - the composer's Project chip with v1's create form, plus the approved Name field and Account picker.
- **Transcript:**
  - moved, not rebuilt;
  - v1's typography;
  - an opened session reads its latest turn in full;
  - flow 30's corpus is identical to v1 on desktop, 8 of 8.

What remains is under [Owner-reported bugs](#owner-reported-bugs) and [Deferred](#deferred-by-the-owner).

### 2. Performant

**The rule:** v2 is fast because of its data layer (stores the server pushes into, one owner per datum), never because of v1's patches.

**The plan's gate:** agent-app-benchmark, packaged v1 against packaged v2. No row may be lost, and v2 must win:

| Row | Target | v1 |
| --- | --- | --- |
| Idle CPU | ≤ 4.4% | 8.6% |
| Long rows (8 MiB in 8 rows) | ≤ 2.4 s | 3.5 s |
| Panel open | ≤ 250 ms | 1,032 ms, 900 ms of it a hydration delay |
| Idle memory | ≤ 700 MiB | 801 MiB |
| App start | ≤ 1.1 s | 1.24 s |

**Where it stands: unmeasured.** The bench lane stopped at the first usage limit, and no packaged v2 build has been benchmarked. This acceptance criterion is unverified.

**What the code shows (observed):**
- **No v1 perf patch in live code.** There's no `requestIdleCallback`, hydration delay or held call outside `src/legacy`.
- **One timer needs its cause found.** Most surviving timers are UI feedback (a copy flash, a finish animation). `src/composer/harness/harness-options-loader.ts:134` retries after 1 s; find why the first attempt fails instead of retrying.
- **Four sites fail `no-polling`:**
  - `src/transcript/basic-tool.tsx:156`;
  - `src/transcript/message-part.tsx:359`;
  - `src/transcript/session-retry.tsx:24`;
  - `src/ui/controls/account-status.tsx:186`.
- **Opening a session reads twice:** the surface as fragments, then `view=latest-turn` (`src/server/latest-turn.ts`). That's v1's order; the benchmark's switch rows measure it.
- **Each v2 tab holds two SSE streams.** Over HTTP/1.1 (Vite dev), several tabs hit the browser's six-connection limit and a new tab hangs on "Loading". Test dev with one or two tabs. Packaged builds aren't affected.

**Next:** move the perf-harness driver to agent-app-benchmark with v2's hooks (plan, "Performance gate"), then run the verdict three times on packaged builds.

### 3. Easy code

**What holds (observed):**
- **One boundary to the server.** `src/server/` is the only code that knows routes, event names and payloads, and `adapter-boundary` passes.
- **No providers.**
  - Live v2 code has zero `createContext` calls and zero uses of v1's providers: `useLanguage`, `authFetch`, `getClaxedoServerUrl`, `useSDK`, `useGlobalSync`, `useLayout`, `useSessionParams`.
  - Access is provider-free. Only `AuthProvider` stays at the root, giving a signed server scope keyed by the principal.
- **Domains:** `src/<domain>/`, each with a narrow `index.ts`. The shell knows no feature: features register pages, pane kinds, panel views and settings sections in `src/shell/registry.ts`.
- **One owner for the session list:** `src/session/list/`, with six written reconcile rules, proven by flow 31.
- **Projects are ids.** A folder is only where a project runs.
- **Seams added in the parity phase:**
  - `usePanel().show({ kind, ... })` and `usePanel().maximized()`;
  - `panelViews` (`context` | `subagent`);
  - `useTerminals()`: items, retain, `createTerminal`, open, close, `startNew`;
  - `server.sessions.latestTurn`.

**What falls short: `bun run check` fails 10 of 17 steps** (observed at `8636e87e00`). Ported v1 code arrived with its comments, OpenCode names and long functions.

| Check | Violations | Mostly in |
| --- | --- | --- |
| no-comments | 2,104 | composer 667, transcript 646, session 466, ui 193 (transcript comments get triaged into corpus cases first) |
| claxedo-names | 1,111 | session 382, transcript 376, composer 185 |
| v2-only | 877 | transcript 397, shell 168, session 103; the check doesn't know the parity ruling that v1's kit is the look |
| one-owner | 239 | spread across domains (duplicate names and dictionaries) |
| one-home-per-datum | 81 | transcript 51 |
| size | 73 | composer 44: `harness-config-store.ts` is 346 lines, with a 258-line `createHarnessConfigStore` and a 184-line `createHarnessHydrator` |
| no-swallowed-errors | 56 | transcript 17, composer 13, session 11, auth 9 |
| domain-boundaries | 36 | composer 11, rail 7, shell 6, session 6 |
| budget | 8 parts over | composer 11.3k (budget 5.5k); `src/ui` plus transcript 23.7k (budget 20k) |
| no-polling | 4 | see Performant |

These pass: typecheck, adapter-boundary, no-directory-identity, access-boundary, protected-areas, e2e-hygiene.

**The biggest problem: two UI kits.**
- Ported v1 components import `@opencode-ai/ui`: 72 files import its Button, 43 its dialog context, 39 its toast.
- v2's own `src/ui` still supplies a second Button (21 importers), `useDialog` (18) and `showToast` (13).
- The plan's goal 1 ("one UI kit, inside the app") conflicts with the owner's ruling ("v1's look is the kit").
- **The resolution that meets both:** one kit that renders v1's look and lives in the app.
  - At the swap, move the v1 kit components v2 actually uses into `src/ui`, delete v2's duplicates, and drop both kit dependencies.
  - Until then, `packages/ui` can't change, because today's app shares it.

**Repo gates** (checked 23:20):
- **`bun run test:architecture-ratchets`: the retirement and product-boundary steps pass.**
  - The transcript seed no longer names retired contracts.
  - The local-server closure ceiling rose to exactly 73/30 source and 102/31 runtime, for the daemon's live plugins; `verify:closure` passes in full.
- **The helpers step fails, with 4,390 findings.**
  - About 3,200 are in `src/legacy`, and nearly all the rest pair v2's copies with v1's originals.
  - They clear when `src/legacy` is deleted and v1 goes at the swap.
  - The 8 real ones in live v2, local `isRecord` copies, are fixed (3e2ea6eb3a).

**One kit, progress:** toasts (876dad469b) and Tooltip (54257ea3ec) are now the kit's, with v2's copies deleted. Dialog and Button are next, one surface per commit.

### 4. Less LOC

Measured as tracked `.ts/.tsx/.js/.mjs`, without tests, stories or locales (the plan's measure):

| | v1 today | v2 now | Target at the swap |
| --- | --- | --- | --- |
| App production code | 175.6k, plus a 35.7k perf harness | 86.4k | ≤ 94k for app and kit together |
| Kit packages the app imports | `ui` 15.7k, `session-ui` 20.8k | the same two packages | inside the 94k |
| Unit tests | 155.2k | 0 | 0 |
| e2e | 56.8k | 6.2k | ≤ 16k |
| First-party plugins | inside the app | 14 lines (Tasks and Pages stubs) | ≤ 7k |
| `src/legacy`: v1's copy, the porting source, not built | — | 141.3k | 0, deleted when nothing is left to port |

**The honest projection:**
- The budget check counts 77.2k of 94k, but its part table leaves out the two kit packages.
- App plus kit is about 123k today, and the unported surfaces still have to fit: settings sections, onboarding, Marketplace, Tasks, Pages.
- Reaching 94k needs two things:
  - the one-kit move, which brings in only the kit components v2 uses;
  - the composer shrunk back toward its 5.5k row.

## Where things are

| Ref | State |
| --- | --- |
| `feat/app-v2` in `~/test/opencode-app-v2` | The integration branch; tip in `git log -1 feat/app-v2`. Base is dev `37563dc802`, and dev hasn't moved since. 468 commits, 240 of them non-merge. **Not pushed.** |
| Lanes | `~/test/opencode-app-v2-lanes/<lane>` on `v2/<lane>`. See [Lanes at the stop](#lanes-at-the-stop). |
| Unmerged WIP | Five lanes stopped with uncommitted work. It's saved as WIP commits on their own branches, unreviewed and unmerged:<br>• `v2/adapter` `f1439bf342`: subagent wire<br>• `v2/checks` `c87e2ebc5e`: check proofs<br>• `v2/live-plugins` `23888d6e0a`: the `claxedo plugin` CLI<br>• `v2/plugins` `4fe40a57d6`: flows 20, 28 and 29; flow 29 is obsolete, since the owner deleted the Codex theme plugin<br>• `v2/server-projects` `57667c45d6`: D1 project store and migration 0042 |
| Outside the v2 package | 73 files: the local projects route (server-core, local-server), plugin-api and plugin-build, desktop `dev:v2`, and the `plugins/tasks` and `plugins/pages` stubs. |
| `packages/claxedo-app` (v1) | Untouched. |

**Test servers, all run from `~/test/opencode-app-v2`:**

```sh
# v2 on 4480: Vite dev, so merges into feat/app-v2 show up live
cd packages/claxedo-app-v2 && CLAXEDO_DEV_PROXY_TARGET=http://127.0.0.1:2598 PORT=4480 bun run dev
# v1 on 4481
cd packages/claxedo-app && VITE_CLAXEDO_SERVER_URL=http://127.0.0.1:2598 CLAXEDO_DEV_PROXY_TARGET=http://127.0.0.1:2598 PORT=4481 bun run dev
# daemon on 2598 with the pinned Pi 0.85.1 (the runtime refuses Homebrew's 0.87.1)
cd packages/claxedo-server && PI_EXECUTABLE=$PWD/../agent-sdk-runtime/.artifacts/pi/node_modules/.bin/pi CLAXEDO_SERVER_PORT=2598 bun run start
```

- **The daemon on 2598 holds the owner's real data.** Agents may navigate and screenshot there, nothing else.
- **Flows run their own stacks** on lane port ranges: `CLAXEDO_E2E_PORT_RANGE=<a>-<b> bun run e2e -- --app=v1|v2`.
- **Restart the daemon after any server change.** "/welcome while projects exist" was an old daemon that didn't send `available`, so the app's guard dropped every project.

## Owner-reported bugs

Updated 21:40, after the owner switched accounts and the lanes resumed.

| The owner's report | Lane | State |
| --- | --- | --- |
| The landing says "Nothing is open" | session-screen | **Fixed** (b729548e87). `/w/<ws>/session` opens the workspace's one draft, and the landing skips unavailable projects. Verified in a fresh browser on 4480. |
| Missing projects sort first and aren't dimmed | projects-app | **Fixed** (96ce7ab098, cb45ca5ae6). v1's order is by project id. A project is available while a folder exists or a cloud sandbox is ready. The daemon was restarted and verified. |
| "terminal only appears in tab not in left sidebar" | shell | **Fixed** (6c6df50e56). One `session \| terminal` row list in `rail/model.ts`. Flow 13 passes on v1 and v2. |
| Account card; Usage opens Settings → Usage; sign in and out | shell | **Done** (b763917e60). The org switch waits for org routes in the adapter and something in v2 that consumes the choice. |
| "no need of separate setting icon, keep usage icon beside accounts menu" (21:10) | shell | **Done** (142bb781ba). |
| "skipping/stop button clicking on question dock, make it stuck" | session-screen | **Partly fixed** (4bf6411e77): a failed reply no longer freezes the dock. Still being checked: the dock must disappear when the harness closes the question after Stop. |
| Todo dock goes away when done; stays collapsed across a reload | session-screen | **Fixed** (54fc8c7c27). This deviates from v1 and is recorded in DECISIONS. |
| Contrast sliders show only for Codex | main | **Fixed** (94b91105c8). Verified headless. |
| "subagents are going to top for no reason" | transcript | In progress. `ambientSubagents()` claims chips that belong to a turn. |
| Subagents open as a workspace-panel tab; same-page logic removed | transcript | In progress, after the attribution fix. Flow 09. |
| Closing a terminal from the rail leaves it in the compact tabs | shell | In progress. The fix is one owner for the terminal list. |
| Clicking a file in the Files navigator freezes for seconds; toggling the navigator back freezes the app | tools (resumed for this only) | In progress. Traced with long-task timings, and fixed at the cause. |
| The composer floats over a maximized panel | session-screen | Queued. |

**Found by the flows with no owner running:** v2's `/login` shows only "Continue", with no email form (00-signed-smoke). The auth screens belong to the stopped settings-access lane.

## Owner questions still open

- **Closing a terminal ends its PTY.** In v1 the shell kept running (DECISIONS 18:25). Confirm the fix.
- **The contrast formula.** Keep the one derived from the Codex bundle, or replace it with our own curve.
- **The todo dock when everything is done.** The owner's expectation differs from v1's `todoState`; record the approval.

## Deferred by the owner

At 19:08 the owner said: finish in-progress work; start no new work.

- **Settings sections** in v2's settings style: General, Models, Terminals, Machines, Orgs & Teams, Presets.
- **v1's onboarding.** Flow 01 fails on v2 until it lands.
- **Marketplace, Tasks and Pages:** the extras inventory has 103 rows missing.
- **The composer's Environment, Workspace and Branch chips** (PROJ-078..080), with worktree creation on first send. Also PROJ-074, the inline Connect GitHub, unless projects-app landed it.
- **Session screen:**
  - the floating composer over a maximized panel;
  - the session-edge "Open changes / Open files" strip, which flow 14 waits on.
- **Shell:** the phone surfaces (SHELL-951..).
- **Panel and palette:**
  - recent files in the palette: v1 shows the session's file tabs, active first, deduped, so the panel needs a `filePaths()` accessor that owns that order;
  - the panel's "+" → File;
  - v1's `review.toggle` (⌘⇧R).
- **Editing files with Pierre.** The owner asked for it, and no server write route exists yet.
- **Flows not yet written:** 17–25, 28, 32, 34–36. The signed flows need the self-hosted Node signed fixture.
- **Stopped lanes with WIP:** live plugins, hosted projects on D1, the checks lane.

## Deletion candidates

**The dead revert path.** No harness declares `revert`, v2 passes no `actions` to MessageTimeline, and v1 never renders these (DECISIONS 23:55). Delete the whole list together, or bring it back together with a harness that declares revert. Line numbers are as of 27781bb17e.
- `src/transcript/message-part.tsx`:
  - 205-211: `UserActions.revert` and `fork`. `openAttachment` in the same type is live and stays.
  - 1213-1224: the `revert()` handler.
  - 1329-1344: the "Revert message" button.
- `src/session/view/timeline/message-timeline.tsx`: 1185, 1289-1296 (`undoTurn`), 1303.
- `src/session/view/timeline/message-timeline-turn-rows.tsx`: 87, 99-105 and 119-133 (the "Undo" button).
- `src/session/view/timeline/message-timeline-props.ts:9` and `timeline-user-message.tsx:10,16`: the `actions` prop.
- The i18n keys `ui.message.revertMessage` and `transcript.message.revertMessage`. Check dynamic key readers first.

**`src/legacy`,** 153k lines: v1's copy, the porting source. Delete it when nothing is left to port.

## Next steps, in order

1. **Merge each lane's final commits and verify every owner bug on 4480**, on the owner's own session, against the same session on 4481.
2. **The owner tests 4480 against 4481.** Each difference becomes an inventory row or a DECISIONS line.
3. **One kit** (see [Easy code](#3-easy-code)). This is the largest single cut in both lines and concepts.
4. **Checks to zero, domain by domain, composer first.**
   - Split files by responsibility; never squeeze lines.
   - Transcript comments get triaged into corpus cases before they're stripped.
5. **Refresh the inventory status** with `bun run e2e:parity`, so the spec says what's actually left.
6. **Port the deferred surfaces** from `src/legacy` with the same method.
7. **Delete `src/legacy`.**
8. **Benchmark.** Move the driver, then run the verdict three times on packaged builds.
9. **Make the flows robust:** 20 local runs per spec, 3 CI repeats, and the coverage map against v1's 58 specs.
10. **P6 "Ready for you"**, then the owner's test, then the swap (plan § P6). Never swap without the owner's approval.

## Lanes at the stop

At 20:30 the owner said to wrap up. Each running lane was given its last items, told to commit each one, report, and stop:

| Lane (agent) | Last items |
| --- | --- |
| shell (`lane-shell-4`) | terminals in the rail, then the account card |
| session-screen (`lane-session-screen-3`) | the draft route, the question dock, the todo dock |
| transcript (`lane-transcript-3`) | subagents in their turn, the subagent panel tab, the ascending-messageId default in `e2e/harness/api.ts` (flow 11's flake cause), the ratchet fixture |
| projects-app (`lane-projects-app-3`) | project order and dimming; PROJ-074 only if small |
| harness (`lane-harness-3`) | commit, send the v2 run table, stop |

Every other lane is stopped: adapter, session-data, kit, tools, settings-access, plugins, checks, server-projects, live-plugins, bench.

**How a lane's work was merged:** `integrate.sh <lane>`, run in the integration worktree.
1. `git merge --no-ff v2/<lane>`; a conflict aborts it.
2. `bun install` if a manifest or lockfile changed.
3. `typecheck`, `typecheck:e2e` and `build` in `packages/claxedo-app-v2`. Any failure undoes the merge with `reset --hard` to the pre-merge commit.
4. A list of files the merge changed outside the lane's folders. That list caught one lane's merge silently reverting another lane's change.

## Lessons from this run

- **Usage is the bottleneck, not parallelism.**
  - 16 concurrent Fable agents used the whole 5-hour window in about 40 minutes.
  - 6 to 10 Opus agents used a window in about 3.5 hours.
  - Run at most 5 lanes.
- **Messaging a stopped agent resumes it.** Keep the list of names that may be messaged exact.
- **Never kill processes by name or pattern.** One lane took down the owner's test servers that way, and another lane quit Chrome.
- **Don't stop a background task unless you started it.** The task list shows teammates' tasks too.
- **Restart the daemon after server changes.** The app guards wire shapes strictly, so an old daemon empties lists instead of erroring.
- **Merges silently revert.** Read the outside-folders report after every merge.
- **Green is a claim.** A flow that passes on v2 alone proves nothing about parity. Every baseline flow is written v1-first and must pass on v1 before it judges v2. It branches only for an approved deviation, titled with its DECISIONS entry.
