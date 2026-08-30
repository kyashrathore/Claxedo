import fs from "fs/promises"
import path from "path"

const ROOT = path.resolve(import.meta.dirname, "..")
const MAX_PRODUCTION_LINES = 1_000
const correctiveTone = /\b(?:regression|previously|used to|old version|bug this|what noticed|clobbered|drifted)\b|\bU\d+(?:-F\d+)?\b/i
const failures: string[] = []

for await (const relative of new Bun.Glob("{src,docs}/**/*.{ts,md}").scan({ cwd: ROOT })) {
  const content = await fs.readFile(path.join(ROOT, relative), "utf8")
  const lines = content.split("\n")
  if (relative.endsWith(".ts") && !relative.endsWith(".test.ts") && lines.length > MAX_PRODUCTION_LINES) {
    failures.push(`${relative}: ${lines.length} lines exceeds ${MAX_PRODUCTION_LINES}`)
  }
  lines.forEach((line, index) => {
    if (!/^\s*(?:\/\/|\/\*|\*)/.test(line)) return
    if (correctiveTone.test(line)) failures.push(`${relative}:${index + 1}: corrective-history comment`)
  })
}

if (failures.length) {
  console.error(failures.join("\n"))
  process.exit(1)
}

console.log(`Source shape verified: production files <= ${MAX_PRODUCTION_LINES} lines and comments are context-independent.`)
