# claxedo-cookbook

Eight runnable recipes, one capability each, ordered as a ladder: start at
recipe 01 (a working agent backend in ~15 essential lines) and climb to
relay-attached workspace placement. Every recipe is a single liftable file
under [`src/recipes/`](src/recipes/) that either completes with printed proof
or prints `SKIP: <reason>` — never a stack trace.

Docs with expected output per recipe: **[claxedo.com/framework](https://claxedo.com/framework/cookbook/overview)**
(Cookbook tab).

## Run

```bash
bun install         # builds + links the @claxedo/* packages from this monorepo checkout
bun run recipe:01-hello-agent
```

`bun install` runs a postinstall step (`scripts/link-local.mjs`) that links the
`@claxedo/*` packages from this monorepo's `packages/` directory. Those packages
ship `dist/` when published but not in a source checkout, so the first `bun
install` also builds any of the seven linked packages whose `dist/` is missing
(in dependency order) before symlinking them in — that first run takes longer
than a plain link; later runs are instant once `dist/` exists. Outside the repo
checkout, set `CLAXEDO_PACKAGES_ROOT=/path/to/opencode`.

Recipes 01–07 run under Node (`tsx`); recipe 08 runs under Bun because
`@claxedo/workspace-relay` requires `Bun.serve`.

This monorepo-checkout dance is only for running *this cookbook's* recipes
against local source. The `@claxedo/*` packages themselves are ordinary
published npm packages — to use one in your own project, `npm install
@claxedo/agent-sdk-runtime` (or any of the others) against the published
registry version works with no monorepo, no linking, and no local build.

## The ladder

| # | Recipe | Capability | The wow |
| --- | --- | --- | --- |
| 01 | `recipe:01-hello-agent` | `@claxedo/agent-sdk-runtime` facade | runtime → session → message → real model reply, ~15 essential lines |
| 02 | `recipe:02-harness-swap` | one facade, many vendors | the SAME `runOnce()` runs claude/codex/cursor — only the harness id string changes |
| 03 | `recipe:03-one-event-shape` | `@claxedo/agent-event-runtime` | claude-sdk and codex-app-server dialects normalize to one identical event envelope; errors become events |
| 04 | `recipe:04-kill-and-resume` | sqlite store durability | SIGKILL a process holding a live session; a fresh process recovers it from disk |
| 05 | `recipe:05-workspace-host` | `@claxedo/workspace-runtime` | one loopback host = files, search, git commits, diffs, managed processes, event stream — no agent needed |
| 06 | `recipe:06-extensions-once` | `@claxedo/agent-extensions` | author one extension package → materialized natively for opencode, claude, codex, and cursor |
| 07 | `recipe:07-sandbox-secrets` | `@claxedo/sandbox-manager` | the manager refuses to leak a brokered secret into a driver that cannot broker — fail-closed by design |
| 08 | `recipe:08-place-anywhere` | `@claxedo/workspace-relay` | the same `/api/wr/health` route served locally and through an authenticated relay; bypassing the relay gets 401 |

Run the whole ladder (each recipe passes or SKIPs with a reason):

```bash
bun run recipes:all
```

## What each recipe needs

- **01, 02, 04** talk to a real coding agent: they detect installed CLIs
  (`claude`, `codex`, `cursor-agent`, or their ACP binaries) plus credentials,
  run what is available, and SKIP the rest with the fix printed. See
  [`.env.example`](.env.example).
- **03, 05, 06** are fully deterministic — no agent, no network, no keys.
- **07** part 1 (the fail-closed refusal) needs nothing; part 2 provisions a
  real docker sandbox only when the sandbox image is already present locally.
- **08** needs Bun only.

All recipes work in fresh temp directories — never in your checkout.

## Operational safety

This is runnable example code, not a production deployment template. The live
recipes drive real agent CLIs with your local credentials and write transcript
text to stdout; treat captured output as potentially sensitive. Recipe 08
mints throwaway in-process keypairs — do not reuse its token wiring verbatim
without reading the relay deployment docs.

## What happened to the chat server + UI?

The previous cookbook (a production-shaped chat server with a React UI) was
removed in favor of this ladder; a composed capstone app will return in a
later iteration, built on these recipes. If you need the old code:
`git log -- claxedo-cookbook/src/claxedo-chat-server.ts`.
