import type { SandboxListing } from "@/accounts"
import type { OnboardingText } from "./i18n"

export type ProviderRow = { readonly id: string; readonly title: string; readonly detail: string; readonly keyed: boolean }

function driverLabel(listing: SandboxListing, id: string): string {
  return listing.drivers.find((driver) => driver.id === id)?.label ?? id
}

export function providerRows(t: OnboardingText, listing: SandboxListing): readonly ProviderRow[] {
  const keyed = [...new Set(listing.keys.map((key) => key.providerId))]
  if (keyed.length > 0) return keyed.map((id) => ({ id, title: t("onboarding.cloud.key", { provider: driverLabel(listing, id) }), detail: t("onboarding.cloud.key.detail"), keyed: true }))
  const managed = listing.managedDriver
  return managed ? [{ id: managed, title: t("onboarding.cloud.managed"), detail: t("onboarding.cloud.managed.detail", { provider: driverLabel(listing, managed) }), keyed: false }] : []
}

export function providerInUse(t: OnboardingText, listing: SandboxListing): string {
  const driver = listing.defaultDriver ?? listing.managedDriver
  return driver && driver !== listing.managedDriver ? t("onboarding.cloud.key", { provider: driverLabel(listing, driver) }) : t("onboarding.cloud.managed")
}
