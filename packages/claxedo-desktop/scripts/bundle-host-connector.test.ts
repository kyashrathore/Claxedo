import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { bundleHostConnector, HOST_CONNECTOR_CHILD_MANIFEST_SCHEMA } from "./bundle-host-connector"
import { verifyHostConnectorChildArtifact } from "../src/main/host-connector/child-artifact"

const dirs: string[] = []
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "claxedo-host-connector-child-"))
  dirs.push(dir)
  return dir
}

describe("the separately built child", () => {
  let built: Awaited<ReturnType<typeof bundleHostConnector>>
  beforeAll(async () => {
    built = await bundleHostConnector({ outputDir: tempDir() })
  })

  test("emits one executable with a deterministic SHA-256 manifest", async () => {
    const manifest = JSON.parse(readFileSync(built.manifestPath, "utf8")) as Record<string, unknown>
    const actualHash = createHash("sha256").update(readFileSync(built.output)).digest("hex")
    expect(manifest).toEqual({
      schema: HOST_CONNECTOR_CHILD_MANIFEST_SCHEMA,
      entry: "index.js",
      sha256: actualHash,
    })
    expect(Object.keys(manifest).sort()).toEqual(["entry", "schema", "sha256"])
  })

  test("the executable is self-contained and owns the connector implementation", () => {
    const output = readFileSync(built.output, "utf8")

    expect(output).toContain("claxedo.host-enrollment.enroll.v1")
    expect(output).not.toMatch(/from\s+["']@claxedo\/host-connector/)
  })

  test("main refuses an executable that does not match the emitted fingerprint", () => {
    const copy = tempDir()
    cpSync(built.output, join(copy, "index.js"))
    cpSync(built.manifestPath, join(copy, "manifest.json"))
    writeFileSync(join(copy, "index.js"), `${readFileSync(built.output, "utf8")}\n// tampered\n`)

    expect(() => verifyHostConnectorChildArtifact(copy)).toThrow(/fingerprint mismatch/)
  })

  test("main resolves the exact reviewed executable when its fingerprint matches", () => {
    expect(verifyHostConnectorChildArtifact(join(built.output, ".."))).toBe(built.output)
  })
})
