import { traceDirectories, type DirectoryValues } from "./lib/directory-flow"
import { codeExtensions, listFiles, packageRoot, rel, under } from "./lib/files"
import { compilerOptions, createProgram, startLine, ts } from "./lib/parse"
import { finish, type Violation } from "./lib/report"
import { calleeName, textOf, unwrap, walk } from "./lib/tree"

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
const keyedCalls = new Set(["persistedSignal", "persistedStore", "setItem", "getItem", "removeItem", "set", "get", "has", "delete"])
const memberCollections = new Set(["Set", "ReadonlySet", "WeakSet"])
const identityProperty = /^(id|key|[a-z]+Id)$/
const guidance = "key by project id, placement id or SessionLocation; only src/server turns a placement into a directory"

function main(): never {
  const files = listFiles(packageRoot, ["src"], codeExtensions)
  const program = createProgram(files, compilerOptions())
  const checker = program.getTypeChecker()
  const directories = traceDirectories(program, files, identityNames)
  const violations: Violation[] = []
  for (const file of files) {
    const sf = program.getSourceFile(file)
    if (!sf || under(packageRoot, file, "src/server")) continue
    walk(sf, (node) => {
      const message = directoryIdentity(node, directories)
      if (message) violations.push({ file, line: startLine(node, sf), message })
    })
  }
  finish("no-directory-identity", packageRoot, violations, files.length)

  function directoryIdentity(node: ts.Node, values: DirectoryValues): string | undefined {
    const text = textOf(node)
    if (text !== undefined && routePatterns.some((pattern) => pattern.test(text))) {
      return `directory in a route or query string; ${guidance}`
    }
    const key = identityKey(node, checker)
    const origin = key && values.originOf(key.expression)
    return origin ? `${key.use} holds the folder path ${origin.name} from ${rel(packageRoot, origin.file)}:${origin.line}; ${guidance}` : undefined
  }
}

type IdentityKey = { readonly use: string; readonly expression: ts.Expression }

function identityKey(node: ts.Node, checker: ts.TypeChecker): IdentityKey | undefined {
  if (ts.isCallExpression(node)) {
    const name = calleeName(node)
    const [key] = node.arguments
    if (!name || !keyedCalls.has(name) || !key || isSetMember(node, checker)) return undefined
    return { use: `${name}(${key.getText()})`, expression: key }
  }
  if (ts.isElementAccessExpression(node)) return { use: `the index ${node.argumentExpression.getText()}`, expression: node.argumentExpression }
  if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && identityProperty.test(node.name.text)) {
    return { use: node.name.text, expression: unwrap(node.initializer) }
  }
  if (ts.isJsxAttribute(node) && node.name.getText() === "key" && node.initializer && ts.isJsxExpression(node.initializer)) {
    return node.initializer.expression ? { use: "key", expression: node.initializer.expression } : undefined
  }
  if (ts.isExpression(node) && ts.isArrayLiteralExpression(node.parent) && inQueryKey(node.parent)) return { use: "a query key", expression: node }
  return undefined
}

function isSetMember(call: ts.CallExpression, checker: ts.TypeChecker): boolean {
  const callee = unwrap(call.expression)
  if (!ts.isPropertyAccessExpression(callee)) return false
  const receiver = checker.getTypeAtLocation(callee.expression).getNonNullableType()
  return memberCollections.has(receiver.getSymbol()?.getName() ?? "")
}

function inQueryKey(array: ts.ArrayLiteralExpression): boolean {
  return ts.isPropertyAssignment(array.parent) && ts.isIdentifier(array.parent.name) && array.parent.name.text === "queryKey"
}

main()
