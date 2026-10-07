import fs from "node:fs/promises"

const WINDOWS_HANDLE_RELEASE_BUDGET_MS = 10_000
const WINDOWS_HANDLE_RELEASE_POLL_MS = 50
const WINDOWS_HANDLE_STILL_OPEN = new Set(["EBUSY", "EPERM", "ENOTEMPTY"])

async function releaseHandlesHeldByFinalizers(): Promise<void> {
  if ("Bun" in globalThis) Bun.gc(true)
  await new Promise((resolve) => setTimeout(resolve, WINDOWS_HANDLE_RELEASE_POLL_MS))
}

export async function removeTempRoot(root: string): Promise<void> {
  const deadlineAt = Date.now() + WINDOWS_HANDLE_RELEASE_BUDGET_MS
  for (;;) {
    try {
      await fs.rm(root, { recursive: true, force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ""
      if (process.platform !== "win32" || !WINDOWS_HANDLE_STILL_OPEN.has(code) || Date.now() >= deadlineAt) throw error
      await releaseHandlesHeldByFinalizers()
    }
  }
}
