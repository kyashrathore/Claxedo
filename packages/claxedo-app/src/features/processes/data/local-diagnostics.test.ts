import { describe, expect, test } from "bun:test"
import type { Platform } from "@/platform/runtime/platform-provider"
import { LocalDiagnostics } from "./local-diagnostics"

const processRecord = (extra: Record<string, unknown> = {}) => ({
  identity: {
    id: "host:412:100",
    domain: "host",
    pid: 412,
    creation: { state: "available", value: "100", source: "linux-proc" },
    launchId: "launch-codex",
  },
  ownerId: "owner-codex",
  role: "harness",
  label: "Codex ACP",
  lifecycle: "running",
  actionEligibility: { state: "ineligible", reason: "owner-operation-unavailable" },
  ...extra,
})

describe("local diagnostics contract", () => {
  test("carries only opaque expiring grants for eligible owner actions", () => {
    const result = LocalDiagnostics.ProcessRecord.safeParse({
      identity: {
        id: "host:412:100",
        domain: "host",
        pid: 412,
        creation: { state: "available", value: "100", source: "linux-proc" },
        launchId: "launch-codex",
      },
      ownerId: "owner-codex",
      role: "harness",
      label: "Codex ACP",
      lifecycle: "running",
      actionEligibility: {
        state: "eligible",
        actions: [
          {
            action: "stop",
            token: "opaque-diagnostics-token-0001",
            expiresAt: 2_000,
          },
        ],
      },
    })

    expect(result.success).toBe(true)
  })

  test("parses retained history with stable process and logical owner identities", () => {
    const result = LocalDiagnostics.RetainedSnapshot.safeParse({
      version: 1,
      generation: "generation-1",
      capturedAt: 1_000,
      retainedFromAt: 100,
      targetWindowMs: 900_000,
      retention: { state: "complete" },
      owners: [
        {
          id: "owner-app",
          kind: "electron-main",
          label: "Claxedo",
          launchId: "launch-app",
          access: "local",
          lifecycle: "current",
        },
        {
          id: "owner-codex",
          kind: "harness",
          label: "Codex ACP",
          launchId: "launch-codex",
          access: "local",
          lifecycle: "current",
          workspaceId: "workspace-1",
          harnessId: "codex",
        },
        {
          id: "owner-pty",
          kind: "pty",
          label: "Terminal",
          launchId: "launch-pty",
          access: "local",
          lifecycle: "current",
          workspaceId: "workspace-1",
        },
        {
          id: "owner-wsl-sidecar",
          kind: "sidecar",
          label: "OpenCode sidecar",
          launchId: "launch-wsl-sidecar",
          access: "local",
          lifecycle: "current",
        },
      ],
      processes: [
        {
          identity: {
            id: "host:100:10",
            domain: "host",
            pid: 100,
            creation: { state: "available", value: "10", source: "electron" },
            launchId: "launch-app",
          },
          ownerId: "owner-app",
          role: "main",
          label: "Claxedo",
          lifecycle: "running",
          actionEligibility: { state: "ineligible", reason: "protected-process" },
        },
        {
          identity: {
            id: "host:412:100",
            domain: "host",
            pid: 412,
            creation: { state: "available", value: "100", source: "linux-proc" },
            launchId: "launch-codex",
          },
          ownerId: "owner-codex",
          role: "harness",
          label: "Codex ACP",
          lifecycle: "running",
          actionEligibility: {
            state: "eligible",
            actions: [
              {
                action: "stop",
                token: "opaque-diagnostics-token-0001",
                expiresAt: 2_000,
              },
              {
                action: "kill",
                token: "opaque-diagnostics-token-0002",
                expiresAt: 2_000,
              },
            ],
          },
        },
        {
          identity: {
            id: "host:500:120",
            domain: "host",
            pid: 500,
            creation: { state: "available", value: "120", source: "linux-proc" },
            launchId: "launch-pty",
          },
          ownerId: "owner-pty",
          role: "pty",
          label: "Terminal",
          lifecycle: "running",
          actionEligibility: { state: "ineligible", reason: "owner-operation-unavailable" },
        },
        {
          identity: {
            id: "wsl:700:150",
            domain: "wsl",
            pid: 700,
            creation: { state: "available", value: "150", source: "wsl" },
            launchId: "launch-wsl-sidecar",
          },
          ownerId: "owner-wsl-sidecar",
          role: "sidecar",
          label: "OpenCode sidecar",
          lifecycle: "running",
          actionEligibility: { state: "ineligible", reason: "identity-unavailable" },
        },
      ],
      samples: [
        {
          at: 1_000,
          processId: "host:412:100",
          cpuMachinePercent: { state: "available", value: 12.5 },
          rssBytes: { state: "available", value: 128_000_000 },
        },
      ],
      sources: [
        {
          source: "electron",
          domain: "host",
          state: "healthy",
          lastSuccessAt: 1_000,
          accuracy: "native",
          capabilities: {
            cpu: true,
            rss: true,
            ancestry: false,
            creationIdentity: true,
            actionIdentity: false,
          },
        },
        {
          source: "linux-proc",
          domain: "host",
          state: "healthy",
          lastSuccessAt: 1_000,
          accuracy: "native",
          capabilities: {
            cpu: true,
            rss: true,
            ancestry: true,
            creationIdentity: true,
            actionIdentity: true,
          },
        },
        {
          source: "wsl",
          domain: "wsl",
          state: "healthy",
          lastSuccessAt: 1_000,
          accuracy: "native",
          capabilities: {
            cpu: true,
            rss: true,
            ancestry: true,
            creationIdentity: true,
            actionIdentity: false,
          },
        },
      ],
      markers: [],
      interval: {
        startAt: 100,
        endAt: 1_000,
        sampleCount: 1,
        totals: {
          currentCpuMachinePercent: { state: "available", value: 12.5 },
          peakCpuMachinePercent: { state: "available", value: 12.5 },
          currentRssBytes: { state: "available", value: 128_000_000 },
          peakRssBytes: { state: "available", value: 128_000_000 },
          rssChangeBytes: { state: "available", value: 0 },
        },
        contributors: [
          {
            processId: "host:412:100",
            ownerId: "owner-codex",
            peakCpuMachinePercent: { state: "available", value: 12.5 },
            cpuSharePercent: { state: "available", value: 100 },
            peakRssBytes: { state: "available", value: 128_000_000 },
            rssChangeBytes: { state: "available", value: 0 },
          },
        ],
        churn: [],
      },
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.processes[1]?.identity).toEqual({
      id: "host:412:100",
      domain: "host",
      pid: 412,
      creation: { state: "available", value: "100", source: "linux-proc" },
      launchId: "launch-codex",
    })
    expect(result.data.owners.map((owner) => owner.kind)).toEqual([
      "electron-main",
      "harness",
      "pty",
      "sidecar",
    ])
    expect(result.data.processes.map((process) => process.identity.domain)).toEqual([
      "host",
      "host",
      "host",
      "wsl",
    ])
  })

  test("keeps unavailable metrics explicit and preserves degraded source history", () => {
    const metric = LocalDiagnostics.MetricPoint.parse({
      at: 1_500,
      processId: "host:412:100",
      cpuMachinePercent: { state: "unavailable", reason: "source-timeout" },
      rssBytes: { state: "available", value: 128_000_000 },
    })
    const source = LocalDiagnostics.SourceStatus.parse({
      source: "linux-proc",
      domain: "host",
      state: "degraded",
      reason: "source-timeout",
      lastSuccessAt: 1_000,
      accuracy: "native",
      capabilities: {
        cpu: true,
        rss: true,
        ancestry: true,
        creationIdentity: true,
        actionIdentity: true,
      },
    })

    expect(metric.cpuMachinePercent).toEqual({ state: "unavailable", reason: "source-timeout" })
    expect(source).toMatchObject({ state: "degraded", lastSuccessAt: 1_000 })
  })

  test("rejects secret-bearing fields at every process payload boundary", () => {
    for (const field of ["env", "argv", "command", "prompt", "header", "config"]) {
      expect(LocalDiagnostics.ProcessRecord.safeParse(processRecord({ [field]: "sentinel-secret" })).success).toBe(
        false,
      )
    }

    expect(
      LocalDiagnostics.LifecycleMarker.safeParse({
        type: "lifecycle",
        id: "marker-1",
        at: 1_000,
        event: "owner-started",
        prompt: "sentinel-secret",
      }).success,
    ).toBe(false)
  })

  test("represents PID reuse as separate creation identities", () => {
    const identities = LocalDiagnostics.ProcessIdentity.array().parse([
      {
        id: "host:412:100",
        domain: "host",
        pid: 412,
        creation: { state: "available", value: "100", source: "linux-proc" },
        launchId: "launch-1",
      },
      {
        id: "host:412:200",
        domain: "host",
        pid: 412,
        creation: { state: "available", value: "200", source: "linux-proc" },
        launchId: "launch-2",
      },
    ])

    expect(identities[0]?.pid).toBe(identities[1]?.pid)
    expect(identities[0]?.creation).not.toEqual(identities[1]?.creation)
    expect(identities[0]?.id).not.toBe(identities[1]?.id)
  })

  test("accepts only an opaque token and action kind for action requests", () => {
    expect(
      LocalDiagnostics.ActionRequest.safeParse({
        action: "stop",
        token: "opaque-diagnostics-token-0001",
      }).success,
    ).toBe(true)

    for (const target of ["pid", "pgid", "signal", "workspaceRelayTarget"]) {
      expect(
        LocalDiagnostics.ActionRequest.safeParse({
          action: "kill",
          token: "opaque-diagnostics-token-0002",
          [target]: 412,
        }).success,
      ).toBe(false)
    }
  })

  test("allows web platforms to omit local diagnostics entirely", () => {
    const webPlatform = {
      platform: "web",
      openLink() {},
      restart: async () => {},
      back() {},
      forward() {},
      notify: async () => {},
    } satisfies Platform

    expect("processDiagnostics" in webPlatform).toBe(false)
  })
})
