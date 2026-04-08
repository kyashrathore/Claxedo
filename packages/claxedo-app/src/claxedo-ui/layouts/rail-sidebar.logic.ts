import type { Process } from "@claxedo/process/process"

type ProcessConfig = Process.ProcessConfig
type ManagedProcess = Process.ManagedProcess
type Status = Process.Status
type EventType = "process.started" | "process.stopped" | "process.crashed" | "process.status"

export function showEmpty(rows: number, total: number, more: boolean, procs = 0) {
  return rows === 0 && total === 0 && !more && procs === 0
}

export function loadProcessView(row: { processes?: unknown } | undefined) {
  return row?.processes === "hide" ? "hide" : "show"
}

export function processRows(configs: ProcessConfig[], processes: Record<string, ManagedProcess>) {
  return configs.map((cfg) => ({
    id: cfg.id,
    title: cfg.name || "Process",
    attention: processes[cfg.id]?.status === "crashed" || !!processes[cfg.id]?.conflict,
    status: processes[cfg.id]?.conflict ? "crashed" : processes[cfg.id]?.status ?? "idle",
  }))
}

export function processAction(status: Status | undefined) {
  if (status === "crashed") {
    return {
      icon: "reset",
      title: "Restart process",
      mode: "restart",
    } as const
  }
  if (status === "running" || status === "starting" || status === "stopping" || status === "restarting") {
    return {
      icon: "stop",
      title: "Stop process",
      mode: "stop",
    } as const
  }
  return {
    icon: "play",
    title: "Start process",
    mode: "start",
  } as const
}

export function processTone(status: Status | undefined) {
  if (status === "running") return "good" as const
  if (status === "starting" || status === "stopping" || status === "restarting") return "warn" as const
  if (status === "crashed") return "bad" as const
  return "idle" as const
}

export function mergeProcessEvent(
  proc: ManagedProcess | undefined,
  input: {
    type: EventType
    configId: string
    status?: Status
    ptyId?: string
    exitCode?: number
    restartCount?: number
  },
) {
  if (input.type === "process.started") {
    return {
      ...(proc ?? { configId: input.configId, restartCount: 0 }),
      configId: input.configId,
      ptyId: input.ptyId,
      status: "running" as const,
      restartCount: proc?.restartCount ?? 0,
      startedAt: Date.now(),
      conflict: undefined,
      exitCode: undefined,
      exitedAt: undefined,
    } satisfies ManagedProcess
  }

  if (input.type === "process.stopped") {
    return {
      ...(proc ?? { configId: input.configId, restartCount: 0 }),
      configId: input.configId,
      status: "stopped" as const,
      ptyId: undefined,
      exitCode: input.exitCode ?? proc?.exitCode,
      exitedAt: Date.now(),
      conflict: undefined,
      assignedPort: undefined,
    } satisfies ManagedProcess
  }

  if (input.type === "process.crashed") {
    return {
      ...(proc ?? { configId: input.configId, restartCount: 0 }),
      configId: input.configId,
      status: "crashed" as const,
      ptyId: input.ptyId ?? proc?.ptyId,
      exitCode: input.exitCode ?? proc?.exitCode,
      restartCount: input.restartCount ?? proc?.restartCount ?? 0,
      exitedAt: Date.now(),
    } satisfies ManagedProcess
  }

  if (!input.status) return proc
  if (proc && input.status === "stopping" && (proc.status === "stopped" || proc.status === "crashed")) {
    return proc
  }

  return {
    ...(proc ?? { configId: input.configId, restartCount: 0 }),
    configId: input.configId,
    status: input.status,
    ...(input.status === "stopped"
      ? {
          ptyId: undefined,
          conflict: undefined,
          assignedPort: undefined,
          exitedAt: proc?.exitedAt ?? Date.now(),
        }
      : {}),
    ...(input.status === "running" || input.status === "starting" || input.status === "restarting"
      ? {
          exitCode: undefined,
          exitedAt: undefined,
          conflict: undefined,
        }
      : {}),
  } satisfies ManagedProcess
}

export function showCloud(input: {
  worktree: string
  workspaces?: Record<string, { kind: "local" | "cloud" }>
  workspaceDir?: string
  local: boolean
}) {
  const dir = input.workspaceDir ?? input.worktree
  if (dir === input.worktree) return input.workspaces?.[dir]?.kind === "cloud" || !input.local
  const ws = input.workspaces?.[dir]
  if (ws) return ws.kind === "cloud"
  return false
}
