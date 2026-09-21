import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { REPO_ROOT, walk } from "./closure"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

test("explicit Vite worker URL follows executable source and retains dependency edges", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "closure-worker-"))
  roots.push(root)
  fs.writeFileSync(path.join(root, "entry.ts"), 'import workerUrl from "./validation.worker?worker&url"; new Worker(workerUrl)')
  fs.writeFileSync(path.join(root, "validation.worker.ts"), 'import { evaluate } from "@example/validator/worker"; evaluate()')
  const result = walk({ entry: path.join(root, "entry.ts"), roots: [path.relative(REPO_ROOT, root)], runtimeOnly: true })
  expect(result.modules).toHaveLength(2)
  expect(result.packages).toEqual(["@example/validator"])
  expect(result.edges[0]?.specifier).toBe("./validation.worker?worker&url")
  expect(result.unresolved).toEqual([])
  fs.writeFileSync(path.join(root, "entry.ts"), 'import x from "./validation.worker?unknown"; x()')
  expect(walk({ entry: path.join(root, "entry.ts"), roots: [path.relative(REPO_ROOT, root)] }).unresolved).toHaveLength(1)
})
