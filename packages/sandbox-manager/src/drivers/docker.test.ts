import { execFileSync } from "node:child_process"
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
  const envs: Array<Record<string, string> | undefined> = []
  const fn: DockerCommandRunner = vi.fn(async (args, _timeout, env) => {
    calls.push(args)
    envs.push(env)
    if (args[0] === "create") return { stdout: output.create ?? "container-id\n" }
    if (args[0] === "port") return { stdout: output.port ?? "127.0.0.1:5330\n" }
    if (args[0] === "inspect") return { stdout: output.inspect ?? "container-id\n" }
    return { stdout: "" }
  })
  return { calls, envs, fn }
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

function nodeOnPath() {
  const found = execFileSync(process.platform === "win32" ? "where" : "which", ["node"], { encoding: "utf8" }).split(/\r?\n/).find(Boolean)
  if (!found) throw new Error("node is not on PATH")
  return found
}

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-docker-driver-test-"))
  tempDirs.push(dir)
  return dir
}

describe("DockerSandboxDriver", () => {
  test("resume inspect errors prevent start and ready target", async () => {
    const error = new Error("inspect denied")
    const docker = runner()
    const command: DockerCommandRunner = vi.fn(async (args, timeout) => {
      if (args[0] === "inspect") throw error
      return docker.fn(args, timeout)
    })
    const driver = createDockerSandboxDriver({ image: "claxedo-sandbox:test", docker: command, syncLocalAuth: false, waitForHealth: false })
    await expect(driver.resumeHost!({
      lease: {
        workspaceId: input.workspaceId, homeRegion: input.homeRegion, driver: "docker", epoch: 1,
        status: "stopped", retryCount: 0, updatedAt: 1, createdAt: 1, sandboxId: "container-id",
      },
      ensure: input,
    })).rejects.toBe(error)
    expect(docker.calls).toEqual([])
  })

  test("auth staging stat errors are not treated as missing credentials", async () => {
    const authHome = await tempDir()
    await fs.mkdir(path.join(authHome, ".codex"))
    await fs.symlink("auth.json", path.join(authHome, ".codex", "auth.json"))
    const docker = runner()
    const driver = createDockerSandboxDriver({ image: "claxedo-sandbox:test", docker: docker.fn, authHome, syncLocalAuth: true, waitForHealth: false })
    await expect(driver.ensureHost(input)).rejects.toMatchObject({ code: "ELOOP" })
    expect(docker.calls.some((args) => args[0] === "start")).toBe(false)
  })

  test("auth staging skips absent credentials", async () => {
    const authHome = await tempDir()
    const docker = runner()
    const driver = createDockerSandboxDriver({ image: "claxedo-sandbox:test", docker: docker.fn, authHome, syncLocalAuth: true, waitForHealth: false })
    expect(await driver.ensureHost(input)).toMatchObject({ sandboxId: "container-id" })
    expect(docker.calls.some((args) => args[0] === "cp")).toBe(false)
  })

  test("auth staging cleanup failure prevents start", async () => {
    const authHome = await tempDir()
    await fs.mkdir(path.join(authHome, ".codex"))
    await fs.writeFile(path.join(authHome, ".codex", "auth.json"), "{}")
    const error = Object.assign(new Error("cleanup denied"), { code: "EACCES" })
    const docker = runner()
    const originalRm = fs.rm.bind(fs)
    let stagedPath: string | undefined
    const rm = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (String(target).includes("claxedo-docker-auth-")) {
        stagedPath = String(target)
        throw error
      }
      return originalRm(target, options)
    })
    try {
      const driver = createDockerSandboxDriver({ image: "claxedo-sandbox:test", docker: docker.fn, authHome, syncLocalAuth: true, waitForHealth: false })
      await expect(driver.ensureHost(input)).rejects.toBe(error)
      expect(docker.calls.some((args) => args[0] === "start")).toBe(false)
    } finally {
      rm.mockRestore()
      if (stagedPath) await originalRm(stagedPath, { recursive: true, force: true })
    }
  })

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
      nativeHarness: "opencode",
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
        "WORKSPACE_RUNTIME_WORKSPACE_ID",
        "--env",
        "WORKSPACE_RUNTIME_HOST_ID",
        "--env",
        "WORKSPACE_RUNTIME_DIRECTORY",
        "--env",
        "WORKSPACE_RUNTIME_PORT",
        "--env",
        "WORKSPACE_RUNTIME_HOST",
        "--env",
        "WORKSPACE_RUNTIME_NATIVE_HARNESS",
        "--env",
        "WORKSPACE_RUNTIME_SOURCE_KIND",
        "--env",
        "WORKSPACE_RUNTIME_GIT_REPO_URL",
        "--env",
        "WORKSPACE_RUNTIME_GIT_BRANCH",
        "--env",
        "WORKSPACE_RUNTIME_LEASE_ID",
        "--env",
        "WORKSPACE_RUNTIME_SANDBOX_ID",
        "--env",
        "CUSTOM_BOOT_FLAG",
      ]),
    )
    expect(docker.calls[0].filter((arg) => /^[A-Z_]+=/.test(arg))).toEqual([])
    expect(docker.envs[0]).toEqual({
      WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_1",
      WORKSPACE_RUNTIME_HOST_ID: "docker-host-ws_1",
      WORKSPACE_RUNTIME_DIRECTORY: "/work/app",
      WORKSPACE_RUNTIME_PORT: "2593",
      WORKSPACE_RUNTIME_HOST: "0.0.0.0",
      WORKSPACE_RUNTIME_NATIVE_HARNESS: "opencode",
      WORKSPACE_RUNTIME_SOURCE_KIND: "git",
      WORKSPACE_RUNTIME_GIT_REPO_URL: "https://repo.test/app.git",
      WORKSPACE_RUNTIME_GIT_BRANCH: "dev",
      WORKSPACE_RUNTIME_LEASE_ID: "lease-docker-host-ws_1",
      WORKSPACE_RUNTIME_SANDBOX_ID: "docker-host-ws_1",
      CUSTOM_BOOT_FLAG: "yes",
    })
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

  test("the docker CLI receives boot env values in its environment, never in its arguments", async () => {
    // Windows runs only a real executable from `execFile`, so the `docker` on
    // PATH is node under another name, whose preload answers the CLI's calls
    // and exits before node would look for a script named `create`. It is a
    // copy there, where a symlink needs a privilege, and a symlink elsewhere,
    // where a copied node loses the shared library beside its install.
    const bin = await tempDir()
    const record = path.join(bin, "record")
    const node = nodeOnPath()
    const executable = path.join(bin, `docker${path.extname(node)}`)
    if (process.platform === "win32") await fs.copyFile(node, executable)
    else await fs.symlink(node, executable)
    const shim = path.join(bin, "docker-shim.cjs")
    await fs.writeFile(shim, [
      'const fs = require("node:fs")',
      'const path = require("node:path")',
      "const subcommand = path.basename(process.argv[1])",
      `if (subcommand === "create") {`,
      `  fs.writeFileSync(${JSON.stringify(`${record}.args`)}, [subcommand, ...process.argv.slice(2)].join("\\n"))`,
      `  fs.writeFileSync(${JSON.stringify(`${record}.env`)}, process.env.CUSTOM_BOOT_SECRET ?? "")`,
      '  process.stdout.write("container-id\\n")',
      "}",
      'if (subcommand === "port") process.stdout.write("127.0.0.1:5330\\n")',
      "process.exit(0)",
    ].join("\n"))
    const previous = { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS }
    process.env.PATH = `${bin}${path.delimiter}${previous.PATH ?? ""}`
    process.env.NODE_OPTIONS = `--require ${shim}`
    try {
      const driver = createDockerSandboxDriver({ image: "claxedo-sandbox:test", syncLocalAuth: false, waitForHealth: false })
      await driver.ensureHost({ ...input, env: { CUSTOM_BOOT_SECRET: "boot-secret-value" } })
    } finally {
      process.env.PATH = previous.PATH
      if (previous.NODE_OPTIONS === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = previous.NODE_OPTIONS
    }
    const args = (await fs.readFile(`${record}.args`, "utf8")).split("\n")
    expect(args[0]).toBe("create")
    expect(args).toContain("CUSTOM_BOOT_SECRET")
    expect(args.join("\n")).not.toContain("boot-secret-value")
    expect(await fs.readFile(`${record}.env`, "utf8")).toBe("boot-secret-value")
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

  test("option-like image identifiers are rejected before reaching docker argv", async () => {
    const docker = runner()
    const driver = createDockerSandboxDriver({
      image: "claxedo-sandbox:test",
      docker: docker.fn,
      syncLocalAuth: false,
      waitForHealth: false,
    })

    for (const bad of ["--privileged", "-v/host:/host", "img:test --network=host", " img:test"]) {
      await expect(
        driver.ensureHost({ ...input, bootSource: { kind: "image", image: bad } }),
      ).rejects.toThrow(/image reference/)
    }
    // Same guard on the configured/env image and the persisted snapshot paths.
    await expect(driver.ensureHost({ ...input, snapshot: "-e" })).rejects.toThrow(/image reference/)
    const badOptions = createDockerSandboxDriver({
      image: "--network=host",
      docker: docker.fn,
      syncLocalAuth: false,
      waitForHealth: false,
    })
    await expect(badOptions.ensureHost(input)).rejects.toThrow(/image reference/)

    expect(docker.calls).toHaveLength(0)
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
