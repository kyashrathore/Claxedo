# OpenCode beta-18684 on Node/Electron

The five version-pinned OpenCode patches are applied by the repository's
existing `script/apply-dependency-patches.ts` postinstall step.

- SDK, client, server and simulation: explicit relative ESM file extensions.
- Core: explicit watcher wrapper extension and a Node-API-backed `flock`
  binding using pinned `koffi@3.1.6`, instead of experimental `node:ffi`.
  The lock file, nonblocking contention result and close-to-release protocol
  remain upstream-owned. The patch does not bypass locking.
- Core's config-provider overlay also preserves an explicit disabled
  activation set by a host plugin. Without this, a configured provider is
  silently re-enabled after Claxedo disables it. The real-SDK provider-policy
  test covers disable, re-enable, workspace isolation and restart.

The runtime is owned by `packages/workspace-runtime/src/opencode` and exposed
as `@claxedo/workspace-runtime/opencode`. Bun is not needed to execute it.
The runtime minimum is Node 24: Node 22.22.3 fails to parse the published
`@opencode-ai/util` resource-management syntax. Sandbox images use Node 24.18.0;
Electron is 44.4.3 with its Node 24.21.0 runtime.

Verification from `packages/workspace-runtime`:

```sh
node scripts/node-sdk-smoke.mjs
node scripts/node-host-smoke.mjs
ELECTRON_RUN_AS_NODE=1 /path/to/electron scripts/node-sdk-smoke.mjs
bun test src/opencode
bun run build
```

The Node probe checks real cross-process contention, fd-release/reacquisition,
invalid-fd errors, health, location-dependent config/agent/provider calls and
session persistence. It isolates configuration and state in a temporary root.
Verified locally on macOS arm64 with Node 26.8.1 and Electron 44.4.3 / Node
24.21.0. The staged SDK and the emitted desktop server entrypoint also pass
under Electron, including workspace/session routes and PTY creation. A clean
npm install passes the SDK probe on Linux arm64 / Node 24.18.0, and the emitted
HTTP host passes session creation, durable failure and snapshot checks there.
The standard image uses Debian Trixie because better-sqlite3 13's arm64
prebuild requires glibc 2.38 (Bookworm only has 2.36). Windows, Linux x64,
the Cloudflare base image and a signed final desktop installer remain release
verification gates.

Desktop and standalone Node builds stage the patched SDK dependency closure
as real packages (no checkout symlinks), preserving upstream native and data
assets. Declaration files and source maps are excluded. The desktop keeps
these packages outside app.asar; the server still runs on Electron's Node.
The macOS arm64 SDK closure occupies 326 MiB on disk (621 dependency packages),
or 54,886,400 bytes in a gzip tar, in addition to the 14.7 MB bundled server.
This is not the signed installer size;
the native/data dependency closure remains a material size cost without Bun.
Sandbox builds bundle the same dependency-patch installer as a Node script
and run it during npm postinstall, so no Bun runtime is needed there either.
The published workspace-runtime package carries that installer and the exact
patch bytes in dist/opencode-node; its npm postinstall patches hoisted or
package-local dependencies. Source-workspace installs are owned by the root
postinstall instead. Git must be available during install; it is not used for
patching at application startup. Installs with lifecycle scripts disabled must
explicitly run the package's postinstall before using the SDK.

Upstream tracking: [Node ESM PR](https://github.com/anomalyco/opencode/pull/44582)
and [process-lock issue](https://github.com/anomalyco/opencode/issues/47365).
Node 26's experimental FFI flag does not supply FFI to Electron's Node 24.

On a beta upgrade, test the clean upstream package first. Remove patches that
upstream no longer needs, their root manifest entries, and Koffi when upstream
provides a lock binding compatible with the shipped Electron runtime. The
postinstall exact-version and forward/reverse checks deliberately fail on
unreviewed dependency drift.
