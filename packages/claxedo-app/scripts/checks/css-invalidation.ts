import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, resolve as resolvePath } from "node:path"
import { applyBaseline, isTestFile, type Baselined, type Candidate } from "./lib/baseline"
import { codeExtensions, listFiles, packageRoot, repoRoot, styleExtensions, under } from "./lib/files"
import { parseStylesheet, type Declaration, type StyleRule } from "./lib/css"
import { compilerOptions, createResolver, importsOf, readSource, startLine, ts, type Resolver } from "./lib/parse"
import { finish } from "./lib/report"
import { carriesState, isFeatureless, isStructural, rightmost } from "./lib/selectors"
import { walk } from "./lib/tree"

const baseline: readonly Baselined[] = [
  { file: "src/settings/view/settings.css", matcher: ".settings-toolbar > :first-child", owner: "settings", reason: "first toolbar child loses its margin; give the child a class" },
  { file: "src/shell/styles/index.css", matcher: '[data-action="prompt-harness-model"] > :not(:first-child)', owner: "composer", reason: "collapsed composer hides the model button's trailing children; give them a class" },
  { file: "src/onboarding/view/first-project-canvas.css", matcher: "> form > *:nth-child(", owner: "onboarding", reason: "the project step staggers its form rows by position; give each row its delay" },
  { file: "src/tasks/view/tasks.css", matcher: '.tsk-dot[data-liveness="live"] { animation:', owner: "tasks", reason: "pulse on a live task's dot for as long as it is live" },
  { file: "src/auth/view/auth.css", matcher: "animation: auth-spin", owner: "auth", reason: "spinner while a sign-in request is pending" },
  { file: "src/shell/styles/ui-overrides.css", matcher: "animation: tl-dot-wave", owner: "shell", reason: "typing dots while a turn is running" },
  { file: "src/transcript/agent-glyph.css", matcher: "animation: agent-glyph-pulse", owner: "transcript", reason: "the agent glyph pulses while the agent is active" },
  { file: "src/workbench/workbench.css", matcher: "animation: workbench-handover-cue", owner: "workbench", reason: "the handover's progress line sweeps while mounted, and is mounted only while a pane hands over" },
  { file: "src/onboarding/view/first-project-canvas.css", matcher: "animation: first-project-drift", owner: "onboarding", reason: "the first-project canvas hatch drifts for the whole onboarding screen" },
  { file: "src/shell/styles/index.css", matcher: '[data-component="session-progress-bar"] { will-change: clip-path', owner: "shell", reason: "always-on hint on the progress bar; set it only while a turn is running" },
  { file: "src/shell/styles/app-shell.css", matcher: ".claxedo-pop-bounce { will-change: transform", owner: "shell", reason: "hint for a one-shot bounce; the animation alone promotes the layer" },
  { file: "src/transcript/tool-error-card.css", matcher: "will-change: opacity", owner: "transcript", reason: "always-on hint for a hover-revealed action; the opacity transition alone suffices" },
  { file: "src/transcript/session-review.css", matcher: "will-change: opacity", owner: "transcript", reason: "always-on hint for a hover-revealed button; the opacity transition alone suffices" },
  { file: "src/transcript/message-part.css", matcher: "will-change: opacity", owner: "transcript", reason: "always-on hint for hover-revealed message actions; the opacity transition alone suffices" },
  { file: "src/session/view/timeline/markdown-viewer.css", matcher: "will-change: transform", owner: "session", reason: "always-on hint on the viewer's centered placeholder; nothing animates it" },
  { file: "../ui/src/components/icon-button.css", matcher: "animation: stop-pulse", owner: "ui", reason: "the stop button's pulse while a turn runs; the button is mounted only then" },
  { file: "../ui/src/v2/components/text-shimmer-v2.css", matcher: "animation-iteration-count: infinite", owner: "ui", reason: "the swept copy sweeps while mounted, and is mounted only while the shimmer is active" },
]

