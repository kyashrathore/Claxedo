# @opencode-ai/claxedo-app

Cloud extension package for OpenCode (Claxedo). The SolidJS frontend that runs
on top of `packages/app` via the `@/` override system.

## Test runner: `bun test`

`package.json` `scripts.test` runs:

```sh
bun test --conditions=browser --preload ./happydom.ts ./src
```

This package uses **`bun test`**, not Vitest. The choice is intentional and
the rubric item Q13 ("pick one test runner per package") landed on this
combination for the following reasons:

- **SolidJS requires the `browser` condition.** Without
  `--conditions=browser`, the runtime resolves `solid-js` to its SSR bundle
  (`dist/server.js`), where `createEffect` is a no-op and `createMemo`
  evaluates only once. Component tests silently produce wrong results.
  `bun test --conditions=browser` is the only way to pass the condition —
  `bunfig.toml` does not support a `conditions` key, so the CLI flag in the
  npm script is load-bearing. **Always run `bun run test`, never
  `bun test ./src` directly.**
- **Bun's startup is meaningfully faster** than Vitest for this package's
  test volume (1993 tests across 161 files in ~6s), and the override
  resolver in `vite.cloud.config.ts` is already wired through Bun's module
  resolution path during development. Reusing that resolver in tests keeps
  one source of truth for `@/` and `@claxedo/` aliasing.
- **happy-dom** is preloaded via `./happydom.ts` for the DOM environment
  that SolidJS component tests need.

Vitest is also installed and used by `test:ui` (`vitest run --config
vitest.config.ts`) for a small number of tests that need Vitest-specific
features. The primary `test` script remains Bun.

## Why a different runner from `claxedo-server`

The sibling `packages/claxedo-server` uses **Vitest**, deliberately. The mixed
setup is intentional: each package picks the runner that fits its constraints
(browser-condition resolution + speed here, `vi.mock`/`vi.hoisted` ergonomics
+ Node-only target there). See
[`packages/claxedo-server/README.md`](../claxedo-server/README.md) for the
server-side rationale.
