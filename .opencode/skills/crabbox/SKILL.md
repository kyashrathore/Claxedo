---
name: crabbox
description: Run commands and tests on remote Hetzner boxes via Crabbox. Use when running remote tests, needing a clean Linux environment, or when .crabbox.yaml / script/cbx are present.
---

# Crabbox (Hetzner)

Always use the repo wrapper — it loads `HETZNER_TOKEN` from
`packages/claxedo-server/.env` and pins the image (`CRABBOX_HETZNER_IMAGE`, not
settable in `.crabbox.yaml`).

```bash
./script/cbx doctor          # verify token + provider access
./script/cbx list            # live boxes and slugs
```

`list` may show boxes you did not create (leases are `keep=true`). Don't adopt or
stop someone else's — warm your own `--slug`. Boxes bill continuously (~€0.21/h on
cpx62); `stop` yours rather than waiting out the 45m idle timeout.

## Warm once, reuse many

`crabbox run` alone provisions a NEW box and deletes it after the command. Never
use it for iterative work.

```bash
./script/cbx warmup --type cpx62 --slug ci        # ~50s; prints slug
./script/cbx run --id ci -- bun install --frozen-lockfile
./script/cbx run --id ci --no-sync -- <cmd>       # 2-4s round trip
./script/cbx stop ci
```

If `run --id` says the lease is unclaimed, add `--reclaim` once.

**ALWAYS `--frozen-lockfile`.** A transient install failure once made bun re-save a
broken lockfile; later installs silently skipped 310 packages and e2e failed with
"Cannot find module".

## Two things that break every run

**1. `umask` is 0002; tests need 022.** The image's bake writes to `~/.bashrc`,
which Ubuntu skips for non-interactive shells — so it has never worked (verified on
image 412360550: `0002` in both `bash -c` and `bash -lc`). Without the fix,
`opencode`'s `tool.write > file permissions` fails on every run — not flake, not a
regression. `script/cbx-rebake` now bakes it via `/etc/login.defs` + `pam_umask` +
`BASH_ENV`, but that only lands after a rebake. Until then:

```bash
./script/cbx run --id ci --no-sync -- bash -c 'umask 022; <cmd>'
```

**2. `.env.local` never syncs.** Sync carries tracked files + the dirty delta;
gitignored files don't transfer. Missing `VITE_AUTH_ENABLED=true` fails exactly
three e2e tests — `core-settings-auth.spec.ts:1001`, `:1012`, `:2065`. Environment,
not code. Pass the vars inline or `scp` the file once per lease. **Check this first
when a remote failure doesn't reproduce locally.**

## Running the test gate

```bash
./script/cbx run --id ci --no-sync -- bash -c 'umask 022; CI=1 bun turbo test --concurrency=14 --continue'
./script/cbx run --id ci --no-sync -- bash -c 'umask 022; CI=1 bun turbo build --concurrency=14'   # exits 1 on opencode#build; harmless
./script/cbx run --id ci --no-sync -- bash -c 'umask 022; cd packages/claxedo-app &&
  VITE_AUTH_ENABLED=true CI=1 bun run test:e2e:core:base -- --workers=8'
```

### `--concurrency` is the wrong lever

`turbo test --concurrency=14` took **8m26s — of which `opencode#test` alone was
8m15s** (3137 tests / 244 files). Everything else finished in 40s and idled. Turbo
splits across packages; `opencode#test` is ONE task running `bun test` serially.
Neither concurrency nor a bigger box moves it.

### Shard inside opencode: 494s → 91s

```bash
./script/cbx run --id u1 --no-sync -- bash -c '
umask 022
cd packages/opencode
mapfile -t F < <(find . -name "*.test.ts" -not -path "./node_modules/*" | sort)
N=8
for i in $(seq 0 $((N-1))); do
  ( printf "%s\n" "${F[@]}" | awk -v i=$i -v n=$N "NR % n == i" | xargs bun test --timeout 30000 > /tmp/shard$i.log 2>&1 ) &
done
wait
grep -hE "^ *[0-9]+ (pass|fail)" /tmp/shard*.log | awk "{a[\$2]+=\$1} END {for (k in a) print k, a[k]}"
'
```

91s wall, 3086 pass. Shards finish unevenly — the split is round-robin by file
index, not duration; a duration-weighted split would cut the tail.

### e2e does not scale with workers

| where | workers | wall |
|---|---:|---:|
| local macOS | 1 | 21m |
| cpx62 (16 vCPU) | 8 | 13m32s |

8x workers bought 1.6x — the suite is dominated by fixed per-test waits (poll
intervals, SSE settle windows, timeouts), not CPU. **More workers on one box will
not speed it up.** The only thing that scales is Playwright `--shard=i/N` across
separate concurrent boxes, then merging results. `--workers=14` also adds ~3% load
flakes; use 8 for a trustworthy gate.

## Timings (cpx62 / 16 vCPU, image 412360550, 2026-07-25)

| step | time |
|---|---|
| `warmup --type cpx62` | 47-58s |
| first sync + `bun install` | 37-56s (sync 30-49s; install itself ~6s) |
| `run --no-sync` round trip | 2-4s |
| `turbo test --concurrency=14` | 8m26s (→ ~91s if opencode is sharded) |
| e2e core, 281 tests, workers=8 | 13m32s |

Fixed overhead is ~90-110s per cold box. Keep boxes warm for fast loops.

## Config and image notes

- Config keys are version-specific and silently ignored when wrong. Valid for
  v0.40: `serverType`, `keep`, `ttl` (Go duration), `idleTimeout`. NOT `type`,
  NOT `ttl_minutes`, NOT top-level `image`.
- `--type` overrides `serverType` per lease. Realistic ceiling is `cpx62`
  (16 vCPU, ~€0.21/h); dedicated `ccx*` get quota-rejected and fall back.
- Never run tests from the repo root — per-package dirs only.
- Repo-wide `turbo typecheck` has pre-existing fork-delta gaps
  (@opencode-ai/cli, workspace-runtime) — not part of the test gate.

## Rebaking

```bash
./script/cbx-rebake [--delete-old]
```

Boots a temp box, refreshes apt + toolchain + bun/playwright caches, snapshots it,
and repoints `script/cbx` at the new image.

**Rebaking does not make runs faster.** Only the ~6s install is bakeable and it is
already warm via the baked bun cache; the workdir is wiped to keep the image lean,
so `node_modules` isn't baked (it would save ~6s and go stale on every lockfile
change). Sync dominates and is your local diff — no image can remove it.

Rebake only for toolchain/apt drift, a new Playwright version, or a fix to the
box environment itself. **Never bake secrets** — images are frozen and shared
across all future leases. Snapshots bill by size, so pass `--delete-old` unless you
want a rollback target.

**Verify what you baked actually took** — the umask bake sat broken precisely
because nobody checked:

```bash
./script/cbx run --id <slug> --no-sync -- bash -c 'umask'    # expect 0022
./script/cbx run --id <slug> --no-sync -- bash -lc 'umask'   # expect 0022
```
