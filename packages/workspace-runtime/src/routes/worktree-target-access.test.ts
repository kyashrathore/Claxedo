import { afterEach, describe, expect, test } from "bun:test"
import { generateKeyPair, SignJWT } from "jose"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { embeddedWorkspaceRuntimeExposure, EMBEDDED_RELAY_HOST_AUTH_HEADER, relayWorkspaceRuntimeExposure } from "../exposure"
import { remoteWorkspaceSessionAccessPolicy } from "../remote-session-authority"
import { createWorkspaceRuntimeApp, type WorkspaceRuntimeApp } from "../server"
import { loopbackMachineLoginPolicy } from "../testing"
import { fetchBodyJson, fetchUrl } from "../test-support/fetch-double"
import { asRecord } from "@claxedo/helpers/guards"

const target = { workspaceId: "ws_root_files", hostId: "host_root_files" }

const cleanups: Array<() => Promise<unknown>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function git(args: string[], cwd: string) {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(stderr)
  return stdout.trim()
}

/** A workspace root no session claims: one committed file and one uncommitted change. */
async function repository() {
  const directory = await mkdtemp(path.join(tmpdir(), "workspace-runtime-root-files-"))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  await git(["init", "-b", "main"], directory)
  await git(["config", "user.email", "runtime@example.test"], directory)
  await git(["config", "user.name", "Workspace Runtime"], directory)
  await writeFile(path.join(directory, "README.md"), "base\n")
  await git(["add", "README.md"], directory)
  await git(["commit", "-m", "initial"], directory)
  await writeFile(path.join(directory, "README.md"), "changed\n")
  return directory
}

function started(app: WorkspaceRuntimeApp) {
  cleanups.push(() => app.dispose())
  return app
}

/**
 * The control plane's host authority as the runtime's remote policy reaches
 * it: it answers for the parent Runtime Access Token of the host token it is
 * shown, so revoking that parent refuses a host token that still verifies.
 */
function hostAuthority() {
  const asked: Array<{ action: unknown; authorization: string | null }> = []
  let parentActive = true
  const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    const action = asRecord(fetchBodyJson(init?.body))?.action
    asked.push({ action, authorization: headers.get("authorization") })
    if (action !== "host_read" && action !== "host_admin") {
      return Response.json({ error: { code: "unexpected_action", message: JSON.stringify(action) } }, { status: 400 })
    }
    return parentActive
      ? Response.json({ allowed: true })
      : Response.json({ error: { code: "runtime_access_token_inactive", message: "Runtime Access Token is inactive" } }, { status: 401 })
  }
  return { asked, fetch, revoke: () => { parentActive = false } }
}

