import { afterEach, describe, expect, test } from "bun:test"
import { Hono, type MiddlewareHandler } from "hono"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { managedWorkspaceSessionAccessPolicy, type SessionAccessPolicy } from "../session-access-policy"
import { RuntimeStore } from "../store"
import { registerWorkspaceDirectory, unregisterWorkspaceDirectory, withWorkspaceTarget } from "../target"
import type { RelayHostAuthContext } from "../workspace-host-service-auth"
import { WorkspaceWorktreeManager } from "../worktree"
import { createDiffRoutes } from "../routes/diff"
import type { DiffRoutesDeps } from "../workspace-files/diff"
import { mountWorkspaceFiles } from "./core"

const WORKSPACE_ID = "ws_1"
const SECRET = "private-secret-contents"

const cleanups: Array<() => void | Promise<void>> = []

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

function relayAuth(role: NonNullable<RelayHostAuthContext["relayHostAuth"]>["role"] = "editor") {
  const now = Math.floor(Date.now() / 1000)
  return {
    iss: "workspace-relay",
    aud: "workspace-host-service",
    principal_kind: "user",
    actor_id: "actor_1",
    actor_kind: "human",
    org_id: "org_1",
    workspace_id: WORKSPACE_ID,
    host_id: "host_1",
    role,
    backing: "cloud-vm",
    exp: now + 60,
    iat: now,
    jti: "jti_1",
    parent_jti: "rat_jti_1",
  } satisfies NonNullable<RelayHostAuthContext["relayHostAuth"]>
}

/**
 * The authority a relay composition delegates to: one session is shared with
 * this actor, every other one is not. `requireActor` is the hosted flavour's
 * default — a machine with no local owner, where an unattributed request is
 * nobody's.
 */
function sharedSessionPolicy(shared: string, options: { requireActor?: boolean } = {}): SessionAccessPolicy {
  const owns = ({ sessionId }: { sessionId: string }) => sessionId === shared
  return managedWorkspaceSessionAccessPolicy({
    requireActor: options.requireActor ?? true,
    authority: {
      authorizeSessionRead: owns,
      authorizeSessionWrite: owns,
      authorizeSessionStream: ({ sessionId }) => sessionId === shared
        ? { allowed: true, lease: "lease", expiresAt: Date.now() + 15_000 }
        : { allowed: false, status: 403, code: "session_private", message: "Session is private" },
      registerSession: () => true,
      acquireTurn: (input) => ({
        allowed: true,
        turnId: input.turnId,
        leaseId: "turn_lease_1",
        fencingToken: 1,
        acquiredAt: Date.now(),
        expiresAt: Date.now() + 15_000,
      }),
      renewTurn: (input) => ({
        allowed: true,
        turnId: input.turnId,
        leaseId: input.leaseId,
        fencingToken: input.fencingToken + 1,
        acquiredAt: Date.now(),
        expiresAt: Date.now() + 15_000,
      }),
      releaseTurn: () => ({ released: true }),
    },
  })
}

/**
 * The real mount, behind the identity a verified relay request carries.
 * `identity: undefined` is this machine's own user, who presents none.
 */
function mounted(input: {
  directory: string
  policy?: SessionAccessPolicy
  identity?: NonNullable<RelayHostAuthContext["relayHostAuth"]>
}) {
  const app = new Hono()
  if (input.identity) {
    // The shape the relay host-token middleware leaves behind, stamped the way
    // `startServer` stamps it: on the plain app the mount is given.
    const stamp: MiddlewareHandler = async (c, next) => {
      c.set("relayHostAuth", input.identity)
      return await next()
    }
    app.use("*", stamp)
  }
  mountWorkspaceFiles(app, input.policy)
  return {
    request: (pathname: string, init?: RequestInit) => withWorkspaceTarget(
      { workspaceId: WORKSPACE_ID, directory: input.directory },
      () => app.request(`http://localhost${pathname}`, init),
    ),
  }
}

/** A workspace repository plus two real per-session worktrees the manager registered. */
async function fixture(options: { worktreeRoot?: (source: string) => string } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-runtime-p64-"))
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }))
  const source = path.join(root, "source")
  await fs.mkdir(source)
  await git(["init", "-b", "main"], source)
  await git(["config", "user.email", "runtime@example.test"], source)
  await git(["config", "user.name", "Workspace Runtime"], source)
  await fs.writeFile(path.join(source, "README.md"), "base\n")
  await git(["add", "README.md"], source)
  await git(["commit", "-m", "base"], source)

  const store = new RuntimeStore(path.join(root, "state"))
  const manager = new WorkspaceWorktreeManager({
    workspaceId: WORKSPACE_ID,
    sourceDirectory: source,
    root: options.worktreeRoot?.(source) ?? path.join(root, "hidden"),
    store,
  })
  cleanups.push(() => {
    manager.close()
    store.close()
  })

  const shared = await manager.ensure({ sessionId: "ses_shared" })
  const private_ = await manager.ensure({ sessionId: "ses_private" })
  await git(["config", "user.email", "runtime@example.test"], private_.path)
  await git(["config", "user.name", "Workspace Runtime"], private_.path)
  await fs.writeFile(path.join(private_.path, "secret.txt"), `${SECRET}\n`)
  await fs.writeFile(path.join(shared.path, "shared.txt"), "shared\n")

  return { root, source, shared: shared.path, private: private_.path }
}

