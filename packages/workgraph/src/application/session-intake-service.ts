import type { ExecutionProfileDefaults, WorkGraphContext } from "../contracts"

export type IdleSession = Readonly<{
  sessionId: string
  title: string
  summary: string
  meaningful: boolean
  becameIdleAt: number
  execution?: ExecutionProfileDefaults
}>

export type SessionIntakePort = Readonly<{
  createUnorganized(
    context: WorkGraphContext,
    input: Readonly<{
      idempotencyKey: string
      sessionId: string
      title: string
      body: string
      observedAt: number
      execution?: ExecutionProfileDefaults
    }>,
  ): Promise<"created" | "existing">
}>

export function createSessionIntakeService(port: SessionIntakePort) {
  return {
    onIdle: async (context: WorkGraphContext, session: IdleSession) => {
      if (!session.meaningful) return "ignored" as const
      return port.createUnorganized(context, {
        idempotencyKey: `idle-session:${session.sessionId}`,
        sessionId: session.sessionId,
        title: session.title,
        body: session.summary,
        observedAt: session.becameIdleAt,
        ...(session.execution ? { execution: session.execution } : {}),
      })
    },
  }
}
