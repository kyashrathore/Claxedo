import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "../../..")

function desktopBuildStep(file: string) {
  const source = readFileSync(resolve(root, file), "utf8")
  const marker = "\n      - name: Build desktop\n"
  const start = source.indexOf(marker)
  if (start < 0) throw new Error(`${file} has no Build desktop step`)
  const next = source.indexOf("\n      - name:", start + 1)
  return source.slice(start, next < 0 ? undefined : next)
}

describe("desktop release account boundary", () => {
  test("draft creation is structurally blocked on an attested U8 qualification", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/release-claxedo.yml"), "utf8")
    expect(workflow).toContain("qualify-u8-release:")
    expect(workflow).toContain('gh attestation verify "$report"')
    expect(workflow).toMatch(/create-release:\n\s+needs: \[prepare, build-desktop, qualify-u8-release\]/)
  })

  test("electron-vite bakes only the selected core origin", () => {
    const config = readFileSync(resolve(root, "packages/claxedo-desktop/electron.vite.config.ts"), "utf8")
    expect(config).toContain('"CLAXEDO_CORE_ORIGIN"')
    for (const name of [
      "CLAXEDO_ACCOUNT_AUTHORIZE_URL",
      "CLAXEDO_ACCOUNT_TOKEN_URL",
      "CLAXEDO_ACCOUNT_CLIENT_ID",
      "CLAXEDO_ACCOUNT_SCOPE",
      "CLAXEDO_SERVER_ORIGIN",
    ])
      expect(config).not.toContain(`"${name}"`)
    expect(config).not.toContain("CLIENT_SECRET")
  })

  for (const workflow of [".github/workflows/release-claxedo.yml", ".github/workflows/release-gates.yml"]) {
    test(`${workflow} bakes only the selected core origin`, () => {
      const step = desktopBuildStep(workflow)
      expect(step).toContain("CLAXEDO_CORE_ORIGIN")
      for (const name of [
        "CLAXEDO_ACCOUNT_AUTHORIZE_URL",
        "CLAXEDO_ACCOUNT_TOKEN_URL",
        "CLAXEDO_ACCOUNT_CLIENT_ID",
        "CLAXEDO_ACCOUNT_SCOPE",
        "CLAXEDO_SERVER_ORIGIN",
      ])
        expect(step).not.toContain(name)

      expect(step).not.toContain("VITE_CLAXEDO_SERVER_URL")
    })
  }
})
