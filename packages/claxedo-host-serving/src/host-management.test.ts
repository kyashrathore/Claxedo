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
import { execFileSync, spawnSync } from "node:child_process"
import { createServer, type IncomingMessage, type Server } from "node:http"

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

async function requestBody(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

/** `git http-backend` over the bare repositories under `projectRoot`, for the requests `admit` maps to a repository path. */
function gitHttpServer(projectRoot: string, admit: (request: IncomingMessage) => string | undefined) {
  return createServer(async (request, response) => {
    const pathInfo = admit(request)
    if (!pathInfo) {
      response.writeHead(401).end()
      return
    }
    const input = await requestBody(request)
    const result = spawnSync("git", ["http-backend"], {
      input,
      env: {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: "1",
        REQUEST_METHOD: request.method ?? "GET",
        PATH_INFO: pathInfo,
        QUERY_STRING: new URL(request.url ?? "/", "http://127.0.0.1").search.slice(1),
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        CONTENT_LENGTH: String(input.length),
      },
    })
    const separator = result.stdout.indexOf("\r\n\r\n")
    let status = 200
    for (const line of result.stdout.subarray(0, separator).toString().split("\r\n")) {
      const colon = line.indexOf(":")
      if (colon < 0) continue
      const name = line.slice(0, colon).trim()
      const value = line.slice(colon + 1).trim()
      if (name.toLowerCase() === "status") status = Number.parseInt(value, 10)
      else response.setHeader(name, value)
    }
    response.writeHead(status).end(result.stdout.subarray(separator + 4))
  })
}

function bareRepository(projectRoot: string, fullName: string, readme: string) {
  const working = path.join(projectRoot, "working", fullName)
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", ...args], { cwd: working })
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", working])
  return fs.writeFile(path.join(working, "README.md"), readme).then(() => {
    git("add", "README.md")
    git("commit", "--quiet", "-m", "init")
    execFileSync("git", ["clone", "--quiet", "--bare", working, path.join(projectRoot, `${fullName}.git`)])
  })
}

describe("host management through a served workspace", () => {
  let relayKey: Awaited<ReturnType<typeof generateKeyPair>>
  let planeEnv: Record<string, string>
  let jwks: Server
  let listener: HostRuntimeListener
  let root: string
  let tree: string
  let gitServer: Server
  let broker: Server
  let gitUrl: string
  let brokerUrl: string
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
    const repositories = path.join(root, "repositories")
    await bareRepository(repositories, "acme/public", "public\n")
    await bareRepository(repositories, "acme/private", "private\n")
    gitServer = gitHttpServer(repositories, (request) => new URL(request.url ?? "/", "http://127.0.0.1").pathname.startsWith("/acme/public.git/")
      ? new URL(request.url ?? "/", "http://127.0.0.1").pathname
      : undefined)
    gitUrl = `${await listen(gitServer)}/acme/public.git`
    broker = gitHttpServer(repositories, (request) => {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname
      return request.headers.authorization === "Bearer stand-in" && pathname.startsWith("/bindings/b1/acme/private.git/")
        ? pathname.slice("/bindings/b1".length)
        : undefined
    })
    brokerUrl = `${await listen(broker)}/bindings/b1`
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
    await new Promise<void>((resolve) => gitServer?.close(() => resolve()))
    await new Promise<void>((resolve) => broker?.close(() => resolve()))
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

  async function clone(body: Record<string, unknown>, destination: string) {
    const response = await listener.fetch(new Request(`${listener.url}/workspaces/${WORKSPACE}${HOST_MANAGEMENT_ROUTES.clone}`, {
      method: "POST",
      headers: { ...await relayHeaders(), [HOST_MANAGEMENT_GRANT_HEADER]: await grant("clone", destination) },
      body: JSON.stringify(body),
    }))
    return { status: response.status, body: JSON.parse(await response.text()) as Record<string, unknown> }
  }

  const origin = (directory: string) => execFileSync("git", ["config", "--get", "remote.origin.url"], { cwd: directory, encoding: "utf8" }).trim()

  test("the owner clones a repository by its URL into a new folder, and a folder already there is refused", async () => {
    const directory = path.join(root, "clones", "public")
    expect(await clone({ repoUrl: gitUrl, directory }, directory)).toEqual({ status: 200, body: { directory } })
    expect(await fs.readFile(path.join(directory, "README.md"), "utf8")).toBe("public\n")
    expect(origin(directory)).toBe(gitUrl)

    expect(await clone({ repoUrl: gitUrl, directory }, directory)).toMatchObject({ status: 200, body: { error: { code: "folder_exists", status: 409 } } })
  })

  test("a brokered clone reaches the repository through the broker alone, and its checkout's origin is the repository", async () => {
    const repoUrl = "https://github.com/acme/private.git"
    const directory = path.join(root, "clones", "private")
    expect(await clone({ repoUrl, directory, broker: { url: brokerUrl, authorization: "Bearer stand-in" } }, directory)).toEqual({ status: 200, body: { directory } })
    expect(await fs.readFile(path.join(directory, "README.md"), "utf8")).toBe("private\n")
    expect(origin(directory)).toBe(repoUrl)
    expect(await fs.readFile(path.join(directory, ".git", "config"), "utf8")).not.toContain("stand-in")

    const refused = path.join(root, "clones", "refused")
    expect(await clone({ repoUrl, directory: refused, broker: { url: brokerUrl, authorization: "Bearer spent" } }, refused))
      .toMatchObject({ status: 200, body: { error: { code: "repository_clone_failed", status: 502 } } })
    await expect(fs.stat(refused)).rejects.toThrow()
  })

  test("a clone names its repository and a full path, and its grant names that folder", async () => {
    const directory = path.join(root, "clones", "unnamed")
    expect(await clone({ repoUrl: gitUrl, directory: "clones/relative" }, "clones/relative")).toMatchObject({ status: 400, body: { error: { code: "host_management_request_invalid" } } })
    expect(await clone({ repoUrl: gitUrl, directory, broker: { url: brokerUrl } }, directory)).toMatchObject({ status: 400 })
    expect(await clone({ repoUrl: gitUrl, directory }, path.join(root, "clones"))).toMatchObject({ status: 403, body: { error: { code: "host_management_grant_mismatch" } } })
    expect(await clone({ repoUrl: "file:///etc", directory }, directory)).toMatchObject({ status: 200, body: { error: { code: "repository_clone_failed" } } })
    await expect(fs.stat(directory)).rejects.toThrow()
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
