import { engineRead } from "./engine-read.js"
import type { OpenCodeHost } from "./host.js"
import { assertLocationInScope, type WorkspaceScope } from "./scope.js"
import { asArrayOrUndefined as arr, asNumber as num, asRecord as rec } from "@claxedo/helpers/guards"

export type PermissionRequest = Readonly<{
  id: string
  sessionID: string
  type?: string
  title?: string
  metadata?: Readonly<Record<string, unknown>>
  createdAt?: number
}>

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
  permissions(scope: WorkspaceScope, sessionID: string): Promise<readonly PermissionRequest[]>
  replyPermission(
    scope: WorkspaceScope,
    input: { sessionID: string; requestID: string; reply: PermissionReply; message?: string },
  ): Promise<void>
  forms(scope: WorkspaceScope, sessionID: string): Promise<readonly FormRequest[]>
  replyForm(
    scope: WorkspaceScope,
    input: { sessionID: string; formID: string; answer: Readonly<Record<string, FormFieldValue>> },
  ): Promise<void>
  cancelForm(scope: WorkspaceScope, input: { sessionID: string; formID: string }): Promise<void>
}>

function rows(response: unknown): readonly Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const row of arr(response) ?? []) {
    const item = rec(row)
    if (item) out.push(item)
  }
  return out
}

function createdAt(row: Record<string, unknown>): number | undefined {
  return num(rec(row.time)?.created) ?? num(row.timeCreated)
}

async function assertOwned(host: OpenCodeHost, scope: WorkspaceScope, sessionID: string) {
  const client = await host.client()
  const session = await client.sessions.get({ sessionID })
  assertLocationInScope(scope, (session as { location?: { directory?: string } }).location?.directory)
}

async function permissions(host: OpenCodeHost, scope: WorkspaceScope, sessionID: string): Promise<readonly PermissionRequest[]> {
      if (host.status().lifecycle !== "ready") return []
      const client = await host.client()
      await assertOwned(host, scope, sessionID)
      const response = await engineRead("permission.list", scope, () => client.permission.list({ sessionID }))
      return rows(response).map((row) => {
        const at = createdAt(row)
        return {
          id: String(row.id ?? row.requestID),
          sessionID: String(row.sessionID),
          ...(typeof row.type === "string" ? { type: row.type } : {}),
          ...(typeof row.title === "string" ? { title: row.title } : {}),
          ...(row.metadata === undefined ? {} : { metadata: rec(row.metadata) ?? {} }),
          ...(at === undefined ? {} : { createdAt: at }),
        }
      })
}

async function forms(host: OpenCodeHost, scope: WorkspaceScope, sessionID: string): Promise<readonly FormRequest[]> {
      if (host.status().lifecycle !== "ready") return []
      const client = await host.client()
      await assertOwned(host, scope, sessionID)
      const response = await engineRead("form.list", scope, () => client.form.list({ sessionID }))
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
}

export function createInteractionPort(host: OpenCodeHost): OpenCodeInteractionPort {
  return {
    permissions: (scope, sessionID) => permissions(host, scope, sessionID),
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

    forms: (scope, sessionID) => forms(host, scope, sessionID),

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
