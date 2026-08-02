import { describe, expect, test } from "vitest"
import { clerkWebhookEvent } from "../../../../../convex/http"

describe("Convex Clerk webhook policy", () => {
  test("invalid webhook signatures are rejected without throwing", () => {
    expect(clerkWebhookEvent({
      payload: "{}",
      headers: new Headers(),
      verifier: () => {
        throw new Error("bad signature")
      },
    })).toBeUndefined()
  })
})
