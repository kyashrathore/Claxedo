import { shown } from "./files"

export type Violation = { readonly file: string; readonly line: number; readonly message: string }

export function finish(name: string, root: string, violations: readonly Violation[], scanned: number): never {
  const sorted = [...violations].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  for (const item of sorted) console.log(`${shown(root, item.file)}:${item.line} ${name} ${oneLine(item.message)}`)
  const noun = sorted.length === 1 ? "violation" : "violations"
  console.error(`${name}: ${sorted.length} ${noun} in ${scanned} files`)
  process.exit(sorted.length === 0 ? 0 : 1)
}

function oneLine(message: string): string {
  return message.replace(/\s+/g, " ").trim()
}
