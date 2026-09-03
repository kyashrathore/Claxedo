# Claxedo App

The web app for **Claxedo** — a cloud/hosted coding-agent platform built on the
[OpenCode](https://github.com/anomalyco/opencode) engine. This package
(`@claxedo/app`) is a **hard fork of OpenCode's web UI**: the fork
history was reset to a single commit and the code is developed as first-party
source, not synced via merge.

It is the SolidJS frontend and adds the features Claxedo is built around:

- **Terminal as a first-class tab** — a full xterm-backed terminal, not a side panel.
- **Multipane / split workbench** — drag/split/keyboard-driven panes and tabs.
- **Cloud-hosted workspaces** — provision and connect to remote workspace runtimes.
- **Multiple simultaneous connections** — several server/workspace connections at once.
- **Multi-harness agents** — model/harness selection per session.

It also **powers the Electron desktop app**: `packages/claxedo-desktop` consumes
this package (`@claxedo/app`) as its renderer.

Repo: `kyashrathore/Claxedo`. All frontend source lives under `src/**`; there is
no `packages/app` and no upstream override system (an earlier setup that
predates the fork) — `@/...` and `@claxedo/...` both resolve to `./src/*` and
are interchangeable. See `CONTRIBUTING.md` for the full history.

## Quickstart

From the repo root, install the workspace once:

```sh
bun install
```

The app needs a backend (the control plane) and the Vite dev server. Run them in
two terminals:

```sh
# 1. Backend / control plane — serves on http://127.0.0.1:2593
cd packages/claxedo-server
bun run dev

# 2. Web app — serves on http://localhost:4444
cd packages/claxedo-app
bun run dev
```

When the web server is up you'll see Vite print `VITE ... ready` with
`Local: http://localhost:4444/`; open that URL. The dev server proxies `/api`,
`/event`, and the other backend routes to `http://127.0.0.1:2593` by default.
Point it at a different backend with `VITE_CLAXEDO_SERVER_URL`, and override the
web port with `PORT` (default `4444`).

> The desktop shell is a separate package: `cd packages/claxedo-desktop && bun run dev`.

### Onboarding v1 preview

The onboarding v1 UI is build-time gated and disabled by default so normal UI
development keeps the existing Home/empty-state behavior. Enable it explicitly:

```sh
VITE_CLAXEDO_ONBOARDING_V1=true bun run dev
```

Its Playwright acceptance flow uses the same flag. Server-side credential,
repository, provisioning, and remote-access contracts remain available without
mounting the preview UI.

### Product UI flags

The following build-time UI entry points are disabled by default and accept the
literal value `true` to enable them:

| Environment variable | Entry points |
| --- | --- |
| `VITE_CLAXEDO_DOCUMENT_NAVIGATION_ENABLED` | Documents in the main rail and the top-level New Document action |
| `VITE_CLAXEDO_ACCOUNT_SIGN_IN_ENABLED` | Sign in in the bottom-left account menu |
| `VITE_CLAXEDO_SETTINGS_CONNECTIONS_ENABLED` | Settings → Connections |
| `VITE_CLAXEDO_SETTINGS_SANDBOX_PROVIDERS_ENABLED` | Settings → Sandbox Providers |

These switches hide navigation and configuration entry points only. They do not
replace the underlying permission checks or remove deep-linked surfaces.

## Tests

### Unit / component tests — `bun run test`

```sh
bun run test          # bun test --conditions=browser --preload ./happydom.ts ./src
```

The `--conditions=browser` flag is **load-bearing**: without it the runtime
resolves `solid-js` to its SSR bundle where `createEffect` is a no-op and
component tests silently produce wrong results. `bunfig.toml` cannot supply the
condition, so always use `bun run test` (never `bun test ./src` directly). The
full suite runs several thousand tests in roughly ~11s. `happy-dom` is preloaded
via `./happydom.ts` for the DOM environment.

To run a single file, pass the same flags:

```sh
bun test --conditions=browser --preload ./happydom.ts ./src/features/terminal/core/terminal-stream.test.ts
```

A small number of tests need Vitest features and run there instead:

```sh
bun run test:vitest   # vitest run --config vitest.config.ts
```

### Architecture guards — `bun run test:architecture`

```sh
bun run test:architecture   # bun test ./src/architecture
```

Fast structural-invariant suite (orphan modules, god-file size, directional
layering, single-writer query caches, retired-vocabulary, and more). See the
guard system section below.

### End-to-end (Playwright) — `bun run test:e2e:core`

```sh
bun run test:e2e:core       # CLAXEDO_E2E_SUITE=core playwright test
bun run test:e2e:mobile     # --project=mobile (375×812 core flows)
```

Both commands run every selected flow twice: first with the development Test
User, then as a loopback unsigned visitor with auth UI enabled and no synthetic
user. `CLAXEDO_E2E_AUTH_MODE=test-user|local-unsigned` selects one mode for a
direct `test:e2e:*:base` invocation. The matrix runner always attempts both
modes and all requested lane scripts before returning a non-zero aggregate
status, so an early Test User failure cannot hide unsigned coverage.

**Suite lanes.** `CLAXEDO_E2E_SUITE` selects specs *by tag* — a spec that carries
no lane tag is selected by no lane and silently never runs. The registry lives in
`playwright.config.ts` (`suiteGrep`); an unknown suite name throws rather than
falling through to "run everything".

| suite | tag | what it is |
| --- | --- | --- |
| `core` (**default**) | `@core` | Tier M — every route mocked, zero real network. The lane CI watches, sharded six-way per auth mode on every PR. |
| `live` | `@live` | Tier L — real `claxedo-server`, real agent binaries, real credentials. Not in CI (no credentials there). |
| `marketing` | `@marketing` | Screenshot capture tool; writes PNGs into `claxedo-web/public/screenshots`. Never in CI. |
| `all` | — | No filter, including lanes CI cannot run. |

The `@tier-real` and `@documents-*-canary` tags are sub-selectors *within* a
lane, not lanes: `test:e2e:core:base` carves `@tier-real` out of the sharded
lane with `--grep-invert`.
`src/architecture/e2e-suite-tags.guard.test.ts` fails if any spec carries no lane
tag, or carries an unregistered one (a `@cores` typo).

**Operational contract** (learned the hard way — the config and plan docs
enforce it):

- Run against `bun run dev`, **never** a `vite preview` production build —
  dev-only test seams get dead-code-eliminated from the prod bundle.
- `--workers=1` per suite (the `@core`/`all` suites already pin this).
- At most 2–3 concurrent Playwright suites machine-wide — more overloads the dev
  server.

The Playwright config auto-starts the dev server on port `4455`
(`PLAYWRIGHT_PORT`); set `PLAYWRIGHT_SKIP_WEBSERVER=1` to reuse one you started.
The E2E suites need a running backend and were **not executed as part of writing
this README** — they require the dev + backend setup above.

## The architecture-guard system

`src/architecture/` is a suite of structural fitness functions. The pattern is
one scanner rule per invariant, each paired with a `*-baseline.json` or
`*-allowlist.json` that records the currently-tolerated violations. New
violations fail CI; existing ones are **shrink-only** — they may be removed as
the underlying code is fixed but never added back, ratcheting the codebase's
debt toward zero. The directional-layering guard (`layering.ts` +
`layering-baseline.json`), god-file size ratchet, orphan-module detector, and
retired-vocabulary guard all live here. Run them with `bun run test:architecture`.

## Where to look next

- **`src/ARCHITECTURE.md`** — charter for every top-level directory in `src/`
  (what each owns and "where do I add X"), verified against the live tree.
- **`src/VOCABULARY.md`** — the canonical noun list. Read this before naming
  anything "workspace" — it has five distinct meanings in this codebase.
- **`CONTRIBUTING.md`** — the tests-as-specs standard, test-location
  conventions, and fork history.
- **`src/ui/controls/README.md`** — the admission rule for reusable UI
  primitives (`ui/`) vs feature-owned widgets.

## License

MIT.
