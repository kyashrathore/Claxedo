import { usePlatform } from "@/platform/runtime/platform-provider"
import * as Config from "@/app/providers/config"
import { createOnboardingFunnel } from "@/features/onboarding/funnel"
import { capture as captureTelemetry, identityProps } from "@/platform/telemetry/analytics"

/**
 * The app's funnel, on its own so the no-project canvas can emit without
 * evaluating the whole feature-ports wiring; that module reaches every
 * feature at import time, which is more than a screen may pull in.
 */
export function useOnboardingFunnel() {
  const platform = usePlatform()
  const config = Config.useConfigOptional()
  return createOnboardingFunnel({
    deployment: platform.platform === "desktop" || config?.sandboxEnabled ? "hosted" : "self-host",
    capture: (name, properties) => captureTelemetry(name, { ...identityProps(), surface: "onboarding", ...properties }),
  })
}
