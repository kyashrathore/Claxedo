import {
  crossMachineWritesOff,
  type CrossMachineWrites,
} from "@claxedo/server-core/platform/auth/cross-machine-writes"
import { workspaceRuntimeTasksCapabilityEnv } from "@claxedo/server-core/hosts/workspace-runtime/env"
import type { TasksCapabilityScope, TasksOperation } from "@claxedo/server-core/tasks-host/capability"
import { mintTasksCapability } from "./capability"

export type TasksRootIdentity = Omit<TasksCapabilityScope, "operations">

export type TasksRootCapabilityInput = Readonly<{
  /** Where the runtime signing key lives; the same one the gateway tokens are signed with. */
  signingEnv: Record<string, string | undefined>
  crossMachineWrites?: CrossMachineWrites
  ttlSeconds?: number
}>

/**
 * The grant one cloud root's sessions are launched with.
 *
 * Reading and creating tasks stay inside the root's own project, so every root
 * gets them. Starting a task puts work on a machine this session is not,
 * which is exactly what the account setting governs — so `start` is granted
 * only when that setting says yes, and is simply absent from the scope
 * otherwise rather than granted and refused later.
 */
export function createTasksRootCapability(input: TasksRootCapabilityInput) {
  const crossMachineWrites = input.crossMachineWrites ?? crossMachineWritesOff
  return async (root: TasksRootIdentity): Promise<Record<string, string>> => {
    const operations: TasksOperation[] = ["read", "create"]
    if (await crossMachineWrites({ userId: root.userId, orgId: root.orgId })) operations.push("start")
    const minted = await mintTasksCapability(
      { ...root, operations },
      input.signingEnv,
      input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds },
    )
    return workspaceRuntimeTasksCapabilityEnv({ token: minted.token, operations, projectId: root.projectId })
  }
}
