import { afterAll, beforeAll, describe, expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { LivePluginRoutes } from "./routes"
import { createLivePluginService, type LivePluginService } from "./service"
import { SOURCE_FILE_MAX_BYTES } from "./source"

const unsigned = { enabled: false, mode: "local-only", reason: "local test" } as const
const signedConfig = { enabled: true, issuer: "https://auth.test", jwksUrl: "custom:test" } as const

const APP = `import { definePlugin } from "@claxedo/plugin-api"

export default definePlugin({ activate() {} })
`

const PACKAGE_JSON = JSON.stringify({
  name: "claxedo-plugin-lens",
  version: "0.1.0",
  type: "module",
  claxedo: { id: "lens", name: "Lens", version: "0.1.0", app: "./src/app.tsx", server: { routes: ["/api/claxedo/projects"] } },
})

let root: string
let folder: string
let service: LivePluginService
let app: ReturnType<typeof LivePluginRoutes>

async function source(requested: string) {
  return app.request(`/lens/source/file?path=${encodeURIComponent(requested)}`)
}

async function errorCode(response: Response) {
  return ((await response.json()) as { error: { code: string } }).error.code
}

function signedAs(subject: string): SignedControlPlaneAuth {
  return { mode: "signed", user: { subject, tokenIdentifier: subject, issuer: "https://auth.test" } }
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "live-plugins-source-"))
  folder = path.join(root, "lens")
  await fs.mkdir(path.join(folder, "src", "deep"), { recursive: true })
  await fs.mkdir(path.join(folder, "node_modules", "dep"), { recursive: true })
  await fs.mkdir(path.join(folder, ".git"), { recursive: true })
  await fs.mkdir(path.join(folder, "dist"), { recursive: true })
  await fs.writeFile(path.join(folder, "package.json"), PACKAGE_JSON)
  await fs.writeFile(path.join(folder, "src", "app.tsx"), APP)
  await fs.writeFile(path.join(folder, "src", "deep", "notes.md"), "notes\n")
  await fs.writeFile(path.join(folder, "node_modules", "dep", "index.js"), "module.exports = 1\n")
  await fs.writeFile(path.join(folder, ".git", "config"), "[core]\n")
  await fs.writeFile(path.join(folder, "dist", "app.js"), "built\n")
  await fs.writeFile(path.join(folder, "big.txt"), "x".repeat(SOURCE_FILE_MAX_BYTES + 1))
  await fs.writeFile(path.join(folder, "logo.bin"), Buffer.from([0x89, 0x50, 0x00, 0x47]))
  await fs.writeFile(path.join(root, "outside.txt"), "a secret outside the plugin folder\n")
  await fs.symlink(path.join(root, "outside.txt"), path.join(folder, "secret.txt"))
  await fs.symlink(root, path.join(folder, "src", "escape"))
  service = createLivePluginService({ root: path.join(root, "data") })
  app = LivePluginRoutes({ authConfig: unsigned }, { service })
  const added = await app.request("/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ directory: folder }) })
  expect(added.status).toBe(201)
})

afterAll(async () => {
  service.dispose()
  await fs.rm(root, { recursive: true, force: true })
})

