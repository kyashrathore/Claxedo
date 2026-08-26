/**
 * §2 resolution probe: produce a Node-loadable bundle of the pinned public SDK.
 *
 * The published package cannot be imported by Node directly (extensionless
 * relative ESM specifiers). Claxedo already bundles its server with Bun.build
 * for exactly this class of reason, so the fix is to reuse that pipeline rather
 * than invent a loader shim.
 *
 * Two pieces are carried over from `claxedo-desktop/scripts/bundle-claxedo-server.ts`:
 *
 *   1. The `jsonc-parser` UMD -> ESM resolve plugin. jsonc-parser's default
 *      entry is UMD, whose relative requires hide inside the factory closure;
 *      Bun cannot see them, so they leak as runtime `require("./impl/format")`
 *      that resolves nowhere in a bundled app. The ESM entry inlines cleanly.
 *      This is the same failure the desktop bundle already fixes this way.
 *
 *   2. Native modules stay external — they cannot be bundled and ship as real
 *      node_modules beside the artifact.
 *
 *   bun run build-node-bundle.ts && node probe-node.mjs
 */
import { createRequire } from "node:module"

const require_ = createRequire(import.meta.url)

/** Native/binary modules that must resolve from node_modules at runtime. */
const EXTERNAL = ["better-sqlite3", "@opencode-ai/pty", "ffi-rs"]

const result = await Bun.build({
  entrypoints: ["./sdk-entry.mjs"],
  outdir: "./dist-node",
  target: "node",
  format: "esm",
  external: EXTERNAL,
  plugins: [
    {
      name: "jsonc-parser-esm",
      setup(build) {
        build.onResolve({ filter: /^jsonc-parser$/ }, () => ({
          path: require_.resolve("jsonc-parser/lib/esm/main.js"),
        }))
      },
    },
  ],
})

if (!result.success) {
  console.error("BUILD FAILED")
  for (const log of result.logs.slice(0, 15)) console.error(log.message ?? log)
  process.exit(1)
}

for (const output of result.outputs) {
  console.log(`BUILD_OK ${output.path} (${(Bun.file(output.path).size / 1e6).toFixed(1)} MB)`)
}
