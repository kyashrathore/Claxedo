import { describe, expect, test } from "vitest"
import { ControlPlaneAuthError } from "../auth/auth"
import { TelemetryTrackRoutes, type TrackIdentity } from "./track-route"

type Captured = { distinctId: string; event: string; properties?: Record<string, unknown> }

function route(identity: (request: Request) => Promise<TrackIdentity | undefined> = async () => ({ userId: "user_1", orgId: "org_1" })) {
  const captured: Captured[] = []
  let at = 1_000
  const app = TelemetryTrackRoutes({
    identity,
    telemetry: { capture: (distinctId, event, properties) => void captured.push({ distinctId, event, properties }) },
    now: () => at,
  })
  const track = (body: unknown) =>
    app.request("http://cp.test/api/claxedo/track", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  return { captured, track, advance: (ms: number) => { at += ms } }
}

describe("POST /api/claxedo/track", () => {
  test("forwards an allowlisted event under the signed caller with its org group", async () => {
    const { captured, track } = route()

    const response = await track({ event: "session_started", properties: { harness: "pi", where: "cloud" } })

    expect(response.status).toBe(200)
    expect(captured).toEqual([{
      distinctId: "user_1",
      event: "session_started",
      properties: { harness: "pi", where: "cloud", org_id: "org_1", $groups: { org: "org_1" } },
    }])
  })

  test("drops properties outside the event's allowlist and ignores a distinct id in the body", async () => {
    const { captured, track } = route()

    await track({
      distinctId: "someone-else",
      event: "feature_used",
      properties: { feature: "terminal", prompt: "secret text", email: "a@b.test", org_id: "org_spoofed" },
    })

    expect(captured).toEqual([{
      distinctId: "user_1",
      event: "feature_used",
      properties: { feature: "terminal", org_id: "org_1", $groups: { org: "org_1" } },
    }])
  })

  test.each([
    ["an event the product does not emit", { event: "made_up", properties: {} }],
    ["a value outside the property's set", { event: "feature_used", properties: { feature: "/Users/me/secret.txt" } }],
    ["a missing property", { event: "ui_error_shown", properties: { error_class: "network" } }],
    ["a non-string value", { event: "onboarding_step_viewed", properties: { step: 1 } }],
    ["a body that is not JSON object", ["session_started"]],
  ])("refuses %s", async (_label, body) => {
    const { captured, track } = route()

    const response = await track(body)

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: "telemetry_event_refused" } })
    expect(captured).toEqual([])
  })

  test("refuses an unsigned caller and an invalid credential without capturing", async () => {
    const unsigned = route(async () => undefined)
    expect((await unsigned.track({ event: "feature_used", properties: { feature: "review" } })).status).toBe(401)

    const invalid = route(async () => { throw new ControlPlaneAuthError(401, "invalid_bearer_token", "Token is invalid") })
    const response = await invalid.track({ event: "feature_used", properties: { feature: "review" } })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: { code: "invalid_bearer_token" } })

    expect([...unsigned.captured, ...invalid.captured]).toEqual([])
  })

  test("limits each caller to its own window and opens a fresh one when the period turns", async () => {
    let userId = "user_1"
    const { captured, track, advance } = route(async () => ({ userId, orgId: "org_1" }))
    const event = { event: "feature_used", properties: { feature: "file_open" } }

    for (let index = 0; index < 120; index += 1) expect((await track(event)).status).toBe(200)
    const limited = await track(event)
    expect(limited.status).toBe(429)
    expect(limited.headers.get("retry-after")).toBe("60")
    expect(await limited.json()).toMatchObject({ error: { code: "rate_limited" } })

    userId = "user_2"
    expect((await track(event)).status).toBe(200)

    userId = "user_1"
    advance(60_000)
    expect((await track(event)).status).toBe(200)
    expect(captured).toHaveLength(122)
  })

  test("on a Worker the send is kept alive past the response", async () => {
    let settle: () => void = () => {}
    const sent = new Promise<void>((resolve) => { settle = resolve })
    const app = TelemetryTrackRoutes({ identity: async () => ({ userId: "user_1", orgId: "org_1" }), telemetry: { capture: () => sent } })
    const kept: Promise<unknown>[] = []

    const response = await app.request(
      "http://cp.test/api/claxedo/track",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "feature_used", properties: { feature: "review" } }) },
      {},
      { waitUntil: (work: Promise<unknown>) => void kept.push(work), passThroughOnException: () => {}, props: {} } as never,
    )

    expect(response.status).toBe(200)
    expect(kept).toHaveLength(1)
    settle()
    await expect(kept[0]).resolves.toBeUndefined()
  })
})
