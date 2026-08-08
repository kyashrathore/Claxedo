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

  test("index.local.html uses only relative local asset paths", async () => {
    // The unsigned product's document, and it is subject to exactly the same
    // rule as the signed one: the packaged renderer is loaded with
    // `win.loadFile(...)`, so it is a `file://` document and a root-absolute
    // `/favicon…` resolves to the filesystem root. Four shipped defects came
    // from that single fact — the desktop's own copies of these documents exist
    // because `claxedo-app/index*.html` are server-relative. A local product
    // built from the wrong template would reproduce every one of them.
    const file = await html("index.local.html")
    expect(file).not.toContain('rel="manifest"')
    expect(file).toContain('src="./local.tsx"')
    expect(file).not.toContain('src="./index.tsx"')
    for (const ref of refs(file)) {
      expect(ref.startsWith("/")).toBe(false)
    }
  })

  test("both product documents differ only in the entry module they load", async () => {
    // A local document that drifted from the signed one — a missing theme
    // preload, a different root element — would produce product-specific paint
    // and startup bugs that no closure guard can see.
    const signed = await html("index.html")
    const local = await html("index.local.html")
    expect(local.replace('src="./local.tsx"', 'src="./index.tsx"')).toBe(signed)
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
