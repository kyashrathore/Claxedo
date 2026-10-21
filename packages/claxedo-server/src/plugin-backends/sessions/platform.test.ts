/**
 * The caller rules of an app plugin's session calls, against the real D1
 * baseline. A start and its preview are refused for a member-driven
 * session's agent before anything else is read; the hosted workerd suite
 * (`plugin-backends.workerd.test.ts`) drives the rest through a loaded
 * backend.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { D1Database } from "@cloudflare/workers-types"
import type { PluginCaller } from "@claxedo/plugin-api/backend"
import { miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "../../test-support/control-plane-migrations"
import { hostedPluginSessions, type PluginSessionCall } from "./platform"

let instance: ControlPlaneDatabase
let database: D1Database

const SCOPE = { orgId: "org", pluginId: "notes" }
const START = {
  origin: { scope: "prj", key: "draft-1" },
  projectId: "prj",
  placement: "local",
  configuration: { harness: { id: "codex", access: "native" }, model: { providerID: "openai", modelID: "gpt-5" }, effort: null },
} as const

function sessions() {
  const unreachable = async () => {
    throw new Error("no workspace is reached before the caller is admitted")
  }
  return hostedPluginSessions({
    database,
    blob: unreachable,
    reads: { workspace: unreachable, projectWorkspaces: unreachable, projectSource: unreachable, sessions: unreachable },
    registrations: {},
    cloudRoots: { refusal: unreachable, allocate: unreachable },
    runtimeClient: { role: "owner" },
  })
}

const codeOf = async (call: PluginSessionCall, caller: PluginCaller) => {
  const answer = await sessions()(call, SCOPE, caller)
  return answer.ok ? "answered" : answer.code
}

beforeAll(async () => {
  instance = await miniflareControlPlaneDatabase()
  database = instance.database
  await database.batch([
    database.prepare("insert into users values ('alice', 'active', 1, 1, null, null)"),
    database.prepare("insert into actors (actor_id, user_id, kind, state, created_at, updated_at) values ('act_alice', 'alice', 'human', 'active', 1, 1)"),
  ])
})

afterAll(async () => {
  await instance?.dispose()
})

describe("an app plugin's session calls", () => {
  test("a member-driven session's agent is refused a start and its preview before any project or workspace is read", async () => {
    const memberDriven: PluginCaller = { orgId: "org", origin: "agent", userId: "alice", session: { sessionId: "ses_a", workspaceId: "ws_a" }, ownerDriven: false }
    const unmarked: PluginCaller = { orgId: "org", origin: "agent", userId: "alice", session: { sessionId: "ses_a", workspaceId: "ws_a" } }
    for (const caller of [memberDriven, unmarked]) {
      expect(await codeOf({ name: "sessions.preview", ...START }, caller)).toBe("plugin_session_start_refused")
      expect(await codeOf({ name: "sessions.start", ...START, digest: "d".repeat(64) }, caller)).toBe("plugin_session_start_refused")
    }
  })

  test("an owner-driven session's agent and a person reach the project check, which a caller outside the project fails", async () => {
    const ownerDriven: PluginCaller = { orgId: "org", origin: "agent", userId: "alice", session: { sessionId: "ses_a", workspaceId: "ws_a" }, ownerDriven: true }
    const person: PluginCaller = { orgId: "org", origin: "person", userId: "alice" }
    for (const caller of [ownerDriven, person]) {
      expect(await codeOf({ name: "sessions.preview", ...START }, caller)).toBe("plugin_project_forbidden")
      expect(await codeOf({ name: "sessions.start", ...START, digest: "d".repeat(64) }, caller)).toBe("plugin_project_forbidden")
    }
  })

  test("a caller who is no active person is refused every call that acts as one", async () => {
    const stranger: PluginCaller = { orgId: "org", origin: "person", userId: "nobody" }
    expect(await codeOf({ name: "sessions.preview", ...START }, stranger)).toBe("plugin_caller_not_a_person")
    expect(await codeOf({ name: "sessions.authorizeOpen", session: { sessionId: "ses_a", workspaceId: "ws_a" } }, stranger)).toBe("plugin_caller_not_a_person")
  })
})
