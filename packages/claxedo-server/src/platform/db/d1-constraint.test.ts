import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { D1Database } from "@cloudflare/workers-types"
import { controlPlaneMigrations, miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "../../test-support/control-plane-migrations"
import { d1BatchAssertionFailed, d1ConstraintFailure, d1UniqueFailureOn } from "./d1-constraint"

let instance: ControlPlaneDatabase
let database: D1Database

beforeAll(async () => {
  instance = await miniflareControlPlaneDatabase(controlPlaneMigrations())
  database = instance.database
  await database.prepare("create table pairs (a text not null, b text not null, unique (a, b))").run()
  await database.prepare("insert into pairs values ('x', 'y')").run()
})

afterAll(() => instance.dispose())

async function refusal(run: () => Promise<unknown>) {
  return run().then(() => expect.unreachable("the statement was accepted"), (error: unknown) => error)
}

describe("D1 constraint failures", () => {
  test("a guarded batch's failed assertion is a batch assertion failure", async () => {
    const error = await refusal(() => database.batch([
      database.prepare("insert into authority_batch_assertions (assertion_id, passed) values ('a1', 0)"),
    ]))
    expect(d1ConstraintFailure(error)).toEqual({ kind: "check", target: "passed = 1" })
    expect(d1BatchAssertionFailed(error)).toBe(true)
  })

  test("a unique failure names the table it was raised on", async () => {
    const error = await refusal(() => database.prepare("insert into pairs values ('x', 'y')").run())
    expect(d1ConstraintFailure(error)).toEqual({ kind: "unique", target: "pairs.a, pairs.b" })
    expect(d1UniqueFailureOn(error, "pairs")).toBe(true)
    expect(d1UniqueFailureOn(error, "pair")).toBe(false)
    expect(d1BatchAssertionFailed(error)).toBe(false)
  })

  test("a not-null failure is neither unique nor an assertion", async () => {
    const error = await refusal(() => database.prepare("insert into authority_batch_assertions (assertion_id, passed) values ('a2', null)").run())
    expect(d1ConstraintFailure(error)).toEqual({ kind: "not_null", target: "authority_batch_assertions.passed" })
    expect(d1BatchAssertionFailed(error)).toBe(false)
  })

  test("the production message without an extended code still classifies, and other failures do not", () => {
    expect(d1ConstraintFailure(new Error("D1_ERROR: UNIQUE constraint failed: users.email: SQLITE_CONSTRAINT")))
      .toEqual({ kind: "unique", target: "users.email" })
    expect(d1ConstraintFailure(new Error("D1_ERROR: no such table: users: SQLITE_ERROR"))).toBeUndefined()
    expect(d1ConstraintFailure("UNIQUE constraint failed: users.email")).toBeUndefined()
  })
})
