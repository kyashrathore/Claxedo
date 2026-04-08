import { describe, expect, test } from "bun:test"
import path from "node:path"

const root = path.join(import.meta.dir)

async function html(name: string) {
  return Bun.file(path.join(root, name)).text()
}

function refs(input: string) {
  return [...input.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)].map((match) => match[1])
}

describe("desktop html contract", () => {
  test("index.html uses only relative local asset paths", async () => {
    const file = await html("index.html")
    expect(file).not.toContain('rel="manifest"')
    expect(file).toContain('src="./index.tsx"')
    for (const ref of refs(file)) {
      expect(ref.startsWith("/")).toBe(false)
    }
  })

  test("loading.html uses only relative local asset paths", async () => {
    const file = await html("loading.html")
    expect(file).not.toContain('rel="manifest"')
    expect(file).toContain('src="./loading.tsx"')
    for (const ref of refs(file)) {
      expect(ref.startsWith("/")).toBe(false)
    }
  })
})
