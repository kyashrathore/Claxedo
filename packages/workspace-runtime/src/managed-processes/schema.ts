import z from "zod"

function mark<T extends z.ZodTypeAny>(schema: T, ref: string): T {
  const hit = schema as T & { meta?: (data: { ref: string }) => T }
  return typeof hit.meta === "function" ? hit.meta({ ref }) : schema
}

export namespace Process {
  /**
   * Generate a process config ID.
   * Uses "proc" prefix with ascending timestamp, matching the Identifier pattern
   * but without requiring upstream registration.
   */
  export function createId(): string {
    const now = Date.now()
    const hex = now.toString(16).padStart(12, "0")
    const rand = Math.random().toString(36).slice(2, 16)
    return `proc_${hex}${rand}`
  }

  export const RestartPolicy = z.enum(["never", "on-failure", "always"])
  export type RestartPolicy = z.infer<typeof RestartPolicy>

  export const Status = z.enum([
    "idle",
    "starting",
    "running",
    "stopping",
    "stopped",
    "crashed",
    "restarting",
  ])
  export type Status = z.infer<typeof Status>

  export const PortConflictStrategy = z.enum(["pick-new", "kill-existing"])
  export type PortConflictStrategy = z.infer<typeof PortConflictStrategy>

  export const PortConflictInfo = z.object({
    type: z.literal("port-conflict"),
    port: z.number().int(),
    pid: z.number().int().optional(),
    command: z.string().optional(),
    /** If the occupier is one of our managed processes */
    processName: z.string().optional(),
    processId: z.string().optional(),
    /** Workspace directory of the occupying process (if known) */
    directory: z.string().optional(),
  })
  export type PortConflictInfo = z.infer<typeof PortConflictInfo>

  export const RouteConflictInfo = z.object({
    type: z.literal("route-conflict"),
    hostname: z.string(),
    pid: z.number().int(),
    command: z.string().optional(),
    /** If the occupier is one of our managed processes */
    processName: z.string().optional(),
    processId: z.string().optional(),
    /** Workspace directory of the occupying process (if known) */
    directory: z.string().optional(),
  })
  export type RouteConflictInfo = z.infer<typeof RouteConflictInfo>

  export const LaunchRequest = z.object({
    portConflict: PortConflictStrategy.optional(),
    routeConflict: PortConflictStrategy.optional(),
  })
  export type LaunchRequest = z.infer<typeof LaunchRequest>

  export const ProcessConfig = mark(z.object({
      id: z.string().default(() => createId()),
      name: z.string().min(1, "Name is required"),
      command: z.string(),
      args: z.array(z.string()).default([]),
      cwd: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
      autoStart: z.boolean().default(false),
      restartPolicy: RestartPolicy.default("never"),
      maxRestarts: z.number().int().min(0).default(3),
      color: z.string().optional(),
      /** Processes (by name) that must be running before this one starts. */
      dependsOn: z.array(z.string()).optional(),
      port: z.object({
        name: z.string().regex(/^[a-z0-9._-]+$/),
        inject: z.string(),
        /** Preferred port number — try this workspace's target port before scanning upward. */
        preferred: z.number().int().positive().optional(),
        /**
         * What to do when the preferred port is already in use.
         * If unset, the caller is prompted interactively (409 conflict response).
         * Set to "pick-new" or "kill-existing" to auto-resolve without prompting.
         */
        onConflict: PortConflictStrategy.optional(),
      }).optional(),
    }), "ProcessConfig")

  export type ProcessConfig = z.infer<typeof ProcessConfig>

  export const ProcessConfigFile = z.object({
    $schema: z.string().optional(),
    processes: z.array(ProcessConfig),
  })

  export type ProcessConfigFile = z.infer<typeof ProcessConfigFile>

  export const ManagedProcess = mark(z.object({
      configId: z.string(),
      ptyId: z.string().optional(),
      status: Status,
      restartCount: z.number().int().min(0).default(0),
      exitCode: z.number().int().optional(),
      startedAt: z.number().optional(),
      exitedAt: z.number().optional(),
      assignedPort: z.number().int().optional(),
      conflict: PortConflictInfo.optional(),
      namedUrl: z.string().optional(),
    }), "ManagedProcess")

  export type ManagedProcess = z.infer<typeof ManagedProcess>

