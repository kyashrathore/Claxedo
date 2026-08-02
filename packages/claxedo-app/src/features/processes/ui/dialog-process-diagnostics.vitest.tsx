import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { JSX } from "solid-js"
import type { LocalDiagnostics } from "../data/local-diagnostics"

const state = vi.hoisted(() => {
  let listener: ((snapshot: LocalDiagnostics.RetainedSnapshot) => void) | undefined
  return {
    listener: () => listener,
    getSnapshot: vi.fn<() => Promise<LocalDiagnostics.RetainedSnapshot>>(),
    subscribe: vi.fn((next: (snapshot: LocalDiagnostics.RetainedSnapshot) => void) => {
      listener = next
      return vi.fn(() => {
        listener = undefined
      })
    }),
    stop: vi.fn(),
    kill: vi.fn(),
  }
})

vi.mock("@/platform/runtime/platform-provider", () => ({
  usePlatform: () => ({
    platform: "desktop",
    processDiagnostics: {
      getSnapshot: state.getSnapshot,
      subscribe: state.subscribe,
      stop: state.stop,
      kill: state.kill,
    },
  }),
}))

vi.mock("@opencode-ai/ui/dialog", () => ({
  Dialog: (props: { title: string; children: JSX.Element }) => (
    <div role="dialog" aria-label={props.title}>{props.children}</div>
  ),
}))

vi.mock("@opencode-ai/ui/button", () => ({
  Button: (props: {
    children: JSX.Element
    disabled?: boolean
    onClick?: () => void
  }) => <button type="button" disabled={props.disabled} onClick={props.onClick}>{props.children}</button>,
}))

import { DialogProcessDiagnostics } from "./dialog-process-diagnostics"
import { formatTime } from "./diagnostics/timeline"

beforeEach(() => {
  state.getSnapshot.mockReset()
  state.subscribe.mockClear()
  state.stop.mockReset()
  state.kill.mockReset()
  state.getSnapshot.mockResolvedValue(snapshot())
  state.stop.mockResolvedValue({
    ok: true,
    action: "stop",
    completedAt: 4_000,
    markerId: "marker-action-complete",
  })
  state.kill.mockResolvedValue({
    ok: false,
    action: "kill",
    code: "user-cancelled",
  })
})

afterEach(() => cleanup())

