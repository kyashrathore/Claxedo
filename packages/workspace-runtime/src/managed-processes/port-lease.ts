import fs from "fs/promises"
import path from "path"
import z from "zod/v3"
import { stateDir } from "../paths"
import { Log } from "../log"

const log = Log.create({ service: "process-lease" })
const LEASE_DIR = "managed-processes/port-leases"

const File = z.object({
  project_id: z.string(),
  workspace: z.string(),
  process_id: z.string(),
  port_name: z.string(),
  preferred: z.number().int().positive(),
  port: z.number().int().positive(),
  updated_at: z.number().int().nonnegative(),
})

type File = z.infer<typeof File>

type Key = {
  project_id: string
  workspace: string
  process_id: string
}

type Entry = {
  project_id: string
  workspace: string
  process_id: string
  port_name: string
  preferred: number
  port: number
}

function tag(value: string) {
  return Buffer.from(value).toString("base64url")
}

function file(key: Key) {
  return path.join(
    stateDir(),
    LEASE_DIR,
    tag(key.project_id),
    tag(key.workspace),
    `${tag(key.process_id)}.json`,
  )
}

export async function read(key: Key): Promise<File | undefined> {
  try {
    const raw = JSON.parse(await fs.readFile(file(key), "utf-8"))
    return File.parse(raw)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return
    log.warn("failed to read lease", { key, err: String(err) })
    return
  }
}

export async function write(entry: Entry) {
  const next = {
    ...entry,
    updated_at: Date.now(),
  } satisfies File
  const out = file(entry)
  await fs.mkdir(path.dirname(out), { recursive: true })
  await fs.writeFile(out, JSON.stringify(next, null, 2) + "\n")
}

export async function drop(key: Key) {
  await fs.rm(file(key), { force: true }).catch(() => undefined)
}

export async function prune(input: {
  project_id: string
  workspace: string
  process_ids: Set<string>
}) {
  const dir = path.join(stateDir(), LEASE_DIR, tag(input.project_id), tag(input.workspace))
  const list = await fs.readdir(dir).catch(() => [])
  await Promise.all(
    list.map(async (name) => {
      if (!name.endsWith(".json")) return
      const raw = await fs.readFile(path.join(dir, name), "utf-8").then(JSON.parse).catch(() => undefined)
      const item = File.safeParse(raw)
      if (!item.success) {
        await fs.rm(path.join(dir, name), { force: true }).catch(() => undefined)
        return
      }
      if (input.process_ids.has(item.data.process_id)) return
      await fs.rm(path.join(dir, name), { force: true }).catch(() => undefined)
    }),
  )
}
