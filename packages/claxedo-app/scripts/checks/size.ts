import { codeExtensions, listFiles, packageRoot, rel, under } from "./lib/files"
import { endLine, lineCount, readSource, startLine, type Source } from "./lib/parse"
import { finish, type Violation } from "./lib/report"
import { containsJsx, functionName, isFunctionNode, walk, type FunctionNode } from "./lib/tree"

const fileLimit = 300
const functionLimit = 40
const componentLimit = 120
const measuredOnly = ["src/transcript", "src/session/view/timeline"]

function main(): never {
  const appFiles = listFiles(packageRoot, ["src", "scripts"], codeExtensions)
  const e2eFiles = new Set(listFiles(packageRoot, ["e2e"], codeExtensions))
  const violations: Violation[] = []
  const measured: Violation[] = []
  for (const file of [...appFiles, ...e2eFiles]) {
    const source = readSource(file)
    const found = e2eFiles.has(file) ? fileSize(source) : [...fileSize(source), ...functionSizes(source)]
    const bucket = measuredOnly.some((folder) => under(packageRoot, file, folder)) ? measured : violations
    bucket.push(...found)
  }
  for (const item of measured) {
    console.error(`measured, not enforced: ${rel(packageRoot, item.file)}:${item.line}: ${item.message}`)
  }
  finish("size", packageRoot, violations, appFiles.length + e2eFiles.size)
}

function fileSize({ file, text }: Source): Violation[] {
  const lines = lineCount(text)
  if (lines <= fileLimit) return []
  return [{ file, line: 1, message: `file has ${lines} lines; the limit is ${fileLimit}` }]
}

function functionSizes({ file, sf }: Source): Violation[] {
  const violations: Violation[] = []
  walk(sf, (node) => {
    if (!isFunctionNode(node) || !node.body) return
    const lines = endLine(node, sf) - startLine(node, sf) + 1
    const component = isComponent(node)
    const limit = component ? componentLimit : functionLimit
    if (lines <= limit) return
    const kind = component ? "component" : "function"
    const name = functionName(node) ?? "anonymous"
    violations.push({ file, line: startLine(node, sf), message: `${kind} ${name} has ${lines} lines; the limit is ${limit}` })
  })
  return violations
}

function isComponent(node: FunctionNode): boolean {
  const name = functionName(node)
  return name !== undefined && /^[A-Z]/.test(name) && containsJsx(node)
}

main()
