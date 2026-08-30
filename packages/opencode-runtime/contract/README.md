# Public OpenCode SDK contract probes

Executable form of `docs/architecture/opencode-embedded-sdk-contract.md`. Each
assertion names the doc section it defends.

## Why this is not a workspace package

The repo's `packages/*` workspace glob matches one level, so
`packages/opencode-runtime/contract/` is deliberately **outside** the workspace.
That matters: the repo still ships local packages named `@opencode-ai/sdk`,
`core`, `server`, `plugin`, `schema`, `codemode` and `protocol`, all of which
collide with the pinned public dependency closure. Inside the workspace those
would shadow the published package and the probes would characterize the fork
instead of the release under test.

Install and run it on its own:

```sh
cd packages/opencode-runtime/contract
npm install
bun run probe.mjs        # full contract probe
node node-loadability.mjs # §2 Node import gate
```

## Running it on Node — the §2 path

`@opencode-ai/sdk@0.0.0-beta-18684` ships extensionless relative ESM specifiers
(`export * as OpenCode from "./opencode"`) that Node ESM cannot resolve, so
`probe.mjs` imports the package directly and therefore needs Bun.

Every shipped Claxedo deployment is Node, so that had to be solved, and it is:

```sh
bun run build-node-bundle.ts   # Bun.build, target node, jsonc-parser ESM plugin
node probe-node.mjs            # same 31 assertions, on Node
```

The only non-obvious ingredient is the `jsonc-parser` resolve plugin, lifted
from `claxedo-desktop/scripts/bundle-claxedo-server.ts:37`. jsonc-parser's
default entry is UMD and hides its relative requires inside a factory closure,
so they survive bundling as a runtime `require("./impl/format")` that resolves
nowhere. Pointing the bundler at the ESM entry inlines it cleanly. The repo
already hit this; we reuse the fix rather than inventing one.

Also note the SDK uses **`node:sqlite`** on the Node condition, not
`better-sqlite3` — no native SQLite module is required, but `node:sqlite` is
experimental in Node 22, so packaged Electron needs verifying per target.

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
