import fs from "node:fs/promises"
import path from "node:path"

export async function restartedDataDir(dataDir: string): Promise<string> {
  if (process.env.H27_RESTART_WITH_EMPTY_DATA !== "1") return dataDir
  const empty = path.join(dataDir, "restart-with-empty-data")
  await fs.mkdir(empty, { recursive: true })
  return empty
}