const kitFolder = "packages/ui"
const styleImport = /@import\s+(?:url\()?["']([^"']+)["']/g

const utilityToken = /^-?(?:[\w[\]/.-]+:)*(?:space-[xy]-[\w[\].-]+|divide-[xy](?:-[\w[\].-]+)?)$/

function main(): never {
  const appSheets = listFiles(packageRoot, ["src"], styleExtensions)
  const code = listFiles(packageRoot, ["src"], codeExtensions).filter((file) => !isTestFile(file))
  const sheets = [...appSheets, ...kitSheets(code, appSheets)]
  const candidates = [...sheets.flatMap(sheetViolations), ...code.flatMap(utilityViolations)]
  finish("css-invalidation", packageRoot, applyBaseline(packageRoot, baseline, candidates), sheets.length + code.length)
}

function kitSheets(code: readonly string[], sheets: readonly string[]): string[] {
  const resolve = createResolver(compilerOptions())
  const seen = new Set<string>()
  const found = new Set<string>()
  const visit = (target: string | undefined): void => {
    if (!target || !under(repoRoot, target, kitFolder) || seen.has(target)) return
    seen.add(target)
    if (target.endsWith(".css")) {
      found.add(target)
      for (const next of styleImports(target)) visit(next)
    } else if (/\.tsx?$/.test(target) && !isTestFile(target)) {
      for (const next of codeImports(target, resolve)) visit(next)
    }
  }
  for (const file of code) for (const target of codeImports(file, resolve)) visit(target)
  for (const file of sheets) for (const target of styleImports(file)) visit(target)
  return [...found].sort()
}

function codeImports(file: string, resolve: Resolver): (string | undefined)[] {
  return importsOf(readSource(file).sf).map(({ specifier }) => (specifier.endsWith(".css") ? sheetPath(file, specifier) : resolve(file, specifier)))
}

function styleImports(file: string): (string | undefined)[] {
  return [...readFileSync(file, "utf8").matchAll(styleImport)].map((match) => sheetPath(file, match[1] ?? ""))
}

function sheetPath(from: string, specifier: string): string | undefined {
  const path = specifier.startsWith(".") ? resolvePath(dirname(from), specifier) : resolvedSheet(from, specifier)
  return path && existsSync(path) ? realpathSync(path) : undefined
}

function resolvedSheet(from: string, specifier: string): string | undefined {
  try {
    return Bun.resolveSync(specifier, dirname(from))
  } catch {
    return undefined
  }
}

function sheetViolations(file: string): Candidate[] {
  const out: Candidate[] = []
  for (const rule of parseStylesheet(readFileSync(file, "utf8"))) {
    for (const selector of rule.selectors) {
      const message = selectorProblem(selector)
      if (message) out.push({ file, line: rule.line, text: selector, message })
    }
    for (const declaration of rule.declarations) {
      const message = declarationProblem(rule, declaration)
      if (message) out.push({ file, line: declaration.line, text: `${rule.selectors.join(", ")} { ${declaration.property}: ${declaration.value} }`, message })
    }
  }
  return out
}

function selectorProblem(selector: string): string | undefined {
  const last = rightmost(selector)
  if (!last || !isFeatureless(last.text)) return undefined
  if (isStructural(last.text)) {
    return `"${selector}" ends in a featureless structural compound; Blink restyles the whole subtree on every sibling change. Name the child with a class`
  }
  if (last.combinator === "+" || last.combinator === "~") {
    return `"${selector}" ends in a featureless sibling compound; Blink restyles the whole subtree on every sibling change. Name the sibling with a class`
  }
  return undefined
}

function declarationProblem(rule: StyleRule, declaration: Declaration): string | undefined {
  const { property, value } = declaration
  const tokens = value.split(/[\s,]+/)
  if ((property === "animation" || property === "animation-iteration-count") && tokens.includes("infinite")) {
    return `an infinite animation keeps the compositor awake; run it only while a state attribute says so, or bound it`
  }
  if (property !== "will-change" || value.trim() === "auto") return undefined
  const stateless = rule.selectors.find((selector) => !carriesState(rightmost(selector)?.text ?? ""))
  if (stateless === undefined) return undefined
  return `will-change: ${value} on "${stateless}" holds a compositor layer forever; set it under :hover, :focus or a state attribute`
}

function utilityViolations(file: string): Candidate[] {
  const { sf } = readSource(file)
  const out: Candidate[] = []
  walk(sf, (node) => {
    for (const text of literalTexts(node)) {
      for (const token of new Set(text.split(/\s+/))) {
        if (utilityToken.test(token)) out.push({ file, line: startLine(node, sf), text: token, message: `${token} styles siblings through a featureless structural selector; use gap` })
      }
    }
  })
  return out
}

function literalTexts(node: ts.Node): string[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text]
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)]
  if (ts.isJsxText(node)) return [node.text]
  return []
}

main()
