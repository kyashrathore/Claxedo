import { describe, expect, test } from "vitest"
import {
  dockerSandboxDriverEnabled,
  sandboxDriverCatalog,
  sandboxDriverId,
  validateSandboxPersistenceCapabilities,
} from "./driver-catalog"
import { isSandboxDriverID, sandboxDriverIds } from "@claxedo/sandbox-contract"

describe("sandbox driver catalog", () => {
  test("owns every direct sandbox driver id", () => {
    expect(sandboxDriverIds).toEqual(["modal", "vercel", "cloudflare", "boat", "docker"])
    expect(Object.keys(sandboxDriverCatalog).sort()).toEqual([...sandboxDriverIds].sort())
    expect(isSandboxDriverID("vercel")).toBe(true)
    expect(isSandboxDriverID("fetch")).toBe(false)
  })

  test("describes where each driver can run without workerSafe/localOnly booleans", () => {
    expect(sandboxDriverCatalog.cloudflare.metadata.driverRunsIn).toEqual(["worker"])
    expect(sandboxDriverCatalog.docker.metadata.driverRunsIn).toEqual(["local"])
  })

  test("declares persistence semantics for every driver", () => {
    expect(sandboxDriverCatalog.cloudflare.metadata.persistence).toEqual({
      resume: "replacement-restore",
      capture: "directories",
      clone: false,
      captureSource: "preserved",
      retention: "explicit",
      restoreMount: "copy-on-write",
    })
    expect(sandboxDriverCatalog.boat.metadata.persistence.capture).toBe("none")
    expect(sandboxDriverCatalog.docker.metadata.persistence.restoreMount).toBe("same-resource")
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
    expect(sandboxDriverCatalog.boat.credentialFields).toEqual([{ key: "api_key", label: "API Key", secret: true }])
    expect(sandboxDriverCatalog.cloudflare.credentialFields.map((field) => field.key)).toEqual(["api_token", "worker_url"])
  })

  test("keeps Docker hidden unless explicitly enabled", () => {
    expect(dockerSandboxDriverEnabled({})).toBe(false)
    expect(dockerSandboxDriverEnabled({ CLAXEDO_ENABLE_DOCKER_SANDBOX: "1" })).toBe(true)
    expect(sandboxDriverId("docker", undefined, {})).toBeUndefined()
    expect(sandboxDriverId("docker", undefined, { CLAXEDO_ENABLE_DOCKER_SANDBOX: "1" })).toBe("docker")
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
