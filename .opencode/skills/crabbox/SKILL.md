---
name: crabbox
description: Run commands and tests on remote Hetzner boxes via Crabbox. Use when running remote tests, needing a clean Linux environment, or when .crabbox.yaml / script/cbx are present.
---

# Crabbox (Hetzner)

Always use the repo wrapper — it loads `HETZNER_TOKEN` from
`packages/claxedo-server/.env` and pins the pre-baked snapshot image
(`CRABBOX_HETZNER_IMAGE`, not settable in `.crabbox.yaml`):

```bash
./script/cbx doctor          # verify token + provider access
./script/cbx list            # show live boxes and their slugs
```

## Workflow: warm once, reuse many

A plain `crabbox run` provisions a NEW box (~4 min from snapshot) and deletes
it after the command. Never use it for iterative work. Instead:

```bash
./script/cbx warmup                          # once per work session; prints slug
./script/cbx run --id <slug> -- bun test     # per-run: diff sync (~11s) + command
./script/cbx run --id <slug> --no-sync -- bun test   # ~4s when tree unchanged
./script/cbx stop <slug>                     # when done (else idleTimeout 45m / ttl 3h)
```

If `run --id <slug>` says the lease is unclaimed, add `--reclaim` once to adopt
it; afterwards plain `--id` works.

## Gotchas learned the hard way

- Config keys are version-specific and silently ignored when wrong. Valid for
  v0.40: `serverType`, `keep`, `ttl` (Go duration), `idleTimeout`. NOT `type`,
  NOT `ttl_minutes`, NOT top-level `image`.
- Booting from a Hetzner snapshot takes ~4 min (disk restore) — slower than the
  ~1 min stock-image boot. The snapshot only pays off because bun/node/rsync
  and the bun install cache are pre-baked. The real speedup is warm-box reuse,
  not fresh snapshot boots.
- Sync runs on every `run`. On a warm box it is incremental (git seed ~0.4s);
  only actually-changed files transfer. `.crabbox.yaml`/`.crabboxignore` are
  excluded from sync via `.crabboxignore` so they don't dirty the delta.
- Current snapshot: image ID `412228901` (ubuntu 24.04 + bun 1.3.14 +
  node 22 + python3 + warm bun cache). The older `412173922` snapshot is empty
  (no bun/node) — do not use it.

## Big machine for full CI suites

`--type` overrides the config's `serverType` for that lease:

```bash
./script/cbx warmup --type cpx62 --slug ci-beast        # 16 vCPU / 30 GB
./script/cbx run --id ci-beast -- bun install
./script/cbx run --id ci-beast -- bun turbo test --concurrency=16
./script/cbx stop ci-beast
```

- Realistic ceiling is `cpx62` (16 shared vCPU, ~€0.21/h). Dedicated `ccx43/53/63`
  get quota/capacity-rejected on this account — crabbox falls back down automatically.
- `bun turbo test` parallelizes across packages (default concurrency 10; raise
  with `--concurrency`). Never run tests from repo root — per-package dirs only.

## Rebaking the base image

Images are frozen forever; nothing on a box flows back. Rebake only when a cold
box's first `bun install` gets slow (lockfile drift) or the toolchain changes:

```bash
./script/cbx-rebake [--delete-old]
```

Boots a temp box, refreshes apt + bun cache, snapshots it, and updates the
image ID in `script/cbx` automatically. Repo code changes never need a rebake.

## Running the full test gate remotely

```bash
./script/cbx warmup --type cpx62 --slug ci
./script/cbx run --id ci -- bun install --frozen-lockfile
./script/cbx run --id ci --no-sync -- bash -c 'CI=1 bun turbo test --concurrency=14 --continue'
./script/cbx run --id ci --no-sync -- bash -c 'CI=1 bun turbo build --concurrency=14'   # e2e needs dist/
./script/cbx run --id ci --no-sync -- bash -c 'cd packages/claxedo-app && CI=1 bun run test:e2e:core:base -- --workers=14'
```

Measured on cpx62 (16 vCPU), v3 image (412360550): units ~2-8 min, e2e core
~10 min (279 tests), workgraph e2e ~5 min, diagnostics+perf ~1 min.

Hard-won facts:
- ALWAYS `bun install --frozen-lockfile` on boxes. A transient install failure
  once made bun re-save a broken lockfile; later installs silently skipped 310
  packages (e.g. better-sqlite3) and e2e failed with "Cannot find module".
- Box umask is 002; tests assume 022 (baked into v3 image bashrc).
- `--workers=14` e2e produces ~3% load flakes (all pass at `--workers=2`).
  For a strict gate use `--workers=8` or re-run failures.
- `opencode#build` fails on this fork (upstream script wants `packages/app`,
  which claxedo replaced). Unrelated to tests — opencode#test passes.
- Repo-wide `turbo typecheck` has pre-existing fork-delta gaps
  (@opencode-ai/cli, workspace-runtime) — not part of the CI test gate.