const READ_ROUTES = [
  "/api/wr/file",
  "/api/wr/file?path=.",
  "/api/wr/file/content?path=secret.txt",
  "/api/wr/file/raw?path=secret.txt",
  "/api/wr/file/status",
  "/api/wr/file/all",
  "/api/wr/find/file?query=secret",
  // The Claxedo client-presentation aliases of the same handlers.
  "/file",
  "/file/content?path=secret.txt",
  "/file/raw?path=secret.txt",
  "/file/status",
  "/file/all",
  "/find/file?query=secret",
  "/api/wr/diff/targets",
  "/api/wr/diff/vcs",
  "/api/wr/diff/vcs?content=summary",
  "/api/wr/diff/vcs/file?file=secret.txt",
  "/api/wr/diff/refs",
  "/api/wr/git/status",
  "/api/wr/git/log",
]

const WRITE_ROUTES: Array<[string, unknown]> = [
  ["/api/wr/git/stage", { paths: ["secret.txt"] }],
  ["/api/wr/git/unstage", { paths: ["secret.txt"] }],
  ["/api/wr/git/commit-staged", { message: "stolen" }],
  ["/api/wr/git/push", {}],
]

function post(server: ReturnType<typeof mounted>, pathname: string, body: unknown) {
  return server.request(pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function scoped(pathname: string, directory: string) {
  const [route, query] = pathname.split("?")
  const params = new URLSearchParams(query)
  params.set("directory", directory)
  return `${route}?${params}`
}

describe("mounted file, diff and Git routes against a private session worktree", () => {
  test("refuses every read a caller without the session's grant aims at it", async () => {
    const f = await fixture()
    const server = mounted({
      directory: f.source,
      policy: sharedSessionPolicy("ses_shared"),
      identity: relayAuth(),
    })

    for (const route of READ_ROUTES) {
      const response = await server.request(scoped(route, f.private))
      const text = await response.text()
      expect({ route, status: response.status }).toEqual({ route, status: 403 })
      expect(text).toContain("session_private")
      expect(text).not.toContain(SECRET)
    }
  })

  test("refuses every Git write and leaves the worktree untouched", async () => {
    const f = await fixture()
    const server = mounted({
      directory: f.source,
      policy: sharedSessionPolicy("ses_shared"),
      identity: relayAuth(),
    })
    const head = await git(["rev-parse", "HEAD"], f.private)

    for (const [route, body] of WRITE_ROUTES) {
      const response = await post(server, scoped(route, f.private), body)
      expect({ route, status: response.status }).toEqual({ route, status: 403 })
      await expect(response.json()).resolves.toMatchObject({ error: { code: "session_private" } })
    }

    expect(await git(["diff", "--cached", "--name-only"], f.private)).toBe("")
    expect(await git(["status", "--porcelain"], f.private)).toBe("?? secret.txt")
    expect(await git(["rev-parse", "HEAD"], f.private)).toBe(head)
  })

  test("serves the session the actor does hold a grant on", async () => {
    const f = await fixture()
    const server = mounted({
      directory: f.source,
      policy: sharedSessionPolicy("ses_shared"),
      identity: relayAuth(),
    })

    for (const route of READ_ROUTES) {
      const response = await server.request(scoped(route.replace("secret.txt", "shared.txt"), f.shared))
      expect({ route, status: response.status }).toEqual({ route, status: 200 })
    }

    const content = await server.request(scoped("/api/wr/file/content?path=shared.txt", f.shared))
    await expect(content.json()).resolves.toMatchObject({ type: "text", content: "shared" })
    const staged = await post(server, scoped("/api/wr/git/stage", f.shared), { paths: ["shared.txt"] })
    expect(staged.status).toBe(204)
    expect(await git(["diff", "--cached", "--name-only"], f.shared)).toBe("shared.txt")
  })

  test("takes ownership from the registration, not from a session the caller names", async () => {
    const f = await fixture()
    const server = mounted({
      directory: f.source,
      policy: sharedSessionPolicy("ses_shared"),
      identity: relayAuth(),
    })

    const forged = [
      `/api/wr/file/content?path=secret.txt&sessionID=ses_shared&directory=${encodeURIComponent(f.private)}`,
      `/api/wr/file/content?path=secret.txt&sessionId=ses_shared&directory=${encodeURIComponent(f.private)}`,
      `/api/wr/git/status?sessionID=ses_shared&directory=${encodeURIComponent(f.private)}`,
    ]
    for (const route of forged) {
      const response = await server.request(route)
      expect({ route, status: response.status }).toEqual({ route, status: 403 })
      expect(await response.text()).not.toContain(SECRET)
    }

    // The header is the other channel the routes read the target from.
    const header = await server.request("/api/wr/file/content?path=secret.txt", {
      headers: { "x-claxedo-directory": f.private },
    })
    expect(header.status).toBe(403)
    expect(await header.text()).not.toContain(SECRET)
  })

  test("refuses an alias of the same worktree: a relative spelling and a symlink to it", async () => {
    const f = await fixture()
    const server = mounted({
      directory: f.source,
      policy: sharedSessionPolicy("ses_shared"),
      identity: relayAuth(),
    })

    const alias = path.join(path.dirname(f.private), ".", path.basename(f.private))
    const dotted = path.join(f.private, "..", path.basename(f.private))
    for (const directory of [alias, dotted, `${f.private}${path.sep}`]) {
      const response = await server.request(scoped("/api/wr/git/status", directory))
      expect({ directory, status: response.status }).toEqual({ directory, status: 403 })
    }

    // The link is followed to the worktree it points at before the route's own
    // containment check gets to refuse the escape, so the answer names the
    // session rather than the path.
    await fs.symlink(f.private, path.join(f.source, "shortcut"))
    const linked = await server.request("/api/wr/file/content?path=shortcut/secret.txt")
    expect(linked.status).toBe(403)
    expect(await linked.text()).not.toContain(SECRET)
  })

  test("fails closed for a verified remote caller when the composition has no policy", async () => {
    const f = await fixture()
    const server = mounted({ directory: f.source, identity: relayAuth() })

    const response = await server.request(scoped("/api/wr/file/content?path=secret.txt", f.private))
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "session_authority_required" } })
  })

  test("keeps this machine's own user reading every worktree the runtime serves", async () => {
    const f = await fixture()
    // No policy at all, and the daemon's flavour: a host with a local owner,
    // where an unattributed request is that owner's.
    for (const policy of [undefined, sharedSessionPolicy("ses_shared", { requireActor: false })]) {
      const server = mounted({ directory: f.source, policy })
      const response = await server.request(scoped("/api/wr/file/content?path=secret.txt", f.private))
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ type: "text", content: SECRET })
    }

    // The hosted flavour has no local owner to fall back on.
    const hosted = mounted({ directory: f.source, policy: sharedSessionPolicy("ses_shared") })
    const unattributed = await hosted.request(scoped("/api/wr/file/content?path=secret.txt", f.private))
    expect(unattributed.status).toBe(403)
    await expect(unattributed.json()).resolves.toMatchObject({ error: { code: "session_actor_required" } })
  })
})

