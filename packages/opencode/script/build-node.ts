#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

// jsonc-parser ships no `exports` map, so `target: "node"` resolves its `main`
// — the UMD build, whose `require("./impl/format")` is DYNAMIC. Bundling keeps
// that require verbatim, and it throws at runtime because impl/ was never
// emitted. The package's `module` field points at an ESM build using static
// imports that inlines cleanly, so alias the bare specifier straight to it.
const jsoncParserEsm = Bun.resolveSync("jsonc-parser/lib/esm/main.js", dir)

await Bun.build({
  target: "node",
  entrypoints: ["./src/node.ts"],
  outdir: "./dist/node",
  format: "esm",
  sourcemap: "linked",
  plugins: [
    {
      name: "jsonc-parser-esm",
      setup(build) {
        build.onResolve({ filter: /^jsonc-parser$/ }, () => ({ path: jsoncParserEsm }))
      },
    },
  ],
  // ONLY genuinely unbundleable packages belong here. Every external is a bare
  // import left in the output, and this artifact ships to the desktop app as a
  // lone file (Resources/opencode-engine/node.js) with NO node_modules beside
  // it — so an external that isn't separately shipped fails to resolve at
  // runtime, in the packaged app only.
  //
  // `jsonc-parser` was external despite being pure JS with zero dependencies.
  // It is imported at the top of the engine's config module, so the failed
  // resolution killed the whole engine import, and every route that proxies to
  // it degraded to its empty fallback: `/config/providers` returned
  // `{providers: []}` and the model picker rendered "No model results" with no
  // visible error. Bundling it removes the runtime dependency entirely.
  //
  // `@lydell/node-pty` is a native module — it CANNOT be bundled. It ships
  // beside the engine via extraResources in electron-builder.config.ts, which
  // is the only reason a bare import resolves from Resources/opencode-engine/.
  external: ["@lydell/node-pty"],
  define: {
    OPENCODE_MODELS_DEV: generated.modelsData,
    OPENCODE_CHANNEL: `'${Script.channel}'`,
  },
  files: {
    "opencode-web-ui.gen.ts": "",
  },
})

console.log("Build complete")
