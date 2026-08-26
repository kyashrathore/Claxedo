import type { OnboardingStepId } from "./registry"
import type { OnboardingSurface } from "./state"
import type { OnboardingGoFurtherCardId } from "./go-further"

type FirstTurnFailureClass = "credential" | "harness" | "model" | "usage_limit" | "workspace" | "session" | "unknown"

export type OnboardingFunnelEvent =
  | { name: "signup" }
  | { name: "setup_form_shown" }
  | { name: "setup_form_dismissed" }
  | { name: "step_done"; step: OnboardingStepId; surface: OnboardingSurface }
  | { name: "step_verify_failed"; step: OnboardingStepId; class: string }
  | { name: "provider_connected"; provider: string }
  | { name: "first_turn_ok" }
  | { name: "first_turn_failed"; class: FirstTurnFailureClass }
  | { name: "sandbox_provider_configured"; provider: string }
  | { name: "first_cloud_turn_ok" }
  | { name: "remote_access_enabled" }
  | { name: "second_device_open" }
  | { name: "gofurther_card_clicked"; card: OnboardingGoFurtherCardId }
  | { name: "gofurther_card_dismissed"; card: OnboardingGoFurtherCardId }

export function createOnboardingFunnel(input: {
  deployment: "hosted" | "self-host"
  ossOptIn?: boolean
  capture: (name: OnboardingFunnelEvent["name"], properties?: Record<string, unknown>) => void
}) {
  return {
    emit(event: OnboardingFunnelEvent) {
      if (input.deployment === "self-host" && input.ossOptIn !== true) return
      const properties = Object.fromEntries(Object.entries(event).filter(([key]) => key !== "name"))
      input.capture(event.name, Object.keys(properties).length > 0 ? properties : undefined)
    },
  }
}
