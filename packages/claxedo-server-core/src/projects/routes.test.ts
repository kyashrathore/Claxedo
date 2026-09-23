import { describe, expect, test, vi } from "vitest"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "../platform/auth/auth"
import type { ProjectAction, WorkspaceAuthority } from "../platform/auth/authority"
import { ProjectRoutes, type ProjectRouteOptions } from "./routes"
import { ProjectStoreError, type ProjectCreateInput, type ProjectRecord, type ProjectStore } from "./store"

function record(id: string, name: string): ProjectRecord {
  return { id, name, env: {}, directory: null, repoUrl: null, created_at: 1, updated_at: 1 }
}

/** A store that keeps records in memory and remembers what it was asked. */
function memoryStore(input: { folders: boolean; records?: ProjectRecord[] }) {
  const records = new Map((input.records ?? []).map((item) => [item.id, item]))
  const created: ProjectCreateInput[] = []
  const store: ProjectStore = {
    folders: input.folders,
    list: async () => [...records.values()],
    get: async (id) => records.get(id),
    ...(input.folders
      ? { byDirectory: async (directory: string) => [...records.values()].find((item) => item.directory === directory) }
      : {}),
    create: async (create) => {
      created.push(create)
      const repository = create.source.kind === "repository" ? await create.source.resolve() : undefined
      const item = {
        ...record(`prj_${records.size + 1}`, create.name ?? repository?.name ?? "unnamed"),
        env: create.env ?? {},
        directory: create.source.kind === "directory" ? create.source.directory : null,
        repoUrl: repository?.repoUrl ?? null,
      }
      records.set(item.id, item)
      return item
    },
    update: async (id, patch) => {
      const existing = records.get(id)
      if (!existing) return undefined
      const next = { ...existing, ...(patch.name ? { name: patch.name } : {}), ...(patch.env ? { env: patch.env } : {}) }
      records.set(id, next)
      return next
    },
    remove: async (id) => records.delete(id),
  }
  return { store, records, created }
}

const signed: SignedControlPlaneAuth = {
  mode: "signed",
  user: { subject: "usr_1", tokenIdentifier: "tok_1", issuer: "https://issuer.test" },
}

/** An authority that grants `actions` on the named projects and nothing else. */
function authorityGranting(grants: Record<string, ProjectAction[]>) {
  return {
    authorizeProject: vi.fn(async (_auth: SignedControlPlaneAuth, args: { projectId: string; action: ProjectAction }) =>
      grants[args.projectId]?.includes(args.action) ? { ok: true, role: "owner", orgId: "org_1" } : { ok: false }),
  } as unknown as WorkspaceAuthority
}

const asSigned: ProjectRouteOptions["authenticate"] = async () => signed
const asUnsigned: ProjectRouteOptions["authenticate"] = async () => undefined

const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

describe("the projects route over its store", () => {
  test("a folder source is refused where the host has no filesystem, before the store is asked", async () => {
    const { store, created } = memoryStore({ folders: false })
    const app = ProjectRoutes({ store, authenticate: asUnsigned })
    const res = await app.request("http://localhost/", json("POST", { source: { kind: "directory", directory: "/srv/repo" } }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: "project_source_unsupported" } })
    expect(created).toEqual([])
    expect((await app.request("http://localhost/by-directory?directory=%2Fsrv%2Frepo")).status).toBe(404)
  })

  test("a repository source reaches the store unresolved, and resolves to the URL and its name when the store asks", async () => {
    const { store, created } = memoryStore({ folders: false })
    const app = ProjectRoutes({ store, authenticate: asUnsigned })
    const res = await app.request("http://localhost/", json("POST", { source: { kind: "repository", repoUrl: "https://github.com/acme/Demo.git" }, env: { A: "1" } }))
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ project: { name: "Demo", repoUrl: "https://github.com/acme/Demo.git", env: { A: "1" } } })
    expect(created).toHaveLength(1)
    expect(created[0]?.source.kind).toBe("repository")
  })

  test("a bad body, a bad environment and an unclonable URL are refused as 400s with their own codes", async () => {
    const { store } = memoryStore({ folders: false })
    const app = ProjectRoutes({ store, authenticate: asUnsigned })
    expect((await app.request("http://localhost/", json("POST", { name: "No source" }))).status).toBe(400)
    const env = await app.request("http://localhost/", json("POST", { source: { kind: "repository", repoUrl: "https://github.com/a/b" }, env: { "not a name": "x" } }))
    expect(await env.json()).toMatchObject({ error: { code: "project_env_invalid" } })
    const url = await app.request("http://localhost/", json("POST", { source: { kind: "repository", repoUrl: "not a url" } }))
    expect(url.status).toBe(400)
    expect(await url.json()).toMatchObject({ error: { code: "project_repository_invalid" } })
    const connection = await app.request("http://localhost/", json("POST", { source: { kind: "repository", connectionId: "c1", repo: { fullName: "a/b" } } }))
    expect(await connection.json()).toMatchObject({ error: { code: "project_connection_requires_signin" } })
  })

  test("a store refusal reaches the wire as the status and code it names", async () => {
    const { store } = memoryStore({ folders: false })
    store.create = async () => {
      throw new ProjectStoreError(409, "project_name_taken", "A project named \"Taken\" already exists")
    }
    const app = ProjectRoutes({ store, authenticate: asUnsigned })
    const res = await app.request("http://localhost/", json("POST", { name: "Taken", source: { kind: "repository", repoUrl: "https://github.com/a/b" } }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: { code: "project_name_taken", message: "A project named \"Taken\" already exists" } })
  })

  test("the unsigned local product reads, rewrites and removes every record", async () => {
    const { store, records } = memoryStore({ folders: true, records: [{ ...record("prj_1", "One"), directory: "/srv/one" }] })
    const app = ProjectRoutes({ store, authenticate: asUnsigned })
    expect(await (await app.request("http://localhost/")).json()).toEqual({ projects: [records.get("prj_1")] })
    expect((await app.request("http://localhost/prj_1")).status).toBe(200)
    expect(await (await app.request("http://localhost/by-directory?directory=%2Fsrv%2Fone")).json()).toMatchObject({ project: { id: "prj_1" } })
    expect(await (await app.request("http://localhost/prj_1", json("PATCH", { name: "Uno" }))).json()).toMatchObject({ project: { name: "Uno" } })
    expect(await (await app.request("http://localhost/prj_1", { method: "DELETE" })).json()).toEqual({ deleted: true })
    expect((await app.request("http://localhost/prj_1")).status).toBe(404)
    expect((await app.request("http://localhost/prj_1", { method: "DELETE" })).status).toBe(404)
  })
})