describe("local performance diagnostics dialog", () => {
  test("loads retained startup history, subscribes once, and renders ranked local ownership", async () => {
    render(() => <DialogProcessDiagnostics />)

    expect(screen.getByText("Loading retained startup history…")).toBeInTheDocument()
    expect(await screen.findByRole("button", { name: /Codex harness/ })).toBeInTheDocument()
    expect(screen.getByText("Collector active")).toBeInTheDocument()
    expect(screen.getByText("CPU and memory history")).toBeInTheDocument()
    expect(screen.getByText(/Workspace model work shares/)).toBeInTheDocument()
    expect(screen.getByText("Lifecycle activity")).toBeInTheDocument()
    expect(screen.getByText(/owner started · Codex harness/)).toBeInTheDocument()
    expect(state.getSnapshot).toHaveBeenCalledOnce()
    expect(state.subscribe).toHaveBeenCalledOnce()

    state.listener()?.({
      ...snapshot(),
      capturedAt: 4_000,
      samples: [...snapshot().samples, point(4_000, 4, 4_000)],
    })
    await waitFor(() => expect(screen.getByText(/last sample/)).toHaveTextContent(formatTime(4_000)))
  })

  test("uses only the opaque grant for a named owner action and refreshes after the result", async () => {
    render(() => <DialogProcessDiagnostics />)
    const owner = await screen.findByRole("button", { name: /Codex harness/ })
    fireEvent.click(owner)
    fireEvent.click(screen.getByRole("button", { name: "Stop gracefully" }))

    await waitFor(() => expect(state.stop).toHaveBeenCalledWith({
      action: "stop",
      token: "opaque-diagnostics-token-0001",
    }))
    expect(state.stop.mock.calls[0]?.[0]).not.toHaveProperty("pid")
    expect(await screen.findByText("Stopped the selected local owner.")).toBeInTheDocument()
    expect(state.getSnapshot).toHaveBeenCalledTimes(2)
  })

  test("exposes named keyboard range handles and a textual equivalent", async () => {
    const view = render(() => <DialogProcessDiagnostics />)
    const start = await screen.findByRole("slider", { name: "Selection start" })
    expect(start).toBeInTheDocument()
    expect(screen.getByRole("slider", { name: "Selection end" })).toBeInTheDocument()
    fireEvent.input(start, { target: { value: "2000" } })
    await waitFor(() => expect(view.container.querySelector("[aria-live]")).toHaveTextContent("Selected timeline interval"))
    fireEvent.click(screen.getByText("Text timeline summary"))
    expect(screen.getByRole("columnheader", { name: "Time" })).toBeInTheDocument()
    expect(screen.getByRole("columnheader", { name: "CPU" })).toBeInTheDocument()
    expect(screen.getByRole("columnheader", { name: "RSS" })).toBeInTheDocument()
  })

  test("announces source transitions without announcing routine samples", async () => {
    const view = render(() => <DialogProcessDiagnostics />)
    await screen.findByText("Collector active")
    const live = view.container.querySelector("[aria-live]")!

    state.listener()?.({ ...snapshot(), capturedAt: 4_000 })
    expect(live).toHaveTextContent("")
    state.listener()?.({
      ...snapshot(),
      capturedAt: 5_000,
      sources: [{
        ...snapshot().sources[0]!,
        state: "degraded",
        reason: "source-timeout",
      }],
    })
    await waitFor(() => expect(live).toHaveTextContent("linux-proc on host changed from healthy to degraded"))
  })

  test("renders release-task evidence for startup, ownership, growth, degradation, and churn", async () => {
    state.getSnapshot.mockResolvedValue(taskSnapshot())
    const view = render(() => <DialogProcessDiagnostics />)

    await screen.findByRole("button", { name: /Electron main/ })
    const contributors = [...view.container.querySelectorAll<HTMLElement>(
      '[data-testid="diagnostics-contributor"]',
    )]
    expect(new Set(contributors.map((item) => item.dataset.ownerKind))).toEqual(
      new Set(["electron-main", "server", "sidecar", "harness"]),
    )
    expect(
      contributors.some((item) =>
        item.dataset.ownerKind === "harness" && Number(item.dataset.rssChange) > 0),
    ).toBe(true)
    const range = view.container.querySelector<HTMLElement>('[aria-label="Selected interval summary"]')!
    expect(Number(range.dataset.diagnosticsRangeStart)).toBe(1_000)
    expect(Number(range.dataset.diagnosticsRangeEnd)).toBe(3_000)
    expect(view.container.querySelector('[data-testid="diagnostics-source"]')).toHaveAttribute(
      "data-state",
      "degraded",
    )
    expect(view.container.querySelector('[data-testid="diagnostics-churn"]')).toHaveAttribute(
      "data-measurement",
      "unmeasured",
    )
    expect(screen.getByText(/unmeasured churn, never as zero usage/)).toBeInTheDocument()
  })
})

function taskSnapshot(): LocalDiagnostics.RetainedSnapshot {
  const owners = [
    owner("owner-electron", "electron-main", "Electron main"),
    owner("owner-server", "server", "Claxedo server"),
    owner("owner-sidecar", "sidecar", "OpenCode sidecar"),
    owner("owner-harness", "harness", "Codex harness"),
  ] satisfies LocalDiagnostics.OwnerIdentity[]
  const roles = ["main", "server", "sidecar", "harness"] satisfies LocalDiagnostics.ProcessRole[]
  const processes = owners.map((item, index) =>
    readOnlyProcess(
      `host:${String(10 + index)}:${String(100 + index)}`,
      10 + index,
      item.id,
      roles[index]!,
      item.label,
    ))
  const samples = [
    taskPoint(1_000, processes[0]!.identity.id, 75, 20_000),
    taskPoint(1_000, processes[1]!.identity.id, 15, 30_000),
    taskPoint(1_000, processes[2]!.identity.id, 5, 10_000),
    taskPoint(1_000, processes[3]!.identity.id, 10, 1_000),
    taskPoint(2_000, processes[0]!.identity.id, 5, 22_000),
    taskPoint(2_000, processes[1]!.identity.id, 60, 42_000),
    taskPoint(2_000, processes[2]!.identity.id, 35, 16_000),
    taskPoint(2_000, processes[3]!.identity.id, 20, 40_000),
    taskPoint(3_000, processes[0]!.identity.id, 2, 23_000),
    taskPoint(3_000, processes[1]!.identity.id, 3, 44_000),
    taskPoint(3_000, processes[2]!.identity.id, 2, 17_000),
    taskPoint(3_000, processes[3]!.identity.id, 1, 65_000),
  ]
  return {
    ...snapshot(),
    owners,
    processes,
    samples,
    sources: [{
      ...snapshot().sources[0]!,
      state: "degraded",
      reason: "source-timeout",
    }],
    markers: [
      {
        type: "lifecycle",
        id: "marker-profiler-started",
        at: 900,
        event: "profiler-started",
        source: "electron",
      },
      {
        type: "lifecycle",
        id: "marker-server-starting",
        at: 1_500,
        event: "server-starting",
        ownerId: "owner-server",
      },
      {
        type: "churn",
        id: "marker-cli-churn",
        at: 2_500,
        ownerId: "owner-harness",
        launched: 1,
        exited: 1,
        shortestDurationMs: 25,
        longestDurationMs: 25,
        resourceMeasurement: { state: "unmeasured", reason: "not-sampled" },
      },
    ],
  }
}