async function relayed(directory: string) {
  const pair = await generateKeyPair("EdDSA")
  const authority = hostAuthority()
  const runtime = started(createWorkspaceRuntimeApp({
    sessionIdWorkspace: () => undefined, placement: loopbackMachineLoginPolicy(),
    exposure: relayWorkspaceRuntimeExposure({ ...target, key: pair.publicKey }),
    target: { workspaceId: target.workspaceId, directory },
    sessionAccessPolicy: remoteWorkspaceSessionAccessPolicy({ url: "https://control.example.test/authority", fetch: authority.fetch }),
  }))
  const token = await new SignJWT({
    principal_kind: "user", actor_id: "actor_owner", actor_kind: "human",
    actor_public_id: "usr_owner", actor_name: "Owner",
    org_id: "org_root_files", workspace_id: target.workspaceId, host_id: target.hostId,
    role: "owner", scope: "workspace", backing: "cloud-vm", parent_jti: "rat_parent",
  }).setProtectedHeader({ alg: "EdDSA" }).setIssuer("workspace-relay").setAudience("workspace-host-service")
    .setIssuedAt().setExpirationTime("5m").setJti("rht_root_files").sign(pair.privateKey)
  const request = (pathname: string, init: Pick<RequestInit, "method" | "body"> = {}) => runtime.app.request(`http://localhost${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "x-workspace-id": target.workspaceId,
      "x-forwarded-by": "workspace-relay",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  })
  return { authority, request, token }
}

const READS = [
  "/api/wr/file?path=",
  "/api/wr/file/content?path=README.md",
  "/api/wr/find/file?query=READ",
  "/api/wr/file/status",
  "/api/wr/file/all",
  "/api/wr/git/status",
  "/api/wr/git/log",
  "/api/wr/git/snapshot?path=README.md",
  "/api/wr/diff/vcs",
  "/api/wr/diff/vcs/file?file=README.md",
] as const

const WRITES = [
  ["/api/wr/git/stage", { paths: ["README.md"] }],
  ["/api/wr/git/unstage", { paths: ["README.md"] }],
  ["/api/wr/git/commit-staged", { message: "stolen" }],
  ["/api/wr/git/commit", { path: "README.md", message: "stolen", content: "overwritten\n" }],
  ["/api/wr/git/push", {}],
] as const

describe("the workspace root no session claims", () => {
  test("every relayed read and write asks the current host authority, and a revoked parent reads and writes nothing", async () => {
    const directory = await repository()
    const relay = await relayed(directory)
    expect((await relay.request("/api/wr/file/content?path=README.md")).status).toBe(200)
    expect((await relay.request("/api/wr/git/stage", { method: "POST", body: JSON.stringify({ paths: ["README.md"] }) })).status).toBe(204)
    expect(relay.authority.asked.map((entry) => entry.action)).toEqual(["host_read", "host_admin"])
    const head = await git(["rev-parse", "HEAD"], directory)

    relay.authority.revoke()
    for (const route of READS) expect({ route, status: (await relay.request(route)).status }).toEqual({ route, status: 401 })
    for (const [route, body] of WRITES) {
      const response = await relay.request(route, { method: "POST", body: JSON.stringify(body) })
      expect({ route, status: response.status }).toEqual({ route, status: 401 })
    }
    expect(await git(["rev-parse", "HEAD"], directory)).toBe(head)
    expect(await git(["diff", "--cached", "--name-only"], directory)).toBe("README.md")
    expect(await readFile(path.join(directory, "README.md"), "utf8")).toBe("changed\n")
    expect(relay.authority.asked.every((entry) => entry.authorization === `Bearer ${relay.token}`)).toBe(true)
  })
})

describe("an unsigned desktop's root", () => {
  /** The daemon's own composition before any control plane has told it where its authority lives. */
  function unsignedDesktop(directory: string) {
    const fetched: string[] = []
    const runtime = started(createWorkspaceRuntimeApp({
      sessionIdWorkspace: () => undefined, placement: loopbackMachineLoginPolicy(),
      exposure: embeddedWorkspaceRuntimeExposure({ owner: "test", guard: () => true }),
      target: { workspaceId: target.workspaceId, directory },
      sessionAccessPolicy: remoteWorkspaceSessionAccessPolicy({
        url: () => undefined,
        requireActor: false,
        fetch: async (input) => {
          fetched.push(fetchUrl(input))
          return Response.json({ allowed: true })
        },
      }),
    }))
    return { runtime, fetched }
  }

  test("serves the machine's own user, who presents no relay identity, without asking any authority", async () => {
    const directory = await repository()
    const { runtime, fetched } = unsignedDesktop(directory)

    const content = await runtime.app.request("http://localhost/api/wr/file/content?path=README.md")
    expect(content.status).toBe(200)
    expect(await content.json()).toMatchObject({ content: "changed" })
    const staged = await runtime.app.request("http://localhost/api/wr/git/stage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: ["README.md"] }),
    })
    expect(staged.status).toBe(204)
    expect(await git(["diff", "--cached", "--name-only"], directory)).toBe("README.md")
    expect(fetched).toEqual([])
  })

  test("refuses a stamped relay identity while no host authority is reachable", async () => {
    const directory = await repository()
    const { runtime } = unsignedDesktop(directory)
    const stamp = JSON.stringify({
      principal_kind: "user", actor_id: "actor_member", actor_kind: "human",
      actor_public_id: "usr_member", actor_name: "Member",
      org_id: "org_root_files", workspace_id: target.workspaceId, role: "owner",
    })

    const response = await runtime.app.request("http://localhost/api/wr/file/content?path=README.md", {
      headers: { [EMBEDDED_RELAY_HOST_AUTH_HEADER]: stamp, authorization: "Bearer relay-host-token" },
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: "session_authority_unavailable" } })
  })
})
