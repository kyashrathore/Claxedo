import {
  crossMachineWritesOff,
  type CrossMachineWrites,
} from "@claxedo/server-core/platform/auth/cross-machine-writes"
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
  /** Where the runtime signing key lives; the same one the gateway tokens are signed with. */
  signingEnv: Record<string, string | undefined>
  crossMachineWrites?: CrossMachineWrites
  ttlSeconds?: number
  /** Where each minted grant is written down, so the switch and the workspace's deletion can take it back. */
  passes?: SandboxPassRegister
  now?: () => number
}>

/**
 * The Tasks grant one cloud root's sessions act with.
 *
 * Whether a root is launched with one at all is the provisioning path's
 * decision, made from the project's consent; this only says what the grant
 * holds. Reading and creating tasks stay inside the root's own project, so
 * every grant carries them. Starting a task puts work on a machine this
 * session is not, which is what the account setting governs — so `start` is
 * absent from the scope rather than granted and refused later. Renewal mints
 * through the same reader, which is how `start` follows the setting mid-life.
 */
export function createTasksRootGrant(input: TasksRootCapabilityInput) {
  const crossMachineWrites = input.crossMachineWrites ?? crossMachineWritesOff
  return async (root: TasksRootIdentity): Promise<TasksRootGrant> => {
    const operations: TasksOperation[] = ["read", "create"]
    if (await crossMachineWrites({ userId: root.userId, orgId: root.orgId })) operations.push("start")
    const minted = await mintTasksCapability({ ...root, operations }, input.signingEnv, {
      ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
      ...(input.passes ? { register: input.passes } : {}),
      ...(input.now ? { now: input.now } : {}),
    })
    return { token: minted.token, operations, expiresAt: minted.expiresAt }
  }
}

/** The same grant as environment the sandbox reads at launch. */
export function createTasksRootCapability(input: TasksRootCapabilityInput) {
  const grant = createTasksRootGrant(input)
  return async (root: TasksRootIdentity): Promise<Record<string, string>> => {
    const minted = await grant(root)
    return workspaceRuntimeTasksCapabilityEnv({ token: minted.token, operations: minted.operations, projectId: root.projectId })
  }
}
