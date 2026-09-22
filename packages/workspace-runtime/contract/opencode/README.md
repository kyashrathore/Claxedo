# Upstream OpenCode SDK diagnostic probes

This isolated, unpatched npm fixture characterizes beta-18684. It is not a
workspace member or a production execution path. Its own lockfile prevents
repository patches or workspace aliases from hiding upstream defects.

```sh
cd packages/workspace-runtime/contract/opencode
npm install
bun run probe.mjs
node node-loadability.mjs
```

The unpatched Node-import probe reports extensionless ESM exports. The older
`build-node-bundle.ts` / `probe-node.mjs` experiment gets past those exports
but exposes the upstream `node:ffi` dependency. These scripts are diagnostics,
not desktop build inputs. `node-loadability.mjs` reports rather than fails on
that known upstream defect; it is not a product acceptance check.

The product installs the public SDK with the exact-version patches in
`patches/README.opencode-node.md`. Node 24 or newer is required; Electron
is 44.4.3. No Bun sidecar, private host import, or old engine fallback
is used. Its owner is `workspace-runtime/src/opencode`.

Run product acceptance from `packages/workspace-runtime`:

```sh
bun run build
node scripts/node-sdk-smoke.mjs
node scripts/node-host-smoke.mjs
bun test src/opencode
```

Run both smoke scripts with `ELECTRON_RUN_AS_NODE=1 /path/to/electron` to
exercise Electron's own Node runtime. Desktop boot and package-structure tests
also verify the staged SDK and real host/PTY entrypoints. Linux, Windows and
signed installer verification remain platform release gates.

The diagnostic contract's security facts still matter: `sessions.get` does
not authorize workspace access, and session listing requires a flat
`directory` filter. The product's opaque workspace scope validates ownership
before mutations; it must never replace those checks with an unscoped call.
