import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, describe, expect, test } from "vitest"
import type { ControlPlaneServicesContract } from "@claxedo/server-core/authority/control-plane-contract"
import { BootstrapRoutes } from "./bootstrap"

const root = path.join(os.tmpdir(), `claxedo-bootstrap-route-${Date.now()}-${Math.random().toString(16).slice(2)}`)
const previous = {
  CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
  CLAXEDO_STATE_DIR: process.env.CLAXEDO_STATE_DIR,
}

process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
process.env.CLAXEDO_STATE_DIR = path.join(root, "state")

afterAll(async () => {
  if (previous.CLAXEDO_DATA_DIR === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previous.CLAXEDO_DATA_DIR
  if (previous.CLAXEDO_STATE_DIR === undefined) delete process.env.CLAXEDO_STATE_DIR
  else process.env.CLAXEDO_STATE_DIR = previous.CLAXEDO_STATE_DIR
  await fs.rm(root, { recursive: true, force: true })
})

const signedAuth = {
  authConfig: { enabled: true as const, issuer: "https://auth.test", jwksUrl: "custom:test" },
  verifier: async (token: string) => ({
    mode: "signed" as const,
    user: { subject: token, issuer: "https://auth.test", tokenIdentifier: token },
  }),
}

async function signedBootstrap(input: {
  workspaces?: unknown[]
  hostAggregateEvents?: boolean
  hostEnrollmentId?: () => string | undefined
} = {}) {
  return await BootstrapRoutes({
    ...signedAuth,
    hostAggregateEvents: input.hostAggregateEvents ?? false,
    ...(input.hostEnrollmentId ? { hostEnrollmentId: input.hostEnrollmentId } : {}),
    services: {
      authority: { listWorkspaces: async () => input.workspaces ?? [] },
    } as unknown as ControlPlaneServicesContract,
  }).request("http://control.example/api/claxedo/bootstrap", { headers: { authorization: "Bearer owner" } })
}

describe("BootstrapRoutes", () => {
  test("returns only Claxedo-owned bootstrap fields", async () => {
    const response = await BootstrapRoutes({ env: { npm_package_version: "9.9.9-test" }, hostAggregateEvents: true })
      .request("/api/claxedo/bootstrap")

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      healthy: true,
      version: "9.9.9-test",
      path: { worktree: "", directory: "" },
      project: [],
    })
    expect(body.provider_auth).toBeDefined()
    expect(body.provider).toBeUndefined()
    expect(body.config).toBeUndefined()
    expect(body.config_providers).toBeUndefined()
  })

  test("shell scope omits credential presentation", async () => {
    const response = await BootstrapRoutes({ env: {}, hostAggregateEvents: true })
      .request("/api/claxedo/bootstrap?scope=shell")

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.provider_auth).toBeUndefined()
    expect(body.provider).toBeUndefined()
  })

  test("allows loopback browser bootstrap when a bearer is attached", async () => {
    const response = await BootstrapRoutes({
      authConfig: { enabled: false, mode: "local-only", reason: "local test" },
      hostAggregateEvents: true,
    }).request("http://127.0.0.1/api/claxedo/bootstrap", {
      headers: {
        Authorization: "Bearer local-test-token",
        Origin: "http://127.0.0.1:4444",
      },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ healthy: true })
  })

  // The client cannot derive this from the server URL — a signed node runs its
  // issuer on localhost too — nor from its own build flags, so a body that
  // omits it leaves the reader opening a stream the server may refuse forever.
  test("declares whether this composition serves the host aggregate, in the local body", async () => {
    const served = await BootstrapRoutes({ env: {}, hostAggregateEvents: true })
      .request("/api/claxedo/bootstrap")
    await expect(served.json()).resolves.toMatchObject({ events: { hostAggregate: true } })

    const unserved = await BootstrapRoutes({ env: {}, hostAggregateEvents: false })
      .request("/api/claxedo/bootstrap")
    await expect(unserved.json()).resolves.toMatchObject({ events: { hostAggregate: false } })

    const shell = await BootstrapRoutes({ env: {}, hostAggregateEvents: false })
      .request("/api/claxedo/bootstrap?scope=shell")
    await expect(shell.json()).resolves.toMatchObject({ events: { hostAggregate: false } })
  })

  // A client answers "is the machine serving this workspace me" by comparing a
  // control-plane row's host to this one; nothing else on the wire ties that
  // row to the server the client is already talking to.
  test("states this machine's enrollment, and states its absence rather than omitting it", async () => {
    const enrolled = await BootstrapRoutes({
      env: {},
      hostAggregateEvents: true,
      hostEnrollmentId: () => "enr_this_machine",
    }).request("/api/claxedo/bootstrap")
    await expect(enrolled.json()).resolves.toMatchObject({ host: { enrollment: "enr_this_machine" } })

    const unenrolled = await BootstrapRoutes({ env: {}, hostAggregateEvents: true })
      .request("/api/claxedo/bootstrap")
    await expect(unenrolled.json()).resolves.toMatchObject({ host: { enrollment: null } })

    const shellScope = await BootstrapRoutes({
      env: {},
      hostAggregateEvents: true,
      hostEnrollmentId: () => "enr_this_machine",
    }).request("/api/claxedo/bootstrap?scope=shell")
    await expect(shellScope.json()).resolves.toMatchObject({ host: { enrollment: "enr_this_machine" } })
  })

  // The client cannot read this off the URL: a signed node runs its issuer on
  // localhost, and an unsigned node can be reached over a LAN name. The
  // declaration is derived from the composition's own auth config so the body
  // cannot say "sign in" about a server that authenticates by loopback.
  test("declares whether this composition issues sessions", async () => {
    const localOnly = await BootstrapRoutes({
      env: {},
      hostAggregateEvents: false,
      authConfig: { enabled: false, mode: "local-only", reason: "local test" },
    }).request("/api/claxedo/bootstrap")
    await expect(localOnly.json()).resolves.toMatchObject({ deployment: { issuesSessions: false } })

    const shell = await BootstrapRoutes({
      env: {},
      hostAggregateEvents: false,
      authConfig: { enabled: false, mode: "local-only", reason: "local test" },
    }).request("/api/claxedo/bootstrap?scope=shell")
    await expect(shell.json()).resolves.toMatchObject({ deployment: { issuesSessions: false } })

    const signed = await signedBootstrap()
    await expect(signed.json()).resolves.toMatchObject({ deployment: { issuesSessions: true } })
  })

  // A composition whose signed auth is misconfigured still refuses every signed
  // route. Declaring it a personal machine would send an unsigned client into a
  // shell where nothing it does can work.
  test("a misconfigured signed composition still says it issues sessions", async () => {
    const response = await BootstrapRoutes({
      env: {},
      hostAggregateEvents: false,
      authConfig: { enabled: false, mode: "misconfigured", reason: "hosted route mounted without an auth config" },
    }).request("http://control.example/api/claxedo/bootstrap")
    await expect(response.json()).resolves.toMatchObject({ deployment: { issuesSessions: true } })
  })

  // The declaration has to reach a caller who has not signed in yet — that is
  // the caller it is for — but the local body carries this node's project list
  // and home directory, which an anonymous caller has no claim on.
  test("an anonymous caller on a session-issuing node gets the declaration and nothing else", async () => {
    const response = await BootstrapRoutes({
      ...signedAuth,
      env: { npm_package_version: "9.9.9-test" },
      hostAggregateEvents: true,
    }).request("http://control.example/api/claxedo/bootstrap")

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({
      healthy: true,
      version: "9.9.9-test",
      events: { hostAggregate: true },
      deployment: { issuesSessions: true },
    })
  })

  test("an anonymous caller on a local-only node still gets the machine's own body", async () => {
    const response = await BootstrapRoutes({
      env: {},
      hostAggregateEvents: true,
      authConfig: { enabled: false, mode: "local-only", reason: "local test" },
    }).request("/api/claxedo/bootstrap")

    const body = await response.json()
    expect(body.path).toBeDefined()
    expect(body.project).toEqual([])
    expect(body.deployment).toEqual({ issuesSessions: false })
  })

  test("declares it in the signed body too", async () => {
    const response = await signedBootstrap()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ events: { hostAggregate: false } })
  })

  test("the signed body states the machine too", async () => {
    const response = await signedBootstrap({ hostEnrollmentId: () => "enr_node" })

    await expect(response.json()).resolves.toMatchObject({ host: { enrollment: "enr_node" } })
  })
})

