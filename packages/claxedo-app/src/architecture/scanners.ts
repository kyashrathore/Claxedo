import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import productionSetIntervalAllowlist from "./production-set-interval-allowlist.json"

export type SourceFile = {
  path: string
  text: string
}

export type Finding = {
  file: string
  line: number
  match: string
}

export type MetricName =
  | "directoryStringParams"
  | "signedControlPlaneAccess"
  | "isWorkspaceIdRef"
  | "isFilesystemDirectory"
  | "isLoopbackHttpUrl"
  | "filesystemShapeRegexClones"
  | "userHostedComparisons"
  | "legacyDirectoryRouteKeyRefs"
  | "isSignedInGates"
  | "timerDrivenDataPolls"
  | "asAnyCasts"
  | "setQueryDataCalls"
  | "setQueryDataFiles"
  | "deepSessionUiImports"
  | "sdkImportingFiles"
  | "effectStateWrites"
  | "moduleScopeMutableState"
  | "suppressionFlags"
  | "untrackCalls"
  | "propsDestructuring"
  | "queryMirrorEffects"
  | "conversationHydrationEntrypoints"
  | "runtimeGatewayOutsideTransport"

export type Metric = {
  name: MetricName
  description: string
  scan: (files: SourceFile[]) => Finding[]
}

export function walkProdSources(appRoot: string) {
  return prodSourcePaths(appRoot)
    .filter((file) => /\.(ts|tsx)$/.test(file))
    .map((file) => ({
      path: path.relative(path.join(appRoot, "src"), file).split(path.sep).join("/"),
      text: readFileSync(file, "utf8"),
    }))
}

export function walkTestSources(appRoot: string) {
  return walk(path.join(appRoot, "src"))
    .filter((file) => /\.(test|vitest|spec)\.(ts|tsx)$/.test(file))
    .filter((file) => !path.relative(path.join(appRoot, "src"), file).startsWith(`architecture${path.sep}`))
    .map((file) => ({
      path: path.relative(path.join(appRoot, "src"), file).split(path.sep).join("/"),
      text: readFileSync(file, "utf8"),
    }))
}

export function prodSourcePaths(appRoot: string) {
  return walk(path.join(appRoot, "src"))
    .filter((file) => /\.(ts|tsx)$/.test(file))
    .filter((file) => !/\.(test|vitest)\./.test(file))
    .filter((file) => !file.endsWith(".d.ts"))
    .filter((file) => !path.relative(path.join(appRoot, "src"), file).startsWith(`architecture${path.sep}`))
}

export function lineCounts(appRoot: string) {
  const srcRoot = path.join(appRoot, "src")
  return prodSourcePaths(appRoot).map((file) => ({
    file: path.relative(srcRoot, file).split(path.sep).join("/"),
    lines: readFileSync(file, "utf8").split("\n").length,
  }))
}

export function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") return []
      return walk(file)
    }
    return [file]
  })
}

export function metricCounts(files: SourceFile[]) {
  return Object.fromEntries(metrics.map((metric) => [metric.name, metric.scan(files).length])) as Record<
    MetricName,
    number
  >
}

