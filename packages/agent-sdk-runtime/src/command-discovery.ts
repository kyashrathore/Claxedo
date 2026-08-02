import * as fs from "fs"
import * as path from "path"
import { dataDir } from "./paths"

export type CommandItem = {
  name: string
  content: string
}

function commandDir() {
  return path.join(dataDir(), "opencode-config", "command")
}

export async function listCommands(): Promise<CommandItem[]> {
  try {
    await fs.promises.mkdir(commandDir(), { recursive: true, mode: 0o755 })
    return await Promise.all((await fs.promises.readdir(commandDir()))
      .filter((file) => file.endsWith(".md"))
      .map(async (file) => ({
        name: file.slice(0, -3),
        content: await fs.promises.readFile(path.join(commandDir(), file), "utf-8"),
      })))
  } catch {
    return []
  }
}