describe("the signed bootstrap project inventory", () => {
  // A control-plane row is ADDRESSED by its id; the serving host's path is
  // placement metadata. Stated as `directory`, it would make
  // `workspaceRouteIdentity` resolve a `/w/<id>` route to a filesystem path,
  // the panes would register that path as their scope, and every live frame —
  // which both event lanes publish under `workspace:<id>` — would be dropped
  // for the mismatch.
  test("addresses a control-plane row by id and keeps the host path as remote_directory", async () => {
    const response = await signedBootstrap({
      workspaces: [
        {
          workspace_id: "ws_1",
          project_id: "proj_1",
          workspace_name: "Main",
          backing: "local-worktree",
          remote_directory: "/Users/host/repo",
        },
      ],
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      project: [
        {
          id: "proj_1",
          name: "proj_1",
          worktree: "ws_1",
          sandboxes: ["ws_1"],
          workspaces: {
            ws_1: {
              id: "ws_1",
              backing: "local-worktree",
              workspace_name: "Main",
              directory: "workspace:ws_1",
              remote_directory: "/Users/host/repo",
            },
          },
        },
      ],
    })
  })

  test("omits remote_directory when the row carries no host path", async () => {
    const response = await signedBootstrap({ workspaces: [{ workspace_id: "ws_2", backing: "cloud-vm" }] })

    const body = await response.json() as { project: Array<{ workspaces: Record<string, unknown> }> }
    expect(body.project[0]?.workspaces.ws_2).toEqual({
      id: "ws_2",
      backing: "cloud-vm",
      workspace_name: "ws_2",
      directory: "workspace:ws_2",
    })
  })
})
