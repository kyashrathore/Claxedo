import { describe, expect, test } from "vitest"
import {
  defaultSandboxDriverID,
  dockerSandboxDriverEnabled,
  hasSandboxDriverAuth,
  isSandboxDriverID,
  listSandboxDrivers,
  sandboxDriverCatalog,
  sandboxDriverIds,
  sandboxDriverId,
  sandboxDriverAuth,
  validateSandboxPersistenceCapabilities,
} from "./driver-catalog"

describe("sandbox driver catalog", () => {
  test("owns every direct sandbox driver id", () => {
    expect(sandboxDriverIds).toEqual(["exe", "daytona", "modal", "vercel", "cloudflare", "box", "docker"])
    expect(Object.keys(sandboxDriverCatalog).sort()).toEqual([...sandboxDriverIds].sort())
    expect(isSandboxDriverID("daytona")).toBe(true)
    expect(isSandboxDriverID("fetch")).toBe(false)
  })

  test("describes where each driver can run without workerSafe/localOnly booleans", () => {
    expect(sandboxDriverCatalog.cloudflare.metadata.driverRunsIn).toEqual(["worker"])
    expect(sandboxDriverCatalog.exe.metadata.driverRunsIn).toEqual(["worker", "node"])
    expect(sandboxDriverCatalog.daytona.metadata.driverRunsIn).toEqual(["worker", "node"])
    expect(sandboxDriverCatalog.docker.metadata.driverRunsIn).toEqual(["local"])
  })

  test("declares persistence semantics for every driver", () => {
    expect(sandboxDriverCatalog.daytona.metadata.persistence).toEqual({
      resume: "same-sandbox",
      capture: "filesystem",
      clone: false,
      captureSource: "preserved",
      retention: "provider-managed",
      restoreMount: "new-resource",
    })
    expect(sandboxDriverCatalog.cloudflare.metadata.persistence).toEqual({
      resume: "replacement-restore",
      capture: "directories",
      clone: false,
      captureSource: "preserved",
      retention: "provider-managed",
      restoreMount: "copy-on-write",
    })
    expect(sandboxDriverCatalog.box.metadata.persistence.capture).toBe("none")
    expect(sandboxDriverCatalog.docker.metadata.persistence.restoreMount).toBe("same-resource")
    expect(sandboxDriverCatalog.exe.metadata.persistence.clone).toBe(true)
    for (const driver of Object.values(sandboxDriverCatalog)) {
      expect(validateSandboxPersistenceCapabilities(driver.metadata.persistence)).toEqual({ valid: true })
    }
  })

  test("rejects capability combinations that cannot restore consistently", () => {
    expect(validateSandboxPersistenceCapabilities({
      resume: "replacement-restore",
      capture: "none",
      clone: false,
      captureSource: "not-applicable",
      retention: "not-applicable",
      restoreMount: "not-applicable",
    })).toEqual({
      valid: false,
      reason: "replacement restore requires a capture source",
    })
  })

  test("keeps Docker local-only and loopback-only", () => {
    expect(sandboxDriverCatalog.docker.metadata).toMatchObject({
      driverRunsIn: ["local"],
      targetAccess: "loopback",
    })
  })

  test("exposes concrete credential field metadata", () => {
    expect(sandboxDriverCatalog.daytona.credentialFields).toEqual([{ key: "api_key", label: "API Key", secret: true }])
    expect(sandboxDriverCatalog.cloudflare.credentialFields.map((field) => field.key)).toEqual(["api_token", "worker_url"])
  })

  test("parses config and environment auth without the legacy provider registry", () => {
    expect(sandboxDriverAuth({ auth: { daytona: { api_key: "dtn" } } }, "daytona")).toEqual({ api_key: "dtn" })
    expect(sandboxDriverAuth(undefined, "exe", { EXE_DEV_API_TOKEN: "exe-token" })).toEqual({
      api_token: "exe-token",
    })
    expect(sandboxDriverAuth(undefined, "modal", {
      MODAL_TOKEN_ID: "id",
      MODAL_TOKEN_SECRET: "secret",
    })).toEqual({ token_id: "id", token_secret: "secret" })
    expect(sandboxDriverAuth(undefined, "cloudflare", {
      CLOUDFLARE_API_TOKEN: "cf",
      CLOUDFLARE_SANDBOX_WORKER_URL: "https://worker.test",
    })).toEqual({ api_token: "cf", worker_url: "https://worker.test" })
    expect(sandboxDriverAuth({ auth: { box: { api_key: "bx" } } }, "box")).toEqual({ api_key: "bx" })
    expect(sandboxDriverAuth(undefined, "box", { BOX_API_KEY: "bx-env" })).toEqual({ api_key: "bx-env" })
  })

  test("keeps Docker hidden unless explicitly enabled", () => {
    expect(dockerSandboxDriverEnabled({})).toBe(false)
    expect(dockerSandboxDriverEnabled({ CLAXEDO_ENABLE_DOCKER_SANDBOX: "1" })).toBe(true)
    expect(sandboxDriverId("docker", undefined, {})).toBeUndefined()
    expect(listSandboxDrivers(undefined, {}).drivers.map((driver) => driver.id)).not.toContain("docker")
    expect(sandboxDriverId("docker", undefined, { CLAXEDO_ENABLE_DOCKER_SANDBOX: "1" })).toBe("docker")
    expect(defaultSandboxDriverID(undefined, {
      CLAXEDO_ENABLE_DOCKER_SANDBOX: "1",
      CLAXEDO_DOCKER_SANDBOX_DEFAULT: "1",
    })).toBe("docker")
  })

  test("checks driver auth from config or env", () => {
    expect(hasSandboxDriverAuth({ auth: { vercel: {
      access_token: "token",
      team_id: "team",
      project_id: "project",
    } } }, "vercel", {})).toBe(true)
    expect(hasSandboxDriverAuth(undefined, "cloudflare", {
      CLOUDFLARE_API_TOKEN: "cf",
      CLOUDFLARE_SANDBOX_WORKER_URL: "https://worker.test",
    })).toBe(true)
    expect(hasSandboxDriverAuth(undefined, "docker", {})).toBe(false)
  })

  test("uses default_driver as the canonical config and response key", () => {
    expect(defaultSandboxDriverID({ default_driver: "modal" }, {})).toBe("modal")
    expect(listSandboxDrivers({ default_driver: "cloudflare" }, {}).default_driver).toBe("cloudflare")
  })

  test("does not accept legacy default_provider config", () => {
    expect(defaultSandboxDriverID({ default_provider: "vercel" } as never, {})).toBe("daytona")
    expect(listSandboxDrivers({ default_provider: "cloudflare" } as never, {})).not.toHaveProperty("default_provider")
  })

  test("does not expose descriptive-only capability flags", () => {
    for (const driver of Object.values(sandboxDriverCatalog)) {
      expect(driver.metadata).not.toHaveProperty("driverExecutionEnvironments")
      expect(driver.metadata).not.toHaveProperty("hostControl")
      expect(driver.metadata).not.toHaveProperty("networking")
      expect(driver.metadata).not.toHaveProperty("bootSources")
      expect(driver.metadata).not.toHaveProperty("egressPolicy")
      expect(driver.metadata).not.toHaveProperty("workerSafe")
      expect(driver.metadata).not.toHaveProperty("localOnly")
      expect(driver.metadata).not.toHaveProperty("websockets")
      expect(driver.metadata).not.toHaveProperty("publicHttp")
      expect(driver.metadata).not.toHaveProperty("explicitStop")
      expect(driver.metadata).not.toHaveProperty("persistentResume")
    }
  })
})
