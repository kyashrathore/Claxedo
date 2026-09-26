import fs from "node:fs/promises"
import path from "node:path"
import { isMissingFile } from "@claxedo/helpers/fs"

export class LivePluginStoreError extends Error {
  readonly file: string

  constructor(file: string, detail: string) {
    super(`${file}: ${detail}`)
    this.name = "LivePluginStoreError"
    this.file = file
  }
}

export async function readJsonFileIfPresent(file: string): Promise<unknown | undefined> {
  let text: string
  try {
    text = await fs.readFile(file, "utf8")
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw error
  }
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new LivePluginStoreError(file, error instanceof Error ? error.message : String(error))
  }
}

export async function writeJsonFileAtomically(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const staged = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(staged, `${JSON.stringify(value, null, 2)}\n`)
  await fs.rename(staged, file)
}
