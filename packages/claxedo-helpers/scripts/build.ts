#!/usr/bin/env bun

/**
 * One bundle per published subpath, plus the declaration tree.
 *
 * Each entrypoint is bundled standalone, so a consumer that imports only
 * `@claxedo/helpers/guards` never loads `./number` or a `node:` builtin. The
 * runtime-neutral entries build for `browser` to keep that guarantee
 * mechanical: a stray Node import in `guards`, `string` or the root barrel
 * fails the build rather than shipping.
 */
import fs from "node:fs"
import path from "node:path"

import { buildPackage } from "../../../script/bun-build"

const ROOT = path.resolve(import.meta.dirname, "..")

const ENTRIES: readonly { readonly entry: string; readonly target: "browser" | "node" }[] = [
  { entry: "index", target: "browser" },
  { entry: "api-error", target: "browser" },
  { entry: "crypto", target: "browser" },
  { entry: "guards", target: "browser" },
  { entry: "readers", target: "browser" },
  { entry: "string", target: "browser" },
  { entry: "env", target: "browser" },
  { entry: "skill-frontmatter", target: "browser" },
  { entry: "route-param", target: "browser" },
  { entry: "claxedo-credentials", target: "node" },
  { entry: "claxedo-daemon", target: "browser" },
  { entry: "claxedo-document", target: "browser" },
  { entry: "sse", target: "browser" },
  { entry: "fs", target: "node" },
  { entry: "path", target: "node" },
  { entry: "real-path", target: "node" },
  { entry: "process", target: "node" },
  { entry: "net", target: "node" },
  { entry: "machine-name", target: "node" },
]

// package.json is what consumers resolve, so a subpath it exports must have a
// bundle here or every dist-resolved consumer breaks at build time.
const exported = new Set(
  JSON.stringify(JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).exports)
    .matchAll(/\.\/dist\/([a-z0-9-]+)\.mjs/g)
    .map((match) => match[1]),
)
const built = new Set(ENTRIES.map(({ entry }) => entry))
const unbuilt = [...exported].filter((entry) => !built.has(entry))
if (unbuilt.length > 0) throw new Error(`package.json exports subpaths with no build entry: ${unbuilt.join(", ")}`)

await buildPackage({
  root: ROOT,
  bundles: ENTRIES.map(({ entry, target }) => ({
    entrypoints: [`src/${entry}.ts`],
    target,
    format: "esm",
    naming: "[name].mjs",
  })),
})
