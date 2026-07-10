# `src/overrides/` — tombstone directory

This directory holds no production `.ts`/`.tsx` files and should stay that
way. It is a deliberate tombstone, not an oversight.

## Why this directory is empty

Before the hard fork (commit `00a533c2fb`, see the `project_hardfork_completion`
project memory), Claxedo was layered on top of a separate `packages/app`
package that vendored upstream OpenCode's web UI. `src/overrides/` used to
hold first-party replacement files for individual upstream `@/...` modules,
resolved by a dynamic override-scanning system, and this README used to
document each mapped override plus a `@opencode-ai/app` vs
`@opencode-ai/claxedo-app` import-resolution contract.

**That system no longer exists.** Verified as of this writing:

- `packages/app` does not exist anywhere in this monorepo (`ls packages/` at
  the repo root lists `claxedo-app`, `claxedo-server`, `claxedo-desktop`,
  `claxedo-web`, and the `@claxedo/*` internal packages — no `app`).
- `tsconfig.json`'s path map resolves **both** `"@/*"` and `"@claxedo/*"` to
  `["./src/*"]` (`packages/claxedo-app/tsconfig.json:21-25`) — there is no
  fallback to any `packages/app/src/*` location, and never a distinction
  between "overridden" vs "upstream" import paths.
- `vite.cloud.config.ts:103,120` aliases `@claxedo/` and `@/` to this
  package's own `./src/` directory directly, with a comment at line 119
  noting "upstream packages/app fully vendored; divorce plan 006".
- **Remaining debt, not yet cleaned up:** `vite.cloud.config.ts:117` still
  has a live `resolve.alias` entry pointing at
  `../app/node_modules/@solid-primitives/active-element/dist/index.js` — a
  relative path into the now-nonexistent `packages/app`. This is a stale
  alias left over from the pre-divorce setup; it is dead-code debt owned by
  the Wave 1 dead-code sweep, not evidence that `packages/app` still exists
  anywhere. Do not treat this file's "nothing left to override" claim below
  as "zero references to `packages/app` anywhere in the repo" — this one
  alias is the documented exception.
- `packages/claxedo-desktop/vite.renderer.ts:13` states explicitly:
  "Post-divorce (plan 006): the renderer resolves `@/` against claxedo-app,
  not packages/app."

In other words: every module this app imports via `@/...` or `@claxedo/...`
now resolves directly into `packages/claxedo-app/src/**`. There is nothing
left to "override" — the entire app is first-party, single-source-of-truth
source code (module resolution, not asset paths — see the dead
`vite.cloud.config.ts:117` alias above). There is no more upstream-diffing
workflow (`git diff upstream/dev -- packages/app/src/...`) — that command no
longer has a target.
`src/overrides/` and this file exist only so a contributor grepping for the
old override system, or reading stale docs elsewhere that still describe it,
lands on an explanation instead of a dead end.

## What to do instead

Put all Claxedo code directly under `packages/claxedo-app/src/**`, using the
directory charters in `../ARCHITECTURE.md` to pick a location. Do not add
production `.ts`/`.tsx` files to `src/overrides/` — there is no scanner left
that would pick them up, and doing so would silently produce dead code.

If you are trying to change behavior that used to live in an "override" per
old documentation you found elsewhere (an old `CONTRIBUTING.md` or this
file's previous revision mentioning `@/app`, `@/pages/layout`,
`@/context/global-sync`, a two-level "App scope vs Directory scope" context
architecture, or a `@opencode-ai/app` vs `@opencode-ai/claxedo-app` import
distinction), that behavior is not overridden anymore — it is simply
implemented directly at `src/app.tsx`, `src/pages/layout.tsx`,
`src/context/global-sync.tsx`, and so on. Edit those files directly, and use
plain `@/...` or `@claxedo/...` imports (they are equivalent, both resolve
to `./src/*`) — there is no "wrong" scope to accidentally import from
anymore.

## See also

`../ARCHITECTURE.md` for directory charters, `../VOCABULARY.md` for naming,
and `../../CONTRIBUTING.md` for the current (post-hard-fork) contribution
workflow.