describe("a live plugin's source", () => {
  test("lists the folder's files, skipping node_modules, .git, dist and every symbolic link", async () => {
    const response = await app.request("/lens/source")
    expect(response.status).toBe(200)
    const listing = (await response.json()) as { files: { path: string; size: number }[]; truncated: boolean }
    expect(listing.truncated).toBe(false)
    expect(listing.files.map((file) => file.path)).toEqual(["big.txt", "logo.bin", "package.json", "src/app.tsx", "src/deep/notes.md"])
    expect(listing.files.find((file) => file.path === "src/app.tsx")?.size).toBe(Buffer.byteLength(APP))
  })

  test("reads a file inside the folder as text", async () => {
    const response = await source("src/app.tsx")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ path: "src/app.tsx", size: Buffer.byteLength(APP), text: APP })
    expect(await (await source("src/deep/notes.md")).json()).toMatchObject({ text: "notes\n" })
  })

  test("refuses every path that leaves the folder", async () => {
    for (const requested of ["../outside.txt", "src/../../outside.txt", "/etc/passwd", path.join(root, "outside.txt"), "./package.json", "src//app.tsx", "src\\app.tsx", "", "src/app.tsx\0"]) {
      const response = await source(requested)
      expect({ requested, status: response.status }).toEqual({ requested, status: 400 })
      expect(await errorCode(response)).toBe("live_plugin_source_path_invalid")
    }
    const encoded = await app.request("/lens/source/file?path=%2e%2e%2foutside.txt")
    expect(encoded.status).toBe(400)
    expect((await app.request("/lens/source/file")).status).toBe(400)
  })

  test("refuses a symbolic link, to a file or through a folder", async () => {
    for (const requested of ["secret.txt", "src/escape/outside.txt"]) {
      const response = await source(requested)
      expect({ requested, status: response.status }).toEqual({ requested, status: 403 })
      expect(await errorCode(response)).toBe("live_plugin_source_symlink")
    }
  })

  test("refuses node_modules, .git and dist even when named directly", async () => {
    for (const requested of ["node_modules/dep/index.js", ".git/config", "dist/app.js", "src/node_modules/x.js"]) {
      const response = await source(requested)
      expect({ requested, status: response.status }).toEqual({ requested, status: 403 })
      expect(await errorCode(response)).toBe("live_plugin_source_skipped")
    }
  })

  test("refuses a file over the size cap, a binary file, a folder and a missing file", async () => {
    expect((await source("big.txt")).status).toBe(413)
    expect((await source("logo.bin")).status).toBe(415)
    expect((await source("src")).status).toBe(404)
    expect((await source("src/missing.ts")).status).toBe(404)
    expect((await source("package.json/x")).status).toBe(404)
  })

  test("answers only for a registered plugin", async () => {
    expect((await app.request("/nope/source")).status).toBe(404)
    expect((await app.request("/nope/source/file?path=package.json")).status).toBe(404)
    expect((await app.request("/Not-An-Id/source")).status).toBe(400)
  })

  test("a folder replaced by a symbolic link after it was registered is refused", async () => {
    const moved = path.join(root, "lens-moved")
    await fs.rename(folder, moved)
    await fs.symlink(moved, folder)
    try {
      const response = await app.request("/lens/source")
      expect(response.status).toBe(403)
      expect(await errorCode(response)).toBe("live_plugin_source_folder_replaced")
      expect((await source("package.json")).status).toBe(403)
    } finally {
      await fs.rm(folder)
      await fs.rename(moved, folder)
    }
  })
})

describe("signed callers", () => {
  const owner = "user_owner"
  const routes = () =>
    LivePluginRoutes(
      { authConfig: signedConfig, verifier: async (token) => signedAs(token) },
      {
        service,
        authorizeMachineOwner: (auth) => {
          if (auth.user.subject !== owner) throw new ControlPlaneAuthError(403, "operator_required", "Live plugins belong to this machine's owner")
        },
      },
    )

  test("only the machine's owner lists, reads, fetches or changes a plugin", async () => {
    const signed = routes()
    const [row] = service.list()
    const paths = ["/", "/lens/source", "/lens/source/file?path=package.json", `/lens/${row.hash}/app.js`]
    for (const target of paths) {
      expect({ target, status: (await signed.request(target, { headers: { authorization: `Bearer ${owner}` } })).status }).toEqual({ target, status: 200 })
      const member = await signed.request(target, { headers: { authorization: "Bearer user_member" } })
      expect({ target, status: member.status }).toEqual({ target, status: 403 })
      expect(await errorCode(member)).toBe("operator_required")
      expect({ target, status: (await signed.request(target)).status }).toEqual({ target, status: 401 })
    }
    const removal = await signed.request("/lens", { method: "DELETE", headers: { authorization: "Bearer user_member" } })
    expect(removal.status).toBe(403)
    const addition = await signed.request("/", { method: "POST", headers: { authorization: "Bearer user_member", "content-type": "application/json" }, body: JSON.stringify({ directory: folder }) })
    expect(addition.status).toBe(403)
    expect(service.list().map((plugin) => plugin.id)).toEqual(["lens"])
  })

  test("a signed composition that names no machine owner refuses everyone", async () => {
    const signed = LivePluginRoutes({ authConfig: signedConfig, verifier: async (token) => signedAs(token) }, { service })
    for (const target of ["/", "/lens/source", "/lens/source/file?path=package.json"]) {
      const response = await signed.request(target, { headers: { authorization: `Bearer ${owner}` } })
      expect({ target, status: response.status }).toEqual({ target, status: 403 })
    }
  })
})
