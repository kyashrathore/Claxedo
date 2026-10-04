import { describe, expect, test, vi } from "vitest"
import type { GenericEndpointContext } from "@better-auth/core"
import type { D1Database } from "@cloudflare/workers-types"

import { betterAuthD1AuthenticationEvidenceHooks } from "./better-auth-d1-authentication-evidence"

type ExecutedStatement = { sql: string; values: unknown[] }

function database(options: { evidenceChanges?: number } = {}) {
  const statements: ExecutedStatement[] = []
  const db = {
    prepare(sql: string) {
      let values: unknown[] = []
      return {
        bind(...input: unknown[]) {
          values = input
          return this
        },
        async run() {
          statements.push({ sql, values })
          return { meta: { changes: sql.includes(`insert into "authenticationEvidence"`)
            ? (options.evidenceChanges ?? 1)
            : 1 } }
        },
      }
    },
  } as unknown as D1Database
  return { db, statements }
}

function endpoint(path: string, id?: string) {
  return { path, params: id === undefined ? {} : { id } } as unknown as GenericEndpointContext
}

function session(id: string) {
  return {
    id,
    userId: `user:${id}`,
    token: `token:${id}`,
    createdAt: new Date("2026-08-28T00:00:00.123Z"),
    updatedAt: new Date("2026-08-28T00:00:00.123Z"),
    expiresAt: new Date("2026-09-04T00:00:00.123Z"),
  }
}

function createHook(db: D1Database) {
  const hooks = betterAuthD1AuthenticationEvidenceHooks(db)
  const create = hooks?.session?.create
  if (!create?.before || !create.after) throw new Error("evidence session hooks are missing")
  return create
}

describe("Better Auth D1 authentication evidence producer", () => {
  test.each([
    ["password", endpoint("/sign-in/email"), "password"],
    ["Google", endpoint("/callback/:id", "google"), "oauth:google"],
    ["GitHub", endpoint("/callback/:id", "github"), "oauth:github"],
  ])("persists %s only from its successful session producer", async (_name, context, method) => {
    const configured = database()
    const hook = createHook(configured.db)
    const created = session(`session:${method}`)

    await expect(hook.before!(created, context)).resolves.toBeUndefined()
    await hook.after!(created, context)

    expect(configured.statements).toEqual([{
      sql: expect.stringContaining(`insert into "authenticationEvidence"`),
      values: [
        created.id,
        created.userId,
        created.createdAt.getTime(),
        JSON.stringify([method]),
        "single-factor",
        expect.any(Number),
      ],
    }])
  })

  test.each([
    null,
    endpoint("/sign-up/email"),
    endpoint("/verify-email"),
    endpoint("/callback/:id", "unconfigured-provider"),
    endpoint("/get-session"),
  ])("rejects a session whose successful authentication provenance is unknown", async (context) => {
    const configured = database()
    const hook = createHook(configured.db)

    await expect(hook.before!(session("unknown"), context)).rejects.toThrow(/no supported authentication provenance/)
    expect(configured.statements).toEqual([])
  })

  test("preserves caller hooks but rejects mutation of evidence bindings", async () => {
    const configured = database()
    const after = vi.fn(async () => {})
    const hooks = betterAuthD1AuthenticationEvidenceHooks(configured.db, {
      session: {
        create: {
          before: async () => ({ data: { userId: "different-subject" } }),
          after,
        },
      },
    })
    const create = hooks?.session?.create
    if (!create?.before || !create.after) throw new Error("evidence session hooks are missing")

    await expect(create.before(session("hook-mutation"), endpoint("/sign-in/email")))
      .rejects.toThrow(/changed its authentication evidence binding/)
    expect(configured.statements).toEqual([])
    expect(after).not.toHaveBeenCalled()
  })

  test("deletes the just-created session when evidence persistence cannot be confirmed", async () => {
    const configured = database({ evidenceChanges: 0 })
    const hook = createHook(configured.db)
    const created = session("persistence-failure")

    await expect(hook.after!(created, endpoint("/sign-in/email")))
      .rejects.toThrow(/was not persisted/)
    expect(configured.statements).toHaveLength(2)
    expect(configured.statements[1]).toEqual({
      sql: expect.stringContaining(`delete from "session"`),
      values: [created.id],
    })
  })
})
