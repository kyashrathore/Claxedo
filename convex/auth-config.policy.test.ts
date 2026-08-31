import { describe, expect, test } from "vitest"
import { clerkJwtAudiences } from "./auth.config"

describe("Convex Clerk JWT audiences", () => {
  test("keeps the standard Clerk session audience by default", () => {
    expect(clerkJwtAudiences({})).toEqual(["convex"])
  })

  test("accepts and deduplicates every explicitly configured client audience", () => {
    expect(clerkJwtAudiences({
      CLERK_JWT_AUDIENCES: "convex, desktop-client, convex",
      CLERK_JWT_AUDIENCE: "ignored-single-audience",
    })).toEqual(["convex", "desktop-client"])
  })

  test("continues to honor the existing single-audience deployment setting", () => {
    expect(clerkJwtAudiences({ CLERK_JWT_AUDIENCE: "custom-session-audience" }))
      .toEqual(["custom-session-audience"])
  })
})
