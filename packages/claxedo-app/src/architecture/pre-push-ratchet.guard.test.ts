import { describe, expect, test } from "bun:test"

const root = new URL("../../../../", import.meta.url)

describe("pre-push architecture ratchet", () => {
  test("runs every source-closure policy after typecheck", async () => {
    const manifest = await Bun.file(new URL("package.json", root)).json()

    expect(manifest.scripts["test:architecture-ratchets"]).toBe(
      "bun ./script/product-boundary/verify.ts --all --source-only",
    )
    expect(manifest.scripts.prepush).toBe(
      "bun run typecheck && bun run test:architecture-ratchets",
    )
    expect(await Bun.file(new URL(".husky/pre-push", root)).text()).toContain("bun run prepush")
  })

  test("teaches both agents to fix accidental edges before changing ceilings", async () => {
    for (const file of ["AGENTS.md", "CLAUDE.md"]) {
      const instructions = await Bun.file(new URL(file, root)).text()
      expect(instructions).toContain("bun run test:architecture-ratchets")
      expect(instructions).toContain("do not blindly raise a ceiling or baseline")
      expect(instructions).toContain("Never hide a dependency from the scanner with an opaque dynamic import")
    }
  })
})
