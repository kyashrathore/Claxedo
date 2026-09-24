import { codeExtensions, listFiles, parseArgs, rel } from "./lib/files"
import { readSource, startLine, ts } from "./lib/parse"
import { finish, type Violation } from "./lib/report"
import { calleeName, textOf, unwrap, walk } from "./lib/tree"

const flowSpec = /^e2e\/flows\/\d{2}-[a-z0-9]+(-[a-z0-9]+)*\.spec\.ts$/
const selectorCallees = new Set([
  "locator",
  "$",
  "$$",
  "$eval",
  "$$eval",
  "waitForSelector",
  "frameLocator",
  "querySelector",
  "querySelectorAll",
  "click",
  "dblclick",
  "hover",
  "check",
  "uncheck",
  "focus",
  "tap",
  "innerText",
  "textContent",
  "inputValue",
  "isVisible",
  "isHidden",
  "isEnabled",
  "isChecked",
])
const engines = /^(text|role|xpath|id|data-testid|data-test-id|data-test|nth|visible|has-text|_react|_vue)=/
const classSelector = /(^|[\s>+~,(])[a-zA-Z0-9_-]*\.[A-Za-z_][\w-]*/
const sleepCallees = new Set(["setTimeout", "sleep", "delay"])
const moduleMocks = new Set(["vi.mock", "jest.mock", "mock.module"])
const fakeBoundary = "fakes live only at external boundaries, as real processes"

function main(): never {
  const { root } = parseArgs(process.argv.slice(2))
  const files = listFiles(root, ["e2e"], codeExtensions)
  const violations: Violation[] = []
  for (const file of files) {
    const spec = file.endsWith(".spec.ts")
    if (spec && !flowSpec.test(rel(root, file))) {
      violations.push({ file, line: 1, message: "spec without its flow number; flows live in e2e/flows/NN-name.spec.ts" })
    }
    const { sf } = readSource(file)
    walk(sf, (node) => {
      const message = sleeps(node, spec) ?? cssClass(node) ?? mocks(node) ?? focused(node, spec)
      if (message) violations.push({ file, line: startLine(node, sf), message })
    })
  }
  finish("e2e-hygiene", root, violations, files.length)
}

function sleeps(node: ts.Node, spec: boolean): string | undefined {
  if (!ts.isCallExpression(node)) return undefined
  const name = calleeName(node)
  if (name === "waitForTimeout") return "waitForTimeout sleeps; wait on a visible state"
  return spec && name !== undefined && sleepCallees.has(name) ? `${name} sleeps; wait on a visible state` : undefined
}

function cssClass(node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node)) return undefined
  const name = calleeName(node)
  if (!name || !selectorCallees.has(name)) return undefined
  const [argument] = node.arguments
  const text = argument ? textOf(argument) : undefined
  if (text === undefined || !text.split(">>").some((part) => isClassSelector(part.trim()))) return undefined
  return `CSS-class selector "${text}"; select by role and accessible name, then by the frozen hook list`
}

function isClassSelector(text: string): boolean {
  if (engines.test(text) || text.startsWith("//") || text.startsWith("internal:")) return false
  const bare = text
    .replace(/^css=/, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/"[^"]*"|'[^']*'/g, "")
    .replace(/:has-text\([^)]*\)/g, "")
  return classSelector.test(bare)
}

function mocks(node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node)) return undefined
  const callee = unwrap(node.expression)
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    const pair = `${callee.expression.text}.${callee.name.text}`
    if (moduleMocks.has(pair)) return `${pair} fakes a module; ${fakeBoundary}`
  }
  if (calleeName(node) === "route" && node.arguments.slice(1).some(fulfills)) {
    return `route() fabricates a response; ${fakeBoundary}`
  }
  return undefined
}

function fulfills(node: ts.Node): boolean {
  let found = false
  walk(node, (child) => {
    if (ts.isCallExpression(child) && calleeName(child) === "fulfill") found = true
  })
  return found
}

function focused(node: ts.Node, spec: boolean): string | undefined {
  if (!spec) return undefined
  if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "retries") {
    return "retries hide flakes; find the cause"
  }
  if (!ts.isCallExpression(node)) return undefined
  const callee = unwrap(node.expression)
  const only = ts.isPropertyAccessExpression(callee) && callee.name.text === "only"
  return only ? "test.only leaves the suite behind; remove it" : undefined
}

main()
