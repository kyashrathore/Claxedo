/**
 * GUARDRAIL (B): build-artifact check.
 *
 * Ground truth. After `vite build`, the emitted entry chunk is the module-graph
 * `import("./entry.js")` referenced by dist/index.html's `<script type="module">`.
 * We read that chunk (NOT the whole dist) and grep it for library-INTERNAL markers
 * (config `markers`). If any forbidden marker appears, the dep's runtime body leaked
 * into the eager chunk and CI fails.
 *
 * Why this complements the static check: it catches leaks the static walker can't see
 * — a dep pulled through a node_module re-export, a manualChunks misconfig that folds a
 * lazy island back into the entry, or a vite/solid transform that inlines something.
 *
 * Configurable allowlist (BUILD_MARKER_ALLOWLIST) lets an accepted, justified marker
 * through without disabling the whole check.
 *
 * Build first, then run:
 *   bun run build && bun run scripts/check-main-chunk-markers.ts
 * Or one-shot:
 *   bun run check:eager-chunk
 *
 * Env:
 *   CLAXEDO_DIST_DIR  override dist dir (default ./dist, or ./dist-demo for demo build)
 */

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { BUILD_MARKER_ALLOWLIST, FORBIDDEN_DEPS } from "./forbidden-eager-deps.config.ts"

const here = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(here, "..")

const distDir = path.resolve(
  appRoot,
  process.env.CLAXEDO_DIST_DIR || (process.env.CLAXEDO_BUILD_TARGET === "demo" ? "dist-demo" : "dist"),
)
const indexHtml = path.join(distDir, "index.html")

/**
 * Find the entry chunk(s): the modulepreload/script src in index.html. The entry is
 * the `<script type="module" ... src="/assets/main-XXXX.js">`. We resolve it relative
 * to distDir. (vite emits exactly one entry script for this app.)
 */
function findEntryChunks(html: string): string[] {
  const out = new Set<string>()
  const scriptRe = /<script[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["']/g
  let m: RegExpExecArray | null
  while ((m = scriptRe.exec(html))) {
    out.add(m[1])
  }
  // Fallback: any script src that looks like the built entry.
  if (out.size === 0) {
    const any = /<script[^>]*\bsrc=["'](\/assets\/[^"']+\.js)["']/g
    while ((m = any.exec(html))) out.add(m[1])
  }
  return [...out].map((src) => path.join(distDir, src.replace(/^\//, "")))
}

function fail(msg: string): never {
  console.error(msg)
  process.exit(1)
}

function main() {
  if (!existsSync(indexHtml)) {
    fail(
      `[main-chunk-markers] no built index.html at ${indexHtml}.\n` +
        `Run the production build first:  bun run build`,
    )
  }

  const html = readFileSync(indexHtml, "utf8")
  const entryChunks = findEntryChunks(html).filter((p) => p.endsWith(".js"))

  if (entryChunks.length === 0) {
    fail(`[main-chunk-markers] could not locate an entry <script type="module"> in ${indexHtml}.`)
  }

  const missing = entryChunks.filter((p) => !existsSync(p))
  if (missing.length) {
    fail(`[main-chunk-markers] entry chunk(s) referenced by index.html not found on disk:\n  ${missing.join("\n  ")}`)
  }

  const allowlist = new Set(BUILD_MARKER_ALLOWLIST)
  const chunkBodies = entryChunks.map((p) => ({ file: p, body: readFileSync(p, "utf8") }))

  type Leak = { label: string; marker: string; estGzip: string; fixHint?: string; chunk: string }
  const leaks: Leak[] = []

  for (const dep of FORBIDDEN_DEPS) {
    if (dep.markers.length === 0) continue // static-check-only deps
    for (const marker of dep.markers) {
      if (allowlist.has(marker)) continue
      for (const { file, body } of chunkBodies) {
        if (body.includes(marker)) {
          leaks.push({
            label: dep.label,
            marker,
            estGzip: dep.estGzip,
            fixHint: dep.fixHint,
            chunk: path.relative(appRoot, file),
          })
        }
      }
    }
  }

  console.log(
    `[main-chunk-markers] scanned entry chunk(s): ${entryChunks.map((p) => path.basename(p)).join(", ")}`,
  )

  if (leaks.length === 0) {
    console.log("[main-chunk-markers] build-artifact check passed — no forbidden lib markers in the eager entry chunk.")
    return
  }

  console.error("\n[main-chunk-markers] BUILD-ARTIFACT CHECK FAILED")
  console.error("Forbidden library internals were found in the eager entry chunk:\n")

  // group by dep label
  const byLabel = new Map<string, Leak[]>()
  for (const leak of leaks) {
    const arr = byLabel.get(leak.label) ?? []
    arr.push(leak)
    byLabel.set(leak.label, arr)
  }

  for (const [label, group] of byLabel) {
    console.error(`  ✗ ${label}   (est. ${group[0].estGzip})`)
    for (const leak of group) {
      console.error(`      marker "${leak.marker}" found in ${leak.chunk}`)
    }
    if (group[0].fixHint) console.error(`    fix: ${group[0].fixHint}`)
    console.error("")
  }

  console.error(
    "If a marker is genuinely benign (e.g. only a dynamic-import trigger), add it to\n" +
      "BUILD_MARKER_ALLOWLIST in scripts/forbidden-eager-deps.config.ts WITH a justification.",
  )
  process.exit(1)
}

main()
