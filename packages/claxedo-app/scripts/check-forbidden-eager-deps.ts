/**
 * GUARDRAIL (A): static import-graph check.
 *
 * Walks the STATIC import closure starting at src/main.tsx (the real boot entry —
 * index.html loads `/src/main.tsx`). An edge is followed only if it is a *static*
 * `import ... from "x"` / `import "x"` / `export ... from "x"`. Dynamic `import("x")`
 * and `lazy(() => import("x"))` are treated as boundaries and NOT followed — that is
 * exactly the seam a heavy dep is supposed to hide behind.
 *
 * Fails (exit 1) if any FORBIDDEN_DEPS specifier is reachable on that static graph.
 * The failure prints the shortest import chain main.tsx -> ... -> <forbidden> so the
 * regression is one click to fix.
 *
 * Dependency-light: uses only node:fs / node:path and a small import-scanner regex.
 * No es-module-lexer needed — we deliberately under-parse (string-literal specifiers
 * only), which is sound for this purpose: any real static import is a string literal.
 *
 * Run: `bun run scripts/check-forbidden-eager-deps.ts`
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { FORBIDDEN_DEPS, type ForbiddenDep } from "./forbidden-eager-deps.config.ts"

const here = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(here, "..")
const repoRoot = path.resolve(appRoot, "../..")
const appSrc = path.join(appRoot, "src")
const uiSrc = path.resolve(appRoot, "../ui/src")
const upstreamSrc = path.resolve(appRoot, "../app/src")

const ENTRY = path.join(appSrc, "main.tsx")

const RESOLVE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"]
const INDEX_FILES = RESOLVE_EXTS.map((e) => `index${e}`)

// ---------------------------------------------------------------------------
// Alias table — mirrors vite.cloud.config.ts resolve.alias (exact-match first,
// then prefix aliases, lowest priority last). Keep in sync with that file.
// ---------------------------------------------------------------------------

type ExactAlias = { kind: "exact"; find: string; to: string }
type PrefixAlias = { kind: "prefix"; find: string; to: string }
type Alias = ExactAlias | PrefixAlias

const FIRST_PARTY_OWNERS: Array<[string, string]> = [
  ["@/app", "./src/app.tsx"],
  ["@/components/dialog-settings", "./src/components/dialog-settings.tsx"],
  ["@/components/dialog-connect-provider", "./src/components/dialog-connect-provider.tsx"],
  ["@/components/dialog-custom-provider", "./src/components/dialog-custom-provider.tsx"],
  ["@/components/dialog-manage-models", "./src/components/dialog-manage-models.tsx"],
  ["@/components/dialog-select-directory", "./src/components/dialog-select-directory.tsx"],
  ["@/components/dialog-select-file", "./src/components/dialog-select-file.tsx"],
  ["@/components/dialog-select-mcp", "./src/components/dialog-select-mcp.tsx"],
  ["@/components/dialog-select-model", "./src/components/dialog-select-model.tsx"],
  ["@/components/dialog-select-model-unpaid", "./src/components/dialog-select-model-unpaid.tsx"],
  ["@/components/dialog-select-provider", "./src/components/dialog-select-provider.tsx"],
  ["@/components/prompt-input", "./src/components/prompt-input.tsx"],
  ["@/components/prompt-input/submit", "./src/components/prompt-input/submit.ts"],
  ["@/components/terminal", "./src/components/terminal.tsx"],
  ["@/components/session/session-context-tab", "./src/components/session/session-context-tab.tsx"],
  ["@/components/session/session-header", "./src/components/session/session-header.tsx"],
  ["@/components/session/session-new-view", "./src/components/session/session-new-view.tsx"],
  ["@/components/settings-general", "./src/components/settings-general.tsx"],
  ["@/components/settings-providers", "./src/components/settings-providers.tsx"],
  ["@/context/command", "./src/context/command.tsx"],
  ["@/context/file", "./src/context/file.tsx"],
  ["@/context/file/view-cache", "./src/context/file/view-cache.ts"],
  ["@/context/global-sdk", "./src/context/global-sdk.tsx"],
  ["@/context/global-sync", "./src/context/global-sync.tsx"],
  ["@/context/language", "./src/context/language.tsx"],
  ["@/context/layout", "./src/context/layout.tsx"],
  ["@/context/local", "./src/context/local.tsx"],
  ["@/context/notification", "./src/context/notification.tsx"],
  ["@/context/platform", "./src/context/platform.tsx"],
  ["@/context/prompt", "./src/context/prompt.tsx"],
  ["@/context/sdk", "./src/context/sdk.tsx"],
  ["@/context/server", "./src/context/server.tsx"],
  ["@/context/terminal", "./src/context/terminal.tsx"],
  ["@/context/use-providers", "./src/context/use-providers.ts"],
  ["@/pages/directory-layout", "./src/pages/directory-layout.tsx"],
  ["@/pages/error", "./src/pages/error.tsx"],
  ["@/pages/home", "./src/pages/home.tsx"],
  ["@/pages/layout", "./src/pages/layout.tsx"],
  ["@/pages/session", "./src/pages/session.tsx"],
  ["@/pages/session/use-session-commands", "./src/pages/session/use-session-commands.tsx"],
  ["@/pages/session/composer", "./src/pages/session/composer/index.ts"],
  ["@/pages/session/composer/session-composer-region", "./src/pages/session/composer/session-composer-region.tsx"],
  ["@/pages/session/composer/session-composer-state", "./src/pages/session/composer/session-composer-state.ts"],
  ["@/utils/persist", "./src/utils/persist.ts"],
  ["@/utils/server-health", "./src/utils/server-health.ts"],
]

const ALIASES: Alias[] = [
  { kind: "exact", find: "#terminal-backend", to: path.join(appSrc, "terminal/backend/xterm.ts") },
  { kind: "exact", find: "@/components/session-context-usage", to: path.join(appSrc, "components/session-context-usage.tsx") },
  ...FIRST_PARTY_OWNERS.map(([find, rel]) => ({
    kind: "exact" as const,
    find,
    to: path.resolve(appRoot, rel),
  })),
  { kind: "exact", find: "@claxedo/agent-event-runtime/contracts", to: path.resolve(appRoot, "../agent-event-runtime/src/contracts/index.ts") },
  { kind: "exact", find: "@claxedo/agent-event-runtime/opencode-compat", to: path.resolve(appRoot, "../agent-event-runtime/src/projections/opencode-compat/index.ts") },
  { kind: "exact", find: "@claxedo/agent-event-runtime", to: path.resolve(appRoot, "../agent-event-runtime/src/index.ts") },
  { kind: "prefix", find: "@claxedo/", to: appSrc + path.sep },
  // upstream @/ — lowest priority
  { kind: "prefix", find: "@/", to: upstreamSrc + path.sep },
]

// @opencode-ai/ui subpath exports -> packages/ui/src (covers the marked / file edges).
// Mirrors ../ui/package.json "exports": "./context/*" and the "./*" wildcard.
function resolveUiSubpath(spec: string): string | null {
  const rest = spec.slice("@opencode-ai/ui".length)
  if (rest === "" || rest === "/") return path.join(uiSrc, "index.ts")
  const sub = rest.replace(/^\//, "")
  if (sub.startsWith("context/")) return path.join(uiSrc, "context", sub.slice("context/".length))
  if (sub.startsWith("components/")) return path.join(uiSrc, "components", sub.slice("components/".length))
  if (sub === "context") return path.join(uiSrc, "context/index.ts")
  if (sub === "hooks") return path.join(uiSrc, "hooks/index.ts")
  if (sub === "theme") return path.join(uiSrc, "theme/index.ts")
  // "./*" wildcard -> ./src/components/*
  return path.join(uiSrc, "components", sub)
}

const UI_PKG_PREFIXES = ["@opencode-ai/ui/", "@opencode-ai/ui"]
const CLAXEDO_APP_PKG = "@opencode-ai/claxedo-app"

// ---------------------------------------------------------------------------
// Module resolution
// ---------------------------------------------------------------------------

function tryFile(p: string): string | null {
  if (existsSync(p) && statSync(p).isFile()) return p
  for (const ext of RESOLVE_EXTS) {
    if (existsSync(p + ext)) return p + ext
  }
  if (existsSync(p) && statSync(p).isDirectory()) {
    for (const idx of INDEX_FILES) {
      const f = path.join(p, idx)
      if (existsSync(f)) return f
    }
  }
  return null
}

function applyAlias(spec: string): string | null {
  // exact first
  for (const a of ALIASES) {
    if (a.kind === "exact" && spec === a.find) return a.to
  }
  for (const a of ALIASES) {
    if (a.kind === "prefix" && spec.startsWith(a.find)) {
      return path.normalize(a.to + spec.slice(a.find.length))
    }
  }
  return null
}

/**
 * Resolve an import specifier to an absolute first-party source file, or null if it
 * is a bare/3rd-party module (a graph leaf we do NOT recurse into — we only care
 * whether the *specifier itself* is forbidden).
 */
