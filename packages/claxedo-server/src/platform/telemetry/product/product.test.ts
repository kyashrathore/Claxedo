import { describe, expect, test, vi } from "vitest"
import { captureProduct, productIdentity } from "./product"

/**
 * The product plane's required-properties contract. The type gate is the real
 * enforcement (a call site omitting any of the four fails the build); these
 * assertions hold the runtime half: the exact payload shape a per-user or
 * per-org aggregate depends on.
 */

describe("captureProduct", () => {
  test("keys the event to the user and groups it under the org", () => {
    const sink = { capture: vi.fn() }
    captureProduct(
      sink,
      "task_created",
      { org_id: "org_1", user_id: "user_1", surface: "documents", deployment_mode: "cloud" },
      { task_id: "task_9" },
    )
    expect(sink.capture).toHaveBeenCalledTimes(1)
    expect(sink.capture).toHaveBeenCalledWith("user_1", "task_created", {
      task_id: "task_9",
      org_id: "org_1",
      user_id: "user_1",
      surface: "documents",
      deployment_mode: "cloud",
      $groups: { org: "org_1" },
    })
  })

  test("identity properties cannot be shadowed by a caller's property bag", () => {
    const sink = { capture: vi.fn() }
    captureProduct(
      sink,
      "model_selected",
      { org_id: "org_1", user_id: "user_1", surface: "composer", deployment_mode: "self-host" },
      { org_id: "spoofed", surface: "spoofed" } as Record<string, unknown>,
    )
    const properties = sink.capture.mock.calls[0]![2] as Record<string, unknown>
    expect(properties.org_id).toBe("org_1")
    expect(properties.surface).toBe("composer")
  })

  test("extra groups merge, but org always comes from org_id", () => {
    const sink = { capture: vi.fn() }
    captureProduct(
      sink,
      "harness_selected",
      { org_id: "org_1", user_id: "user_1", surface: "composer", deployment_mode: "desktop-local" },
      {},
      { groups: { project: "project_1", org: "spoofed" } },
    )
    expect((sink.capture.mock.calls[0]![2] as { $groups: unknown }).$groups).toEqual({
      project: "project_1",
      org: "org_1",
    })
  })

  test("an absent sink and a throwing sink are both silent", () => {
    const identity = { org_id: "org_1", user_id: "user_1", surface: "x", deployment_mode: "cloud" } as const
    expect(() => captureProduct(undefined, "e", identity)).not.toThrow()
    expect(() =>
      captureProduct(
        {
          capture: () => {
            throw new Error("telemetry down")
          },
        },
        "e",
        identity,
      ),
    ).not.toThrow()
  })
})

describe("productIdentity", () => {
  test("resolves when the token names both a user and an org", () => {
    expect(
      productIdentity({ user: { subject: "user_1", orgId: "org_1" } }, { surface: "documents", deployment_mode: "cloud" }),
    ).toEqual({ org_id: "org_1", user_id: "user_1", surface: "documents", deployment_mode: "cloud" })
  })

  test("returns undefined rather than inventing an org id", () => {
    const context = { surface: "documents", deployment_mode: "cloud" } as const
    expect(productIdentity({ user: { subject: "user_1" } }, context)).toBeUndefined()
    expect(productIdentity({ user: { subject: "user_1", orgId: "  " } }, context)).toBeUndefined()
    expect(productIdentity({ user: { subject: "", orgId: "org_1" } }, context)).toBeUndefined()
    expect(productIdentity(undefined, context)).toBeUndefined()
  })
})
