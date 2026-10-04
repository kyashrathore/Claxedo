import type { OpenCodeHost } from "./host.js"
import { assertLocationInScope, type WorkspaceScope } from "./scope.js"

export type PermissionReply = "once" | "always" | "reject"

export type FormFieldValue = string | number | boolean | readonly string[]

export type OpenCodeInteractionPort = Readonly<{
  replyPermission(
    scope: WorkspaceScope,
    input: { sessionID: string; requestID: string; reply: PermissionReply; message?: string },
  ): Promise<void>
  replyForm(
    scope: WorkspaceScope,
    input: { sessionID: string; formID: string; answer: Readonly<Record<string, FormFieldValue>> },
  ): Promise<void>
  cancelForm(scope: WorkspaceScope, input: { sessionID: string; formID: string }): Promise<void>
}>

async function assertOwned(host: OpenCodeHost, scope: WorkspaceScope, sessionID: string) {
  const client = await host.client()
  const session = await client.sessions.get({ sessionID })
  assertLocationInScope(scope, (session as { location?: { directory?: string } }).location?.directory)
}

export function createInteractionPort(host: OpenCodeHost): OpenCodeInteractionPort {
  return {
    async replyPermission(scope, input) {
      const client = await host.client()
      await assertOwned(host, scope, input.sessionID)
      await client.permission.reply({
        sessionID: input.sessionID,
        requestID: input.requestID,
        reply: input.reply,
        ...(input.message === undefined ? {} : { message: input.message }),
      })
    },

    async replyForm(scope, input) {
      const client = await host.client()
      await assertOwned(host, scope, input.sessionID)
      await client.form.reply({
        sessionID: input.sessionID,
        formID: input.formID,
        answer: input.answer,
      })
    },

    async cancelForm(scope, input) {
      const client = await host.client()
      await assertOwned(host, scope, input.sessionID)
      await client.form.cancel({ sessionID: input.sessionID, formID: input.formID })
    },
  }
}