function resolveToFile(spec: string, fromFile: string): string | null {
  // relative
  if (spec.startsWith("./") || spec.startsWith("../")) {
    return tryFile(path.resolve(path.dirname(fromFile), spec))
  }
  // self-package import (rare): @opencode-ai/claxedo-app[/...]
  if (spec === CLAXEDO_APP_PKG || spec.startsWith(CLAXEDO_APP_PKG + "/")) {
    const sub = spec.slice(CLAXEDO_APP_PKG.length).replace(/^\//, "")
    return tryFile(path.join(appSrc, sub || "index.tsx"))
  }
  // @opencode-ai/ui — resolve into packages/ui/src so we can keep walking
  if (UI_PKG_PREFIXES.some((p) => spec === p.replace(/\/$/, "") || spec.startsWith(p))) {
    const target = resolveUiSubpath(spec)
    return target ? tryFile(target) : null
  }
  // aliased (@/, @claxedo/, #terminal-backend, ...)
  const aliased = applyAlias(spec)
  if (aliased) return tryFile(aliased)
  // anything else is a bare node_modules dep — leaf
  return null
}

// ---------------------------------------------------------------------------
// Import scanning (static edges only)
// ---------------------------------------------------------------------------

/** Strip block + line comments so we don't read commented-out imports. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")
}

const STATIC_IMPORT_RE =
  // captures the FULL clause so we can inspect the import-clause text:
  //   import <clause> from "x"  |  import "x"  |  export <clause> from "x"
  /(?:^|[\s;])(import|export)\b([^'"`;()]*?)from\s*["']([^"']+)["']|(?:^|[\s;])import\s*["']([^"']+)["']/g

/**
 * Extract static (non-dynamic), VALUE-bearing import specifiers from a source file.
 *
 * Type-only edges are skipped because TS erases them at build — they never put the
 * module into the runtime graph. We skip:
 *   - `import type { ... } from "x"`  /  `export type { ... } from "x"`   (whole clause)
 *   - a clause that is ENTIRELY inline type specifiers, e.g.
 *       `import { type A, type B } from "x"`  (every named binding prefixed `type`)
 * A clause with at least one value binding (default, namespace, or a non-`type`
 * named binding) IS a real edge and is kept.
 *
 * Dynamic `import("x")` and `lazy(() => import("x"))` are intentionally ignored —
 * they are the deferral boundary we WANT to allow.
 */
function staticImports(src: string): string[] {
  const clean = stripComments(src)
  const out = new Set<string>()
  let m: RegExpExecArray | null
  STATIC_IMPORT_RE.lastIndex = 0
  while ((m = STATIC_IMPORT_RE.exec(clean))) {
    // bare `import "x"` side-effect form — always a value edge
    if (m[4]) {
      out.add(m[4])
      continue
    }
    const keyword = m[1]
    const clause = (m[2] ?? "").trim()
    const spec = m[3]
    if (!spec) continue
    if (isTypeOnlyClause(keyword, clause)) continue
    out.add(spec)
  }
  return [...out]
}

/** True if the import/export clause carries no runtime value (fully erased by TS). */
function isTypeOnlyClause(keyword: string, clause: string): boolean {
  // `import type ...` / `export type ...`
  if (/^type\b/.test(clause)) return true
  // named-only clause where EVERY binding is `type X`
  const named = clause.match(/\{([\s\S]*)\}/)
  // a default or namespace binding (text before `{`) is a value import
  const beforeBrace = named ? clause.slice(0, named.index).trim() : clause
  const hasValueOutsideBraces = beforeBrace.replace(/[,]/g, "").trim().length > 0
  if (hasValueOutsideBraces) return false
  if (!named) return false // e.g. `export {}` re-export with no bindings — ignore as non-edge-ish but harmless
  const bindings = named[1].split(",").map((s) => s.trim()).filter(Boolean)
  if (bindings.length === 0) return false
  return bindings.every((b) => /^type\b/.test(b))
}

// ---------------------------------------------------------------------------
// Walk
// ---------------------------------------------------------------------------

type Hit = { dep: ForbiddenDep; specifier: string; chain: string[] }

function matchForbidden(spec: string): ForbiddenDep | null {
  for (const dep of FORBIDDEN_DEPS) {
    for (const s of dep.specifiers) {
      if (s.endsWith("/")) {
        if (spec === s.slice(0, -1) || spec.startsWith(s)) return dep
      } else if (spec === s || spec.startsWith(s + "/")) {
        return dep
      }
    }
  }
  return null
}

function rel(p: string): string {
  return path.relative(repoRoot, p)
}

function walk(): Hit[] {
  const hits: Hit[] = []
  const seenHit = new Set<string>() // dedupe by dep label
  const visited = new Set<string>()
  // BFS so the reported chain is the SHORTEST path from the entry.
  const queue: Array<{ file: string; chain: string[] }> = [{ file: ENTRY, chain: [rel(ENTRY)] }]

  while (queue.length) {
    const { file, chain } = queue.shift()!
    if (visited.has(file)) continue
    visited.add(file)

    let src: string
    try {
      src = readFileSync(file, "utf8")
    } catch {
      continue
    }

    for (const spec of staticImports(src)) {
      // 1) forbidden specifier reached via a static edge?
      const dep = matchForbidden(spec)
      if (dep && !seenHit.has(dep.label)) {
        seenHit.add(dep.label)
        hits.push({ dep, specifier: spec, chain: [...chain, spec] })
        continue // don't try to resolve a bare forbidden dep to a file
      }
      // 2) follow first-party edges
      const resolved = resolveToFile(spec, file)
      if (resolved && !visited.has(resolved)) {
        queue.push({ file: resolved, chain: [...chain, rel(resolved)] })
      }
    }
  }

  return hits
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function main() {
  if (!existsSync(ENTRY)) {
    console.error(`[forbidden-eager-deps] entry not found: ${ENTRY}`)
    process.exit(2)
  }

  const hits = walk()

  if (hits.length === 0) {
    console.log("[forbidden-eager-deps] static check passed — no forbidden heavy dep is statically reachable from main.tsx.")
    return
  }

  console.error("\n[forbidden-eager-deps] STATIC CHECK FAILED")
  console.error("The following heavy deps are statically reachable from the boot entry (no lazy()/import() boundary).")
  console.error("They must be deferred behind a dynamic import so they leave the eager main chunk.\n")

  for (const { dep, specifier, chain } of hits) {
    console.error(`  ✗ ${dep.label}`)
    console.error(`    forbidden specifier: "${specifier}"   (est. ${dep.estGzip})`)
    if (dep.fixHint) console.error(`    fix: ${dep.fixHint}`)
    console.error(`    static import chain:`)
    chain.forEach((node, i) => {
      const arrow = i === 0 ? "" : "→ "
      console.error(`      ${"  ".repeat(i)}${arrow}${node}`)
    })
    console.error("")
  }

  console.error(`Total: ${hits.length} forbidden eager dep(s). See scripts/forbidden-eager-deps.config.ts to amend the list.`)
  process.exit(1)
}

main()
