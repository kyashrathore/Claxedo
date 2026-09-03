import { describe, expect, test } from "bun:test"
import { createOnboardingFunnel, type OnboardingFunnelEvent } from "./funnel"

const events: OnboardingFunnelEvent[] = [
  { name: "signup" },
  { name: "setup_form_shown" },
  { name: "setup_form_dismissed" },
  { name: "step_done", step: "ai", surface: "desktop" },
  { name: "step_verify_failed", step: "ai", class: "auth_failed" },
  { name: "provider_connected", provider: "anthropic" },
  { name: "first_turn_ok" },
  { name: "first_turn_failed", class: "model" },
  { name: "sandbox_provider_configured", provider: "daytona" },
  { name: "first_cloud_turn_ok" },
  { name: "remote_access_enabled" },
  { name: "second_device_open" },
  { name: "gofurther_card_clicked", card: "harnesses" },
  { name: "gofurther_card_dismissed", card: "harnesses" },
]

describe("onboarding funnel telemetry", () => {
  test("emits every funnel event in hosted mode with a stable property shape", () => {
    const captured: Array<{ name: string; properties?: Record<string, unknown> }> = []
    const funnel = createOnboardingFunnel({
      deployment: "hosted",
      capture: (name, properties) => captured.push({ name, properties }),
    })
    events.forEach(funnel.emit)
    expect(captured.map((event) => event.name)).toEqual(events.map((event) => event.name))
    expect(captured[3]).toEqual({ name: "step_done", properties: { step: "ai", surface: "desktop" } })
  })

  test("defaults self-host and OSS builds off until explicit opt-in", () => {
    const captured: string[] = []
    createOnboardingFunnel({ deployment: "self-host", capture: (name) => captured.push(name) }).emit({ name: "signup" })
    createOnboardingFunnel({ deployment: "self-host", ossOptIn: true, capture: (name) => captured.push(name) }).emit({ name: "signup" })
    expect(captured).toEqual(["signup"])
  })
})
