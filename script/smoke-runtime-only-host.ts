import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import { fileURLToPath } from "node:url"
import {
  mintHostTunnelToken,
  mintRuntimeAccessToken,
} from "../packages/workspace-relay/src/auth"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const serverDir = path.join(repoRoot, "packages", "claxedo-server")
const exampleDir = path.join(repoRoot, "examples", "runtime-only-host")

async function generateEd25519KeyPair() {
  return await crypto.subtle.generateKey(
    "Ed25519",
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair
}

async function exportJwk(key: CryptoKey) {
  return await crypto.subtle.exportKey("jwk", key)
}

async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Could not allocate runtime port")
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
  return address.port
}

async function stopChild(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode) return
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL")
      resolve()
    }, 5_000)
    child.once("exit", () => {
      clearTimeout(timeout)
      resolve()
    })
    child.kill("SIGTERM")
  })
}

async function waitForJsonLine<T extends Record<string, unknown>>(input: {
  child: ChildProcess
  label: string
  timeoutMs: number
  accepts: (value: Record<string, unknown>) => boolean
}) {
  return await new Promise<T>((resolve, reject) => {
    let settled = false
    let stdout = ""
    let logs = ""
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      reject(new Error(`${err.message}\n${logs}`))
    }
    const timeout = setTimeout(() => fail(new Error(`${input.label} did not emit fixture JSON`)), input.timeoutMs)
    input.child.stdout?.on("data", (chunk) => {
      const text = chunk.toString()
      stdout += text
      logs += text
      const lines = stdout.split("\n")
      stdout = lines.pop() ?? ""
      for (const line of lines) {
        if (settled || !line.trim()) continue
        const parsed = (() => {
          try {
            return JSON.parse(line) as Record<string, unknown>
          } catch {
            return
          }
        })()
        if (!parsed) continue
        if (!input.accepts(parsed)) continue
        settled = true
        clearTimeout(timeout)
        resolve(parsed as T)
      }
    })
    input.child.stderr?.on("data", (chunk) => {
      logs += chunk.toString()
    })
    input.child.once("exit", (code, signal) => {
      if (settled) return
      clearTimeout(timeout)
      fail(new Error(`${input.label} exited before ready (${code ?? signal})`))
    })
    input.child.once("error", fail)
  })
}

async function until<T>(fn: () => Promise<T | undefined>, ms = 20_000, step = 100) {
  const end = Date.now() + ms
  let err: unknown
  while (Date.now() < end) {
    try {
      const result = await fn()
      if (result !== undefined) return result
    } catch (next) {
      err = next
    }
    await new Promise((resolve) => setTimeout(resolve, step))
  }
  throw err instanceof Error ? err : new Error("Timed out")
}

async function main() {
  const workspaceId = "ws_runtime_only_host_smoke"
  const hostId = "host_runtime_only_host_smoke"
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-runtime-only-host-smoke-"))
  const workspaceDir = path.join(root, "workspace")
  await fs.mkdir(workspaceDir, { recursive: true })
  await fs.writeFile(path.join(workspaceDir, "hello.txt"), "hello from runtime-only host\n")

  const runtime = await generateEd25519KeyPair()
  const relayHost = await generateEd25519KeyPair()
  let relay: ChildProcess | undefined
  let example: ChildProcess | undefined

  try {
    relay = spawn("bun", ["src/user-hosted-relay-fixture.mjs"], {
      cwd: serverDir,
      env: {
        ...process.env,
        CLAXEDO_DATA_DIR: path.join(root, "server-data"),
        CLAXEDO_RELAY_FIXTURE_WORKSPACE_ID: workspaceId,
        CLAXEDO_RELAY_FIXTURE_HOST_ID: hostId,
        CLAXEDO_RELAY_FIXTURE_RUNTIME_PUBLIC_KEY_JWK: JSON.stringify(await exportJwk(runtime.publicKey)),
        CLAXEDO_RELAY_FIXTURE_HOST_PRIVATE_KEY_JWK: JSON.stringify(await exportJwk(relayHost.privateKey)),
      },
      // The relay fixture treats stdin as its owner-liveness signal. Keep the
      // pipe open for this smoke run's lifetime so the child does not exit on EOF.
      stdio: ["pipe", "pipe", "pipe"],
    })
    const relayReady = await waitForJsonLine<{ url: string }>({
      child: relay,
      label: "runtime-only relay fixture",
      timeoutMs: 10_000,
      accepts: (value) => typeof value.url === "string",
    })
    const runtimePort = await freePort()
    example = spawn("bun", ["run", "start"], {
      cwd: exampleDir,
      env: {
        ...process.env,
        CLAXEDO_DATA_DIR: path.join(root, "runtime-data"),
        CLAXEDO_STATE_DIR: path.join(root, "runtime-state"),
        CLAXEDO_WR_DIRECTORY: workspaceDir,
        CLAXEDO_WR_WORKSPACE_ID: workspaceId,
        CLAXEDO_WR_HOST_ID: hostId,
        CLAXEDO_WR_PORT: String(runtimePort),
        CLAXEDO_WR_RELAY_URL: relayReady.url,
        CLAXEDO_WR_RELAY_TUNNEL_TOKEN: await mintHostTunnelToken({
          subject: "runtime_only_host",
          hostId,
          workspaceIds: [workspaceId],
        }, runtime.privateKey, "EdDSA"),
        CLAXEDO_WR_RELAY_HOST_PUBLIC_KEY_JWK: JSON.stringify(await exportJwk(relayHost.publicKey)),
        CLAXEDO_WR_RELAY_JWT_ALG: "EdDSA",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    await waitForJsonLine({
      child: example,
      label: "runtime-only host example",
      timeoutMs: 20_000,
      accepts: (value) => value.mode === "runtime-only-host" && value.workspaceId === workspaceId,
    })

    const runtimeAccessToken = await mintRuntimeAccessToken({
      subject: "runtime_only_client",
      orgId: "org_runtime_only",
      workspaceId,
      hostId,
      role: "editor",
    }, runtime.privateKey, "EdDSA")
    const relayFetch = (route: string) =>
      fetch(`${relayReady.url}/workspaces/${workspaceId}${route}`, {
        headers: {
          authorization: `Bearer ${runtimeAccessToken}`,
        },
      })
    const health = await until(async () => {
      const response = await relayFetch("/api/wr/health")
      return response.status === 200 ? response : undefined
    })
    const healthJson = await health.json() as Record<string, unknown>
    if (healthJson.workspaceId !== workspaceId || healthJson.service !== "workspace-runtime") {
      throw new Error(`Unexpected runtime health response: ${JSON.stringify(healthJson)}`)
    }

    const file = await relayFetch("/file/raw?path=hello.txt")
    if (file.status !== 200) throw new Error(`Relay file read failed: ${file.status} ${await file.text()}`)
    const text = await file.text()
    if (text !== "hello from runtime-only host\n") throw new Error(`Unexpected relay file content: ${JSON.stringify(text)}`)

    await stopChild(example)
    const offline = await until(async () => {
      const response = await relayFetch("/api/wr/health")
      return response.status !== 200 ? response.status : undefined
    })
    console.log(JSON.stringify({
      ok: true,
      workspaceId,
      hostId,
      relayUrl: relayReady.url,
      offlineStatus: offline,
    }))
  } finally {
    await stopChild(example)
    await stopChild(relay)
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}

await main()
