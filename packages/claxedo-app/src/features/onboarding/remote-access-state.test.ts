import { describe, expect, test } from "bun:test"
import {
  remoteAccessAvailability,
  remoteAccessResumeDecision,
  remoteAccessDeviceLink,
  remoteAccessWorkspaceLink,
  shouldRecordSecondDeviceOpen,
} from "./remote-access-state"

describe("remote access onboarding state", () => {
  test("fails closed with honest blocker copy until Phase A and Relay are configured", () => {
    expect(remoteAccessAvailability({
      deviceLoginConfigured: false,
      relayConfigured: false,
      hostedSignedIn: false,
      enabled: false,
    })).toEqual({
      state: "locked",
      reason: "Remote access is coming soon. Device sign-in and the hosted relay are not available yet.",
    })

    expect(remoteAccessAvailability({
      deviceLoginConfigured: true,
      relayConfigured: false,
      hostedSignedIn: true,
      enabled: false,
    })).toEqual({
      state: "locked",
      reason: "Remote access is coming soon. The hosted relay is not available yet.",
    })
  })

  test("requires sign-in before enablement and proves completion only on a second-device open", () => {
    expect(remoteAccessAvailability({
      deviceLoginConfigured: true,
      relayConfigured: true,
      hostedSignedIn: false,
      enabled: false,
    })).toEqual({ state: "sign-in-required" })
    expect(remoteAccessAvailability({
      deviceLoginConfigured: true,
      relayConfigured: true,
      hostedSignedIn: true,
      enabled: false,
    })).toEqual({ state: "ready-to-enable" })
    expect(remoteAccessAvailability({
      deviceLoginConfigured: true,
      relayConfigured: true,
      hostedSignedIn: true,
      enabled: true,
    })).toEqual({ state: "enabled", proven: false })
    expect(remoteAccessAvailability({
      deviceLoginConfigured: true,
      relayConfigured: true,
      hostedSignedIn: true,
      enabled: true,
      secondDeviceOpen: true,
    })).toEqual({ state: "enabled", proven: true })
  })

  test("boot before sign-in: no attempt during the gap, then exactly one once the account restores", () => {
    // The live failure. The connector reports `hostedSignedIn` at boot, before
    // the account session has restored; auto-resume believed it, called start(),
    // and the child's first account operation came back "not signed in" —
    // `child-start: Error: connector closed` at boot+28s, never retried, machine
    // unpublished until someone pressed Enable.
    const booting = remoteAccessResumeDecision({
      accountSigned: false,
      desktop: true,
      startAtLogin: true,
      enabled: false,
      attempted: false,
    })
    expect(booting).toEqual({ resume: false, attempted: false })

    // The account finishes restoring. THAT is the retry.
    expect(remoteAccessResumeDecision({
      accountSigned: true,
      desktop: true,
      startAtLogin: true,
      enabled: false,
      attempted: booting.attempted,
    })).toEqual({ resume: true, attempted: true })
  })

  test("boot already signed in, connector not started: the persisted intent alone resumes it", () => {
    // The REAL pre-start shape on the desktop. `enrolled === enabled` there —
    // an enrollment nobody beats for expires inside a minute — so a pre-start
    // connector answers false to both, and an `enrolled` condition here would
    // mean the resume never ran on any real boot.
    expect(remoteAccessResumeDecision({
      accountSigned: true,
      desktop: true,
      startAtLogin: true,
      enabled: false,
      attempted: false,
    })).toEqual({ resume: true, attempted: true })
  })

  test("one attempt per sign-in: a failing start gets no second go while still signed", () => {
    expect(remoteAccessResumeDecision({
      accountSigned: true,
      desktop: true,
      startAtLogin: true,
      enabled: false,
      attempted: true,
    })).toEqual({ resume: false, attempted: true })
  })

  test("signing out clears the budget, and signing back in earns exactly one more", () => {
    const signedOut = remoteAccessResumeDecision({
      accountSigned: false,
      desktop: true,
      startAtLogin: true,
      enabled: false,
      attempted: true,
    })
    expect(signedOut).toEqual({ resume: false, attempted: false })

    expect(remoteAccessResumeDecision({
      accountSigned: true,
      desktop: true,
      startAtLogin: true,
      enabled: false,
      attempted: signedOut.attempted,
    })).toEqual({ resume: true, attempted: true })
  })

  test("an explicit disable is never overridden, and does not burn the attempt", () => {
    // Start-at-login off is the standing "I turned this off". Declining to act
    // must NOT spend the budget: switching it back on has to get its attempt.
    const disabled = remoteAccessResumeDecision({
      accountSigned: true,
      desktop: true,
      startAtLogin: false,
      enabled: false,
      attempted: false,
    })
    expect(disabled).toEqual({ resume: false, attempted: false })

    expect(remoteAccessResumeDecision({
      accountSigned: true,
      desktop: true,
      startAtLogin: true,
      enabled: false,
      attempted: disabled.attempted,
    })).toEqual({ resume: true, attempted: true })
  })

  test("pausing does not re-publish the machine behind the user", () => {
    // Pause leaves exactly the shape a waiting machine has (`enabled: false`),
    // so the spent attempt is the ONLY thing standing between the user and an
    // instant re-enable.
    expect(remoteAccessResumeDecision({
      accountSigned: true,
      desktop: true,
      startAtLogin: true,
      enabled: false,
      attempted: true,
    })).toEqual({ resume: false, attempted: true })
  })

  test("a machine already up, and a product that has no login item, are both left alone", () => {
    expect(remoteAccessResumeDecision({
      accountSigned: true,
      desktop: true,
      startAtLogin: true,
      enabled: true,
      attempted: false,
    })).toEqual({ resume: false, attempted: false })

    expect(remoteAccessResumeDecision({
      accountSigned: true,
      desktop: false,
      startAtLogin: true,
      enabled: false,
      attempted: false,
    })).toEqual({ resume: false, attempted: false })
  })

  test("the device link is the app ROOT, because sharing is machine level", () => {
    // Nothing to fetch and no workspace to choose: enabling remote access
    // publishes every local workspace on the machine, so the destination is
    // the account's own list. A staging build must land on staging, and a
    // stale workspace path in the configured origin must not survive.
    expect(remoteAccessDeviceLink({ appOrigin: "https://staging.claxedo.test", sourceClientId: "desktop-client" }))
      .toBe("https://staging.claxedo.test/?claxedo_second_device=1&claxedo_source_client=desktop-client")
    expect(new URL(remoteAccessDeviceLink({
      appOrigin: "https://app.claxedo.test/w/ws_old",
      sourceClientId: "desktop-client",
    })).pathname).toBe("/")
  })

  test("the root link still proves a second device, so the funnel keeps its producer", () => {
    // The marker moved off the per-workspace URL with the per-workspace QR, but
    // the fact it records did not. `RemoteAccessMarkerRecorder` holds it from
    // this landing until the first workspace the device opens.
    const url = new URL(remoteAccessDeviceLink({
      appOrigin: "https://app.claxedo.test",
      sourceClientId: "desktop-client",
    }))

    expect(shouldRecordSecondDeviceOpen({ url, currentClientId: "phone-client", signedIn: true })).toBe(true)
    expect(shouldRecordSecondDeviceOpen({ url, currentClientId: "desktop-client", signedIn: true })).toBe(false)
    expect(shouldRecordSecondDeviceOpen({ url, currentClientId: "phone-client", signedIn: false })).toBe(false)
  })

  test("builds a marker link and rejects same-device or signed-out completion", () => {
    const link = remoteAccessWorkspaceLink({
      appOrigin: "https://app.claxedo.test/",
      workspaceId: "ws_phone",
      sourceClientId: "desktop-client",
    })
    expect(link).toBe(
      "https://app.claxedo.test/w/ws_phone?claxedo_second_device=1&claxedo_source_client=desktop-client",
    )

    const url = new URL(link)
    expect(shouldRecordSecondDeviceOpen({ url, currentClientId: "phone-client", signedIn: true })).toBe(true)
    expect(shouldRecordSecondDeviceOpen({ url, currentClientId: "desktop-client", signedIn: true })).toBe(false)
    expect(shouldRecordSecondDeviceOpen({ url, currentClientId: "phone-client", signedIn: false })).toBe(false)
    expect(shouldRecordSecondDeviceOpen({
      url: new URL("https://app.claxedo.test/w/ws"),
      currentClientId: "phone-client",
      signedIn: true,
    })).toBe(false)
  })
})
