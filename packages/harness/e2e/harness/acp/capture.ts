import fs from "node:fs/promises"
import path from "node:path"
import type { PromptRequest } from "@agentclientprotocol/sdk"

function captureFile(scriptDir: string, name: string) {
  return path.join(scriptDir, `${name}.prompt.json`)
}

export async function captureAcpPrompt(scriptDir: string, name: string, prompt: PromptRequest["prompt"]) {
  await fs.writeFile(captureFile(scriptDir, name), JSON.stringify(prompt))
}

export async function readCapturedAcpPrompt(scriptDir: string, name: string): Promise<PromptRequest["prompt"]> {
  return JSON.parse(await fs.readFile(captureFile(scriptDir, name), "utf8")) as PromptRequest["prompt"]
}
