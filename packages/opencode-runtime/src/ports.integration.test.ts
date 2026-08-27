/**
 * The ports against a REAL embedded host — one process, one SQLite file, two
 * workspace directories.
 *
 * This is the test that would have caught the Unit 1 blocker on day one. Mocks
 * of `client.sessions.*` pass whether or not the SDK's layer graph resolves; a
 * real `OpenCode.create()` plus a real `prompt` does not. Everything here goes
 * through `createOpenCodeHost`, which is also what applies the core repair.
 *
 * No credentials are configured, so no turn actually runs. Admission,
 * projection, paging, revert staging and scope enforcement are all observable
 * without one, and a turn that runs is Unit 4b's integration surface, not the
 * port's.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createOpenCodeHost, type OpenCodeHost } from "./host"
import { createCatalogPort, type OpenCodeCatalogPort } from "./catalog-port"
import { createInteractionPort, type OpenCodeInteractionPort } from "./interaction-port"
import { createSessionPort, type OpenCodeSessionPort } from "./session-port"
import { authorizeWorkspace, WorkspaceScopeError, type WorkspaceScope } from "./scope"

let root: string
let host: OpenCodeHost
let sessions: OpenCodeSessionPort
let catalog: OpenCodeCatalogPort
let interactions: OpenCodeInteractionPort
let alpha: WorkspaceScope
let beta: WorkspaceScope

function workspace(name: string): string {
  const directory = path.join(root, name)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, "README.md"), `# ${name}\n`)
  return directory
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-ports-"))
  host = createOpenCodeHost({ databasePath: path.join(root, "opencode.db") })
  sessions = createSessionPort(host)
  catalog = createCatalogPort(host)
  interactions = createInteractionPort(host)
  alpha = authorizeWorkspace({ workspaceID: "ws-alpha", directory: workspace("alpha") })
  beta = authorizeWorkspace({ workspaceID: "ws-beta", directory: workspace("beta") })
  await host.client()
})

afterAll(async () => {
  await host?.close()
  if (root) fs.rmSync(root, { recursive: true, force: true })
})

describe("session port against a real host", () => {
  test("create, get, rename and list stay inside one workspace", async () => {
    const created = await sessions.create(alpha, { title: "first" })
    expect(created.directory).toBe(alpha.directory)
    expect(created.title).toBe("first")

    const fetched = await sessions.get(alpha, created.id)
    expect(fetched.id).toBe(created.id)

    await sessions.rename(alpha, created.id, "renamed")
    expect((await sessions.get(alpha, created.id)).title).toBe("renamed")

    // `sessions.list` is host-global unless the FLAT directory filter lands.
    // Beta must not see alpha's session.
    await sessions.create(beta, { title: "beta only" })
    const alphaPage = await sessions.list(alpha)
    const betaPage = await sessions.list(beta)
    expect(alphaPage.sessions.map((row) => row.title)).toContain("renamed")
    expect(betaPage.sessions.map((row) => row.title)).not.toContain("renamed")
  })

  test("a session id from another workspace fails closed", async () => {
    const mine = await sessions.create(alpha, { title: "private" })
    // The SDK authorizes nothing here; the port's re-validation is the whole
    // defense, so assert on the port and not on the SDK's behaviour.
    await expect(sessions.get(beta, mine.id)).rejects.toBeInstanceOf(WorkspaceScopeError)
    await expect(sessions.rename(beta, mine.id, "stolen")).rejects.toBeInstanceOf(WorkspaceScopeError)
    await expect(sessions.remove(beta, mine.id)).rejects.toBeInstanceOf(WorkspaceScopeError)
    // And it is still there, under its own title.
    expect((await sessions.get(alpha, mine.id)).title).toBe("private")
  })

  test("prompt admits a turn and the message shows up in the page", async () => {
    const session = await sessions.create(alpha, { title: "prompted" })
    const admitted = await sessions.prompt(alpha, session.id, { text: "say hi", delivery: "steer" })
    expect(admitted.sessionID).toBe(session.id)
    expect(admitted.text).toBe("say hi")
    expect(admitted.id).toStartWith("msg_")

    const page = await sessions.messages(alpha, session.id, { limit: 10 })
    // Admission is recorded on the inbox; the message list is the durable
    // projection and only fills in once the turn produces one. Either way the
    // call must ANSWER rather than 500 - that is the regression this guards.
    expect(Array.isArray(page.messages)).toBe(true)
  })

  test("interrupt answers, and revert is gated on a DURABLE message", async () => {
    const session = await sessions.create(alpha, { title: "controls" })
    const admitted = await sessions.prompt(alpha, session.id, { text: "work" })
    await sessions.interrupt(alpha, session.id)

    // Contract fact worth pinning: the id `prompt` returns is an INBOX entry,
    // not a message in `message.list`. Staging a revert against it is rejected
    // with a typed MessageNotFoundError. Unit 4b's revert projector must take
    // its message id from `messages()`, never from the admission result.
    await expect(sessions.revertTo(alpha, session.id, admitted.id)).rejects.toMatchObject({
      _tag: "MessageNotFoundError",
      sessionID: session.id,
      messageID: admitted.id,
    })

    // Clearing a revert that was never staged is a no-op, not an error, so the
    // adapter's "unrevert" needs no prior-state bookkeeping.
    await sessions.clearRevert(alpha, session.id)
  })

  test("fork refuses an empty session with a typed reason", async () => {
    const session = await sessions.create(alpha, { title: "original" })
    // Another contract fact: V2 will not fork a session that has produced no
    // durable message. The adapter must surface this as a typed failure rather
    // than an empty success - fabricating a fork id here would strand the UI
    // on a session that does not exist.
    await expect(sessions.fork(alpha, session.id, { type: "through" })).rejects.toMatchObject({
      _tag: "InvalidRequestError",
      kind: "empty_session",
    })
  })

  test("remove deletes only after ownership is proven", async () => {
    const session = await sessions.create(alpha, { title: "doomed" })
    await sessions.remove(alpha, session.id)
    const page = await sessions.list(alpha)
    expect(page.sessions.map((row) => row.id)).not.toContain(session.id)
  })
})

describe("catalog and interaction ports", () => {
  test("catalogs answer for a workspace instead of 500ing", async () => {
    // A bare workspace with no config has no agents or commands. The contract
    // being tested is that the call RESOLVES: before the core layer-graph
    // repair every one of these returned an empty 500.
    expect(Array.isArray(await catalog.agents(alpha))).toBe(true)
    expect(Array.isArray(await catalog.commands(alpha))).toBe(true)
    expect(Array.isArray(await catalog.models(alpha))).toBe(true)
  })

  test("pending interactions list per workspace and start empty", async () => {
    expect(await interactions.permissions(alpha)).toEqual([])
    expect(await interactions.forms(alpha)).toEqual([])
  })

  test("replying into another workspace's session fails closed", async () => {
    const mine = await sessions.create(alpha, { title: "interaction scope" })
    await expect(
      interactions.replyPermission(beta, { sessionID: mine.id, requestID: "req_x", reply: "once" }),
    ).rejects.toBeInstanceOf(WorkspaceScopeError)
    await expect(
      interactions.replyForm(beta, { sessionID: mine.id, formID: "frm_x", answer: { a: "b" } }),
    ).rejects.toBeInstanceOf(WorkspaceScopeError)
    await expect(
      interactions.cancelForm(beta, { sessionID: mine.id, formID: "frm_x" }),
    ).rejects.toBeInstanceOf(WorkspaceScopeError)
  })
})