describe("a private worktree nested under the workspace root", () => {
  test("staging an ancestor cannot recursively include a private session directory", async () => {
    const f = await fixture()
    const nested = path.join(f.source, "container", "private")
    await fs.mkdir(nested, { recursive: true })
    await fs.writeFile(path.join(nested, "secret.txt"), SECRET)
    registerWorkspaceDirectory({ workspaceId: WORKSPACE_ID, sessionId: "ses_nested_private", directory: nested })
    cleanups.push(() => unregisterWorkspaceDirectory({ workspaceId: WORKSPACE_ID, sessionId: "ses_nested_private" }))
    const server = mounted({ directory: f.source, policy: sharedSessionPolicy("ses_shared"), identity: relayAuth() })
    const response = await post(server, "/api/wr/git/stage", { paths: ["container"] })
    expect({ status: response.status, staged: await git(["diff", "--cached", "--name-only"], f.source) })
      .toEqual({ status: 403, staged: "" })
  })

  /**
   * The nested-worktree shape the recursive cases share: a private session
   * directory under `container`, an open file beside it, and a shared file at
   * the root the caller is entitled to act on.
   */
  async function containerFixture() {
    const f = await fixture()
    const nested = path.join(f.source, "container", "private")
    await fs.mkdir(nested, { recursive: true })
    await fs.writeFile(path.join(nested, "secret.txt"), `${SECRET}\n`)
    await fs.writeFile(path.join(f.source, "container", "open.txt"), "open\n")
    await fs.writeFile(path.join(f.source, "workspace.txt"), "the workspace's own\n")
    registerWorkspaceDirectory({ workspaceId: WORKSPACE_ID, sessionId: "ses_nested_private", directory: nested })
    cleanups.push(() => unregisterWorkspaceDirectory({ workspaceId: WORKSPACE_ID, sessionId: "ses_nested_private" }))
    return {
      ...f,
      nested,
      server: mounted({ directory: f.source, policy: sharedSessionPolicy("ses_shared"), identity: relayAuth() }),
      staged: () => git(["diff", "--cached", "--name-only"], f.source),
      head: () => git(["log", "-1", "--pretty=%s"], f.source),
    }
  }

  test("authorization and execution agree on whitespace in requested paths", async () => {
    const f = await containerFixture()
    const response = await f.server.request(`/api/wr/file/content?path=${encodeURIComponent(" container/private/secret.txt ")}`)
    expect({ status: response.status, leaked: (await response.text()).includes(SECRET) })
      .toEqual({ status: 403, leaked: false })
    const stage = await post(f.server, "/api/wr/git/stage", { paths: [" container/private/secret.txt "] })
    expect({ status: stage.status, staged: await f.staged() }).toEqual({ status: 403, staged: "" })
  })

  test("single-file diff cannot expand a wildcard into a private path", async () => {
    const f = await containerFixture()
    await git(["add", "--", "container"], f.source)
    const response = await f.server.request(`/api/wr/diff/vcs/file?mode=staged&file=${encodeURIComponent("container/*")}`)
    expect((await response.text()).includes(SECRET)).toBe(false)
  })

  test("single-file diff authorizes the exact filename including leading spaces", async () => {
    const f = await containerFixture()
    const nested = path.join(f.source, " private")
    await fs.mkdir(nested)
    await fs.writeFile(path.join(nested, "secret.txt"), SECRET)
    registerWorkspaceDirectory({ workspaceId: WORKSPACE_ID, sessionId: "ses_spaced_private", directory: nested })
    cleanups.push(() => unregisterWorkspaceDirectory({ workspaceId: WORKSPACE_ID, sessionId: "ses_spaced_private" }))
    await git(["add", "--", " private/secret.txt"], f.source)
    const route = `/api/wr/diff/vcs/file?mode=staged&file=${encodeURIComponent(" private/secret.txt")}`
    const response = await f.server.request(route)
    expect({ status: response.status, leaked: (await response.text()).includes(SECRET) })
      .toEqual({ status: 403, leaked: false })
    const owner = mounted({ directory: f.source, policy: sharedSessionPolicy("ses_spaced_private"), identity: relayAuth() })
    const allowed = await owner.request(route)
    expect(allowed.status).toBe(200)
    expect((await allowed.text()).includes(SECRET)).toBe(true)
  })

  test("a shared registration cannot hide another owner's denial on the same directory", async () => {
    const f = await containerFixture()
    unregisterWorkspaceDirectory({ workspaceId: WORKSPACE_ID, sessionId: "ses_shared" })
    registerWorkspaceDirectory({ workspaceId: WORKSPACE_ID, sessionId: "ses_shared", directory: f.nested })
    const response = await f.server.request("/api/wr/git/status")
    expect(response.status).toBe(200)
    expect((await response.text()).includes("container/private/secret.txt")).toBe(false)
  })

  test("reads a pathspec as the filename it resolved, so a wildcard cannot widen it", async () => {
    const f = await containerFixture()

    const refusals: Record<string, unknown> = {}
    for (const spec of ["container/*", "*.txt", "container/priv*", ":(glob)**/secret.txt"]) {
      const response = await post(f.server, "/api/wr/git/stage", { paths: [spec] })
      refusals[spec] = { status: response.status, code: ((await response.json()) as { error: { code: string } }).error.code }
      expect(await f.staged()).toBe("")
    }
    // Git is handed the filename that was resolved and authorized, so a
    // wildcard is a name no file has rather than a set the check never saw.
    expect(refusals).toEqual({
      "container/*": { status: 400, code: "git_command_failed" },
      "*.txt": { status: 400, code: "git_command_failed" },
      "container/priv*": { status: 400, code: "git_command_failed" },
      // Pathspec magic is a filename too, and no file is called this.
      ":(glob)**/secret.txt": { status: 400, code: "git_command_failed" },
    })

    // The same route still stages the literal file it was given.
    expect((await post(f.server, "/api/wr/git/stage", { paths: ["workspace.txt"] })).status).toBe(204)
    expect(await f.staged()).toBe("workspace.txt")
  })

  test("refuses an ancestor of a private directory whose files were deleted, and unstaging it too", async () => {
    const f = await containerFixture()
    await git(["-c", "core.excludesfile=/dev/null", "add", "-A", "--", "container"], f.source)
    await git(["commit", "-m", "container"], f.source)
    await fs.rm(path.join(f.nested, "secret.txt"))

    for (const route of ["/api/wr/git/stage", "/api/wr/git/unstage"]) {
      const response = await post(f.server, route, { paths: ["container"] })
      expect({ route, status: response.status }).toEqual({ route, status: 403 })
      expect(await f.staged()).toBe("")
    }
    // The deletion is still only in the working tree; nothing was recorded.
    expect(await git(["log", "-1", "--pretty=%s"], f.source)).toBe("container")
  })

  test("commits what the index holds, not what the request names", async () => {
    const f = await containerFixture()
    // What the private session's own tooling would have staged for itself.
    await git(["add", "--", "container/private/secret.txt"], f.source)

    const denied = await post(f.server, "/api/wr/git/commit-staged", { message: "publish" })
    expect(denied.status).toBe(403)
    await expect(denied.json()).resolves.toMatchObject({ error: { code: "session_private" } })
    expect(await f.head()).toBe("base")
    expect(await f.staged()).toBe("container/private/secret.txt")

    // With only the caller's own file staged the same route commits.
    await git(["reset", "-q"], f.source)
    expect((await post(f.server, "/api/wr/git/stage", { paths: ["workspace.txt"] })).status).toBe(204)
    expect((await post(f.server, "/api/wr/git/commit-staged", { message: "mine" })).status).toBe(200)
    expect(await f.head()).toBe("mine")
  })

  test("refuses an amend that would republish a private path, and a rename away from one", async () => {
    const f = await containerFixture()
    await git(["add", "--", "container/private/secret.txt"], f.source)
    await git(["commit", "-m", "private landed"], f.source)
    await git(["add", "--", "workspace.txt"], f.source)

    const amend = await post(f.server, "/api/wr/git/commit-staged", { message: "reworded", amend: true })
    expect(amend.status).toBe(403)
    expect(await f.head()).toBe("private landed")

    // A rename carries the path it came from, and that path is the private one.
    await git(["reset", "-q"], f.source)
    await git(["mv", "container/private/secret.txt", "stolen.txt"], f.source)
    const renamed = await post(f.server, "/api/wr/git/commit-staged", { message: "renamed out" })
    expect(renamed.status).toBe(403)
    expect(await f.head()).toBe("private landed")
    expect(await fs.readFile(path.join(f.source, "stolen.txt"), "utf8")).toBe(`${SECRET}\n`)
  })

  test("refuses a push that would send a repository carrying a private worktree", async () => {
    const f = await containerFixture()
    const response = await post(f.server, "/api/wr/git/push", {})
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "session_private" } })

    // Worktrees registered OUTSIDE the repository do not gate it: the same
    // request reaches git and fails on the missing remote, as it did before.
    const plain = await fixture()
    const ordinary = mounted({
      directory: plain.source,
      policy: sharedSessionPolicy("ses_shared"),
      identity: relayAuth(),
    })
    const reached = await post(ordinary, "/api/wr/git/push", {})
    expect(reached.status).toBe(502)
    await expect(reached.json()).resolves.toMatchObject({ error: { code: "git_push_rejected" } })
  })

  test("preserves each entrypoint's path spelling when authorizing whitespace", async () => {
    const f = await containerFixture()
    const padded = " container/private/secret.txt "

    const diff = await f.server.request(`/api/wr/diff/vcs/file?file=${encodeURIComponent(padded)}`)
    // Diff names a literal Git filename; this padded name does not exist.
    // Snapshot and unstage use the filesystem resolver's trimming contract.
    expect(diff.status).toBe(200)
    expect(await diff.json()).toEqual({ file: padded, patch: "" })

    const snapshot = await f.server.request(`/api/wr/git/snapshot?path=${encodeURIComponent(padded)}`)
    expect(snapshot.status).toBe(403)

    const unstage = await post(f.server, "/api/wr/git/unstage", { paths: [padded] })
    expect(unstage.status).toBe(403)
    expect(await f.staged()).toBe("")
  })

  /**
   * The window the commit check has to survive: the authority is a network
   * call, and the index it was asked about is shared mutable state. The
   * authority callback is where that time passes, so the write lands there.
   */
  test("refuses a commit whose index changed while the authority was answering", async () => {
    const f = await containerFixture()
    const open = path.join(f.source, "container", "shared")
    await fs.mkdir(open, { recursive: true })
    await fs.writeFile(path.join(open, "note.txt"), "shared work\n")
    registerWorkspaceDirectory({ workspaceId: WORKSPACE_ID, sessionId: "ses_shared", directory: open })

    let landed = false
    const racing = managedWorkspaceSessionAccessPolicy({
      requireActor: true,
      authority: {
        authorizeSessionRead: ({ sessionId }) => sessionId === "ses_shared",
        authorizeSessionWrite: async ({ sessionId }) => {
          if (!landed) {
            landed = true
            await git(["add", "--", "container/private/secret.txt"], f.source)
          }
          return sessionId === "ses_shared"
        },
        authorizeSessionStream: () => ({ allowed: false, status: 403, code: "session_private", message: "no" }),
        registerSession: () => true,
        acquireTurn: () => ({ allowed: false, status: 403, code: "session_private", message: "no" }),
        renewTurn: () => ({ allowed: false, status: 403, code: "session_private", message: "no" }),
        releaseTurn: () => ({ released: false }),
      },
    })
    const server = mounted({ directory: f.source, policy: racing, identity: relayAuth() })

    await git(["add", "--", "container/shared/note.txt"], f.source)
    const response = await post(server, "/api/wr/git/commit-staged", { message: "mine" })

    expect(landed).toBe(true)
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "git_conflict" } })
    expect(await f.head()).toBe("base")
    expect(await git(["log", "--all", "--name-only", "--pretty=format:"], f.source))
      .not.toContain("container/private/secret.txt")
  })

  test("refuses a diff pathspec that names a directory holding a private worktree", async () => {
    const f = await containerFixture()
    const response = await f.server.request("/api/wr/diff/vcs/file?file=container")
    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain(SECRET)

    const open = await f.server.request("/api/wr/diff/vcs/file?file=workspace.txt")
    expect(open.status).toBe(200)
  })

  test("keeps a renamed-from private path out of status and diff", async () => {
    const f = await containerFixture()
    await git(["-c", "core.excludesfile=/dev/null", "add", "-A", "--", "container", "workspace.txt"], f.source)
    await git(["commit", "-m", "container"], f.source)
    await git(["mv", "container/private/secret.txt", "surfaced.txt"], f.source)

    // A change the caller IS entitled to, so the filter is proven to be
    // dropping the rename rather than emptying the answer.
    await fs.writeFile(path.join(f.source, "workspace.txt"), "edited\n")

    const status = await f.server.request("/api/wr/git/status")
    const body = await status.json() as {
      staged: Array<{ path: string; from?: string }>
      unstaged: Array<{ path: string; from?: string }>
    }
    expect(body.unstaged.map((entry) => entry.path)).toContain("workspace.txt")
    expect(body.staged.flatMap((entry) => [entry.path, entry.from].filter(Boolean)))
      .toEqual([])

    const diff = await f.server.request("/api/wr/diff/vcs?content=summary")
    const diffed = await diff.json() as Array<{ file: string; from?: string }>
    expect(diffed.map((entry) => entry.file)).toEqual(["workspace.txt"])
    expect(JSON.stringify(diffed)).not.toContain("container/private")
  })

  test("stays out of reach through the root, and out of the listings that walk it", async () => {
    const f = await fixture({ worktreeRoot: (source) => path.join(source, "sessions") })
    const nested = path.join(f.source, "loose")
    await fs.mkdir(nested)
    await fs.writeFile(path.join(nested, "loose-secret.txt"), `${SECRET}\n`)
    await fs.writeFile(path.join(f.source, "workspace-secret.txt"), "the workspace's own\n")
    registerWorkspaceDirectory({ workspaceId: WORKSPACE_ID, sessionId: "ses_loose", directory: nested })
    cleanups.push(() => unregisterWorkspaceDirectory({ workspaceId: WORKSPACE_ID, sessionId: "ses_loose" }))
    await fs.symlink(f.private, path.join(f.source, "shortcut"))

    const server = mounted({
      directory: f.source,
      policy: sharedSessionPolicy("ses_shared"),
      identity: relayAuth(),
    })
    const worktreeRelative = path.relative(f.source, f.private)

    for (const route of [
      `/api/wr/file/content?path=${encodeURIComponent(`${worktreeRelative}/secret.txt`)}`,
      "/api/wr/file/content?path=shortcut/secret.txt",
      "/api/wr/file/raw?path=shortcut/secret.txt",
      "/api/wr/file/content?path=loose/loose-secret.txt",
      "/api/wr/file/raw?path=loose/loose-secret.txt",
      "/api/wr/diff/vcs/file?file=loose/loose-secret.txt",
    ]) {
      const response = await server.request(route)
      expect({ route, status: response.status }).toEqual({ route, status: 403 })
      expect(await response.text()).not.toContain(SECRET)
    }

    const all = await server.request("/api/wr/file/all")
    expect(all.status).toBe(200)
    const paths = (await all.json() as { paths: string[] }).paths
    expect(paths).toContain("README.md")
    expect(paths).toContain("workspace-secret.txt")
    expect(paths.some((item) => item.startsWith("loose"))).toBe(false)
    expect(paths.some((item) => item.startsWith(worktreeRelative))).toBe(false)

    const search = await server.request("/api/wr/find/file?query=secret")
    expect(await search.json()).toEqual(["workspace-secret.txt"])

    const status = await server.request("/api/wr/file/status")
    const entries = (await status.json() as Array<{ path: string }>).map((entry) => entry.path)
    expect(entries).toContain("workspace-secret.txt")
    expect(entries.some((entry) => entry.startsWith("loose"))).toBe(false)

    const listing = await server.request("/api/wr/file?path=.")
    const names = (await listing.json() as Array<{ name: string }>).map((entry) => entry.name)
    expect(names).toContain("README.md")
    expect(names).not.toContain("loose")

    // The untracked arm of a diff and of `git status` reads the working tree.
    const unstaged = await server.request("/api/wr/diff/vcs?mode=unstaged")
    const diffed = await unstaged.json() as Array<{ file: string }>
    expect(diffed.map((entry) => entry.file)).toContain("workspace-secret.txt")
    expect(JSON.stringify(diffed)).not.toContain(SECRET)

    const gitStatus = await server.request("/api/wr/git/status")
    const unstagedPaths = (await gitStatus.json() as { unstaged: Array<{ path: string }> })
      .unstaged.map((entry) => entry.path)
    expect(unstagedPaths).toContain("workspace-secret.txt")
    expect(unstagedPaths.some((item) => item.startsWith("loose"))).toBe(false)

    // A write aimed at the nested worktree through the root it is nested in.
    const staged = await post(server, "/api/wr/git/stage", { paths: ["loose/loose-secret.txt"] })
    expect(staged.status).toBe(403)
    expect(await git(["diff", "--cached", "--name-only"], f.source)).toBe("")
  })

  test("refuses the Git source routes that resolve a path under the workspace root", async () => {
    const f = await fixture()
    const nested = path.join(f.source, "loose")
    await fs.mkdir(nested)
    await fs.writeFile(path.join(nested, "loose-secret.txt"), `${SECRET}\n`)
    await git(["add", "loose/loose-secret.txt"], f.source)
    await git(["commit", "-m", "loose"], f.source)
    registerWorkspaceDirectory({ workspaceId: WORKSPACE_ID, sessionId: "ses_loose", directory: nested })
    cleanups.push(() => unregisterWorkspaceDirectory({ workspaceId: WORKSPACE_ID, sessionId: "ses_loose" }))

    const server = mounted({
      directory: f.source,
      policy: sharedSessionPolicy("ses_shared"),
      identity: relayAuth(),
    })

    const snapshot = await server.request("/api/wr/git/snapshot?path=loose/loose-secret.txt")
    expect(snapshot.status).toBe(403)
    await expect(snapshot.json()).resolves.toMatchObject({ error: { code: "session_private" } })

    const commit = await post(server, "/api/wr/git/commit", {
      path: "loose/loose-secret.txt",
      content: "rewritten\n",
      message: "stolen",
      expected: { baseCommit: await git(["rev-parse", "HEAD"], f.source), baseBlobSha: "" },
    })
    expect(commit.status).toBe(403)
    expect(await fs.readFile(path.join(nested, "loose-secret.txt"), "utf8")).toBe(`${SECRET}\n`)
    expect(await git(["log", "-1", "--pretty=%s"], f.source)).toBe("loose")
  })
})

