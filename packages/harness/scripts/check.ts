import { readFileSync, readdirSync } from "node:fs"
import { dirname, join, posix, relative } from "node:path"
import { builtinModules } from "node:module"
import ts from "typescript-5"

export type Rule =
  | "no-comments"
  | "size"
  | "core-boundary"
  | "transport-boundary"
  | "no-policy-in-transports"
  | "process-wide-state"
  | "no-swallowed-errors"
  | "no-polling"
  | "one-harness-table"
  | "budget"

export type Violation = { path: string; line: number; rule: Rule; fix: string }
export type Source = { path: string; text: string }

const vendorPrefixes = ["@anthropic-ai/", "@cursor/sdk", "@agentclientprotocol/sdk", "@openai/", "@earendil-works/", "@opencode-ai/"]
const transportVendors: Record<string, string[]> = {
  "claude-sdk": ["@anthropic-ai/claude-agent-sdk"],
  "cursor-sdk": ["@cursor/sdk"],
  acp: ["@agentclientprotocol/sdk"],
  "codex-app-server": [],
  "pi-rpc": [],
  "opencode-sdk": ["@opencode-ai/sdk", "@opencode-ai/plugin", "@opencode-ai/schema"],
}
const coreParts = new Set(["contract", "broker", "registry", "capabilities", "translate"])
const harnessIds = new Set(["claude", "codex", "cursor", "pi", "opencode"])
const decisions = new Set(["allow_once", "allow_always", "deny", "reject_always"])
const pollOwners: string[] = []
const nodeBuiltins = new Set(builtinModules.filter(name => !name.startsWith("bun")))

function lines(text: string): number {
  return text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").length
}

function lineAt(source: ts.SourceFile, position: number): number {
  return source.getLineAndCharacterOfPosition(position).line + 1
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  ts.forEachChild(node, child => walk(child, visit))
}

function nameOf(node: ts.Node): string {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  return node.getText()
}

function importTarget(path: string, specifier: string): string {
  if (specifier.startsWith(".")) return posix.normalize(posix.join(posix.dirname(path), specifier)).replace(/\.(?:[cm]?[jt]sx?)$/, "")
  if (specifier.startsWith("@claxedo/harness/")) return `src/${specifier.slice("@claxedo/harness/".length)}`
  return specifier
}

