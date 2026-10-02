import { expect, test } from "vitest"
import type { ReaderSettings } from "@claxedo/agent-runtime-contract"
import { exerciseToolHeaderReads, toolHeaderTranscript } from "@claxedo/server-core/platform/auth/turn-page.conformance"
import { syncTranscript } from "@claxedo/server-core/platform/auth/stored-transcript.conformance"
import { miniflareControlPlaneDatabase } from "../../test-support/control-plane-migrations"
import { storedD1Session } from "../../test-support/d1-stored-session"
import { createSessionReadRoutes, authoritySessionReads } from "./session-read"

test("the D1 read port exposes the stored ordinal on replay, message pages and latest views", async () => {
  const controlPlane = await miniflareControlPlaneDatabase()
  const { database } = controlPlane
  try {
    const { auth, sessions } = await storedD1Session(database)
    await database.prepare("update sessions set max_event_ordinal = 73 where session_id = 'ses'").run()
    const app = createSessionReadRoutes({ authenticate: async () => auth, reads: authoritySessionReads(sessions) })
    for (const query of ["", "&limit=2", "&view=latest-turn"]) {
      const response = await app.request(`/sessions/ses/messages?workspaceId=ws${query}`)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ messages: [], maxEventOrdinal: 73 })
    }
  } finally {
    await controlPlane.dispose()
  }
})

test("every D1 read sends a tool as its header, and whole only when the reader's shell or edit setting opens it", async () => {
  const controlPlane = await miniflareControlPlaneDatabase()
  try {
    const { auth, sessions } = await storedD1Session(controlPlane.database)
    const transcript = toolHeaderTranscript("ses")
    await syncTranscript({
      authority: sessions,
      workspaceId: "ws",
      creator: { auth, runtime: { principalKind: "user", actorId: auth.principal!.actorId, actorKind: "human" } },
    }, "ses", transcript)
    const app = createSessionReadRoutes({ authenticate: async () => auth, reads: authoritySessionReads(sessions) })
    const settings = (reader: ReaderSettings) => `reasoning=${Number(reader.reasoning)}&shell=${Number(reader.shell)}&edit=${Number(reader.edit)}`
    const read = async (path: string) => {
      const response = await app.request(`/sessions/ses/${path}&workspaceId=ws`)
      expect(response.status, path).toBe(200)
      return await response.json()
    }
    await exerciseToolHeaderReads({
      first: async (reader) => (await read(`outline?rows=40&cols=100&${settings(reader)}`)).page,
      page: async (reader, before) => await read(`page?rows=40&cols=100&${settings(reader)}&before=${before}`),
    }, transcript)
  } finally {
    await controlPlane.dispose()
  }
})