export const metrics: readonly Metric[] = [
  regexMetric("directoryStringParams", "`directory: string` parameters", /directory:\s*string/g),
  regexMetric("signedControlPlaneAccess", "`shouldUseSignedControlPlaneAccess` references", /shouldUseSignedControlPlaneAccess/g),
  regexMetric("isWorkspaceIdRef", "`isWorkspaceIdRef(` calls", /isWorkspaceIdRef\s*\(/g),
  regexMetric("isFilesystemDirectory", "`isFilesystemDirectory(` calls", /isFilesystemDirectory\s*\(/g),
  regexMetric("isLoopbackHttpUrl", "`isLoopbackHttpUrl(` calls", /isLoopbackHttpUrl\s*\(/g),
  regexMetric(
    "filesystemShapeRegexClones",
    "copy-pasted filesystem-shape regex clones",
    /startsWith\("\/"\)\s*\|\|\s*\/\^\[A-Za-z\]/g,
  ),
  regexMetric(
    "userHostedComparisons",
    "`user-hosted` string comparisons",
    /(?:===?\s*["']user-hosted["']|["']user-hosted["']\s*===?)/g,
  ),
  regexMetric("legacyDirectoryRouteKeyRefs", "`legacyDirectoryRouteKey` references", /legacyDirectoryRouteKey/g),
  isSignedInGateMetric(),
  timerDrivenDataPollMetric(),
  regexMetric("asAnyCasts", "`as any` and `as unknown as` casts", /as any|as unknown as/g),
  regexMetric("setQueryDataCalls", "`setQueryData` calls", /setQueryData/g),
  fileMetric("setQueryDataFiles", "files containing `setQueryData`", /setQueryData/),
  deepSessionUiImportMetric(),
  fileMetric("sdkImportingFiles", "files importing `@opencode-ai/sdk`", /from\s+["']@opencode-ai\/sdk(?:\/[^"']*)?["']/),
  bodyMetric("effectStateWrites", "`createEffect` bodies that write state", /createEffect\s*\(/g, /\bset[A-Z]\w*\s*\(/),
  moduleScopeMutableStateMetric(),
  regexMetric(
    "suppressionFlags",
    "suppression flag references",
    /\b(suppress[A-Z][A-Za-z]*|skipNext[A-Z][A-Za-z]*|fastSwitchRestoreDeferred)\b/g,
  ),
  regexMetric("untrackCalls", "production `untrack(` calls", /\buntrack\s*\(/g),
  regexMetric("propsDestructuring", "`const { ... } = props` destructuring", /const\s+\{[^}]*\}\s*=\s*props\b/g),
  bodyMetric("queryMirrorEffects", "query-mirror effects", /createEffect\s*\(/g, [/\bset[A-Z]\w*\s*\(/, /\.data\b/]),
  conversationHydrationEntrypointMetric(),
  runtimeGatewayOutsideTransportMetric(),
]

// ---------------------------------------------------------------------------
// Standalone drift guard: OSC 10/11 escape handling has a single owner.
//
// The terminal foreground/background color queries (OSC 10 / OSC 11) and their
// magic RGB response literals must live in exactly ONE production module. A dead
// duplicate used to live in backend/xterm.ts; if either the query detection or
// the response literals drift back into another file, the two copies silently
// disagree. This is a source-shape rule (per CONTRIBUTING it belongs here as a
// named scanner rule, not as a text-scan inside capability-responder.test.ts).
// Baseline: empty — capability-responder.ts is the only allowed owner.
// ---------------------------------------------------------------------------
export const CAPABILITY_RESPONDER_FILE = "features/terminal/core/capability-responder.ts"

// Matches an OSC 10 or OSC 11 escape marker (`ESC ] 10 ;` / `ESC ] 11 ;`) in
// source, in both string-literal (`\x1b]10;`) and regex-literal (`\x1b\]10;`)
// forms, across the ESC spellings the codebase might use (\x1b, , \033).
const oscColorEscapeRe = /(?:\\x1b|\\u001b|\\033)\\?\]1[01];/g

export function oscColorEscapesOutsideResponder(files: SourceFile[]): Finding[] {
  return files
    .filter((file) => file.path !== CAPABILITY_RESPONDER_FILE)
    .flatMap((file) => findMatches(file, oscColorEscapeRe))
}

/**
 * Writing the document URL only round-trips on an http(s) page.
 *
 * The packaged desktop renderer is a `file://` document routed by
 * `MemoryRouter`, so a pushed/replaced path becomes `file:///w/<dir>/<session>`
 * — an unloadable path. The next reload asks Chromium to load it as a file,
 * fails with `net::ERR_FAILED`, and strands the user on a blank
 * `chrome-error://chromewebdata/` window that only a relaunch recovers.
 *
 * Any prod source that writes history state must therefore gate it on
 * `urlRoutingEnabled()`. Referencing the guard anywhere in the file satisfies
 * the rule: the intent is to catch a URL write added with no protocol check at
 * all, not to prove the branch wraps a specific call.
 */
const historyUrlWriteRe = /history\.(?:push|replace)State\s*\(/g

export function unguardedHistoryUrlWrites(files: SourceFile[]): Finding[] {
  return files
    .filter((file) => !file.text.includes("urlRoutingEnabled"))
    .flatMap((file) => findMatches(file, historyUrlWriteRe))
}

export const WORKGRAPH_SURFACE_FILE = "app/integrations/first-party-content-surfaces.tsx"

export function workGraphEagerSurfaceViolations(files: SourceFile[]): Finding[] {
  const file = files.find((item) => item.path === WORKGRAPH_SURFACE_FILE)
  if (!file) return [{ file: WORKGRAPH_SURFACE_FILE, line: 1, match: "WorkGraph surface file is missing" }]
  const findings = [
    ...findMatches(file, /const\s+WorkGraphContent\s*=\s*lazy/g),
    ...findMatches(file, /Loading WorkGraph/g),
  ]
  if (/import\s+\{\s*WorkGraphContent\s*\}\s+from\s+["']\.\.\/\.\.\/features\/workgraph["']/.test(file.text)) {
    return findings
  }
  return [{ file: file.path, line: 1, match: "WorkGraphContent must be imported eagerly" }, ...findings]
}

/**
 * The WorkGraph surface picks project folders with the app's own directory
 * dialog, never the OS-native picker: a native widget in the middle of an in-app
 * flow reads as a different application.
 */
export function workGraphNativePickerViolations(files: SourceFile[]): Finding[] {
  const file = files.find((item) => item.path === WORKGRAPH_SURFACE_FILE)
  if (!file) return [{ file: WORKGRAPH_SURFACE_FILE, line: 1, match: "WorkGraph surface file is missing" }]
  return findMatches(file, /openDirectoryPickerDialog/g)
}

// Standalone drift guard: the app/entry/app.tsx route spine, ordering, and negatives.
//
// override-batch-contract.test.ts (retired as snapshot theater) encoded ONE
// invariant worth keeping: app/entry/app.tsx composes the upstream route spine, in the
// right order, without retired constructs. The router routes are JSX (there is
// no exported route table to assert against), so per CONTRIBUTING this stays a
// named source-shape rule here — not a Bun.file+toContain grep scattered in a
// pages/*.test.ts. Baseline: empty — app/entry/app.tsx must satisfy every marker.
// ---------------------------------------------------------------------------
export const APP_ROOT_ROUTE_FILE = "app/entry/app.tsx"

// Provider + route markers that must be present in app/entry/app.tsx's route spine.
const APP_ROUTE_SPINE_REQUIRED = [
  "<ServerProvider",
  "<GlobalSyncProvider>",
  'path="/:dir"',
  'path="/s/:sessionId"',
  'path="/w/:workspaceId"',
  'path="/permissions"',
  'path="/config"',
] as const

// Retired upstream constructs that must NOT reappear in app/entry/app.tsx.
const APP_ROUTE_SPINE_FORBIDDEN = ["ServerKey"] as const

// The specific "/marketplace" route must be registered BEFORE the catch-all
// "/:dir" directory route; otherwise SolidJS router matches "/:dir" first and
// "/marketplace" becomes dead.
export function appRouteSpineViolations(source: string): Finding[] {
  const findings: Finding[] = []
  for (const token of APP_ROUTE_SPINE_REQUIRED) {
    if (!source.includes(token)) {
      findings.push({ file: APP_ROOT_ROUTE_FILE, line: 1, match: `missing route-spine marker: ${token}` })
    }
  }
  const marketplace = source.indexOf('path="/marketplace"')
  const dir = source.indexOf('path="/:dir"')
  if (marketplace === -1) {
    findings.push({ file: APP_ROOT_ROUTE_FILE, line: 1, match: `missing route-spine marker: path="/marketplace"` })
  } else if (dir !== -1 && marketplace > dir) {
    findings.push({
      file: APP_ROOT_ROUTE_FILE,
      line: lineForOffset(source, dir),
      match: `route path="/marketplace" must precede catch-all path="/:dir"`,
    })
  }
  for (const token of APP_ROUTE_SPINE_FORBIDDEN) {
    for (let idx = source.indexOf(token); idx !== -1; idx = source.indexOf(token, idx + 1)) {
      findings.push({ file: APP_ROOT_ROUTE_FILE, line: lineForOffset(source, idx), match: `forbidden marker: ${token}` })
    }
  }
  return findings
}

function regexMetric(name: MetricName, description: string, pattern: RegExp): Metric {
  return {
    name,
    description,
    scan: (files) => files.flatMap((file) => findMatches(file, pattern)),
  }
}

function timerDrivenDataPollMetric(): Metric {
  const allowedByFile = new Map(productionSetIntervalAllowlist.map((entry) => [entry.file, entry.count] as const))
  return {
    name: "timerDrivenDataPolls",
    description: "unapproved timer-driven data polls",
    scan: (files) =>
      files.flatMap((file) => {
        const findings = [
          ...findMatches(file, /setInterval\s*\(/g),
          ...findSelfRearmingDataTimeouts(file),
        ]
        const allowed = allowedByFile.get(file.path) ?? 0
        return findings.slice(allowed)
      }),
  }
}

function isSignedInGateMetric(): Metric {
  const allowed = new Set([
    "platform/auth/auth-session.ts",
    "platform/auth/auth-client.ts",
  ])
  return {
    name: "isSignedInGates",
    description: "`isSignedIn(` gates outside the auth boundary",
    scan: (files) =>
      files
        .filter((file) => !allowed.has(file.path))
        .flatMap((file) => findMatches(file, /isSignedIn\s*\(/g)),
  }
}

function conversationHydrationEntrypointMetric(): Metric {
  const allowed = new Set([
    "features/session/conversation/conversation-hydrator.ts",
    "features/session/conversation/session-conversation-owner.tsx",
    "features/session/conversation/conversation-registry.ts",
  ])
  return {
    name: "conversationHydrationEntrypoints",
    description: "raw conversation hydration entrypoints outside the owner/hydrator",
    scan: (files) =>
      files
        .filter((file) => !allowed.has(file.path))
        .flatMap((file) => findMatches(file, /hydrateRegisteredConversationSnapshot/g)),
  }
}

function runtimeGatewayOutsideTransportMetric(): Metric {
  const allowed = new Set([
    "platform/runtime/transport.ts",
  ])
  return {
    name: "runtimeGatewayOutsideTransport",
    description: "`RuntimeGateway.` references outside runtime gateway and transport seam",
    scan: (files) =>
      files
        .filter((file) => !allowed.has(file.path))
        .flatMap((file) => findMatches(file, /RuntimeGateway\./g)),
  }
}

function lineMetric(name: MetricName, description: string, pattern: RegExp): Metric {
  return {
    name,
    description,
    scan: (files) =>
      files.flatMap((file) =>
        file.text
          .split("\n")
          .flatMap((line, index) => (pattern.test(line) ? [{ file: file.path, line: index + 1, match: line.trim() }] : [])),
      ),
  }
}

function deepSessionUiImportMetric(): Metric {
  const pattern = /from\s+["']@opencode-ai\/session-ui\/[^"']+["']|import\s*\(\s*["']@opencode-ai\/session-ui\/[^"']+["']\s*\)/
  return {
    name: "deepSessionUiImports",
    description: "deep `@opencode-ai/session-ui/*` import lines outside the session-ui barrel",
    scan: (files) =>
      files
        .filter((file) => file.path !== "ui/session-kit.ts")
        .flatMap((file) =>
          file.text
            .split("\n")
            .flatMap((line, index) => (pattern.test(line) ? [{ file: file.path, line: index + 1, match: line.trim() }] : [])),
        ),
  }
}

function fileMetric(name: MetricName, description: string, pattern: RegExp): Metric {
  return {
    name,
    description,
    scan: (files) =>
      files.flatMap((file) => (pattern.test(file.text) ? [{ file: file.path, line: 1, match: pattern.source }] : [])),
  }
}

function bodyMetric(name: MetricName, description: string, callPattern: RegExp, bodyPatterns: RegExp | RegExp[]): Metric {
  return {
    name,
    description,
    scan: (files) =>
      files.flatMap((file) =>
        extractCallBodies(file, callPattern).flatMap((body) => {
          const patterns = Array.isArray(bodyPatterns) ? bodyPatterns : [bodyPatterns]
          if (!patterns.every((pattern) => pattern.test(body.text))) return []
          return [{ file: file.path, line: body.line, match: body.text.slice(0, 120).replace(/\s+/g, " ") }]
        }),
      ),
  }
}

function moduleScopeMutableStateMetric(): Metric {
  const mapOrSet = /^(export\s+)?(const|let)\s+[A-Za-z_$][\w$]*(\s*:[^=]+)?\s*=\s*new\s+(Map|Set)[<(]/
  const solidStore = /^(export\s+)?(const|let)\s+.*=\s*(createSignal|createStore)[<(]/
  return {
    name: "moduleScopeMutableState",
    description: "module-scope mutable state",
    scan: (files) =>
      files.flatMap((file) =>
        file.text.split("\n").flatMap((line, index) => {
          if (!mapOrSet.test(line) && !solidStore.test(line)) return []
          return [{ file: file.path, line: index + 1, match: line.trim() }]
        }),
      ),
  }
}

function findMatches(file: SourceFile, pattern: RegExp) {
  return Array.from(file.text.matchAll(pattern)).map((match) => ({
    file: file.path,
    line: lineForOffset(file.text, match.index ?? 0),
    match: match[0],
  }))
}

function findSelfRearmingDataTimeouts(file: SourceFile) {
  return Array.from(file.text.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/g)).flatMap((match) => {
    const name = match[1]
    const open = file.text.indexOf("{", match.index ?? 0)
    const end = matchingBrace(file.text, open)
    if (!name || open < 0 || end < 0) return []
    if (name === "connect") return []
    const body = file.text.slice(open + 1, end)
    const rearmingTimer =
      new RegExp(`\\bsetTimeout\\s*\\(\\s*${name}\\b`).test(body) ||
      (/\bsetTimeout\s*\(/.test(body) && new RegExp(`\\b${name}\\s*\\(`).test(body))
    if (!rearmingTimer) return []
    if (!/\b(fetch(Query)?|refetch|refreshMeta|input\.refresh|props\.onRetry|actions\.refetch)\b/.test(body)) return []
    return [{
      file: file.path,
      line: lineForOffset(file.text, match.index ?? 0),
      match: `self-rearming setTimeout(${name}) data poll`,
    }]
  })
}

function extractCallBodies(file: SourceFile, callPattern: RegExp) {
  return Array.from(file.text.matchAll(callPattern)).flatMap((match) => {
    const start = match.index ?? 0
    const open = file.text.indexOf("(", start)
    if (open < 0) return []
    const end = matchingParen(file.text, open)
    if (end < 0) return []
    return [{ line: lineForOffset(file.text, start), text: file.text.slice(open + 1, end) }]
  })
}

function matchingParen(text: string, open: number) {
  let depth = 0
  for (let index = open; index < text.length; index++) {
    if (text[index] === "(") depth++
    if (text[index] === ")") depth--
    if (depth === 0) return index
  }
  return -1
}

function matchingBrace(text: string, open: number) {
  let depth = 0
  for (let index = open; index < text.length; index++) {
    if (text[index] === "{") depth++
    if (text[index] === "}") depth--
    if (depth === 0) return index
  }
  return -1
}

function lineForOffset(text: string, offset: number) {
  return text.slice(0, offset).split("\n").length
}
