// The process entry of the packaged server child, and it exists for exactly one
// reason: TO RUN BEFORE THE PRODUCT ENTRY IS COMPILED.
//
// Node compiles and links an entire static ESM graph during instantiation,
// before any module body executes. The server bundle's static closure is
// 9.11 MB across 23 chunks, and while `enableCompileCache` lived in the product
// entry's own body that closure was already compiled by the time the cache was
// switched on — so it could never be cached, on launch one or launch fifty. The
// shipped `opencode-compile-cache/manifest.json` had exactly one entry, the
// engine, and nothing of the server bundle. Measured cost of that ordering:
// 41.0 ms of pure V8 compile on every launch.
//
// So the bundle is entered HERE, this file seeds the cache, and only then does
// the product entry arrive through a DYNAMIC import — which puts its whole
// closure on the far side of the boundary, compiled after the cache is live.
// It is the same lazy-import shape that already made the 23 MB engine cacheable
// (`embeddedHost()` imports it on first use, not at link time).
//
// Everything this file may import is therefore load-bearing: every module
// reachable STATICALLY from here is compiled BEFORE seeding and can never be
// cached. Keep it to the startup contract and the cache itself.
import { dirname } from "node:path"

import { enableShippedCompileCaches } from "../src/shared/opencode-compile-cache"
import { claxedoServerStartup } from "./claxedo-server-startup"

const startup = claxedoServerStartup(process.env)

// Two shipped sets, one runtime directory: the engine artifact's, keyed
// relative to the engine's own directory, and this bundle's, keyed relative to
// the directory this file was loaded from. Neither root is constructed from a
// packaging layout — one is the path the desktop handed over, the other is
// where this module actually is.
const compileCache = enableShippedCompileCaches({
  dataDir: startup.dataDir,
  sources: [
    startup.opencodeCompileCacheDir && startup.opencodeEmbedPath
      ? { shippedDir: startup.opencodeCompileCacheDir, rootDir: dirname(startup.opencodeEmbedPath) }
      : undefined,
    startup.serverCompileCacheDir
      ? { shippedDir: startup.serverCompileCacheDir, rootDir: import.meta.dirname }
      : undefined,
  ],
})
// Swallowed, not thrown: a cache is an optimisation, and no failure to seed one
// may ever become a failure to boot.
if (compileCache.status === "failed") {
  console.error(`[opencode-compile-cache] not seeded: ${compileCache.reason ?? "unknown"}`)
}

// THE DYNAMIC BOUNDARY. Everything the product is made of is compiled by this
// statement, with the cache already live and already seeded. The build
// generates this bundle's cache by importing the chunk this resolves to — see
// scripts/build-opencode-compile-cache.ts.
await import("./claxedo-server-entry")
