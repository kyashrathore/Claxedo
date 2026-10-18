import { readString } from "@claxedo/helpers/readers"
import type { Subprocess } from "bun"
import type { CdpPage } from "./cdp-page"
import { identityKey, type ProcessFamily, type ProcessRow, readProcessTable } from "./process-family"

export type OwnedProcess = {
  pid: number
  startTimeMs: number
  owner: "application"
  category: string
  role?: "main" | "renderer" | "gpu" | "utility" | "external-helper"
}

type StopInput = { application: Subprocess; family: ProcessFamily; page: CdpPage | undefined }

const GRACEFUL_EXIT_MS = 15_000
const SIGNAL_GRACE_MS = 3_000

async function exitedWithin(application: Subprocess, timeoutMs: number) {
  return Promise.race([application.exited.then(() => true), Bun.sleep(timeoutMs).then(() => false)])
}

function signal(rows: ProcessRow[], name: "SIGTERM" | "SIGKILL") {
  for (const row of rows) {
    try {
      process.kill(row.pid, name)
    } catch (error) {
      if (readString(error, "code") !== "ESRCH") throw error
    }
  }
}

async function survivorsAfter(family: ProcessFamily, name: "SIGTERM" | "SIGKILL") {
  const table = await readProcessTable()
  family.observe(table)
  const before = family.alive(table)
  if (before.length === 0) return before
  signal(before, name)
  await Bun.sleep(SIGNAL_GRACE_MS)
  return family.alive(await readProcessTable())
}

export async function stopProcessFamily(input: StopInput) {
  input.family.observe(await readProcessTable())
  if (input.application.exitCode === null) input.application.kill("SIGTERM")
  if (!(await exitedWithin(input.application, GRACEFUL_EXIT_MS))) input.application.kill("SIGKILL")
  await exitedWithin(input.application, SIGNAL_GRACE_MS)
  input.page?.close()
  let survivors = await survivorsAfter(input.family, "SIGTERM")
  if (survivors.length > 0) survivors = await survivorsAfter(input.family, "SIGKILL")
  const remaining = new Set(survivors.map(identityKey))
  const terminated = [...input.family.known.values()].filter((row) => !remaining.has(identityKey(row)))
  return { terminated, survivors }
}
