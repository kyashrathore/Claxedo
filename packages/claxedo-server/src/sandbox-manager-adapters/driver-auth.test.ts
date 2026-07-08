import { beforeEach, describe, expect, test, vi } from "vitest"

const secrets = new Map<string, string>()

vi.mock("../credentials/registry", () => ({
  getCredentialByProvider: vi.fn((id: string) => secrets.has(id) ? { provider_id: id, status: "available" } : undefined),
  resolveSecretsForScope: vi.fn(async () => ({})),
  resolveSecret: vi.fn(async (id: string) => secrets.get(id) ?? null),
}))

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
})