function owner(
  id: string,
  kind: LocalDiagnostics.OwnerKind,
  label: string,
): LocalDiagnostics.OwnerIdentity {
  return {
    id,
    kind,
    label,
    launchId: `${id}-launch`,
    access: "local",
    lifecycle: "current",
  }
}

function readOnlyProcess(
  id: string,
  pid: number,
  ownerId: string,
  role: LocalDiagnostics.ProcessRole,
  label: string,
): LocalDiagnostics.ProcessRecord {
  return {
    identity: {
      id,
      domain: "host",
      pid,
      creation: { state: "available", value: String(pid), source: "linux-proc" },
      launchId: `${ownerId}-launch`,
    },
    ownerId,
    role,
    label,
    lifecycle: "running",
    actionEligibility: { state: "ineligible", reason: "protected-process" },
  }
}

function taskPoint(at: number, processId: string, cpu: number, rssBytes: number) {
  return {
    at,
    processId,
    cpuMachinePercent: { state: "available" as const, value: cpu },
    rssBytes: { state: "available" as const, value: rssBytes },
  }
}

function snapshot(): LocalDiagnostics.RetainedSnapshot {
  return {
    version: 1,
    generation: "generation-1",
    capturedAt: 3_000,
    retainedFromAt: 1_000,
    targetWindowMs: 15 * 60_000,
    retention: { state: "complete" },
    owners: [{
      id: "owner-codex",
      kind: "harness",
      label: "Codex harness",
      launchId: "launch-codex",
      access: "local",
      lifecycle: "current",
      harnessId: "codex",
    }],
    processes: [{
      identity: {
        id: "host:42:100",
        domain: "host",
        pid: 42,
        creation: { state: "available", value: "100", source: "linux-proc" },
        launchId: "launch-codex",
      },
      ownerId: "owner-codex",
      role: "harness",
      label: "Codex harness",
      lifecycle: "running",
      actionEligibility: {
        state: "eligible",
        actions: [
          { action: "stop", token: "opaque-diagnostics-token-0001", expiresAt: 20_000 },
          { action: "kill", token: "opaque-diagnostics-token-0002", expiresAt: 20_000 },
        ],
      },
    }],
    samples: [
      point(1_000, 1, 1_000),
      point(2_000, 80, 8_000),
      point(3_000, 2, 3_000),
    ],
    sources: [{
      source: "linux-proc",
      domain: "host",
      accuracy: "estimated",
      capabilities: {
        cpu: true,
        rss: true,
        ancestry: true,
        creationIdentity: true,
        actionIdentity: true,
      },
      state: "healthy",
      lastSuccessAt: 3_000,
    }],
    markers: [{
      type: "lifecycle",
      id: "marker-owner-started",
      at: 2_000,
      event: "owner-started",
      ownerId: "owner-codex",
    }],
    interval: {
      startAt: 1_000,
      endAt: 3_000,
      sampleCount: 3,
      totals: {
        currentCpuMachinePercent: { state: "available", value: 2 },
        peakCpuMachinePercent: { state: "available", value: 80 },
        currentRssBytes: { state: "available", value: 3_000 },
        peakRssBytes: { state: "available", value: 8_000 },
        rssChangeBytes: { state: "available", value: 2_000 },
      },
      contributors: [],
      churn: [],
    },
  }
}

function point(at: number, cpu: number, rssBytes: number) {
  return {
    at,
    processId: "host:42:100",
    cpuMachinePercent: { state: "available" as const, value: cpu },
    rssBytes: { state: "available" as const, value: rssBytes },
  }
}
