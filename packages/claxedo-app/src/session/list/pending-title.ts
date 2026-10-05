import { promptTitle } from "@claxedo/agent-runtime-contract"

export function pendingTitle(title: string | undefined, prompt: string | undefined): string {
  return title || promptTitle(prompt ?? "")
}
