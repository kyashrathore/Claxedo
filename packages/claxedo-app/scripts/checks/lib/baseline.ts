import { join } from "node:path"
import { rel } from "./files"
import type { Violation } from "./report"

export type Baselined = { readonly file: string; readonly matcher: string; readonly owner: string; readonly reason: string }

export type Candidate = Violation & { readonly text: string }

export function applyBaseline(root: string, entries: readonly Baselined[], candidates: readonly Candidate[]): Violation[] {
  const matched = new Set<Baselined>()
  const reported: Violation[] = []
  for (const candidate of candidates) {
    const path = rel(root, candidate.file)
    const text = candidate.text.replace(/\s+/g, " ").trim()
    const entry = entries.find((item) => item.file === path && text.includes(item.matcher))
    if (entry) matched.add(entry)
    else reported.push({ file: candidate.file, line: candidate.line, message: candidate.message })
  }
  for (const entry of entries) {
    if (matched.has(entry)) continue
    reported.push({ file: join(root, entry.file), line: 1, message: `fixed: remove it from the baseline: "${entry.matcher}" (owner: ${entry.owner})` })
  }
  return reported
}

export function isTestFile(file: string): boolean {
  return /\.(test|spec|vitest)\.[cm]?[jt]sx?$/.test(file)
}
