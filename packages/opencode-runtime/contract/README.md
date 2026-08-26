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

## Runtime requirement, and the §2 blocker

`probe.mjs` runs under **Bun**, not Node, because
`@opencode-ai/sdk@0.0.0-beta-18314` ships extensionless relative ESM specifiers
(`export * as OpenCode from "./opencode"`) that Node ESM cannot resolve.

Every shipped Claxedo deployment is Node — the sandbox is `node:22-bookworm-slim`,
desktop bundles with `target: "node"`, self-hosted is `self-hosted-node`. So
this is a release blocker for R2, tracked as §2 in the contract doc, and
`node-loadability.mjs` is the gate that tells us when it clears.

`node-loadability.mjs` exits 0 either way by design: it reports a *known*
blocker today and a *resolved* blocker tomorrow, so it can sit in CI without
being a permanent red.

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
