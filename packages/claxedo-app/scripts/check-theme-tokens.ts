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
const sessionUiSrc = path.join(workspaceRoot, "packages/session-ui/src")
const tailwindColors = path.join(workspaceRoot, "packages/ui/src/styles/tailwind/colors.css")
const typographyUtilities = path.join(workspaceRoot, "packages/ui/src/styles/utilities.css")
const rawThemeDefinitionFiles = new Set([
  "packages/ui/src/styles/colors.css",
  "packages/ui/src/styles/theme.css",
  "packages/ui/src/v2/styles/colors.css",
  "packages/ui/src/v2/styles/theme.css",
])
const allowedRawThemeProperties = new Set([
  "--elevation-shadow-raised",
  "--elevation-prominent",
  "--elevation-sidebar",
])

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
  outline: /^(none|0|1|2|4|8|solid|dashed|dotted|double|offset-|\[[-.0-9a-zA-Z%]+\])/,
  from: /^[-.0-9]+%?$/,
  via: /^[-.0-9]+%?$/,
  to: /^[-.0-9]+%?$/,
}

const allowedNonTokenColors = new Set(["transparent", "current", "inherit", "none"])

const sourceExtensions = new Set([".css", ".ts", ".tsx"])

const arbitraryDesignPrefixes = new Set(["text", "font", "leading", "tracking", "rounded", "shadow"])
const cssDesignProperties = new Set([
  "color",
  "background",
  "background-color",
  "border",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-color",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "outline-color",
  "outline",
  "fill",
  "stroke",
  "font-family",
  "font",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "border-radius",
  "box-shadow",
  "text-shadow",
])

const cssKeywordValues = new Set([
  "0",
  "currentcolor",
  "inherit",
  "initial",
  "none",
  "normal",
  "bolder",
  "canvastext",
  "revert",
  "transparent",
  "unset",
])
const rawColorPattern = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|oklch\([^)]*\)/

const tokenAliases = new Set(
  Array.from((await Bun.file(tailwindColors).text()).matchAll(/--color-([a-z0-9-]+):/g)).map((match) => match[1]),
)
const definedTypographyUtilities = new Set(
  Array.from((await Bun.file(typographyUtilities).text()).matchAll(/\.(text-\d+-(?:regular|medium|mono))\s*\{/g)).map(
    (match) => match[1],
  ),
)

const findings: Finding[] = []

for (const file of listFiles([appSrc, uiSrc, sessionUiSrc])) {
  const relative = path.relative(workspaceRoot, file).replaceAll("\\", "/")
  const content = await Bun.file(file).text()
  const searchable = stripComments(content)

  if (file.endsWith(".tsx")) {
    scanClasses(relative, searchable)
  }
  if (file.endsWith(".ts") || file.endsWith(".tsx")) {
    scanInlineStyles(relative, searchable)
    scanEmbeddedCss(relative, searchable)
  }
  if (file.endsWith(".css")) {
    scanCssDesignDeclarations(relative, searchable)
    scanCssRawColors(relative, searchable, searchable, 0, !rawThemeDefinitionFiles.has(relative))
  }
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
    const result = validateClass(value) ?? validateArbitraryDesignClass(value)
    if (!result) continue
    addFinding(file, content, match.index ?? 0, result, value)
  }

  for (const match of content.matchAll(/\btext-\d+-(?:regular|medium|mono)\b/g)) {
    if (!isClassContext(content, match.index ?? 0)) continue
    if (definedTypographyUtilities.has(match[0])) continue
    addFinding(file, content, match.index ?? 0, "Undefined typography utility", match[0])
  }

  for (const match of content.matchAll(/\[(?:font-family|font-size|font-weight|line-height|letter-spacing):[^\]]+\]/g)) {
    if (!isClassContext(content, match.index ?? 0)) continue
    if (/var\(--[a-z0-9-]+\)/.test(match[0])) continue
    addFinding(file, content, match.index ?? 0, "Arbitrary typography must reference a theme token", match[0])
  }
}

function validateArbitraryDesignClass(value: string) {
  const utility = stripModifier(stripVariants(value).replace(/^!/, ""))
  const prefix = utility.slice(0, utility.indexOf("-["))
  if (!arbitraryDesignPrefixes.has(prefix) || !utility.includes("-[")) return
  const body = utility.slice(prefix.length + 2, -1)
  if (/var\(--[a-z0-9-]+\)/.test(body)) return
  return "Arbitrary design utility must reference a theme token"
}

