import { workspaceRuntimeTasksCapabilityEnv } from "@claxedo/server-core/hosts/workspace-runtime/env"
import type { TasksCapabilityScope, TasksOperation } from "@claxedo/server-core/tasks-host/capability"
import type { SandboxPassRegister } from "../platform/auth/sandbox-pass-register"
import { mintTasksCapability } from "./capability"

export type TasksRootIdentity = Omit<TasksCapabilityScope, "operations">

export type TasksRootGrant = Readonly<{
  token: string
  operations: readonly TasksOperation[]
  expiresAt: number
}>

export type TasksRootCapabilityInput = Readonly<{
  signingEnv: Record<string, string | undefined>
  ttlSeconds?: number
  passes?: SandboxPassRegister
  now?: () => number
}>

export function createTasksRootGrant(input: TasksRootCapabilityInput) {
  return async (root: TasksRootIdentity): Promise<TasksRootGrant> => {
    const operations: TasksOperation[] = ["read", "create"]
    const minted = await mintTasksCapability({ ...root, operations }, input.signingEnv, {
      ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
      ...(input.passes ? { register: input.passes } : {}),
      ...(input.now ? { now: input.now } : {}),
    })
    return { token: minted.token, operations, expiresAt: minted.expiresAt }
  }
}

export function createTasksRootCapability(input: TasksRootCapabilityInput) {
  const grant = createTasksRootGrant(input)
  return async (root: TasksRootIdentity): Promise<Record<string, string>> => {
    const minted = await grant(root)
    return workspaceRuntimeTasksCapabilityEnv({ token: minted.token, operations: minted.operations, projectId: root.projectId })
  }
}