function isDirective(comment: string): boolean {
  const body = comment.replace(/^\/\/+|^\/\*+|\*\/$/g, "").trim()
  return /^(@ts-expect-error\b|oxlint-disable-next-line\s+\S+|@vite-ignore$|#__PURE__|<reference\s+[^>]+>|@generated\b)/.test(body)
}

function processOwners(agentsText: string): Set<string> {
  const section = agentsText.match(/^## Process-wide state\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1] ?? ""
  const owners = new Set<string>()
  for (const line of section.split("\n")) {
    if (!/^\s*-\s+/.test(line)) continue
    const explicit = line.match(/`(src\/[^`]+\.[cm]?[jt]sx?)`/)
    if (explicit) owners.add(explicit[1])
  }
  return owners
}

function isTestCode(path: string): boolean {
  return /\.test\.[cm]?[jt]sx?$/.test(path) || /\/test-(?:support|utils)\//.test(path)
}

function isGeneratedProtocol(path: string): boolean {
  return /^src\/transports\/codex-app-server\/(?:.*\/)?(?:generated|generated-protocol|protocol)\//.test(path)
}

function isTypeContext(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isTypeNode(parent)) return true
    if (ts.isExpression(parent) || ts.isStatement(parent)) return false
  }
  return false
}

function isProtocolMapping(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) {
      if (/protocol.*(?:map|mapping)|(?:map|mapping).*protocol/i.test(nameOf(parent.name))) return true
    }
    if (ts.isFunctionLike(parent)) return false
  }
  return false
}

function inNamingOperation(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if ((ts.isMethodDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isVariableDeclaration(parent)) && nameOf(parent.name) === "naming") return true
  }
  return false
}

function isTitleDecision(node: ts.Node): boolean {
  const titleName = (value: ts.Node): boolean => /(?:^|\.)title$|^(?:should|decide|generate)Title$/i.test(nameOf(value))
  if (ts.isCallExpression(node) && /^(?:should|decide|generate)Title$/.test(nameOf(node.expression))) return true
  if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) {
    let found = false
    walk(ts.isIfStatement(node) ? node.expression : node.condition, part => { if (ts.isIdentifier(part) || ts.isPropertyAccessExpression(part)) found ||= titleName(part) })
    return found
  }
  return false
}

function currentFunctionName(node: ts.Node): string | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent) && parent.name) return parent.name.text
    if (ts.isFunctionExpression(parent) && parent.name) return parent.name.text
    if ((ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) && ts.isVariableDeclaration(parent.parent)) return nameOf(parent.parent.name)
  }
  return undefined
}

function atModuleScope(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent) || ts.isClassLike(parent)) return false
    if (ts.isSourceFile(parent)) return true
  }
  return false
}

function errorMessage(node: ts.Node): boolean {
  return ts.isPropertyAccessExpression(node) && node.name.text === "message"
}

function isErrorTextMatch(node: ts.Node): boolean {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    if (node.expression.name.text === "includes" && errorMessage(node.expression.expression)) return true
    if (node.expression.name.text === "test" && node.arguments.some(errorMessage) && ts.isRegularExpressionLiteral(node.expression.expression)) return true
  }
  return ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken].includes(node.operatorToken.kind) && (errorMessage(node.left) || errorMessage(node.right))
}

export function check(sources: Source[], agentsText: string, budgets: Record<string, number>): Violation[] {
  const violations: Violation[] = []
  const owners = processOwners(agentsText)
  const totals = new Map<string, number>()
  const firstFile = new Map<string, string>()
  const add = (path: string, line: number, rule: Rule, fix: string) => violations.push({ path, line, rule, fix })

  for (const { path, text } of sources) {
    if (!path.startsWith("src/") || isGeneratedProtocol(path)) continue
    const parts = path.split("/")
    const part = parts[1] === "transports" ? `transports/${parts[2]}` : parts[1]
    const production = !isTestCode(path)
    if (part && production) {
      totals.set(part, (totals.get(part) ?? 0) + lines(text))
      if (!firstFile.has(part)) firstFile.set(part, path)
    }
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text)
    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
      if (token !== ts.SyntaxKind.SingleLineCommentTrivia && token !== ts.SyntaxKind.MultiLineCommentTrivia) continue
      const comment = scanner.getTokenText()
      if (!isDirective(comment)) add(path, lineAt(source, scanner.getTokenPos()), "no-comments", "Remove the comment or use a listed tool directive")
    }
    if (production && lines(text) > 300) add(path, 301, "size", "Split the file along responsibilities to stay at 300 lines or fewer")

    walk(source, node => {
      const line = lineAt(source, node.getStart(source))
      const local = coreParts.has(parts[1])
      const transport = parts[1] === "transports" ? parts[2] : undefined

      if (production && ts.isFunctionLike(node) && "body" in node && node.body && lineAt(source, node.body.end - 1) - lineAt(source, node.body.getStart(source)) + 1 > 40) {
        add(path, line, "size", "Split the function body into functions of 40 lines or fewer")
      }

      const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined
      if (specifier && ts.isStringLiteral(specifier)) {
        const target = importTarget(path, specifier.text)
        const vendor = vendorPrefixes.some(prefix => target === prefix.slice(0, -1) || target.startsWith(prefix))
        if (local && (target.startsWith("src/transports/") || target.startsWith("src/profiles/") || vendor)) {
          add(path, line, "core-boundary", "Move this dependency behind the contract or broker boundary")
        }
        if (transport) {
          const own = target === `src/transports/${transport}` || target.startsWith(`src/transports/${transport}/`)
          const shared = ["src/contract", "src/translate", "src/profiles"].some(folder => target === folder || target.startsWith(`${folder}/`))
          const builtin = nodeBuiltins.has(target.replace(/^node:/, ""))
          const testSupport = !production && (target === "bun:test" || target === "src/test-support" || target.startsWith("src/test-support/"))
          const helper = target === "@claxedo/helpers" || target.startsWith("@claxedo/helpers/") || target === "@claxedo/agent-runtime-contract" || target.startsWith("@claxedo/agent-runtime-contract/") || target === "@claxedo/agent-event-runtime" || target.startsWith("@claxedo/agent-event-runtime/")
          const sdk = (transportVendors[transport] ?? []).some(prefix => target === prefix || target.startsWith(`${prefix}/`))
          if (!(own || shared || builtin || helper || sdk || testSupport)) add(path, line, "transport-boundary", "Import only this transport, contract, translate, profiles, allowed shared packages, Node built-ins, or its listed SDK")
        }
      }

      if (transport && production) {
        if (ts.isStringLiteral(node) && decisions.has(node.text) && !isTypeContext(node) && !isProtocolMapping(node)) add(path, line, "no-policy-in-transports", "Move the request decision to the broker; keep protocol mappings in a named protocol map")
        if (ts.isCallExpression(node) && /^(?:(?:evaluate|run|start|resume)Goals?(?:Loop)?|goalLoop)$/.test(nameOf(node.expression))) add(path, line, "no-policy-in-transports", "Move goal evaluation to the runtime host")
        if (isTitleDecision(node) && !inNamingOperation(node)) add(path, line, "no-policy-in-transports", "Make title decisions in the naming operation")
      }

      if (production && ts.isVariableStatement(node) && ts.isSourceFile(node.parent)) {
        for (const declaration of node.declarationList.declarations) {
          const mutable = !(node.declarationList.flags & ts.NodeFlags.Const)
          if (mutable && !owners.has(path)) add(path, lineAt(source, declaration.getStart(source)), "process-wide-state", "Move mutable state into an instance or list this exact owner in AGENTS.md")
        }
      }
      if (production && ts.isNewExpression(node) && ["Map", "Set", "WeakMap"].includes(nameOf(node.expression)) && atModuleScope(node) && !owners.has(path)) add(path, line, "process-wide-state", "Move mutable state into an instance or list this exact owner in AGENTS.md")

      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "catch" && node.arguments.length && ts.isArrowFunction(node.arguments[0]) && node.arguments[0].parameters.length === 0) add(path, line, "no-swallowed-errors", "Handle and surface the error with a named parameter")
      if (ts.isCatchClause(node) && node.block.statements.length === 0) add(path, line, "no-swallowed-errors", "Handle or rethrow the caught error")
      if (!path.endsWith("/errors.ts") && isErrorTextMatch(node)) add(path, line, "no-swallowed-errors", "Match a typed error in errors.ts instead of message text")

      if (production && ts.isCallExpression(node) && nameOf(node.expression) === "setInterval" && !pollOwners.includes(path)) add(path, line, "no-polling", "Use an event or add a named owner with a reason in the checker")
      if (production && ts.isCallExpression(node) && nameOf(node.expression) === "setTimeout" && !pollOwners.includes(path)) {
        const owner = currentFunctionName(node)
        const callback = node.arguments[0]
        let recursive = !!owner && !!callback && ts.isIdentifier(callback) && callback.text === owner
        if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) walk(callback.body, child => {
          if (ts.isCallExpression(child) && (owner && nameOf(child.expression) === owner || nameOf(child.expression) === "setTimeout")) recursive = true
        })
        if (recursive) add(path, line, "no-polling", "Replace the self-rescheduling timeout with an event or document a named owner")
      }

      if (parts[1] !== "registry") {
        if (ts.isArrayLiteralExpression(node) && node.elements.filter(item => ts.isStringLiteral(item) && harnessIds.has(item.text)).length >= 3) add(path, line, "one-harness-table", "Move the harness id table into src/registry/")
        if (ts.isSwitchStatement(node) && /(?:harness|transport)(?:Id|Kind|Type)?$|(?:harness|transport)\.id$/i.test(node.expression.getText(source))) add(path, line, "one-harness-table", "Move harness or transport id dispatch into src/registry/")
      }
    })
  }

  for (const [part, count] of totals) {
    const limit = budgets[part]
    if (limit === undefined || count > limit) add(firstFile.get(part)!, 1, "budget", limit === undefined ? `Add a reviewed budget for ${part} to budget.json` : `Reduce ${part} from ${count} to ${limit} lines or fewer; update budget.json only for a reviewed budget`)
  }
  return violations.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.rule.localeCompare(b.rule))
}

function collect(root: string): Source[] {
  const results: Source[] = []
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)) results.push({ path: relative(root, absolute).replaceAll("\\", "/"), text: readFileSync(absolute, "utf8") })
    }
  }
  visit(join(root, "src"))
  return results
}

if (import.meta.main) {
  const root = process.argv[2] ?? dirname(dirname(import.meta.path))
  const violations = check(collect(root), readFileSync(join(root, "AGENTS.md"), "utf8"), JSON.parse(readFileSync(join(root, "budget.json"), "utf8")))
  for (const violation of violations) console.error(`${violation.path}:${violation.line} ${violation.rule}: ${violation.fix}`)
  if (violations.length) process.exitCode = 1
  else console.log("harness checks passed")
}
