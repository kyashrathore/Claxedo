import { expect, test } from "vitest"
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
