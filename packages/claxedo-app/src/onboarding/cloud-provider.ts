import type { SandboxListing } from "@/accounts"
import type { OnboardingText } from "./i18n"

export type ProviderRow = { readonly id: string; readonly title: string; readonly detail: string }

function driverLabel(listing: SandboxListing, id: string): string {
  return listing.drivers.find((driver) => driver.id === id)?.label ?? id
}

export function providerRows(t: OnboardingText, listing: SandboxListing): readonly ProviderRow[] {
  const keyed = [...new Set(listing.keys.map((key) => key.providerId))]
  return keyed.map((id) => ({ id, title: t("onboarding.cloud.key", { provider: driverLabel(listing, id) }), detail: t("onboarding.cloud.key.detail") }))
}

export function providerInUse(t: OnboardingText, listing: SandboxListing): string {
  const driver = listing.defaultDriver
  return driver ? t("onboarding.cloud.fixed", { provider: driverLabel(listing, driver) }) : t("onboarding.cloud.fixed.none")
}
