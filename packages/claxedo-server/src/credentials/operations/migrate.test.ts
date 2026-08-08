import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  config: { auth: {} as Record<string, string> },
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
    mocks.config.auth = {
      migrated_provider: "success-secret",
      failed_provider: "retry-secret",
    }
    mocks.putCredential.mockReset()
    mocks.saveUserConfig.mockReset()
    mocks.putCredential.mockImplementation(async (input: { provider_id: string }) => {
      if (input.provider_id === "failed_provider") throw new Error("backend write failed")
    })
  })

  test("removes only successfully migrated plaintext providers", async () => {
    await expect(migrateCredentials()).resolves.toEqual({
      migrated: ["migrated_provider"],
      errors: ["failed_provider"],
    })
    expect(mocks.saveUserConfig).toHaveBeenCalledWith({
      auth: { failed_provider: "retry-secret" },
    })
  })
})
