import { codeExtensions, listFiles, parseArgs, under } from "./lib/files"
import { readSource, startLine, ts } from "./lib/parse"
import { finish, type Violation } from "./lib/report"
import { calleeName, identifierIn, textOf, unwrap, walk } from "./lib/tree"

const identityNames = new Set([
  "directory",
  "worktree",
  "worktreePath",
  "cwd",
  "folderPath",
  "projectPath",
  "workspacePath",
  "projectDirectory",
  "workspaceDirectory",
  "rootDirectory",
  "legacyDirectory",
])
const routePatterns = [/[?&]directory=/, /:directory\b/, /legacy-directory/, /\/directory\//]
const keyedCalls = new Set(["persisted", "makePersisted", "setItem", "getItem", "removeItem", "set", "get", "has", "delete", "del"])
const identityProperty = /^(id|key|[a-z]+Id)$/
const guidance = "key by project id, placement id or SessionRef; only src/server turns a placement into a directory"

function main(): never {
  const { root } = parseArgs(process.argv.slice(2))
  const files = listFiles(root, ["src", "plugins"], codeExtensions)
  const violations: Violation[] = []
  for (const file of files) {
    if (under(root, file, "src/server")) continue
    const { sf } = readSource(file)
    walk(sf, (node) => {
      const message = directoryIdentity(node)
      if (message) violations.push({ file, line: startLine(node, sf), message })
    })
  }
  finish("no-directory-identity", root, violations, files.length)
}

function directoryIdentity(node: ts.Node): string | undefined {
  const text = textOf(node)
  if (text !== undefined && routePatterns.some((pattern) => pattern.test(text))) {
    return `directory in a route or query string; ${guidance}`
  }
  return keyedByDirectory(node) ?? storedAsIdentity(node) ?? routeParameter(node)
}

function keyedByDirectory(node: ts.Node): string | undefined {
  if (ts.isCallExpression(node)) {
    const name = calleeName(node)
    if (!name || !keyedCalls.has(name)) return undefined
    const found = node.arguments.map((argument) => identifierIn(argument, identityNames)).find(Boolean)
    return found ? `${name}(${found.text}) keys by folder path; ${guidance}` : undefined
  }
  if (ts.isElementAccessExpression(node)) {
    const found = identifierIn(node.argumentExpression, identityNames)
    return found ? `indexes by ${found.text}; ${guidance}` : undefined
  }
  if (ts.isArrayLiteralExpression(node) && ts.isPropertyAssignment(node.parent) && ts.isIdentifier(node.parent.name)) {
    const found = node.parent.name.text === "queryKey" ? identifierIn(node, identityNames) : undefined
    return found ? `query key contains ${found.text}; ${guidance}` : undefined
  }
  return undefined
}

function storedAsIdentity(node: ts.Node): string | undefined {
  if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && identityProperty.test(node.name.text)) {
    const found = identifierIn(unwrap(node.initializer), identityNames)
    return found ? `${node.name.text} holds ${found.text}; ${guidance}` : undefined
  }
  if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === "key" && node.initializer) {
    const found = identifierIn(node.initializer, identityNames)
    return found ? `key holds ${found.text}; ${guidance}` : undefined
  }
  return undefined
}

function routeParameter(node: ts.Node): string | undefined {
  if (!ts.isBindingElement(node) || !ts.isIdentifier(node.name)) return undefined
  const name = node.propertyName && ts.isIdentifier(node.propertyName) ? node.propertyName.text : node.name.text
  if (!identityNames.has(name)) return undefined
  const declaration = node.parent.parent
  if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) return undefined
  const initializer = unwrap(declaration.initializer)
  const fromParams = ts.isCallExpression(initializer) && calleeName(initializer) === "useParams"
  return fromParams ? `route parameter ${name}; routes use ids` : undefined
}

main()