describe("the projects route for a signed caller", () => {
  const two = () => memoryStore({ folders: true, records: [{ ...record("prj_1", "Mine"), directory: "/srv/mine" }, record("prj_2", "Theirs")] })

  test("lists, reads, rewrites and removes only what the authority grants, at the rank each verb needs", async () => {
    const authority = authorityGranting({ prj_1: ["read", "write"], prj_2: [] })
    const app = ProjectRoutes({ store: two().store, authenticate: asSigned, authority })
    expect(await (await app.request("http://localhost/")).json()).toMatchObject({ projects: [{ id: "prj_1" }] })
    expect((await app.request("http://localhost/prj_2")).status).toBe(404)
    expect((await app.request("http://localhost/prj_1")).status).toBe(200)
    const denied = await app.request("http://localhost/prj_2", json("PATCH", { name: "Stolen" }))
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ error: { code: "project_access_denied" } })
    expect((await app.request("http://localhost/prj_1", json("PATCH", { name: "Renamed" }))).status).toBe(200)
    // Write rank rewrites; only the owner rank removes.
    const kept = await app.request("http://localhost/prj_1", { method: "DELETE" })
    expect(kept.status).toBe(403)
    expect(authority.authorizeProject).toHaveBeenLastCalledWith(signed, { projectId: "prj_1", action: "owner" })
  })

  test("a composition serving signed callers without an authority refuses every read and write with 503", async () => {
    const app = ProjectRoutes({ store: two().store, authenticate: asSigned })
    for (const request of [
      app.request("http://localhost/"),
      app.request("http://localhost/prj_1"),
      app.request("http://localhost/", json("POST", { source: { kind: "repository", repoUrl: "https://github.com/a/b" } })),
      app.request("http://localhost/prj_1", { method: "DELETE" }),
    ]) {
      const res = await request
      expect(res.status).toBe(503)
      expect(await res.json()).toMatchObject({ error: { code: "workspace_authority_unavailable" } })
    }
  })

  test("a signed caller's folder takes the machine operator's authorization, and its absence fails closed", async () => {
    const authority = authorityGranting({})
    const body = json("POST", { source: { kind: "directory", directory: "/srv/new" } })
    const unconfigured = ProjectRoutes({ store: two().store, authenticate: asSigned, authority })
    const closed = await unconfigured.request("http://localhost/", body)
    expect(closed.status).toBe(503)
    expect(await closed.json()).toMatchObject({ error: { code: "authority_unavailable" } })

    const refusing = ProjectRoutes({
      store: two().store,
      authenticate: asSigned,
      authority,
      authorizeFolderSource: () => {
        throw new ControlPlaneAuthError(403, "operator_required", "Deployment operator access is required")
      },
    })
    const denied = await refusing.request("http://localhost/", body)
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ error: { code: "operator_required" } })

    const { store, created } = two()
    const admitting = ProjectRoutes({ store, authenticate: asSigned, authority, authorizeFolderSource: () => undefined })
    expect((await admitting.request("http://localhost/", body)).status).toBe(201)
    expect(created).toHaveLength(1)
  })

  test("a signed caller's repository URL is held to destination admission, which a composition must configure", async () => {
    const authority = authorityGranting({})
    const body = json("POST", { source: { kind: "repository", repoUrl: "https://git.internal/acme/repo.git" } })
    const unconfigured = ProjectRoutes({ store: two().store, authenticate: asSigned, authority })
    const closed = await unconfigured.request("http://localhost/", body)
    expect(closed.status).toBe(503)
    expect(await closed.json()).toMatchObject({ error: { code: "repository_admission_unavailable" } })

    const refusing = ProjectRoutes({ store: two().store, authenticate: asSigned, authority, repositories: { admission: { resolve: async () => ["10.0.0.5"] } } })
    const refused = await refusing.request("http://localhost/", body)
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ error: { code: "project_repository_refused" } })

    const admitting = ProjectRoutes({ store: two().store, authenticate: asSigned, authority, repositories: { admission: { resolve: async () => ["140.82.112.3"] } } })
    expect((await admitting.request("http://localhost/", body)).status).toBe(201)
  })

  test("a refused credential is answered as the authentication error it is", async () => {
    const app = ProjectRoutes({
      store: two().store,
      authenticate: async () => {
        throw new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required")
      },
    })
    const res = await app.request("http://localhost/")
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { code: "missing_bearer_token" } })
  })
})
