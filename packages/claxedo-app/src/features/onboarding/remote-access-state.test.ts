import { describe, expect, test } from "bun:test"
import {
  remoteAccessAvailability,
  remoteAccessWorkspaceLink,
  shouldRecordSecondDeviceOpen,
} from "./remote-access-state"

describe("remote access onboarding state", () => {
  test("fails closed with honest blocker copy until Phase A and Relay are configured", () => {
    expect(
      remoteAccessAvailability({
        deviceLoginConfigured: false,
        relayConfigured: false,
        hostedSignedIn: false,
        enabled: false,
      }),
    ).toEqual({
      state: "locked",
      reason: "Remote access is coming soon. Device sign-in and the hosted relay are not available yet.",
    })

    expect(
      remoteAccessAvailability({
        deviceLoginConfigured: true,
        relayConfigured: false,
        hostedSignedIn: true,
        enabled: false,
      }),
    ).toEqual({
      state: "locked",
      reason: "Remote access is coming soon. The hosted relay is not available yet.",
    })
  })

  test("requires sign-in before enablement and proves completion only on a second-device open", () => {
    expect(
      remoteAccessAvailability({
        deviceLoginConfigured: true,
        relayConfigured: true,
        hostedSignedIn: false,
        enabled: false,
      }),
    ).toEqual({ state: "sign-in-required" })
    expect(
      remoteAccessAvailability({
        deviceLoginConfigured: true,
        relayConfigured: true,
        hostedSignedIn: true,
        enabled: false,
      }),
    ).toEqual({ state: "ready-to-enable" })
    expect(
      remoteAccessAvailability({
        deviceLoginConfigured: true,
        relayConfigured: true,
        hostedSignedIn: true,
        enabled: true,
      }),
    ).toEqual({ state: "enabled", proven: false })
    expect(
      remoteAccessAvailability({
        deviceLoginConfigured: true,
        relayConfigured: true,
        hostedSignedIn: true,
        enabled: true,
        secondDeviceOpen: true,
      }),
    ).toEqual({ state: "enabled", proven: true })
  })

  test("builds a marker link and rejects same-device or signed-out completion", () => {
    const link = remoteAccessWorkspaceLink({
      appOrigin: "https://app.claxedo.test/",
      workspaceId: "ws / phone",
      sourceClientId: "desktop-client",
    })
    expect(link).toBe(
      "https://app.claxedo.test/w/ws%20%2F%20phone?claxedo_second_device=1&claxedo_source_client=desktop-client",
    )

    const url = new URL(link)
    expect(shouldRecordSecondDeviceOpen({ url, currentClientId: "phone-client", signedIn: true })).toBe(true)
    expect(shouldRecordSecondDeviceOpen({ url, currentClientId: "desktop-client", signedIn: true })).toBe(false)
    expect(shouldRecordSecondDeviceOpen({ url, currentClientId: "phone-client", signedIn: false })).toBe(false)
    expect(
      shouldRecordSecondDeviceOpen({
        url: new URL("https://app.claxedo.test/w/ws"),
        currentClientId: "phone-client",
        signedIn: true,
      }),
    ).toBe(false)
  })
})
