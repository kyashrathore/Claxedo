import type { PromptRequest } from "@agentclientprotocol/sdk"

export function deliveredAcpPrompt(prompt: PromptRequest["prompt"]): PromptRequest["prompt"] {
  if (process.env.H11_DROP_ACP_IMAGE !== "1") return prompt
  return prompt.filter((block) => block.type !== "image")
}
