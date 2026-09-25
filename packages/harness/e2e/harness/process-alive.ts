import { execFileSync } from "node:child_process"

export function processAlive(pid: number) {
  try { return execFileSync("ps", ["-p", String(pid), "-o", "pid="], { encoding: "utf8" }).trim() === String(pid) }
  catch (error) { if ((error as { status?: number }).status === 1) return false; throw error }
}
