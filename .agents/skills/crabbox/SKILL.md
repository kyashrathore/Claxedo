---
name: crabbox
description: "Run this repository's GitHub-equivalent CI checks on Crabbox, rerun only failed lanes, reuse a clean lease while fixing failures, and verify native platform gates before pushing. Use whenever validation, CI reproduction, remote compute, clean-environment testing, or a pre-push confidence check is requested in this repository."
license: MIT
---

# Crabbox CI

Use the repository entrypoints. `.crabbox.yaml` owns lease routing and named
jobs; `script/cbx-ci.ts` owns grouping, bounded parallelism, result persistence,
and failure-only retries; platform scripts own the commands run on each box.

## Start safely

Run these before provisioning capacity:

```sh
./script/cbx doctor
./script/cbx-ci.ts list
./script/cbx-ci.ts dry-run pr-linux
```

`script/cbx` loads the repository's configured Crabbox credentials and pinned
Hetzner snapshot. It also downloads and checksum-verifies the tested Crabbox
0.40 CLI into `.crabbox/bin`; a global Crabbox upgrade therefore cannot change
CI behavior. Set `CRABBOX_BIN` only when deliberately validating a candidate
CLI release. Do not call bare `crabbox` for this repository unless you have
deliberately supplied the same environment.

Dry-run prints the exact lease and command plan and spends no cloud capacity.
Inspect unexpected provider, target, architecture, server type, or command
changes before a real run.

## Run CI

Run all Linux PR jobs with up to twelve boxes in parallel:

```sh
./script/cbx-ci.ts run pr-linux
```

Linux named jobs use Hetzner by default. The runner cap is twelve concurrent
jobs and is independent of provider capacity. If Hetzner cannot provision the
matrix, route the same commands explicitly to the configured AWS matrix:

```sh
./script/cbx-ci.ts run pr-linux-aws
```

Do not route a product or test failure to AWS as though it were a capacity
failure. Use the AWS matrix only when provisioning capacity is the blocker, or
when AWS Linux itself is the platform under test.

Run one lane while fixing it:

```sh
./script/cbx-ci.ts run pr-unit-linux
```

When the Windows umbrella lane has already identified one failing package, use
the configured focused package job before paying to rerun every package:

```sh
./script/cbx-ci.ts run focus-agent-sdk-runtime-windows
./script/cbx-ci.ts run focus-server-core-windows
```

Focused jobs are diagnostic subsets, not substitutes for their blocking PR
lanes. After the package passes, rerun `pr-unit-windows` to prove the complete
matrix and catch failures that the earlier umbrella run never reached.

Reuse an existing clean lease for a fast edit/test loop. Supplying a lease
forces sequential execution so two jobs never mutate the same worktree at once:

```sh
./script/cbx-ci.ts run --id <slug> pr-unit-linux pr-typecheck-linux
```

The repository sets `sync.delete: false`. This is required for warm native
Windows leases because Node and native addons can keep installed files open;
recursive sync deletion would fail before the test command starts. Normal
`run` performs an overlay sync. Add `--no-sync` only for repeated commands
after a successful sync. Use `./script/cbx run --id <slug> --sync-only` when
only a sync is needed. `sync.gitSeed: true` and `sync.baseRef: dev` seed the
canonical public branch before the dirty-tree overlay when the transport
supports seeding. Native Windows manifest sync can omit `.git`, so
`script/cbx-prepare-windows.ps1` independently hydrates the same public `dev`
commit before dependency installation; policy checks therefore use a real Git
index rather than a synthesized manifest. Overlay sync deliberately retains
remote files that were deleted locally: after deleting or renaming a source or
generated file, use a new lease or `--fresh-sync` before treating the result as
authoritative.

After a grouped run, rerun only its failures:

```sh
./script/cbx-ci.ts retry
```

The last result is stored at `.crabbox/ci/last-run.json`, which is ignored by
Git. Do not hand-edit the file or turn a failed result green without rerunning
the named job.

## Native platform contract

Linux does not prove Windows or macOS behavior.

- `pr-unit-windows` and `pr-agent-runtime-stats-windows` provision AWS native-
  Windows boxes and execute
  `script/cbx-ci-windows.ps1`. AWS credentials and quota must be configured in
  trusted user state, not committed to the repository. Keep an AWS instance
  type on each Windows job: repo-level scalar defaults are inherited, and the
  Hetzner `cpx42` default is not a valid EC2 instance type.
- `pr-e2e-desktop-macos` and `pr-agent-runtime-stats-macos` use native AWS Mac
  hosts (`mac2.metal`, ARM64). Leave their `architecture` override null:
  `mac2.metal` selects ARM64 itself, while Crabbox's explicit `arm64` selector
  is for Linux ARM capacity and is rejected for macOS. AWS credentials and
  `CRABBOX_HOST_ID` (or `aws.macHostId`) for a preallocated host must be
  configured in trusted user state. The account also needs a nonzero “Running
  Dedicated mac2 Hosts” quota before allocating that host. AWS
  Mac hosts have a platform-mandated minimum allocation period, so run only the
  unproven or failed macOS lane instead of repeating a green one. The
  orchestrator serializes macOS jobs so they cannot mutate one durable host
  worktree concurrently.

Preview both native jobs with:

```sh
./script/cbx-ci.ts dry-run pr-native
```

Run the entire platform set only when both providers are ready:

```sh
./script/cbx-ci.ts run pr
```

Never claim the full GitHub matrix is preflighted when only `pr-linux` ran.
When a change can affect Windows process handling, paths, packaging, or native
dependencies, run `pr-unit-windows`. When it can affect Electron packaging,
`file://` rendering, desktop startup, embedded execution, or Host Connector
lifecycle, run `pr-e2e-desktop-macos`.

## Historical triage order

Recent GitHub history makes these the expensive lanes. Use this order when
several jobs fail, while still fixing the first authoritative failure inside
each lane:

1. `pr-unit-windows`: native filesystem semantics (`EPERM`/`fsync`, path and
   state-file `ENOENT`), embedded-module resolution, and deadline kills have
   historically made this the largest source of failed runner time.
2. `pr-unit-linux`: this umbrella lane can fail late in documentation guards,
   product closures, isolated production builds, or the full unit matrix.
3. Packaged macOS lifecycle: distinguish an app stuck on `loading.html`, a
   signed-cloud dependency failure, and teardown/process-lifecycle failure.
4. Stateful browser E2E: inspect traces and the authoritative server log for
   missing UI state or a dead local server; do not treat a longer locator
   timeout as a diagnosis.
5. Tier-real and WorkGraph: preserve harness settlement, connection ownership,
   and multi-process state evidence when reproducing.

## Failure workflow

1. Read the first authoritative product/test failure in that named job. Do not
   repair it with fallback or synthesized events.
2. If sync or installed state is suspect, stop the lease and reproduce on a
   fresh box. Do not debug product behavior on a corrupted reused box.
3. Fix the canonical producer or contract locally.
4. Rerun the one failed job, preferably on the same known-clean lease.
5. When it passes, use `retry` to clear the remaining failed set.
6. Before pushing, run the relevant group and report exactly which native jobs
   were or were not executed.

Crabbox job runs created without `--id` use `stop: auto`, so their leases are
released on completion. A caller-supplied lease remains available for the
interactive loop; stop it explicitly when finished:

The failure digest can still print a rerun command containing the released
slug. That command is usable only when the run started from a caller-supplied
lease; after an auto-stop named job, provision or supply a new lease instead.

```sh
./script/cbx stop <slug>
```
