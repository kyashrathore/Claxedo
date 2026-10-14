import { cloudHarnessHost } from "@claxedo/agent-runtime-contract"

export type SessionPlacement = "durable-object" | "runtime"

export function sessionPlacement(input: { backing: "cloud-vm" | "local-worktree"; harnessId: string }): SessionPlacement {
  return input.backing === "cloud-vm" && cloudHarnessHost(input.harnessId) === "session-host" ? "durable-object" : "runtime"
}
