import { existsSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { PromptRequest } from "@agentclientprotocol/sdk"

const HANDOFF_FAULT = "drop-handoff"

export function dropAcpHandoff(dir: string) {
  writeFileSync(path.join(dir, HANDOFF_FAULT), "drop")
}

export function deliveredAcpPrompt(prompt: PromptRequest["prompt"], dir: string): PromptRequest["prompt"] {
  if (existsSync(path.join(dir, HANDOFF_FAULT))) {
    return prompt.filter((block) => block.type !== "text" || !block.text.includes("<session-handoff"))
  }
  if (process.env.H11_DROP_ACP_IMAGE !== "1") return prompt
  return prompt.filter((block) => block.type !== "image")
}
