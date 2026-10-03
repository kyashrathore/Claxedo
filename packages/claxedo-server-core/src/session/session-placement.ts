export type SessionPlacement = "durable-object" | "runtime"

/** Pi on a cloud workspace runs in its own Durable Object; every other session runs in the workspace's runtime. */
export function sessionPlacement(input: { backing: "cloud-vm" | "local-worktree"; harnessId: string }): SessionPlacement {
  return input.backing === "cloud-vm" && input.harnessId === "pi" ? "durable-object" : "runtime"
}
