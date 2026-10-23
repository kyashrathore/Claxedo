import { afterAll, beforeAll, describe, expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createLocalJWKSet, exportJWK, exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { mintRelayHostToken, type RelayRole } from "@claxedo/workspace-relay"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { resolveMintKid } from "@claxedo/server-core/platform/auth/runtime-access-token"
import {
  HOST_MANAGEMENT_GRANT_HEADER,
  HOST_MANAGEMENT_ROUTES,
  mintHostManagementGrant,
  type HostManagementOperation,
} from "@claxedo/server-core/platform/auth/host-management-grant"
import { createHostRuntimeListener, installHostProviderConfigAuthority, type HostRuntimeListener } from "./runtime"
import { createHostManagement } from "./host-management"
import { createServer, type Server } from "node:http"

const HOST_ID = "host_machine-1"
const ENROLLMENT_ID = "enrollment_machine-1"
const OWNER = "user_owner"
const WORKSPACE = "11111111-1111-4111-8111-111111111111"
const RELAY_KID = "relay-host-current"

function listen(server: Server) {
  return new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("no port")
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

describe("host management through a served workspace", () => {
  let relayKey: Awaited<ReturnType<typeof generateKeyPair>>
  let planeEnv: Record<string, string>
  let jwks: Server
  let listener: HostRuntimeListener
  let root: string
  let tree: string
  const previousDataDir = process.env.CLAXEDO_DATA_DIR

  beforeAll(async () => {
    relayKey = await generateKeyPair("EdDSA", { extractable: true })
    const relayJwk = { ...(await exportJWK(relayKey.publicKey)), kid: RELAY_KID, alg: "EdDSA", use: "sig" }
    jwks = createServer((_request, response) => {
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ keys: [relayJwk] }))
    })
    const relayJwksUrl = `${await listen(jwks)}/.well-known/jwks.json`
    const planeKey = await generateKeyPair("EdDSA", { extractable: true })
    planeEnv = {
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(planeKey.privateKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(planeKey.publicKey),
    }
    const planeJwk = { ...(await exportJWK(planeKey.publicKey)), alg: "EdDSA", kid: await resolveMintKid(planeEnv, planeKey.privateKey) }
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "host-management-")))
    tree = path.join(root, "tree")
    for (const folder of ["alpha", "beta/nested-app", ".hidden", "node_modules/pkg"]) await fs.mkdir(path.join(tree, folder), { recursive: true })
    await fs.writeFile(path.join(tree, "README.md"), "a file\n")
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
    installHostProviderConfigAuthority()
    const management = createHostManagement({ enrollmentId: ENROLLMENT_ID, hostId: HOST_ID, controlPlaneKeys: createLocalJWKSet({ keys: [planeJwk] }) })
    listener = await createHostRuntimeListener({ hostname: "127.0.0.1", port: 0, drainTimeoutMs: 2_000 })
    const directory = path.join(root, "served")
    await fs.mkdir(directory)
    await listener.ensure({
      workspaceId: WORKSPACE,
      directory,
      hostId: HOST_ID,
      relay: { jwksUrl: relayJwksUrl },
      sessionAuthorityUrl: "http://127.0.0.1:9/api/runtime-authority/session-authorize",
      storeRoot: path.join(root, "state"),
      routeContributions: [management.contribution],
    })
  })

  afterAll(async () => {
    if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
    else process.env.CLAXEDO_DATA_DIR = previousDataDir
    await listener?.close()
    ClaxedoDB.close()
    await new Promise<void>((resolve) => jwks?.close(() => resolve()))
    await fs.rm(root, { recursive: true, force: true })
  })

  async function relayHeaders(input: { role?: RelayRole; userId?: string; sessionId?: string } = {}) {
    const token = await mintRelayHostToken({
      principalKind: "user",
      actorId: "actor_owner",
      userId: input.userId ?? OWNER,
      actorKind: "human",
      orgId: "org_1",
      workspaceId: WORKSPACE,
      hostId: HOST_ID,
      role: input.role ?? "owner",
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      parentJti: "rat_jti_1",
      backing: "local-worktree",
      kid: RELAY_KID,
    }, relayKey.privateKey, "EdDSA")
    return { authorization: `Bearer ${token}`, "x-workspace-id": WORKSPACE, "x-forwarded-by": "workspace-relay", "content-type": "application/json" }
  }

  async function grant(operation: HostManagementOperation, destination: string, overrides: { ownerUserId?: string; enrollmentId?: string } = {}) {
    return (await mintHostManagementGrant({
      ownerUserId: overrides.ownerUserId ?? OWNER,
      orgId: "org_1",
      enrollmentId: overrides.enrollmentId ?? ENROLLMENT_ID,
      hostId: HOST_ID,
      operation,
      destination,
    }, planeEnv)).token
  }

  async function readFolders(body: Record<string, unknown>, headers: Record<string, string>) {
    const response = await listener.fetch(new Request(`${listener.url}/workspaces/${WORKSPACE}${HOST_MANAGEMENT_ROUTES["folders.read"]}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }))
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }

  test("the owner reads the machine's home, one folder's subfolders and a search under it, each on its own grant", async () => {
    const home = await readFolders({ read: "home" }, { ...await relayHeaders(), [HOST_MANAGEMENT_GRANT_HEADER]: await grant("folders.read", "~") })
    expect(home).toEqual({ status: 200, body: { home: os.homedir() } })

    const children = await readFolders({ read: "children", directory: tree }, { ...await relayHeaders(), [HOST_MANAGEMENT_GRANT_HEADER]: await grant("folders.read", tree) })
    expect(children).toEqual({ status: 200, body: { folders: [
      { name: ".hidden", absolute: path.join(tree, ".hidden") },
      { name: "alpha", absolute: path.join(tree, "alpha") },
      { name: "beta", absolute: path.join(tree, "beta") },
      { name: "node_modules", absolute: path.join(tree, "node_modules") },
    ] } })

    const search = await readFolders({ read: "search", directory: tree, query: "app", limit: 10 }, { ...await relayHeaders(), [HOST_MANAGEMENT_GRANT_HEADER]: await grant("folders.read", tree) })
    expect(search).toEqual({ status: 200, body: { folders: ["beta/nested-app"] } })
  })

  test("a folder that is not there is named as such", async () => {
    const missing = path.join(tree, "gone")
    const answer = await readFolders({ read: "children", directory: missing }, { ...await relayHeaders(), [HOST_MANAGEMENT_GRANT_HEADER]: await grant("folders.read", missing) })
    expect(answer).toMatchObject({ status: 404, body: { error: { code: "folder_not_found" } } })
  })

  test("no grant, another machine's, another person's, another destination's or a spent one reads nothing", async () => {
    const headers = await relayHeaders()
    const body = { read: "children", directory: tree }
    expect(await readFolders(body, headers)).toMatchObject({ status: 401, body: { error: { code: "host_management_grant_required" } } })
    expect(await readFolders(body, { ...headers, [HOST_MANAGEMENT_GRANT_HEADER]: await grant("folders.read", tree, { enrollmentId: "enrollment_other" }) }))
      .toMatchObject({ status: 403, body: { error: { code: "host_management_grant_invalid" } } })
    expect(await readFolders(body, { ...headers, [HOST_MANAGEMENT_GRANT_HEADER]: await grant("folders.read", tree, { ownerUserId: "user_other" }) }))
      .toMatchObject({ status: 403, body: { error: { code: "host_management_grant_mismatch" } } })
    expect(await readFolders(body, { ...headers, [HOST_MANAGEMENT_GRANT_HEADER]: await grant("folders.read", root) }))
      .toMatchObject({ status: 403, body: { error: { code: "host_management_grant_mismatch" } } })
    expect(await readFolders(body, { ...headers, [HOST_MANAGEMENT_GRANT_HEADER]: await grant("clone", tree) }))
      .toMatchObject({ status: 403, body: { error: { code: "host_management_grant_mismatch" } } })
    const once = await grant("folders.read", tree)
    expect((await readFolders(body, { ...headers, [HOST_MANAGEMENT_GRANT_HEADER]: once })).status).toBe(200)
    expect(await readFolders(body, { ...await relayHeaders(), [HOST_MANAGEMENT_GRANT_HEADER]: once }))
      .toMatchObject({ status: 409, body: { error: { code: "host_management_grant_spent" } } })
  })

  test("a caller the relay names as anyone but the owner reads nothing, grant or not", async () => {
    const body = { read: "children", directory: tree }
    expect(await readFolders(body, { ...await relayHeaders({ role: "editor" }), [HOST_MANAGEMENT_GRANT_HEADER]: await grant("folders.read", tree) }))
      .toMatchObject({ status: 403, body: { error: { code: "host_management_owner_required" } } })
    const bare = await listener.fetch(new Request(`${listener.url}/workspaces/${WORKSPACE}${HOST_MANAGEMENT_ROUTES["folders.read"]}`, {
      method: "POST",
      headers: { "content-type": "application/json", [HOST_MANAGEMENT_GRANT_HEADER]: await grant("folders.read", tree) },
      body: JSON.stringify(body),
    }))
    expect(bare.status).toBe(401)
  })
})
