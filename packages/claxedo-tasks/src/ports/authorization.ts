import type { SessionReference, TasksActor } from "../contracts"

/**
 * Project and session authority stay with the host. Presets are personal and
 * never reach this port: their owner check is `ownerId` equality inside the
 * actor's scope, decided by the preset service.
 */
export type TasksAuthorizationPort = {
  authorizeProject(actor: TasksActor, projectId: string, access: "read" | "write"): Promise<boolean>
  /** Whether this actor may open the linked session, independent of preset ownership. */
  authorizeSessionOpen(actor: TasksActor, session: SessionReference): Promise<boolean>
}
