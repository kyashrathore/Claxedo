import { afterAll, beforeAll, describe, expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { LivePluginRoutes } from "./routes"
import { createLivePluginService, type LivePluginService } from "./service"

const signedConfig = { enabled: true, issuer: "https://auth.test", jwksUrl: "custom:test" } as const
const OWNER = "user_owner"

const PACKAGE_JSON = JSON.stringify({
  name: "claxedo-plugin-lens",
  version: "0.1.0",
  type: "module",
  claxedo: { id: "lens", name: "Lens", version: "0.1.0", app: "./src/app.tsx", server: { routes: ["/api/claxedo/projects"] } },
})

let root: string
let folder: string
let service: LivePluginService

function signedAs(subject: string): SignedControlPlaneAuth {
  return { mode: "signed", user: { subject, tokenIdentifier: subject, issuer: "https://auth.test" } }
}

function ownerOnlyRoutes() {
  return LivePluginRoutes(
    { authConfig: signedConfig, verifier: async (token) => signedAs(token) },
    {
      service,
      authorizeMachineOwner: (auth) => {
        if (auth.user.subject !== OWNER) throw new ControlPlaneAuthError(403, "operator_required", "Live plugins belong to this machine's owner")
      },
    },
  )
}

function as(subject?: string): RequestInit {
  return subject ? { headers: { authorization: `Bearer ${subject}` } } : {}
}

async function errorCode(response: Response) {
  return ((await response.json()) as { error: { code: string } }).error.code
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "live-plugins-signed-"))
  folder = path.join(root, "lens")
  await fs.mkdir(path.join(folder, "src"), { recursive: true })
  await fs.writeFile(path.join(folder, "package.json"), PACKAGE_JSON)
  await fs.writeFile(path.join(folder, "src", "app.tsx"), `import { definePlugin } from "@claxedo/plugin-api"\n\nexport default definePlugin({ activate() {} })\n`)
  service = createLivePluginService({ root: path.join(root, "data") })
  await service.ready
  await service.add(folder)
})

afterAll(async () => {
  service.dispose()
  await fs.rm(root, { recursive: true, force: true })
})

describe("signed callers", () => {
  test("only the machine's owner lists, fetches or changes a plugin", async () => {
    const routes = ownerOnlyRoutes()
    const [row] = service.list()
    for (const target of ["/", `/lens/${row.hash}/app.js`]) {
      expect({ target, status: (await routes.request(target, as(OWNER))).status }).toEqual({ target, status: 200 })
      const member = await routes.request(target, as("user_member"))
      expect({ target, status: member.status }).toEqual({ target, status: 403 })
      expect(await errorCode(member)).toBe("operator_required")
      expect({ target, status: (await routes.request(target)).status }).toEqual({ target, status: 401 })
    }
    const removal = await routes.request("/lens", { method: "DELETE", ...as("user_member") })
    expect(removal.status).toBe(403)
    const addition = await routes.request("/", {
      method: "POST",
      headers: { authorization: "Bearer user_member", "content-type": "application/json" },
      body: JSON.stringify({ directory: folder }),
    })
    expect(addition.status).toBe(403)
    expect(service.list().map((plugin) => plugin.id)).toEqual(["lens"])
  })

  test("a signed composition that names no machine owner refuses everyone", async () => {
    const routes = LivePluginRoutes({ authConfig: signedConfig, verifier: async (token) => signedAs(token) }, { service })
    const [row] = service.list()
    for (const target of ["/", `/lens/${row.hash}/app.js`]) {
      expect({ target, status: (await routes.request(target, as(OWNER))).status }).toEqual({ target, status: 403 })
    }
  })
})
