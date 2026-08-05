import { describe, expect, test } from "bun:test"
import { coarsenProperties, coarsenUrl, initOptions } from "../src/scripts/posthog"

/**
 * The privacy property this whole module exists to hold: PostHog sets its own
 * URL properties from `window.location`, so keeping a detail path out of the
 * conversion event payload is not enough on its own — `$current_url` would
 * carry it anyway. Everything below is about that leak being closed.
 */
describe("URL coarsening", () => {
  test("collapses detail pages to their section", () => {
    expect(coarsenUrl("https://claxedo.com/framework/cookbook/01-hello-agent")).toBe("/framework")
    expect(coarsenUrl("https://claxedo.com/compare/matrix-os/")).toBe("/compare")
  })

  test("strips query strings and fragments", () => {
    expect(coarsenUrl("https://claxedo.com/download?source=secret-campaign#anchor")).toBe("/download")
  })

  test("accepts bare paths as well as absolute URLs", () => {
    expect(coarsenUrl("/pricing")).toBe("/pricing")
  })

  test("an unrecognized path never passes through literally", () => {
    // The case where a literal value would be most surprising to leak.
    expect(coarsenUrl("/some-private-unlisted-page")).toBe("/other")
    expect(coarsenUrl("not a url at all")).toBe("/other")
  })

  test("missing values stay missing rather than becoming a bogus route", () => {
    expect(coarsenUrl(undefined)).toBeUndefined()
    expect(coarsenUrl("")).toBeUndefined()
  })
})

describe("sanitize_properties hook", () => {
  test("rewrites every URL-bearing PostHog property", () => {
    const sanitized = coarsenProperties({
      $current_url: "https://claxedo.com/framework/packages/workgraph",
      $initial_current_url: "https://claxedo.com/framework/api/relay?utm=x",
      $pathname: "/compare/matrix-os",
      $initial_pathname: "/framework/guides/install",
    })
    expect(sanitized.$current_url).toBe("/framework")
    expect(sanitized.$initial_current_url).toBe("/framework")
    expect(sanitized.$pathname).toBe("/compare")
    expect(sanitized.$initial_pathname).toBe("/framework")
  })

  test("keeps an external referrer, which is the acquisition signal", () => {
    const sanitized = coarsenProperties({ $referrer: "https://news.ycombinator.com/item?id=1" })
    expect(sanitized.$referrer).toBe("https://news.ycombinator.com/item?id=1")
  })

  test("preserves PostHog's $direct sentinel", () => {
    expect(coarsenProperties({ $referrer: "$direct" }).$referrer).toBe("$direct")
  })

  test("coarsens an internal referrer so on-site detail paths cannot ride in", () => {
    const sanitized = coarsenProperties({ $referrer: "https://claxedo.com/framework/cookbook/01-hello-agent" })
    expect(sanitized.$referrer).toBe("/framework")
  })

  test("leaves unrelated properties untouched and does not mutate its input", () => {
    const input = { $current_url: "https://claxedo.com/download", placement: "hero", platform: "linux-deb" }
    const sanitized = coarsenProperties(input)
    expect(sanitized.placement).toBe("hero")
    expect(sanitized.platform).toBe("linux-deb")
    expect(input.$current_url).toBe("https://claxedo.com/download")
  })

  test("does not invent properties the event did not carry", () => {
    // A `$current_url: undefined` key on an event that never had one would
    // read as "unknown page" in PostHog rather than "not applicable".
    expect(Object.keys(coarsenProperties({ placement: "hero" }))).toEqual(["placement"])
  })
})

/**
 * Tripwires, not preferences. Autocapture and session recording are opt-OUT in
 * posthog-js's defaults, so a future SDK bump that changes how these resolve
 * would silently start collecting far more than this site is documented to
 * collect. Asserting them here makes that fail loudly at build time.
 */
describe("init options", () => {
  test("no cookies", () => {
    expect(initOptions.persistence).toBe("sessionStorage")
    expect(String(initOptions.persistence)).not.toContain("cookie")
  })

  test("autocapture and session recording stay off", () => {
    expect(initOptions.autocapture).toBe(false)
    expect(initOptions.disable_session_recording).toBe(true)
  })

  test("pageviews are captured manually so the route rides along coarsened", () => {
    expect(initOptions.capture_pageview).toBe(false)
  })

  test("the sanitizer is actually wired, not merely exported", () => {
    expect(initOptions.sanitize_properties).toBe(coarsenProperties)
  })

  test("anonymous visitors do not create person profiles", () => {
    expect(initOptions.person_profiles).toBe("identified_only")
  })
})
