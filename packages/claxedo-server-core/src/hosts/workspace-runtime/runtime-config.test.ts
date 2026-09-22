import { afterAll, afterEach, describe, expect, test, vi } from "vitest"
import { realpathSync } from "fs"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(realpathSync(os.tmpdir()), `runtime-config-test-${randomUUID().slice(0, 8)}`)
const prev = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { createClaxedoAppliedRuntimeConfig } = await import("./runtime-config")
const { configureAgentConfig } = await import("../../agent-config")

const bound = {
  baseUrl: "http://127.0.0.1:2595/bindings/c41e",
  placeholder: "signed-placeholder",
  authMode: "bearer" as const,
  expiresAt: 1_800_000_000_000,
}

const envBound = {
  baseUrl: "https://api.openai.com",
  placeholderEnv: "CLAXEDO_PROVIDER_CODEX_APP_SERVER",
  authMode: "bearer" as const,
  apiPath: "/v1",
}

afterEach(() => {
  configureAgentConfig({})
  vi.unstubAllEnvs()
})

afterAll(() => {
  if (prev === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = prev
})

describe("applied runtime config", () => {
  test("resolves the installed authority's local-scope projection against this process's environment", async () => {
    const projectAuth = vi.fn(async () => ({ "claude-sdk": bound, "codex-app-server": envBound }))
    configureAgentConfig({ projectAuth })
    vi.stubEnv("CLAXEDO_PROVIDER_CODEX_APP_SERVER", "env-placeholder")

    const applied = await createClaxedoAppliedRuntimeConfig({ workspaceId: "ws_1", orgId: "org-a" })

    expect(projectAuth.mock.calls).toEqual([[{ scope: "local", orgId: "org-a", workspaceId: "ws_1" }]])
    expect(applied).toEqual({
      version: 4,
      mcp: {},
      connections: [],
      auth: {
        "claude-sdk": bound,
        "codex-app-server": {
          baseUrl: "https://api.openai.com",
          authMode: "bearer",
          apiPath: "/v1",
          placeholder: "env-placeholder",
        },
      },
    })
  })

  test("refuses to resolve a shared-scope snapshot in this process", async () => {
    // A shared-scope projection names variables the sandbox's own provider
    // fills. Resolving it here would mark every one of them missing from the
    // server's environment and hand the sandbox a config that refuses its own
    // credentials.
    const projectAuth = vi.fn(async () => ({ "claude-sdk": bound }))
    configureAgentConfig({ projectAuth })

    await expect(createClaxedoAppliedRuntimeConfig({ secretScope: "shared", workspaceId: "ws_1" }))
      .rejects.toThrow(/inside its own sandbox/)
    expect(projectAuth).not.toHaveBeenCalled()
  })

  test("refuses a projection the runtime cannot read rather than applying the rest", async () => {
    configureAgentConfig({
      projectAuth: async () => ({ "claude-sdk": bound, "codex-app-server": { ...envBound, placeholderEnv: "" } }),
    })

    await expect(createClaxedoAppliedRuntimeConfig({ workspaceId: "ws_1" }))
      .rejects.toThrow(/invalid Claxedo workspace runtime snapshot/)
  })
})
