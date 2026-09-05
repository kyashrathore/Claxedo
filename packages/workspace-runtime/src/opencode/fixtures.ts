import { createOpenCodeHost, type OpenCodeClient } from "./host"

export type OpenCodeFixtureSession = Pick<Parameters<OpenCodeClient["session"]["import"]>[0], "info" | "messages">
export type OpenCodeFixtureReadback = Awaited<ReturnType<OpenCodeClient["session"]["export"]>>

/** Import through the SDK, then reopen to read the durable result. */
export async function importOpenCodeFixtureSessions(
  databasePath: string,
  sessions: OpenCodeFixtureSession[],
): Promise<OpenCodeFixtureReadback[]> {
  const host = createOpenCodeHost({ databasePath, configContent: "{}" })
  try {
    const client = await host.client()
    for (const session of sessions) {
      await client.session.import({ ...session, location: session.info.location })
    }
  } finally {
    await host.close()
  }
  const reader = createOpenCodeHost({ databasePath, configContent: "{}" })
  try {
    const client = await reader.client()
    return await Promise.all(sessions.map((session) => client.session.export({ sessionID: session.info.id })))
  } finally {
    await reader.close()
  }
}

/** Generate benchmark IDs with the exact schema version installed by the SDK. */
export async function createOpenCodeFixtureIds() {
  const { create } = await import("@opencode-ai/schema/identifier")
  return {
    createId(prefix: "ses" | "msg" | "prt", timestamp: number) {
      return `${prefix}_${create(false, timestamp)}`
    },
  }
}
