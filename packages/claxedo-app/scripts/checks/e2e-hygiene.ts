import { join } from "node:path"
import { codeExtensions, isTestFile, listFiles, packageRoot, rel } from "./lib/files"
import { readSource, startLine, ts } from "./lib/parse"
import { finish, type Violation } from "./lib/report"
import { calleeName, isFunctionNode, textOf, unwrap, walk, type FunctionNode } from "./lib/tree"

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
const steeredReason = "reach the state through the real stack, or name the external failure it stands for in steeredRoutes"
const steeredRoutes: Readonly<Record<string, string>> = {
  "e2e/flows/38-session-sources.spec.ts":
    "stands for a dropped connection on one project's session-list read, a network failure at the external boundary; the flow proves the rail keeps every other project's rows and Retry loads that one",
}

function main(): never {
  const files = listFiles(packageRoot, ["e2e"], codeExtensions)
  const production = listFiles(packageRoot, ["src"], codeExtensions)
  const violations: Violation[] = []
  const steered = new Set<string>()
  for (const file of files) {
    const spec = file.endsWith(".spec.ts")
    if (spec && !flowSpec.test(rel(packageRoot, file))) {
      violations.push({ file, line: 1, message: "spec without its flow number; flows live in e2e/flows/NN-name.spec.ts" })
    }
    const { sf } = readSource(file)
    const path = rel(packageRoot, file)
    walk(sf, (node) => {
      const intercepted = steers(node)
      if (intercepted && steeredRoutes[path]) steered.add(path)
      const message = sleeps(node, spec) ?? cssClass(node) ?? mocks(node) ?? focused(node, spec) ?? (steeredRoutes[path] ? undefined : intercepted)
      if (message) violations.push({ file, line: startLine(node, sf), message })
    })
  }
  for (const path of Object.keys(steeredRoutes)) {
    if (!steered.has(path)) violations.push({ file: join(packageRoot, path), line: 1, message: "an allowlisted route interception is gone; remove its steeredRoutes entry" })
  }
  violations.push(...production.flatMap(testHooks))
  finish("e2e-hygiene", packageRoot, violations, files.length + production.length)
}

export function testHooks(file: string): Violation[] {
  if (isTestFile(file)) return []
  const { sf } = readSource(file)
  const lines = new Set<number>()
  walk(sf, (node) => {
    const text = ts.isIdentifier(node) ? node.text : textOf(node)
    if (text && (/__claxedo(?!PluginFrame\b|PluginRuntime\b)/.test(text) || /(?:^|_)E2E(?:_|$)/.test(text))) lines.add(startLine(node, sf))
  })
  return [...lines].map((line) => ({ file, line, message: "test-only hook in production code; reach the state through the real stack" }))
}

function sleeps(node: ts.Node, spec: boolean): string | undefined {
  if (!ts.isCallExpression(node)) return undefined
  const name = calleeName(node)
  if (name === "waitForTimeout") return "waitForTimeout sleeps; wait on a visible state"
  if (isTestTimeout(node)) return undefined
  return spec && name !== undefined && sleepCallees.has(name) ? `${name} sleeps; wait on a visible state` : undefined
}

function isTestTimeout(call: ts.CallExpression): boolean {
  const callee = unwrap(call.expression)
  return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "test" && callee.name.text === "setTimeout"
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
  return undefined
}

function steers(node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node)) return undefined
  const callee = unwrap(node.expression)
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression) || !routeHandlerParameter(callee.expression)) return undefined
  const method = callee.name.text
  const [argument] = node.arguments
  if (method === "abort") return `route.abort fails a daemon request the stack would answer; ${steeredReason}`
  if (method === "continue" && argument) return `route.continue with overrides sends a request the app never sent; ${steeredReason}`
  if (method === "fulfill" && !(argument && deliversRealResponse(argument))) return `route.fulfill fabricates a daemon response; ${steeredReason}`
  return undefined
}

function routeHandlerParameter(name: ts.Identifier): boolean {
  for (let current = name.parent; current; current = current.parent) {
    if (!isFunctionNode(current)) continue
    const parameter = current.parameters.find((item) => ts.isIdentifier(item.name) && item.name.text === name.text)
    if (parameter) return isRouteHandler(current, parameter)
  }
  return false
}

function isRouteHandler(fn: FunctionNode, parameter: ts.ParameterDeclaration): boolean {
  if (parameter.type && ts.isTypeReferenceNode(parameter.type) && parameter.type.typeName.getText() === "Route") return true
  const call = fn.parent
  return ts.isCallExpression(call) && calleeName(call) === "route" && call.arguments[1] === fn && fn.parameters[0] === parameter
}

function deliversRealResponse(argument: ts.Expression): boolean {
  const options = unwrap(argument)
  if (!ts.isObjectLiteralExpression(options) || options.properties.length !== 1) return false
  const [only] = options.properties
  return !!only?.name && ts.isIdentifier(only.name) && only.name.text === "response"
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

if (import.meta.main) main()
