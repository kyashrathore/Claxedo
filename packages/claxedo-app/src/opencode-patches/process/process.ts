import { BusEvent } from "@/bus/bus-event"
import z from "zod"

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

  export const ProcessConfig = z
    .object({
      id: z.string().default(() => createId()),
      name: z.string(),
      command: z.string(),
      args: z.array(z.string()).default([]),
      cwd: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
      autoStart: z.boolean().default(false),
      restartPolicy: RestartPolicy.default("never"),
      maxRestarts: z.number().int().min(0).default(3),
      color: z.string().optional(),
      portless: z.object({
        hostname: z.string().regex(/^[a-z0-9.\-]*$/, "hostname must be lowercase alphanumeric, dots, or hyphens"),
        portMode: z.enum(["env", "flag"]).default("env"),
        portValue: z.string().regex(/^[a-zA-Z0-9_\-]*$/, "portValue must be alphanumeric, underscores, or hyphens").default("PORT"),
      }).optional(),
    })
    .meta({ ref: "ProcessConfig" })

  export type ProcessConfig = z.infer<typeof ProcessConfig>

  export const ProcessConfigFile = z.object({
    $schema: z.string().optional(),
    processes: z.array(ProcessConfig),
  })

  export type ProcessConfigFile = z.infer<typeof ProcessConfigFile>

  export const ManagedProcess = z
    .object({
      configId: z.string(),
      ptyId: z.string().optional(),
      status: Status,
      restartCount: z.number().int().min(0).default(0),
      exitCode: z.number().int().optional(),
      startedAt: z.number().optional(),
      exitedAt: z.number().optional(),
    })
    .meta({ ref: "ManagedProcess" })

  export type ManagedProcess = z.infer<typeof ManagedProcess>

  export const Event = {
    Started: BusEvent.define(
      "process.started",
      z.object({
        configId: z.string(),
        ptyId: z.string(),
      }),
    ),
    Stopped: BusEvent.define(
      "process.stopped",
      z.object({
        configId: z.string(),
        exitCode: z.number().int(),
      }),
    ),
    Crashed: BusEvent.define(
      "process.crashed",
      z.object({
        configId: z.string(),
        exitCode: z.number().int(),
        restartCount: z.number().int(),
        /** True when the inner command exited but the shell PTY is still alive */
        commandExit: z.boolean().optional(),
        /** PTY ID if the shell is still alive (command-exit crash) */
        ptyId: z.string().optional(),
      }),
    ),
    Status: BusEvent.define(
      "process.status",
      z.object({
        configId: z.string(),
        status: Status,
      }),
    ),
    ConfigChanged: BusEvent.define(
      "process.config.changed",
      z.object({
        configs: z.array(ProcessConfig),
      }),
    ),
  }
}
