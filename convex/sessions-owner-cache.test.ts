import { describe, expect, test } from "vitest"
import type { Id } from "./_generated/dataModel"
import { createUserLookupCache } from "./sessions"

describe("session owner lookup cache", () => {
  test("shares one database lookup for concurrent sessions from the same owner", async () => {
    const ownerId = "owner" as Id<"users">
    let gets = 0
    const lookup = createUserLookupCache(async (userId) => {
      gets += 1
      return { _id: userId, name: "Owner" } as never
    })

    await Promise.all([lookup(ownerId), lookup(ownerId), lookup(ownerId)])

    expect(gets).toBe(1)
  })
})
