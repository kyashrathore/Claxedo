import { asRecord } from "@claxedo/helpers/guards"

export type RunnerRequest =
  | { kind: "run"; id: string; file: string; args: string[]; cwd: string; env: Record<string, string> }
  | { kind: "kill"; id: string }
  | { kind: "release"; id: string }
  | { kind: "end" }

export type RunnerReply =
  | { kind: "started"; id: string; pid: number }
  | { kind: "output"; id: string; stream: "stdout" | "stderr"; data: string }
  | { kind: "exit"; id: string; code: number | null; signal: string | null }
  | { kind: "failed"; id: string; message: string }

export function isRunnerRequest(value: unknown): value is RunnerRequest {
  const row = asRecord(value)
  if (!row) return false
  if (row.kind === "end") return true
  if (typeof row.id !== "string") return false
  if (row.kind === "kill" || row.kind === "release") return true
  const env = asRecord(row.env)
  return row.kind === "run" && typeof row.file === "string" && Array.isArray(row.args) && row.args.every((arg) => typeof arg === "string") && typeof row.cwd === "string"
    && env !== undefined && Object.values(env).every((value) => typeof value === "string")
}

export function isRunnerReply(value: unknown): value is RunnerReply {
  const row = asRecord(value)
  if (!row || typeof row.id !== "string") return false
  if (row.kind === "started") return typeof row.pid === "number"
  if (row.kind === "output") return (row.stream === "stdout" || row.stream === "stderr") && typeof row.data === "string"
  if (row.kind === "exit") return (row.code === null || typeof row.code === "number") && (row.signal === null || typeof row.signal === "string")
  return row.kind === "failed" && typeof row.message === "string"
}
