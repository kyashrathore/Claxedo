import fs from "node:fs/promises"
import path from "node:path"
import { workspaceRuntimePtyHistoryDir } from "../env"
import { createHistory } from "./history"

export function historyPath(directory: string, id: string, root = workspaceRuntimePtyHistoryDir()) {
  const key = Buffer.from(directory).toString("base64url")
  return path.join(root, key, `${id}.log`)
}

export async function renameHistory(
  directory: string,
  oldId: string,
  newId: string,
  root = workspaceRuntimePtyHistoryDir(),
) {
  const oldPath = historyPath(directory, oldId, root)
  const newPath = historyPath(directory, newId, root)
  await fs.mkdir(path.dirname(newPath), { recursive: true })
  await fs.rename(oldPath, newPath)
}

export async function cleanupOrphanedHistory(
  root = workspaceRuntimePtyHistoryDir(),
  maxAgeMs = 7 * 24 * 60 * 60 * 1000,
) {
  const now = Date.now()
  let dirs: string[]
  try {
    dirs = await fs.readdir(root)
  } catch {
    return
  }
  for (const dir of dirs) {
    const dirPath = path.join(root, dir)
    let stat
    try {
      stat = await fs.stat(dirPath)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    let files: string[]
    try {
      files = await fs.readdir(dirPath)
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith(".log")) continue
      const filePath = path.join(dirPath, file)
      try {
        const fstat = await fs.stat(filePath)
        if (now - fstat.mtimeMs > maxAgeMs) {
          await fs.rm(filePath, { force: true })
        }
      } catch {}
    }
  }
}

export async function createDiskHistory(input: { directory: string; id: string; limit: number }) {
  const file = historyPath(input.directory, input.id)
  const history = createHistory(input.limit)
  let bytes = 0
  let staged = ""
  let timer: ReturnType<typeof setTimeout> | undefined
  let queue = Promise.resolve()

  const compact = () =>
    fs
      .writeFile(file, history.snapshot())
      .then(() => {
        bytes = history.size()
      })
      .catch(() => {})

  const flush = () => {
    if (!staged) return queue
    const chunk = staged
    staged = ""
    queue = queue
      .then(() => fs.appendFile(file, chunk))
      .then(() => {
        bytes += chunk.length
        if (bytes <= input.limit) return
        return compact()
      })
      .catch(() => {})
    return queue
  }

  await fs
    .mkdir(path.dirname(file), { recursive: true })
    .then(() => fs.readFile(file, "utf8"))
    .then((saved) => {
      history.append(saved)
      bytes = history.size()
      if (saved.length === bytes) return
      return compact()
    })
    .catch(() => {})

  return {
    append(data: string) {
      if (!data) return
      history.append(data)
      staged += data
      if (timer) return
      timer = setTimeout(() => {
        timer = undefined
        void flush()
      }, 8)
    },
    snapshot(max?: number) {
      return history.snapshot(max)
    },
    size() {
      return history.size()
    },
    async close() {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      await flush()
      await queue
    },
    async clear() {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      staged = ""
      history.clear()
      bytes = 0
      await queue
      await fs.rm(file, { force: true }).catch(() => {})
    },
  }
}
