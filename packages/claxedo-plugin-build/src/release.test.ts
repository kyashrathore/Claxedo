import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { sha256Hex } from "@claxedo/helpers/crypto"
import { verifyPluginRelease } from "@claxedo/plugin-api/release"
import { buildPluginRelease, signPluginRelease } from "./index"

let root: string

async function writePlugin(name: string, backend: boolean) {
  const dir = path.join(root, name)
  await fs.mkdir(path.join(dir, "src"), { recursive: true })
  const manifest = {
    id: name,
    name,
    version: "1.2.3",
    app: "./src/app.ts",
    ...(backend ? { backend: { entry: "./src/backend.ts", routes: ["GET /"] } } : {}),
  }
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ claxedo: manifest }))
  await fs.writeFile(path.join(dir, "src", "app.ts"), "export default { activate() {} }\n")
  await fs.writeFile(path.join(dir, "src", "backend.ts"), "export default { fetch() { return new Response('ok') } }\n")
  return dir
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-plugin-release-test-"))
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe("buildPluginRelease", () => {
  test("names each bundle by the full SHA-256 and size of the code it stores, and signs a release a host verifies", async () => {
    const built = await buildPluginRelease({ rootDir: await writePlugin("with-backend", true), storage: 2, builtAt: new Date("2026-10-20T00:00:00Z") })
    const { release } = built
    expect(release).toMatchObject({ id: "with-backend", version: "1.2.3", storage: 2, builtAt: "2026-10-20T00:00:00.000Z" })
    expect(release.backend).toBeDefined()
    for (const blob of [release.app, release.backend!]) {
      const code = built.blobs.get(blob.sha256)!
      expect(await sha256Hex(code)).toBe(blob.sha256)
      expect(new TextEncoder().encode(code).byteLength).toBe(blob.size)
    }
    const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair
    const publicKey = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))))
    expect(await verifyPluginRelease(await signPluginRelease(release, pair.privateKey, "test"), { test: publicKey })).toEqual(release)
  })

  test("carries no backend for an app-only plugin", async () => {
    const built = await buildPluginRelease({ rootDir: await writePlugin("app-only", false) })
    expect(built.release.backend).toBeUndefined()
    expect([...built.blobs.keys()]).toEqual([built.release.app.sha256])
  })
})
