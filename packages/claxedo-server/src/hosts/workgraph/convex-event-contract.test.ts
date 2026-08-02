import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"
import { WorkGraphEventTypeSchema } from "@claxedo/workgraph/contracts"

/**
 * Convex writes change events that the WorkGraph HTTP router re-validates
 * against WorkGraphEventTypeSchema. A type emitted by Convex but absent from
 * the contract turns every /changes read that includes it into a generic 500
 * and stalls client change-sync (staging incident: stream_deletion_requested).
 */
test("every Convex-emitted WorkGraph event type is in the contract enum", () => {
  const convexDir = join(__dirname, "../../../../../convex")
  const sources = readdirSync(convexDir)
    .filter((name) => name.startsWith("workgraph") && name.endsWith(".ts"))
    .map((name) => readFileSync(join(convexDir, name), "utf8"))
  const emitted = new Set<string>()
  for (const source of sources) {
    for (const match of source.matchAll(/\bpending\(\s*\n?\s*"([a-z_]+)"/g)) emitted.add(match[1]!)
    for (const match of source.matchAll(/\bevent_type:\s*"([a-z_]+)"/g)) emitted.add(match[1]!)
    for (const match of source.matchAll(/\bemitWorkGraphEvent\(\s*\n?\s*"([a-z_]+)"/g)) emitted.add(match[1]!)
  }
  expect(emitted.size).toBeGreaterThan(0)
  const known = new Set<string>(WorkGraphEventTypeSchema.options)
  const missing = [...emitted].filter((type) => !known.has(type)).sort()
  expect(missing).toEqual([])
})
