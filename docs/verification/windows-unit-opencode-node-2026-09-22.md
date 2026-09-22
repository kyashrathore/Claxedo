# Windows unit leg — embedded OpenCode on the Node runtime

Date: 2026-09-22. Status: the failing step is fixed and green on GitHub's own
Windows runner; the leg's remaining red is inventoried below and is not caused
by this step.

Failing run: [CI suite / unit (windows), run 35733420762](https://github.com/kyashrathore/Claxedo/actions/runs/35733420762)
at `244185c1a4`, step "Verify embedded OpenCode on the Node runtime"
(`bun run --cwd packages/workspace-runtime test:opencode-node`):

```
{"ok":true,"node":"24.20.0","electron":null}
Assertion failed: !_wcsnicmp(filename, dir, dirlen), file src\win\fs-event.c, line 72
error: script "test:opencode-node" exited with code 9
```

The SDK smoke passes; the host smoke (`scripts/node-host-smoke.mjs`) aborts
about 2.5 s in. Fix commit: `9f27bf448a`.

## 1. Cause

1. `node-host-smoke.mjs` creates its root with `fs.mkdtempSync(os.tmpdir())`
   and points `HOME`, `XDG_CONFIG_HOME` and `WORKSPACE_RUNTIME_DIRECTORY` at
   it. On GitHub's Windows runner `%TEMP%` is
   `C:\Users\RUNNER~1\AppData\Local\Temp`, an 8.3 spelling of
   `C:\Users\runneradmin\...`.
2. On the first prompt the engine's instruction plugin subscribes to
   `AGENTS.md` in the workspace root and in `XDG_CONFIG_HOME/opencode`. In the
   Node runtime a file subscription is `fs.watch(path.dirname(target),
   { recursive: false })` (`@opencode-ai/core` `dist/chunks/state-ns0sdez7.js`,
   `nativeLayer`). Directory subscriptions go through `@parcel/watcher` and do
   not touch libuv.
3. libuv 1.52.1 `src/win/fs-event.c`: for a directory watch `handle->dirw` is
   the path exactly as given. Each reported change is built as `dirw\name`,
   passed through `GetLongPathNameW`, and `uv__relative_path` asserts that the
   result still starts with `dirw`. `C:\Users\runneradmin\...` does not start
   with `C:\Users\RUNNER~1\...`, so the first change inside a watched
   directory aborts the process. Exit code 9 is the CRT abort. Which write
   lands first was not identified and does not matter: the host writes into
   that root continuously.
4. Node 24.21.0 floats a libuv patch (`deps/uv/src/win/fs-event.c`:
   `uv__relative_path` returns -1 and the reported name is used instead);
   `process.versions.uv` reads 1.52.1 in both builds. Node 24.20.0, which
   `actions/setup-node` with `node-version: "24"` resolved for this run, and
   Electron 43.2.0's Node 24.18.0 carry the assert. The desktop app on Windows
   is therefore exposed to the same abort wherever a watched directory is
   handed to the engine under a short spelling.

## 2. Change

- `patches/@opencode-ai%2Fcore@0.0.0-beta-18684.patch`: the file branch of
  `nativeLayer.subscribe` watches `realpathSync.native(dirname)` on win32
  (`GetFinalPathNameByHandle`, long spelling) and matches the reported name
  against `path.basename(target)` instead of re-joining it onto the directory
  string. POSIX behaviour is unchanged. The patch was regenerated against the
  pristine chunk and reverses/reapplies cleanly
  (`bun script/apply-dependency-patches.ts` reports it applied in 1 copy).
- `packages/workspace-runtime/scripts/node-host-smoke.mjs`: on win32 the smoke
  sets `TEMP`/`TMP` to cmd's `%~s` spelling of `os.tmpdir()` before creating
  its root, and prints the root in its JSON line, so the runner's quirk is
  exercised on any Windows volume that keeps 8.3 names and the log shows which
  spelling ran.
- `script/cbx-ci-windows.ps1`: the `unit` lane runs `test:opencode-node`
  between `build:packages` and `bun turbo test`, as `test.yml` does; new lane
  `opencode-node` stops after that step; switches `-CleanInstall` (a changed
  dependency patch cannot be re-applied over an installed tree), `-NodeVersion`
  (replay the build a run printed) and `-Continue` (turbo past the first
  failing package). `.crabbox.yaml` gains `focus-opencode-node-windows`;
  `script/cbx-ci.ts` lists it. `script/cbx-prepare-windows.ps1` takes
  `-NodeVersion`; the default stays `latest-v24.x`.
- `packages/claxedo-desktop/scripts/windows-ci-contract.test.ts` (`94f99923e6`):
  nothing enforced that the crabbox lane ran the workflow's steps, which is why
  the lane could not reproduce this failure at all before. Removing the command
  from either file now fails that test; checked by deleting it from the lane and
  watching the test go red.

## 2b. The same hazard in first-party code

`fs.watch` on an unresolved directory is not unique to the engine. Three
first-party sites watch a directory on Windows:

| Site | Path it watches | Exposed |
|---|---|---|
| `packages/workspace-runtime/src/managed-processes/manager.ts` | `path.dirname(cfgPath(directory))`, and `cfgPath` calls `realDirectoryPath` | no |
| `packages/workspace-runtime/src/routes/document-hydration.ts` | `path.dirname(document.path)`, never resolved | yes |
| `packages/claxedo-server-core/src/documents/session-hydration.ts` | `hydrated.directory`; `fs.realpath` is called nearby but only for a containment check, and the unresolved string is what is watched | yes |

`packages/workspace-runtime/src/real-directory.ts` already owns the guard
(`realDirectoryPath`). The two exposed sites were not changed here: they need
their own Windows reproduction, and the server-core site would have to reach a
helper that currently lives in another package, which is an architecture-ratchet
question rather than part of this fix. Electron 43.2.0 ships Node 24.18.0, which
carries the assert, so this is a shipped-app exposure and not only a CI one.

## 3. Measurements

All on one AWS `m7i.2xlarge` Windows lease (`cbx_ef0394432f6b`, Windows Server
build 20348, 8.3 names enabled on `C:`, `%TEMP%` =
`C:\Users\crabbox.EC2AMAZ-1R8HFM5\AppData\Local\Temp`), run from this
worktree with `./script/cbx run --provider aws --target windows --arch amd64
--id cbx_ef0394432f6b -- powershell.exe -NoProfile -ExecutionPolicy Bypass
-File script/cbx-ci-windows.ps1 ...`. That is the command `.crabbox.yaml`
gives `pr-unit-windows`; passing `--id` reuses one warm lease across the runs
below instead of provisioning a box per run, which `script/cbx-ci.ts run
pr-unit-windows` would do.

| # | Engine | Node | Smoke root | `-Lane` | Result |
|---|---|---|---|---|---|
| 1 | original | 24.21.0 (latest-v24.x) | every component short (`C:\Users\CRABBO~1.EC2\...\CLAXED~2`) | opencode-node | pass — did not reproduce |
| 2 | original | 24.21.0 | short `%TEMP%`, long leaf (runner shape) | opencode-node | pass — did not reproduce |
| 3 | probe: raw `fs.watch` on a short dir, write a file | 24.21.0 | — | — | events delivered, no abort |
| 4 | probe: `GetLongPathNameW` via python ctypes | — | — | — | expands `CRABBO~1.EC2` to the long name, with and without `\\?\` |
| 5 | original | **24.20.0** (`-NodeVersion 24.20.0`) | runner shape | opencode-node | **`Assertion failed: !_wcsnicmp(filename, dir, dirlen), file src\win\fs-event.c, line 72`, exit code 9** — the CI failure |
| 6 | fixed | 24.20.0, `-CleanInstall` | runner shape | unit | `test:opencode-node` passes: `{"ok":true,"node":"24.20.0","electron":null,"root":"C:\\Users\\CRABBO~1.EC2\\AppData\\Local\\Temp\\claxedo-node-host-RlkcEK"}`; `bun turbo test` then fails in `@claxedo/host-connector` (section 4) |

Confirmed on the real runner, not only on the box.
[Run 35744230704](https://github.com/kyashrathore/Claxedo/actions/runs/35744230704)
(`21a7d773d3`, the first CI run carrying the fix) reports the step as
**success**, and its log line is the short-path root on the Node build that
aborted:

```
{"ok":true,"node":"24.20.0","electron":null,"root":"C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\claxedo-node-host-KG1aug"}
```

That job still fails overall, now in `@claxedo/desktop` (`bun run test`
exited 3), which is section 4's inventory rather than this step.

Rows 1–4 are why the box could not reproduce for the first hour: rows 3 and 4
show the mechanism is real on the box, and the diff between Node's vendored
`deps/uv/src/win/fs-event.c` at `v24.20.0` and `v24.21.0` shows the floated
fallback. Pinning the runner's build (row 5) reproduced the exact assertion.

Local, macOS (Node 26.8.1): `bun run test:opencode-node` passes before and
after; `@claxedo/workspace-runtime`'s own `bun run test` passes end to end;
`packages/claxedo-desktop` `bun test scripts/windows-ci-contract.test.ts`
7 pass; `bun test scripts/stage-opencode-patches.test.ts scripts/stage-opencode-sdk.test.ts`
3 pass; `bun run test:ci-policy` 16 pass; oxlint clean on the edited files.

## 4. What is still red in the Windows leg

Row 6 continued into `bun turbo test --concurrency=2`, which stopped at the
first failing package with 22 of 27 packages unrun. The inventory run below
used `-Continue` so every package reports.

`test.yml` has since split the unit job into a `server` lane and a `rest`
lane (`327102c6ef`), and the embedded-OpenCode step runs in `rest`. The
crabbox lane still runs one `bun turbo test` over everything, so the list
below covers both.

Run: same lease, `-Lane unit -NodeVersion 24.20.0 -Continue`, 1 h 26 m. Twelve
packages fail. Counts are that run's; "failing" is failing tests over tests run.

| Package | Failing | Representative cause |
|---|---|---|
| `@claxedo/workspace-runtime` | 75 / 1530 | execute-permission repair, asar-to-unpacked mapping, PTY process groups, ACP stdio restart, git worktree listing |
| `@claxedo/agent-sdk-runtime` | 70 / 1065 | `pi:install` exits 9, so every Pi native integration test errors |
| `@claxedo/local-server` | 33 / 796 | owner-only file modes, narrowed permissions, git worktree paths, Tasks composition |
| `@claxedo/cli` | 20 / 129 | systemd/LaunchAgent service units and the `claxedo connect` lifecycle around them |
| `@claxedo/server` | 16 / 3233 | mode-0600 secret bundles, Workerd deployment spikes, route-ownership and boundary governance |
| `@claxedo/app` | 3 / 5982 | import-contract, stylesheet-reach and screen-walk checks that compare path strings |
| `@claxedo/host-connector` | 3 / 259 | POSIX mode bits (`expected 438 to be 448`, `0o700` on a directory) and symlink roots that resolve differently |
| `@claxedo/server-core` | 2 / 1082, plus one suite | `EBUSY ... unlink claxedo.db` tears down `tasks-host/sqlite-store`; `SIGTERM` where `SIGKILL` is expected; executable bits read as `+0` |
| `@claxedo/mcp` | 1 / 206 | spawning a real process through the runtime's process routes |
| `@opencode-ai/ui` | 1 / 122 | `new URL(".", import.meta.url).pathname` yields `/C:/...` in the provider-icon sprite test |
| `@claxedo/desktop` | suite aborts, exit 3 | Bun 1.3.14 panic: `Expected pretty file path to have only forward slashes` on a `C:\...` path |
| `@claxedo/workspace-relay` | suite killed, exit 124 | ran past `scripts/test-deadline.mjs`'s 600 s budget on both the first attempt and the retry |

Turbo's own `Failed:` line names ten of these; `@opencode-ai/ui` and
`@claxedo/workspace-runtime` also exited non-zero and are counted here from
their own exit codes.

Packages that passed include `sandbox-contract`, `tasks`, `agent-event-runtime`,
`opencode-server-adapter`, `helpers`, `storybook` and `session-ui`.

None of these is the embedded-Node step. `@claxedo/workspace-runtime` is the
one package this change touches, so its 75 failures were measured against a
baseline rather than assumed: the same package suite was run on the same box against the **unpatched**
engine (clean install, engine chunk confirmed to carry no fix marker) and
failed 75 of 1530 as well. 74 of the 75 test names are identical. The two that
differ are one each way: the unpatched run additionally failed the SDK boundary
guard, and the patched run additionally failed a `GitWorktreeRoutes log`
listing. Neither touches a file watcher, and the runs differ in other ways —
the patched one ran inside the full 30-package turbo run, the baseline alone
after a clean install. `@claxedo/workspace-runtime#test` cannot be isolated
through turbo (`turbo.json` makes it depend on `@claxedo/server#test` and
`@claxedo/app#test`), so the baseline invoked `bun run --cwd
packages/workspace-runtime test` directly.

The rest are POSIX permission semantics, process signalling, a Bun panic, a
hanging relay suite and the Pi installer on Windows — a separate body of work.
The deploy-staging gate therefore stays on `linux-unit-only`
(`docs/deploy/staging-branch.md`) until this list and the e2e shards are green.
