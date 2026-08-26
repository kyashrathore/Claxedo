import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
import {
  createDockerSandboxDriver,
  dockerLocalAuthCandidates,
  dockerSandboxAuthHome,
  dockerSandboxImageFromEnv,
  dockerSandboxSyncLocalAuth,
  parseDockerPort,
  type DockerCommandRunner,
} from "./docker"
import { SANDBOX_IMAGE } from "../image"

function runner(output: Record<string, string> = {}) {
  const calls: string[][] = []
  const fn: DockerCommandRunner = vi.fn(async (args) => {
    calls.push(args)
    if (args[0] === "create") return { stdout: output.create ?? "container-id\n" }
    if (args[0] === "port") return { stdout: output.port ?? "127.0.0.1:5330\n" }
    if (args[0] === "inspect") return { stdout: output.inspect ?? "container-id\n" }
    return { stdout: "" }
  })
  return { calls, fn }
}

const input = {
  workspaceId: "ws_1",
  homeRegion: "us-east" as const,
  epoch: 1,
  hostId: "docker-host-ws_1",
  labels: { "claxedo.projectId": "project_1" },
}

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
  tempDirs.length = 0
})

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-docker-driver-test-"))
  tempDirs.push(dir)
  return dir
}

describe("DockerSandboxDriver", () => {
  test("resolves helper defaults and mapped loopback service ports", () => {
    expect(dockerSandboxSyncLocalAuth({})).toBe(false)
    expect(dockerSandboxSyncLocalAuth({ CLAXEDO_DOCKER_SANDBOX_SYNC_LOCAL_AUTH: "1" })).toBe(true)
    expect(dockerSandboxSyncLocalAuth({ CLAXEDO_DOCKER_SANDBOX_SYNC_LOCAL_AUTH: "false" })).toBe(false)
    expect(
      dockerSandboxAuthHome({
        CLAXEDO_DOCKER_SANDBOX_AUTH_HOME: "/tmp/auth-home",
        HOME: "/tmp/real-home",
      }),
    ).toBe("/tmp/auth-home")
    expect(dockerSandboxImageFromEnv({ CLAXEDO_DOCKER_SANDBOX_IMAGE: "env-image:test" })).toBe("env-image:test")
    expect(dockerSandboxImageFromEnv({})).toBe(SANDBOX_IMAGE)
    expect(dockerLocalAuthCandidates("/tmp/auth-home").map((item) => item.target)).toEqual([
      "/root/.codex/auth.json",
      "/root/.codex/accounts",
      "/root/.local/share/opencode/auth.json",
      "/root/.claude.json",
    ])
    expect(parseDockerPort("127.0.0.1:5330\n")).toBe("http://127.0.0.1:5330")
    expect(parseDockerPort("0.0.0.0:32768")).toBe("http://127.0.0.1:32768")
    expect(parseDockerPort("[::]:32769")).toBe("http://127.0.0.1:32769")
    expect(parseDockerPort("")).toBeUndefined()
  })

  test("ensureHost creates a container that starts workspace-runtime with boot env", async () => {
    const docker = runner()
    const driver = createDockerSandboxDriver({
      image: "claxedo-sandbox:test",
      docker: docker.fn,
      syncLocalAuth: false,
      waitForHealth: false,
      runner: "opencode",
      env: (_input, host) => ({
        WORKSPACE_RUNTIME_LEASE_ID: `lease-${host.id}`,
        WORKSPACE_RUNTIME_SANDBOX_ID: host.id,
      }),
    })

    const result = await driver.ensureHost({
      ...input,
      workspaceRoot: "/work/app",
      env: { CUSTOM_BOOT_FLAG: "yes" },
      source: { kind: "git", repoUrl: "https://repo.test/app.git", branch: "dev" },
    })
    if ("provisioning" in result) throw new Error("expected ready")

    expect(docker.calls[0]).toEqual(
      expect.arrayContaining([
        "create",
        "--name",
        "docker-host-ws_1",
        "--label",
        "app=claxedo",
        "--label",
        "claxedo.workspaceId=ws_1",
        "-p",
        "127.0.0.1::2593",
        "--entrypoint",
        "sh",
        "claxedo-sandbox:test",
        "-lc",
      ]),
    )
    expect(docker.calls[0]).toEqual(
      expect.arrayContaining([
        "--env",
        "WORKSPACE_RUNTIME_WORKSPACE_ID=ws_1",
        "--env",
        "WORKSPACE_RUNTIME_HOST_ID=docker-host-ws_1",
        "--env",
        "WORKSPACE_RUNTIME_DIRECTORY=/work/app",
        "--env",
        "WORKSPACE_RUNTIME_PORT=2593",
        "--env",
        "WORKSPACE_RUNTIME_HOST=0.0.0.0",
        "--env",
        "WORKSPACE_RUNTIME_RUNNER=opencode",
        "--env",
        "WORKSPACE_RUNTIME_SOURCE_KIND=git",
        "--env",
        "WORKSPACE_RUNTIME_GIT_REPO_URL=https://repo.test/app.git",
        "--env",
        "WORKSPACE_RUNTIME_GIT_BRANCH=dev",
        "--env",
        "WORKSPACE_RUNTIME_LEASE_ID=lease-docker-host-ws_1",
        "--env",
        "WORKSPACE_RUNTIME_SANDBOX_ID=docker-host-ws_1",
        "--env",
        "CUSTOM_BOOT_FLAG=yes",
      ]),
    )
    expect(docker.calls[0].at(-1)).toContain("exec /usr/local/bin/workspace-runtime")
    expect(docker.calls[1]).toEqual(["start", "container-id"])
    expect(docker.calls[2]).toEqual(["port", "container-id", "2593/tcp"])
    expect(result).toMatchObject({
      sandboxId: "container-id",
      hostId: "docker-host-ws_1",
      url: "http://127.0.0.1:5330",
      driverResourceId: "container-id",
    })
    expect(result).not.toHaveProperty("runtimeUrl")
  })

  test("waits for mapped runtime health before returning a ready target", async () => {
    const docker = runner()
    const healthFetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503, statusText: "Starting" }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const driver = createDockerSandboxDriver({
      image: "claxedo-sandbox:test",
      docker: docker.fn,
      syncLocalAuth: false,
      healthFetch,
      healthIntervalMs: 0,
    })

    const result = await driver.ensureHost(input)
    if ("provisioning" in result) throw new Error("expected ready")

    expect(healthFetch).toHaveBeenCalledWith("http://127.0.0.1:5330/global/health", expect.any(Object))
    expect(healthFetch).toHaveBeenCalledTimes(2)
    expect(result.url).toBe("http://127.0.0.1:5330")
  })

  test("stages local auth into a stopped container before start", async () => {
    const authHome = await tempDir()
    await fs.mkdir(path.join(authHome, ".codex", "accounts"), { recursive: true })
    await fs.writeFile(path.join(authHome, ".codex", "auth.json"), "{}")
    await fs.writeFile(path.join(authHome, ".codex", "accounts", "user.json"), "{}")
    const docker = runner()
    const driver = createDockerSandboxDriver({
      image: "claxedo-sandbox:test",
      docker: docker.fn,
      authHome,
      // Credential sync is opt-in now; the explicit request is what this
      // staging behavior test exercises.
      syncLocalAuth: true,
      waitForHealth: false,
    })

    await driver.ensureHost(input)

    expect(docker.calls[1][0]).toBe("cp")
    expect(docker.calls[1][2]).toBe("container-id:/tmp/claxedo-auth")
    expect(docker.calls[2]).toEqual(["start", "container-id"])
  })

  test("image boot overrides the configured image and driver snapshots are rejected", async () => {
    const docker = runner()
    const driver = createDockerSandboxDriver({
      image: "claxedo-sandbox:test",
      docker: docker.fn,
      syncLocalAuth: false,
      waitForHealth: false,
    })

    await driver.ensureHost({ ...input, bootSource: { kind: "image", image: "prepared-image:test" } })
    expect(docker.calls[0]).toContain("prepared-image:test")

    await expect(
      driver.ensureHost({
        ...input,
        bootSource: { kind: "driver-snapshot", snapshotId: "snap_1" },
      }),
    ).rejects.toThrow(/driver snapshots/)
  })

  test("restricted network policies are rejected", async () => {
    const driver = createDockerSandboxDriver({
      image: "claxedo-sandbox:test",
      docker: runner().fn,
      syncLocalAuth: false,
      waitForHealth: false,
    })

    await expect(
      driver.ensureHost({
        ...input,
        net: { mode: "restricted", hosts: [] },
      }),
    ).rejects.toThrow(/restricted network policies/)
  })

  test("resumeHost, stop, destroy, and metadata expose direct host semantics", async () => {
    const docker = runner()
    const driver = createDockerSandboxDriver({
      image: "claxedo-sandbox:test",
      docker: docker.fn,
      syncLocalAuth: false,
      waitForHealth: false,
    })

    const restarted = await driver.resumeHost!({
      lease: {
        workspaceId: "ws_1",
        homeRegion: "us-east",
        driver: "docker",
        epoch: 1,
        status: "stopped",
        retryCount: 0,
        updatedAt: 1,
        createdAt: 1,
        sandboxId: "container-id",
      },
      ensure: input,
    })
    if ("provisioning" in restarted) throw new Error("expected ready")
    await driver.stop!(restarted)
    await driver.destroy!(restarted)

    expect(docker.calls[0]).toEqual(["inspect", "-f", "{{.Id}}", "container-id"])
    expect(docker.calls[1]).toEqual(["start", "container-id"])
    expect(docker.calls[2]).toEqual(["port", "container-id", "2593/tcp"])
    expect(docker.calls[3]).toEqual(["stop", "container-id"])
    expect(docker.calls[4]).toEqual(["rm", "-f", "container-id"])
    expect(driver.metadata).toMatchObject({
      driverRunsIn: ["local"],
      hostStopBehavior: "terminates-host", hostResumeBehavior: "same-host",
      targetAccess: "loopback",
    })
  })
})