describe("the base a reported path is named against", () => {
  /**
   * A workspace served at a SUBDIRECTORY of the repository, with the private
   * worktree registered as a sibling of it. Git porcelain reports that sibling
   * from the repository root, so a filter anchored on the served directory
   * would look for it in a tree it does not live in.
   */
  async function siblingFixture() {
    const f = await fixture()
    const served = path.join(f.source, "served")
    const sibling = path.join(f.source, "sibling")
    await fs.mkdir(served)
    await fs.mkdir(sibling)
    await fs.writeFile(path.join(served, "mine.txt"), "mine\n")
    await fs.writeFile(path.join(sibling, "secret.txt"), `${SECRET}\n`)
    registerWorkspaceDirectory({ workspaceId: WORKSPACE_ID, sessionId: "ses_sibling", directory: sibling })
    registerWorkspaceDirectory({ workspaceId: WORKSPACE_ID, sessionId: "ses_served", directory: served })
    cleanups.push(() => {
      unregisterWorkspaceDirectory({ workspaceId: WORKSPACE_ID, sessionId: "ses_sibling" })
      unregisterWorkspaceDirectory({ workspaceId: WORKSPACE_ID, sessionId: "ses_served" })
    })
    return { ...f, served, sibling }
  }

  test("filters a sibling worktree that Git reported from the repository root", async () => {
    const f = await siblingFixture()
    const server = mounted({
      directory: f.source,
      policy: sharedSessionPolicy("ses_served"),
      identity: relayAuth(),
    })

    const status = await server.request(`/api/wr/git/status?directory=${encodeURIComponent(f.served)}`)
    expect(status.status).toBe(200)
    const body = await status.json() as { unstaged: Array<{ path: string }> }
    const reported = body.unstaged.map((entry) => entry.path)
    // Proof the answer is repository-relative and reaches outside the served
    // directory at all, so the filter below is doing work rather than looking
    // at an empty list.
    expect(reported).toContain("served/mine.txt")
    expect(reported.some((entry) => entry.startsWith("sibling"))).toBe(false)
  })

  test("a directory-based listing keeps working outside a Git repository", async () => {
    const f = await fixture()
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-runtime-p64-plain-"))
    cleanups.push(() => fs.rm(plain, { recursive: true, force: true }))
    await fs.writeFile(path.join(plain, "note.txt"), "not a repository\n")
    const hidden = path.join(plain, "hidden")
    await fs.mkdir(hidden)
    await fs.writeFile(path.join(hidden, "secret.txt"), `${SECRET}\n`)
    registerWorkspaceDirectory({ workspaceId: WORKSPACE_ID, sessionId: "ses_plain_private", directory: hidden })
    registerWorkspaceDirectory({ workspaceId: WORKSPACE_ID, sessionId: "ses_plain", directory: plain })
    cleanups.push(() => {
      unregisterWorkspaceDirectory({ workspaceId: WORKSPACE_ID, sessionId: "ses_plain_private" })
      unregisterWorkspaceDirectory({ workspaceId: WORKSPACE_ID, sessionId: "ses_plain" })
    })
    const server = mounted({
      directory: f.source,
      policy: sharedSessionPolicy("ses_plain"),
      identity: relayAuth(),
    })

    const all = await server.request(`/api/wr/file/all?directory=${encodeURIComponent(plain)}`)
    expect(all.status).toBe(200)
    const paths = (await all.json() as { paths: string[] }).paths
    expect(paths).toContain("note.txt")
    expect(paths.some((entry) => entry.startsWith("hidden"))).toBe(false)

    const listing = await server.request(`/api/wr/file?directory=${encodeURIComponent(plain)}&path=.`)
    expect(listing.status).toBe(200)
    const names = (await listing.json() as Array<{ name: string }>).map((entry) => entry.name)
    expect(names).toEqual(["note.txt"])
  })

  test("answers a Git failure rather than an unfiltered diff when the repository cannot be named", async () => {
    const f = await siblingFixture()
    // Tracked, so the diff below is the repository-relative arm: it reports the
    // sibling from the repository root even though it runs inside `served`.
    await git(["add", "-A"], f.source)
    await git(["commit", "-m", "tracked"], f.source)
    await fs.writeFile(path.join(f.sibling, "secret.txt"), `${SECRET}\nchanged\n`)
    await fs.writeFile(path.join(f.served, "mine.txt"), "mine\nchanged\n")

    const diffRoute = (git?: DiffRoutesDeps["git"]) => {
      const app = new Hono()
      const stamp: MiddlewareHandler = async (c, next) => {
        c.set("relayHostAuth", relayAuth())
        return await next()
      }
      app.use("*", stamp)
      app.route("/api/wr/diff", createDiffRoutes(
        git ? { git } : {},
        { sessionAccessPolicy: sharedSessionPolicy("ses_served") },
      ))
      return withWorkspaceTarget(
        { workspaceId: WORKSPACE_ID, directory: f.source },
        () => app.request(`http://localhost/api/wr/diff/vcs?mode=uncommitted&directory=${encodeURIComponent(f.served)}`),
      )
    }

    // With the repository resolvable the answer is served and filtered: the
    // sibling is reachable in this request, which is what makes the failure
    // case below a real one.
    const served = await diffRoute()
    expect(served.status).toBe(200)
    const diffs = await served.json() as Array<{ file: string }>
    expect(diffs.map((entry) => entry.file)).toEqual(["served/mine.txt"])

    // The route's own Git dependency: every command answers except the one
    // that names the repository the reported paths belong to.
    const response = await diffRoute(async (args, cwd) => {
      if (args.includes("--show-toplevel")) throw new Error("rev-parse unavailable")
      const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
      const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
      return code === 0 ? { stdout } : { stdout: "" }
    })
    expect(response.status).toBe(500)
    const text = await response.text()
    expect(text).toContain("diff_vcs_failed")
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain("sibling")
  })
})
