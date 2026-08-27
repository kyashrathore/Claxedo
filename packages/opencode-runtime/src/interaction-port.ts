/**
 * Pending human interactions: permission requests and forms.
 *
 * V1 exposed two different ad-hoc shapes ("questions" answered with a string,
 * permissions answered by id) and the adapter carried both plus a fallback
 * path for ids that could not be routed. V2 has one shape for each and both
 * are workspace-scoped lists with session-scoped replies:
 *
 *   permission.request.list({ location })  ->  permission.reply({ sessionID, requestID, reply, message? })
 *   form.request.list({ location })        ->  form.reply({ sessionID, formID, answer })
 *                                              form.cancel({ sessionID, formID })
 *
 * `answer` is a structured record, not a string. That is what lets Claxedo's
 * harness-neutral question reply carry real form values (R5) instead of
 * stringifying them at the boundary and losing types.
 */
import type { OpenCodeHost } from "./host"
import { assertLocationInScope, type WorkspaceScope } from "./scope"

export type PermissionRequest = Readonly<{
  id: string
  sessionID: string
  type?: string
  title?: string
  metadata?: Readonly<Record<string, unknown>>
  createdAt?: number
}>

/** V2 accepts exactly these three; anything else is a caller bug, not a string. */
export type PermissionReply = "once" | "always" | "reject"

export type FormFieldValue = string | number | boolean | readonly string[]

export type FormRequest = Readonly<{
  id: string
  sessionID: string
  title?: string
  fields?: readonly unknown[]
  createdAt?: number
}>

export type OpenCodeInteractionPort = Readonly<{
  permissions(scope: WorkspaceScope): Promise<readonly PermissionRequest[]>
  replyPermission(
    scope: WorkspaceScope,
    input: { sessionID: string; requestID: string; reply: PermissionReply; message?: string },
  ): Promise<void>
  forms(scope: WorkspaceScope): Promise<readonly FormRequest[]>
  replyForm(
    scope: WorkspaceScope,
    input: { sessionID: string; formID: string; answer: Readonly<Record<string, FormFieldValue>> },
  ): Promise<void>
  cancelForm(scope: WorkspaceScope, input: { sessionID: string; formID: string }): Promise<void>
}>

function rows(response: unknown): readonly Record<string, unknown>[] {
  const data = (response as { data?: unknown }).data
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : []
}

function createdAt(row: Record<string, unknown>): number | undefined {
  const time = row.time as { created?: unknown } | undefined
  if (typeof time?.created === "number") return time.created
  return typeof row.timeCreated === "number" ? row.timeCreated : undefined
}

export function createInteractionPort(host: OpenCodeHost): OpenCodeInteractionPort {
  /**
   * Replies take a bare `sessionID`, so ownership must be proven the same way
   * the session port proves it — otherwise one workspace can answer another's
   * permission prompt.
   */
  async function assertOwned(scope: WorkspaceScope, sessionID: string) {
    const client = await host.client()
    const session = await client.sessions.get({ sessionID })
    assertLocationInScope(scope, (session as { location?: { directory?: string } }).location?.directory)
  }

  return {
    async permissions(scope) {
      const client = await host.client()
      const response = await client.permission.request.list({ location: { directory: scope.directory } })
      return rows(response).map((row) => {
        const at = createdAt(row)
        return {
          id: String(row.id ?? row.requestID),
          sessionID: String(row.sessionID),
          ...(typeof row.type === "string" ? { type: row.type } : {}),
          ...(typeof row.title === "string" ? { title: row.title } : {}),
          ...(row.metadata === undefined ? {} : { metadata: row.metadata as Record<string, unknown> }),
          ...(at === undefined ? {} : { createdAt: at }),
        }
      })
    },

    async replyPermission(scope, input) {
      const client = await host.client()
      await assertOwned(scope, input.sessionID)
      await client.permission.reply({
        sessionID: input.sessionID,
        requestID: input.requestID,
        reply: input.reply,
        ...(input.message === undefined ? {} : { message: input.message }),
      })
    },

    async forms(scope) {
      const client = await host.client()
      const response = await client.form.request.list({ location: { directory: scope.directory } })
      return rows(response).map((row) => {
        const at = createdAt(row)
        return {
          id: String(row.id ?? row.formID),
          sessionID: String(row.sessionID),
          ...(typeof row.title === "string" ? { title: row.title } : {}),
          ...(Array.isArray(row.fields) ? { fields: row.fields as readonly unknown[] } : {}),
          ...(at === undefined ? {} : { createdAt: at }),
        }
      })
    },

    async replyForm(scope, input) {
      const client = await host.client()
      await assertOwned(scope, input.sessionID)
      await client.form.reply({
        sessionID: input.sessionID,
        formID: input.formID,
        answer: input.answer as never,
      })
    },

    async cancelForm(scope, input) {
      const client = await host.client()
      await assertOwned(scope, input.sessionID)
      await client.form.cancel({ sessionID: input.sessionID, formID: input.formID })
    },
  }
}
