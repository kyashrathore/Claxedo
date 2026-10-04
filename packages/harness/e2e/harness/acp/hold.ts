import fs from "node:fs/promises"
import { holdEnteredFile } from "./script"

export async function waitForAcpHold(scriptDir: string, name: string, timeoutMs = 10_000) {
  const file = holdEnteredFile(scriptDir, name)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await fs.access(file)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Scripted ACP never entered hold ${name}`)
}
