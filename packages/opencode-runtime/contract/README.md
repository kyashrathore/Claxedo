# Public OpenCode SDK contract probes

Executable form of `docs/architecture/opencode-embedded-sdk-contract.md`. Each
assertion names the doc section it defends.

## Why this is not a workspace package

The repo's `packages/*` workspace glob matches one level, so
`packages/opencode-runtime/contract/` is deliberately **outside** the workspace.
That keeps the probe's installation and lockfile independent, ensuring it
characterizes the exact published SDK rather than any repository dependency.

Install and run it on its own:

```sh
cd packages/opencode-runtime/contract
npm install
bun run probe.mjs        # full contract probe
node node-loadability.mjs # §2 Node import gate
```

## Node/Electron status — the §2 gate

`@opencode-ai/sdk@0.0.0-beta-18684` is not currently runnable in Claxedo's
Node/Electron process. It ships extensionless relative ESM specifiers
(`export * as OpenCode from "./opencode"`) that strict Node ESM cannot resolve.
Bundling gets past that packaging defect, but the Node-conditioned core graph
then imports `node:ffi`, which Node/Electron does not provide.

These probes separate the two failures:

```sh
bun run build-node-bundle.ts   # gets past extensionless ESM packaging
node probe-node.mjs            # exposes the remaining Node runtime failure
```

The non-obvious bundling ingredient is the `jsonc-parser` resolve plugin, lifted
from `claxedo-desktop/scripts/bundle-claxedo-server.ts`. jsonc-parser's
default entry is UMD and hides its relative requires inside a factory closure,
so they survive bundling as a runtime `require("./impl/format")` that resolves
nowhere. Pointing the bundler at the ESM entry inlines it cleanly.

This bundle is a diagnostic probe, not a production workaround. Claxedo does
not package Bun, spawn a Bun sidecar, deep-import private SDK internals, or fall
back to the removed engine. Desktop enablement remains gated on an upstream SDK
release whose public Node entry loads under Electron and supplies its required
PTY implementation.

The SDK uses **`node:sqlite`** on the Node condition, not `better-sqlite3`; once
the load blocker is fixed, packaged Electron still needs target-by-target
verification of that condition and the SDK's PTY path.

`node-loadability.mjs` still tracks whether _direct_ Node import works. It exits
0 either way by design — reporting a known blocker today and a resolved one if
upstream ever republishes with extensions — so it can sit in CI without being a
permanent red.

Do not resolve §2 by deep-importing `dist/internal/host` — that path physically
exists in the published tarball and does expose a raw `fetch`, which is exactly
what Decision 15 bans.

## What a failure means

`probe.mjs` exits non-zero when the pinned SDK drifts from the assumptions the
cutover plan is built on. That is a stop-and-re-plan signal against a later
exact beta, not something to paper over in Claxedo code.

Two assertions are worth calling out because they encode security posture
rather than mere shape:

- **`sessions.get` performs no location authorization.** Any session is
  readable by ID from any caller, and the response carries the owning
  workspace's directory. Claxedo's opaque workspace scope (Decision 13) is the
  only barrier — not defence-in-depth.
- **A nested `location` filter is silently ignored by `list()`.**
  `SessionListInput` takes a flat `directory`. Passing `{ location: { ... } }`
  looks like a scoped query and returns the host-global set. The typed port
  must make that shape unrepresentable.
