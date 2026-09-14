import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  config: { version: 3, mcp: {}, connections: {} },
  plaintext: {} as Record<string, string>,
  putCredential: vi.fn(),
  saveUserConfig: vi.fn(),
}))

vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}))
vi.mock("@claxedo/server-core/agent-config/index", () => ({
  legacyPlaintextAuth: vi.fn(async () => mocks.plaintext),
  loadUserConfig: vi.fn(async () => mocks.config),
  saveUserConfig: mocks.saveUserConfig,
  sandboxDriverConfig: vi.fn(() => ({})),
  setSandboxDriverConfig: vi.fn(),
}))
vi.mock("@claxedo/server-core/credentials/registry", () => ({ putCredential: mocks.putCredential }))
vi.mock("@claxedo/server-core/credentials/backend-registry", () => ({ getBackend: () => ({ probe: async () => true }) }))
vi.mock("@claxedo/server-core/platform/runtime/lib/paths", () => ({ dataDir: () => "/tmp/claxedo-migrate-test" }))
vi.mock("@claxedo/server-core/sandbox/network/policy", () => ({ syncMcpHosts: vi.fn() }))
vi.mock("@claxedo/server-core/platform/runtime/lib/log", () => ({
  Log: {
    create: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}))

import { migrateCredentials } from "./migrate"

describe("credential migration", () => {
  beforeEach(() => {
    mocks.plaintext = {
      migrated_provider: "success-secret",
      failed_provider: "retry-secret",
    }
    mocks.putCredential.mockReset()
    mocks.saveUserConfig.mockReset()
    mocks.putCredential.mockImplementation(async (input: { provider_id: string }) => {
      if (input.provider_id === "failed_provider") throw new Error("backend write failed")
    })
  })

  test("leaves the plaintext on disk while any of it is still only on disk", async () => {
    // The rewrite drops the whole map, so saving after a partial pass would
    // delete the entry the backend refused. Nothing is written until the next
    // pass can store it too, and the marker is not set either.
    await expect(migrateCredentials()).resolves.toEqual({
      migrated: ["migrated_provider"],
      errors: ["failed_provider"],
    })
    expect(mocks.saveUserConfig).not.toHaveBeenCalled()
  })

  test("rewrites the config without the plaintext once every entry is in the backend", async () => {
    mocks.plaintext = { migrated_provider: "success-secret" }

    await expect(migrateCredentials()).resolves.toEqual({ migrated: ["migrated_provider"], errors: [] })

    expect(mocks.saveUserConfig).toHaveBeenCalledWith(mocks.config)
    expect(JSON.stringify(mocks.saveUserConfig.mock.calls[0])).not.toContain("success-secret")
  })

  test("a config with no plaintext left is not rewritten at all", async () => {
    mocks.plaintext = {}

    await expect(migrateCredentials()).resolves.toEqual({ migrated: [], errors: [] })

    expect(mocks.putCredential).not.toHaveBeenCalled()
    expect(mocks.saveUserConfig).not.toHaveBeenCalled()
  })
})