  export const LaunchResult = mark(z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("started"),
        process: ManagedProcess,
      }),
      z.object({
        kind: z.literal("already_running"),
        process: ManagedProcess,
      }),
      z.object({
        kind: z.literal("port_conflict"),
        conflict: PortConflictInfo,
      }),
      z.object({
        kind: z.literal("route_conflict"),
        conflict: RouteConflictInfo,
      }),
      z.object({
        kind: z.literal("failed"),
        error: z.string(),
        process: ManagedProcess.optional(),
      }),
      z.object({
        kind: z.literal("not_found"),
        error: z.string(),
      }),
    ]), "ProcessLaunchResult")

  export type LaunchResult = z.infer<typeof LaunchResult>

  export const ListResponse = mark(z.object({
      configs: ProcessConfig.array(),
      processes: ManagedProcess.array(),
    }), "ProcessListResponse")

  export type ListResponse = z.infer<typeof ListResponse>

  export const DiagnosticStatus = z.enum(["active", "stale", "suspect"])
  export type DiagnosticStatus = z.infer<typeof DiagnosticStatus>

  export const DiagnosticOwnerKind = z.enum([
    "tab",
    "managed_process",
    "mcp_server",
    "server",
    "app",
    "leaked_server",
    "external",
  ])
  export type DiagnosticOwnerKind = z.infer<typeof DiagnosticOwnerKind>

  export const DiagnosticOsProcess = mark(z.object({
      pid: z.number().int(),
      ppid: z.number().int(),
      pgid: z.number().int(),
      state: z.string(),
      cpu_percent: z.number(),
      rss_kb: z.number().int(),
      elapsed: z.string(),
      kind: z.enum(["process", "terminal", "desktop"]),
      command: z.string(),
      command_short: z.string(),
      process_id: z.string().optional(),
      process_name: z.string().optional(),
      terminal_id: z.string().optional(),
      tab_id: z.string().optional(),
      workspace_id: z.string().optional(),
      agent: z.string().optional(),
      port: z.number().int().optional(),
      mcp_name: z.string().optional(),
      tracked_pty_id: z.string().optional(),
      tracked_process_id: z.string().optional(),
      status: DiagnosticStatus,
      reasons: z.array(z.string()),
      owner_key: z.string().optional(),
      owner_kind: DiagnosticOwnerKind.optional(),
      depth: z.number().int().min(0).default(0),
      current: z.boolean().default(false),
      leaked: z.boolean().default(false),
      hidden_by_default: z.boolean().default(false),
    }), "DiagnosticOsProcess")

  export type DiagnosticOsProcess = z.infer<typeof DiagnosticOsProcess>

  export const DiagnosticGroupTarget = mark(z.object({
      group_key: z.string(),
      pid: z.number().int().positive().optional(),
      scope: z.enum(["pid", "group"]).default("pid"),
    }), "DiagnosticGroupTarget")

  export type DiagnosticGroupTarget = z.infer<typeof DiagnosticGroupTarget>

  export const DiagnosticGroup = mark(z.object({
      key: z.string(),
      kind: DiagnosticOwnerKind,
      title: z.string(),
      status: DiagnosticStatus,
      cpu_percent: z.number(),
      rss_kb: z.number().int(),
      ports: z.array(z.number().int()),
      pid: z.number().int().optional(),
      terminal_id: z.string().optional(),
      process_id: z.string().optional(),
      tab_id: z.string().optional(),
      current: z.boolean(),
      leaked: z.boolean(),
      hidden_children: z.number().int().min(0),
      problem_children: z.number().int().min(0),
      children: z.array(DiagnosticOsProcess),
      target: DiagnosticGroupTarget.optional(),
    }), "DiagnosticGroup")

  export type DiagnosticGroup = z.infer<typeof DiagnosticGroup>

  export const DiagnosticSummaryBucket = mark(z.object({
      groups: z.number().int().min(0),
      rows: z.number().int().min(0),
      cpu_percent: z.number(),
      rss_kb: z.number().int(),
      hidden_children: z.number().int().min(0).default(0),
      problem_children: z.number().int().min(0).default(0),
    }), "DiagnosticSummaryBucket")

  export type DiagnosticSummaryBucket = z.infer<typeof DiagnosticSummaryBucket>

  export const DiagnosticSnapshot = mark(z.object({
      directory: z.string(),
      listening_ports: z.array(z.number().int()),
      server: z.object({
        pid: z.number().int(),
        rss_kb: z.number().int(),
        heap_used_kb: z.number().int(),
        heap_total_kb: z.number().int(),
        uptime_s: z.number().int(),
      }),
      configs: z.array(ProcessConfig),
      processes: z.array(ManagedProcess),
      ptys: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          command: z.string(),
          args: z.array(z.string()),
          cwd: z.string(),
          status: z.enum(["running", "exited"]),
          pid: z.number().int(),
          subscribers: z.number().int().optional(),
          managed: z.boolean().optional(),
          orphanTimerActive: z.boolean().optional(),
        }),
      ),
      os: z.array(DiagnosticOsProcess),
      owners: z.array(DiagnosticGroup),
      leaks: z.array(DiagnosticGroup),
      summary: z.object({
        current: DiagnosticSummaryBucket,
        leaked: DiagnosticSummaryBucket,
        external: DiagnosticSummaryBucket,
      }),
      generated_at: z.number().int(),
    }), "DiagnosticSnapshot")

  export type DiagnosticSnapshot = z.infer<typeof DiagnosticSnapshot>

  export const DiagnosticTerminateInput = z
    .object({
      pid: z.number().int().positive().optional(),
      pty_id: z.string().optional(),
      process_id: z.string().optional(),
      group_key: z.string().optional(),
      signal: z.enum(["SIGTERM", "SIGKILL"]).optional(),
      scope: z.enum(["pid", "group"]).optional(),
    })
    .refine((value) => [value.pid, value.pty_id, value.process_id, value.group_key].filter(Boolean).length === 1, {
      message: "Provide exactly one of pid, pty_id, process_id",
    })

  export type DiagnosticTerminateInput = z.infer<typeof DiagnosticTerminateInput>
}
