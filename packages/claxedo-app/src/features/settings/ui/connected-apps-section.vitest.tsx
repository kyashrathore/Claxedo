import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, expect, test, vi } from "vitest"

import { ConnectedAppsSettingsSection } from "./connected-apps-section"
import { cloudStrings } from "@/platform/i18n/cloud-strings"

afterEach(() => cleanup())

const t = (key: string) => (cloudStrings.en as Record<string, string>)[key] ?? key

test("lists what an account has consented to and revokes one", async () => {
  const revoke = vi.fn(async () => undefined)
  let remaining = [
    { consentId: "consent-1", clientId: "aBcD", name: "Cursor", scopes: ["claxedo:read", "claxedo:act"] },
    { consentId: "consent-2", clientId: "claxedo-cli", name: "Claxedo CLI", scopes: ["workspace:read"] },
  ]

  render(() => (
    <ConnectedAppsSettingsSection
      t={t}
      list={async () => remaining}
      revoke={async (consentId) => {
        await revoke()
        remaining = remaining.filter((app) => app.consentId !== consentId)
      }}
    />
  ))

  expect(await screen.findByText("Cursor")).toBeInTheDocument()
  expect(screen.getByText("claxedo:read, claxedo:act")).toBeInTheDocument()
  expect(screen.getByText("Claxedo CLI")).toBeInTheDocument()

  fireEvent.click(screen.getAllByRole("button", { name: "Disconnect" })[0]!)

  await waitFor(() => expect(screen.queryByText("Cursor")).not.toBeInTheDocument())
  expect(revoke).toHaveBeenCalledTimes(1)
  expect(screen.getByText("Claxedo CLI")).toBeInTheDocument()
})

test("keeps a failed revoke on the page with the account's apps intact", async () => {
  render(() => (
    <ConnectedAppsSettingsSection
      t={t}
      list={async () => [{ consentId: "consent-1", clientId: "aBcD", name: "Cursor", scopes: ["claxedo:read"] }]}
      revoke={async () => {
        throw new Error("Consent record is gone")
      }}
    />
  ))

  fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }))

  expect(await screen.findByRole("alert")).toHaveTextContent("Consent record is gone")
  expect(screen.getByText("Cursor")).toBeInTheDocument()
})

test("says so when nothing has been connected", async () => {
  render(() => <ConnectedAppsSettingsSection t={t} list={async () => []} revoke={vi.fn()} />)

  expect(await screen.findByText("No application has been given access to your Claxedo account."))
    .toBeInTheDocument()
})
