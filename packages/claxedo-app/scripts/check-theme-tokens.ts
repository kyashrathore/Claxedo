import { readdirSync, statSync } from "node:fs"
import path from "node:path"

type Finding = {
  file: string
  line: number
  column: number
  message: string
  value: string
}

const appRoot = path.resolve(import.meta.dir, "..")
const workspaceRoot = path.resolve(appRoot, "../..")
const appSrc = path.join(appRoot, "src")
const uiSrc = path.join(workspaceRoot, "packages/ui/src")
const tailwindColors = path.join(workspaceRoot, "packages/ui/src/styles/tailwind/colors.css")

const colorPrefixes = [
  "ring-offset",
  "placeholder",
  "decoration",
  "outline",
  "divide",
  "accent",
  "stroke",
  "border",
  "caret",
  "fill",
  "text",
  "ring",
  "from",
  "via",
  "bg",
  "to",
]

const defaultPalette = [
  "slate",
  "gray",
  "zinc",
  "neutral",
  "stone",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
  "black",
  "white",
]

const colorFamilies = [
  "background",
  "surface",
  "button",
  "border",
  "text",
  "icon",
  "input",
  "syntax",
  "markdown",
  "avatar",
  "brand",
  "interactive",
  "critical",
  "danger",
  "warning",
  "success",
  "info",
  "diff",
  "primary",
  "accent",
  "base",
  "base2",
  "base3",
]

const structuralByPrefix: Record<string, RegExp> = {
  bg: /^(fixed|local|scroll|bottom|center|left|right|top|auto|cover|contain|repeat|no-repeat|repeat-x|repeat-y|repeat-round|repeat-space|clip-|origin-|blend-|gradient-to-)/,
  border: /^([xysetrbl]|left|right|top|bottom|color|box|0|2|4|8|solid|dashed|dotted|double|hidden|none|collapse|separate|\[[-.0-9a-zA-Z%]+\])$/,
  divide: /^([xy]|0|2|4|8|solid|dashed|dotted|double|none|\[[-.0-9a-zA-Z%]+\])$/,
  fill: /^(none|current)$/,
  stroke: /^(none|current|0|1|2|\[[-.0-9a-zA-Z%]+\])$/,
  text: /^(\d+|\d+-.+|xs|sm|base|lg|xl|[2-9]xl|left|center|right|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip|\[[-.0-9a-zA-Z%/]+\])$/,
  ring: /^(0|1|2|4|8|inset|\[[-.0-9a-zA-Z%]+\])$/,
  "ring-offset": /^(0|1|2|4|8|\[[-.0-9a-zA-Z%]+\])$/,
  outline: /^(none|0|1|2|4|8|dashed|dotted|double|\[[-.0-9a-zA-Z%]+\])$/,
  from: /^[-.0-9]+%?$/,
  via: /^[-.0-9]+%?$/,
  to: /^[-.0-9]+%?$/,
}

const allowedNonTokenColors = new Set(["transparent", "current", "inherit", "none"])

// Pre-existing token debt in files vendored verbatim from upstream packages/app
// (divorce plan 006). These classes were already live in production via the
// old `@/` upstream fallback; the lint simply never scanned packages/app.
// Keyed by `<file>|<value>` so NEW violations in these files still fail.
const vendoredUpstreamDebt = new Set(
  [
    ["packages/claxedo-app/src/app/workbench/controls/file-tree.tsx", "text-icon-weak"],
    // Video pause/play overlay: contrast is against video CONTENT, not the app theme.
    ["packages/claxedo-app/src/app/dialogs/release-notes.tsx", "bg-black/45"],
    ["packages/claxedo-app/src/app/dialogs/release-notes.tsx", "text-white"],
    ["packages/claxedo-app/src/app/dialogs/release-notes.tsx", "hover:bg-black/60"],
    ["packages/claxedo-app/src/features/session/ui/model/model-tooltip.tsx", "text-text-invert-base"],
    ["packages/claxedo-app/src/app/workbench/titlebar/titlebar.tsx", "focus-within:outline-offset-2"],
    ["packages/claxedo-app/src/app/workbench/titlebar/titlebar.tsx", "text-[#FFF]"],
    ["packages/claxedo-app/src/features/workspaces/ui/dialog-edit-project.tsx", "hover:border-border-strong"],
    ["packages/claxedo-app/src/app/connection/server-row.tsx", "text-text-invert-weak"],
    ["packages/claxedo-app/src/features/settings/ui/keybinds.tsx", "text-text-subtle"],
    ["packages/claxedo-app/src/features/session/composer/ui/image-attachments.tsx", "text-white"],
    ["packages/claxedo-app/src/features/session/composer/ui/context-items.tsx", "text-text-invert-base"],
    ["packages/claxedo-app/src/features/session/composer/ui/slash-popover.tsx", "text-text-subtle"],
    ["packages/ui/src/context/marked.tsx", "var(--color-background-stronger"],
    ["packages/ui/src/components/markdown.css", "var(--color-background-stronger"],
    ["packages/ui/src/components/scroll-view.css", ".dark"],
    ["packages/ui/src/components/scroll-view.css", "[data-theme=\"dark\"]"],
    ["packages/ui/src/components/toast.css", "var(--color-primary"],
    ["packages/ui/src/components/avatar.css", "var(--color-surface-info-base"],
    ["packages/ui/src/components/avatar.css", "var(--color-text-base"],
    ["packages/ui/src/components/avatar.css", "var(--color-border-weak-base"],
  ].map(([file, value]) => `${file}|${value}`),
)
const sourceExtensions = new Set([".css", ".ts", ".tsx"])