function scanInlineStyles(file: string, content: string) {
  const property =
    "color|background(?:-color|Color)?|border(?:-color|Color)|font(?:-family|-size|-weight|Family|Size|Weight)|line(?:-height|Height)|letter(?:-spacing|Spacing)|border(?:-radius|Radius)|box(?:-shadow|Shadow)"
  for (const match of content.matchAll(
    new RegExp(`(?:${property})["']?\\s*:\\s*(?:["']([^"']+)["']|(-?\\d+(?:\\.\\d+)?))`, "g"),
  )) {
    const value = (match[1] ?? match[2]).trim()
    if ((value.includes("var(--") && !rawColorPattern.test(value)) || cssKeywordValues.has(value.toLowerCase())) continue
    if (!isStyleContext(content, match.index ?? 0)) continue
    addFinding(file, content, match.index ?? 0, "Inline design value must reference a theme token", value)
  }

  for (const match of content.matchAll(
    new RegExp(`\\.style\\.(?:${property})\\s*=\\s*["']([^"']+)["']`, "g"),
  )) {
    const value = match[1].trim()
    if ((value.includes("var(--") && !rawColorPattern.test(value)) || cssKeywordValues.has(value.toLowerCase())) continue
    addFinding(file, content, match.index ?? 0, "Imperative design value must reference a theme token", value)
  }
}

function isStyleContext(content: string, index: number) {
  const before = content.slice(Math.max(0, index - 1200), index)
  return /style\s*=\s*\{\{[^}]*$/s.test(before) || /Object\.assign\([^,]+\.style\s*,\s*\{[^}]*$/s.test(before)
}

function scanEmbeddedCss(file: string, content: string) {
  for (const match of content.matchAll(/\b(?:export\s+)?const\s+\w*(?:CSS|Styles)\s*=\s*`([\s\S]*?)`/g)) {
    const css = match[1]
    const offset = (match.index ?? 0) + match[0].indexOf(css)
    scanCssDesignDeclarations(file, css, content, offset)
    scanCssRawColors(file, css, content, offset, true)
  }
}

function scanCssDesignDeclarations(file: string, content: string, source = content, offset = 0) {
  for (const match of content.matchAll(/(^|[;{]\s*)([a-z-]+)\s*:\s*([^;}{]+)(?=;|})/gm)) {
    const property = match[2]
    if (!cssDesignProperties.has(property)) continue
    const value = match[3].trim()
    const normalized = value.replace(/!important\s*$/, "").trim().toLowerCase()
    if (value.includes("var(--") || cssKeywordValues.has(normalized)) continue
    if (
      /^border(?:-(?:top|right|bottom|left))?$/.test(property) &&
      /^(?:0(?:\s+solid)?|[\d.]+px\s+solid\s+(?:transparent|canvastext))$/.test(normalized)
    )
      continue
    if (property === "outline" && /^(?:auto|[\d.]+px\s+solid\s+transparent)$/.test(normalized)) continue
    if (property === "color" && /^color-mix\([^)]*currentcolor[^)]*transparent[^)]*\)$/i.test(value)) continue
    if (property === "font-family") {
      const before = content.slice(0, match.index ?? 0)
      if (before.lastIndexOf("@font-face") > before.lastIndexOf("}")) continue
    }
    if (property === "border-radius" && ["0", "50%"].includes(normalized)) continue
    addFinding(
      file,
      source,
      offset + (match.index ?? 0) + match[1].length,
      "CSS design declaration must reference a theme token",
      `${property}: ${value}`,
    )
  }
}

function scanCssRawColors(file: string, content: string, source = content, offset = 0, scanCustomProperties = false) {
  for (const match of content.matchAll(/(^|[;{]\s*)([a-z-]+)\s*:\s*([^;}{]+)(?=;|})/gm)) {
    const property = match[2]
    const value = match[3].trim()
    if (property.startsWith("--") && (!scanCustomProperties || allowedRawThemeProperties.has(property))) continue
    if (property.includes("mask")) continue
    if (cssDesignProperties.has(property) && !value.includes("var(--")) continue
    const valueWithoutRelativeTokenColors = value.replace(/(?:hsl|rgb)\(from\s+var\(--[^)]+\)[^)]*\)/gi, "")
    const raw = valueWithoutRelativeTokenColors.match(rawColorPattern)
    if (!raw) continue
    addFinding(
      file,
      source,
      offset + (match.index ?? 0) + match[1].length,
      "CSS colors must reference a theme token without raw fallbacks",
      `${property}: ${value}`,
    )
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
  const currentLine = content.slice(before.lastIndexOf("\n") + 1, index)
  if (/\b(?:name|icon)\s*=\s*["'][^"']*$/.test(currentLine)) return false
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
