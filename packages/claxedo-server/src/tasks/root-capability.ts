import {
  crossMachineWritesOff,
  type CrossMachineWrites,
} from "@claxedo/server-core/platform/auth/cross-machine-writes"
import {
  workspaceRuntimeMcpToolGroupsEnv,
  workspaceRuntimeTasksCapabilityEnv,
} from "@claxedo/server-core/hosts/workspace-runtime/env"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { TasksCapabilityScope, TasksOperation } from "@claxedo/server-core/tasks-host/capability"
import { mintTasksCapability } from "./capability"

export type TasksRootIdentity = Omit<TasksCapabilityScope, "operations">

export type TasksRootCapabilityInput = Readonly<{
  /** Where the runtime signing key lives; the same one the gateway tokens are signed with. */
  signingEnv: Record<string, string | undefined>
  crossMachineWrites?: CrossMachineWrites
  ttlSeconds?: number
  /**
   * The first-party tool groups this root's project turned on.
   *
   * Required, not optional: the grant exists so the Tasks tools can act, and a
   * root whose project never consented to those tools has nothing to act with.
   * Consent and credential are the same decision, so they are read here once
   * and travel to the sandbox together.
   */
  enabledToolGroups: (root: TasksRootIdentity, auth: SignedControlPlaneAuth) => Promise<readonly string[]>
}>

/** The tool group whose consent the Tasks grant is. */
export const TASKS_TOOL_GROUP = "tasks"

/**
 * The first-party consent and credentials one cloud root's sessions launch
 * with, as environment the sandbox reads.
 *
 * A sandbox has no project route, so what the project consented to has to
 * travel at launch. The tool groups always do; the Tasks grant rides with them
 * only when the Tasks group is among those groups, which is what makes the
 * consent and the capability a single act rather than a switch that hides
 * tools a session still holds a token for.
 *
 * Within a minted grant, reading and creating tasks stay inside the root's own
 * project, so every root gets them. Starting a task puts work on a machine
 * this session is not, which is what the account setting governs — so `start`
 * is absent from the scope rather than granted and refused later.
 */
export function createTasksRootCapability(input: TasksRootCapabilityInput) {
  const crossMachineWrites = input.crossMachineWrites ?? crossMachineWritesOff
  return async (root: TasksRootIdentity, auth: SignedControlPlaneAuth): Promise<Record<string, string>> => {
    const groups = await input.enabledToolGroups(root, auth)
    const environment = workspaceRuntimeMcpToolGroupsEnv(groups)
    if (!groups.includes(TASKS_TOOL_GROUP)) return environment
    const operations: TasksOperation[] = ["read", "create"]
    if (await crossMachineWrites({ userId: root.userId, orgId: root.orgId })) operations.push("start")
    const minted = await mintTasksCapability(
      { ...root, operations },
      input.signingEnv,
      input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds },
    )
    return {
      ...environment,
      ...workspaceRuntimeTasksCapabilityEnv({ token: minted.token, operations, projectId: root.projectId }),
    }
  }
}
