import path from "node:path"
import type { Stack } from "./stack"

export function ownerPiAgentDir(stack: Pick<Stack, "dataDir">) {
  return path.join(stack.dataDir, ".pi", "agent")
}