const tokenAliases = new Set(
  Array.from((await Bun.file(tailwindColors).text()).matchAll(/--color-([a-z0-9-]+):/g)).map((match) => match[1]),
)

const findings: Finding[] = []

for (const file of listFiles([appSrc, uiSrc])) {
  const relative = path.relative(workspaceRoot, file)
  const content = await Bun.file(file).text()
  const searchable = stripComments(content)

  if (file.endsWith(".tsx")) scanClasses(relative, searchable)
  scanRuntimeVars(relative, searchable)
  scanThemeSelectors(relative, searchable)
}

if (findings.length > 0) {
  console.error("Theme token lint failed:")
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line}:${finding.column} ${finding.message}: ${finding.value}`)
  }
  process.exit(1)
}

console.log("Theme token lint passed.")

function listFiles(roots: string[]) {
  return roots.flatMap((root) => walk(root))
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const file = path.join(dir, entry)
    const stats = statSync(file)
    if (stats.isDirectory()) {
      if (["assets", "dist", "node_modules"].includes(entry)) return []
      return walk(file)
    }

    if (!sourceExtensions.has(path.extname(file))) return []
    if (file.includes(".stories.") || file.includes(".test.") || file.includes(".vitest.")) return []
    if (file.endsWith("styles/tailwind/colors.css")) return []
    return [file]
  })
}

function stripComments(content: string) {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
}

function scanClasses(file: string, content: string) {
  for (const match of content.matchAll(/!?[A-Za-z0-9_\-/[\]&.#()=%:!]+-(?:[A-Za-z0-9_[\]().#%:/!,=&-]+)/g)) {
    const value = match[0]
    if (!isClassContext(content, match.index ?? 0)) continue
    const result = validateClass(value)
    if (!result) continue
    addFinding(file, content, match.index ?? 0, result, value)
  }
}

function validateClass(value: string) {
  const utility = stripModifier(stripVariants(value).replace(/^!/, ""))
  const prefix = colorPrefixes.find((candidate) => utility.startsWith(`${candidate}-`))
  if (!prefix) return
  if (utility.includes("=")) return

  const body = normalizeBody(prefix, utility.slice(prefix.length + 1))
  if (!body) return
  if (allowedNonTokenColors.has(body)) return
  if (tokenAliases.has(body)) return

  if (body.startsWith("[")) {
    if (isNonColorArbitraryValue(prefix, body)) return
    if (body.includes("var(--") && !body.includes("var(--color-")) return
    if (/#(?:[0-9a-fA-F]{3,8})\b|rgba?\(|hsla?\(|oklch\(|color-mix\(/.test(body)) {
      return "Hardcoded arbitrary color utility"
    }
    return
  }

  if (structuralByPrefix[prefix]?.test(body)) return

  if (defaultPalette.some((color) => body === color || body.startsWith(`${color}-`))) {
    return "Default Tailwind palette color is not theme-aware"
  }

  if (prefix === "text" && !colorFamilies.some((family) => body === family || body.startsWith(`${family}-`))) return
  return "Unknown theme token utility"
}

function isClassContext(content: string, index: number) {
  const before = content.slice(0, index)
  const lines = before.split("\n")
  const context = lines.slice(Math.max(lines.length - 4, 0)).join("\n")
  return /class(List|Name)?\s*=|classList\s*={{|cn\(|tw\(/.test(context)
}

function normalizeBody(prefix: string, body: string) {
  if (prefix !== "border") return body
  const side = body.match(/^(x|y|s|e|t|r|b|l)-(.+)$/)
  if (!side) return body
  if (structuralByPrefix.border.test(side[2])) return ""
  return side[2]
}

function stripVariants(value: string) {
  let depth = 0
  let lastColon = -1
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "[") depth++
    if (value[index] === "]") depth--
    if (value[index] === ":" && depth === 0) lastColon = index
  }
  return lastColon === -1 ? value : value.slice(lastColon + 1)
}

function stripModifier(value: string) {
  let depth = 0
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "[") depth++
    if (value[index] === "]") depth--
    if (value[index] === "/" && depth === 0) return value.slice(0, index)
  }
  return value
}

function isNonColorArbitraryValue(prefix: string, body: string) {
  const value = body.slice(1, -1)
  if (["text", "border", "ring", "outline", "stroke"].includes(prefix) && /^[-.0-9]+(px|rem|em|ch|vh|vw|%)?$/.test(value)) return true
  if (prefix === "bg" && /^(url|length|position|size):/.test(value)) return true
  return false
}

function scanRuntimeVars(file: string, content: string) {
  for (const match of content.matchAll(/var\(--color-[a-z0-9-]+/g)) {
    addFinding(file, content, match.index ?? 0, "Runtime styles must use raw theme variables, not Tailwind aliases", match[0])
  }
}

function scanThemeSelectors(file: string, content: string) {
  for (const match of content.matchAll(/\[data-theme=(["'])dark\1\]/g)) {
    addFinding(file, content, match.index ?? 0, "Use data-color-scheme for light/dark selectors", match[0])
  }

  if (!file.endsWith(".css")) return
  for (const match of content.matchAll(/(^|[,{]\s*)\.dark(?=[\s,{.:#[>])/gm)) {
    addFinding(file, content, (match.index ?? 0) + match[1].length, "Use data-color-scheme for light/dark selectors", ".dark")
  }
}

function addFinding(file: string, content: string, index: number, message: string, value: string) {
  if (vendoredUpstreamDebt.has(`${file}|${value}`)) return
  const prefix = content.slice(0, index)
  const lines = prefix.split("\n")
  findings.push({
    file,
    line: lines.length,
    column: lines.at(-1)!.length + 1,
    message,
    value,
  })
}
