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
} from "./driver-catalog"

describe("sandbox driver catalog", () => {
  test("owns every direct sandbox driver id", () => {
    expect(sandboxDriverIds).toEqual(["daytona", "modal", "vercel", "cloudflare", "docker"])
    expect(Object.keys(sandboxDriverCatalog).sort()).toEqual([...sandboxDriverIds].sort())
    expect(isSandboxDriverID("daytona")).toBe(true)
    expect(isSandboxDriverID("fetch")).toBe(false)
  })

  test("describes where each driver can run without workerSafe/localOnly booleans", () => {
    expect(sandboxDriverCatalog.cloudflare.metadata.driverRunsIn).toEqual(["worker"])
    expect(sandboxDriverCatalog.daytona.metadata.driverRunsIn).toEqual(["worker", "node"])
    expect(sandboxDriverCatalog.docker.metadata.driverRunsIn).toEqual(["local"])
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
    expect(sandboxDriverAuth(undefined, "modal", {
      MODAL_TOKEN_ID: "id",
      MODAL_TOKEN_SECRET: "secret",
    })).toEqual({ token_id: "id", token_secret: "secret" })
    expect(sandboxDriverAuth(undefined, "cloudflare", {
      CLOUDFLARE_API_TOKEN: "cf",
      CLOUDFLARE_SANDBOX_WORKER_URL: "https://worker.test",
    })).toEqual({ api_token: "cf", worker_url: "https://worker.test" })
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
