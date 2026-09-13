import { beforeEach, describe, expect, test, vi } from "vitest"

type StoredCredential = { secret: string; status?: "available" | "revoked" }

const stored = new Map<string, StoredCredential>()

/**
 * Keyed by provider AND kind, and silent on a row that is not `available`,
 * which is what the registry does: a fake that ignored the kind would answer a
 * lookup for `sandbox_driver` with the operator's model subscription for the
 * same provider name.
 */
vi.mock("@claxedo/server-core/credentials/registry", () => ({
  getCredentialByProvider: vi.fn((id: string, kind?: string) => {
    const row = stored.get(`${id}:${kind ?? ""}`)
    return row ? { provider_id: id, status: row.status ?? "available" } : undefined
  }),
  resolveSecret: vi.fn(async (id: string, kind?: string) => {
    const row = stored.get(`${id}:${kind ?? ""}`)
    return row && (row.status ?? "available") === "available" ? row.secret : null
  }),
}))

const secrets = {
  clear: () => stored.clear(),
  set: (id: string, secret: string, status?: StoredCredential["status"]) =>
    stored.set(`${id}:sandbox_driver`, { secret, ...(status ? { status } : {}) }),
  setUnderKind: (id: string, kind: string, secret: string) => stored.set(`${id}:${kind}`, { secret }),
}

const { hasManagedSandboxDriverAuth, sandboxDriverAuthAsync, sandboxDriverAuthManaged } = await import(
  "./driver-auth"
)

describe("sandbox driver managed auth", () => {
  beforeEach(() => {
    secrets.clear()
  })

  test("parses managed credentials for direct sandbox drivers", async () => {
    secrets.set("daytona", "dtn-key")
    secrets.set("modal", JSON.stringify({ token_id: "modal-id", token_secret: "modal-secret" }))
    secrets.set("vercel", JSON.stringify({
      access_token: "vercel-token",
      team_id: "team-id",
      project_id: "project-id",
    }))
    secrets.set("cloudflare", JSON.stringify({
      api_token: "cf-token",
      worker_url: "https://worker.test",
    }))
    secrets.set("docker", "ghcr.io/example/workspace-runtime:test")

    await expect(sandboxDriverAuthManaged("daytona")).resolves.toEqual({ api_key: "dtn-key" })
    await expect(sandboxDriverAuthManaged("modal")).resolves.toEqual({
      token_id: "modal-id",
      token_secret: "modal-secret",
    })
    await expect(sandboxDriverAuthManaged("vercel")).resolves.toEqual({
      access_token: "vercel-token",
      team_id: "team-id",
      project_id: "project-id",
    })
    await expect(sandboxDriverAuthManaged("cloudflare")).resolves.toEqual({
      api_token: "cf-token",
      worker_url: "https://worker.test",
    })
    await expect(sandboxDriverAuthManaged("docker")).resolves.toEqual({
      image: "ghcr.io/example/workspace-runtime:test",
    })
  })

  test("prefers explicit config/env auth before managed storage", async () => {
    secrets.set("cloudflare", JSON.stringify({
      api_token: "managed-cf",
      worker_url: "https://managed-worker.test",
    }))

    await expect(sandboxDriverAuthAsync(undefined, "cloudflare", {
      CLOUDFLARE_API_TOKEN: "env-cf",
      CLOUDFLARE_SANDBOX_WORKER_URL: "https://env-worker.test",
    })).resolves.toEqual({
      api_token: "env-cf",
      worker_url: "https://env-worker.test",
    })
  })

  test("managed credentials are presence metadata only until the secret parses", async () => {
    secrets.set("vercel", JSON.stringify({ access_token: "token" }))

    expect(hasManagedSandboxDriverAuth("vercel")).toBe(true)
    await expect(sandboxDriverAuthManaged("vercel")).resolves.toBeUndefined()
  })

  test("a driver with nothing stored has neither presence nor auth", async () => {
    expect(hasManagedSandboxDriverAuth("box")).toBe(false)
    await expect(sandboxDriverAuthManaged("box")).resolves.toBeUndefined()
  })

  test("a credential stored under another kind is not this driver's auth", async () => {
    // `daytona` is both a sandbox driver and a provider name; the lookup that
    // drops the kind hands a model subscription to the sandbox manager.
    secrets.setUnderKind("daytona", "api_key", "dtn-not-a-driver-credential")

    expect(hasManagedSandboxDriverAuth("daytona")).toBe(false)
    await expect(sandboxDriverAuthManaged("daytona")).resolves.toBeUndefined()
  })

  test("a revoked driver credential is still present but yields no auth", async () => {
    // The two answers differ on purpose: the settings row must keep showing a
    // stored credential to revoke or replace, and provisioning must not use it.
    secrets.set("daytona", "dtn-key", "revoked")

    expect(hasManagedSandboxDriverAuth("daytona")).toBe(true)
    await expect(sandboxDriverAuthManaged("daytona")).resolves.toBeUndefined()
  })
})
