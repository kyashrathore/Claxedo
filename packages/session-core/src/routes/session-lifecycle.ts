/** What a host contribution does at a session's turn and delete boundaries, run in contribution order. */
export type SessionLifecycleHooks = Readonly<{
  /** After a turn delivered as "start" settles. A failure is logged and never fails the turn. */
  turnSettled?: (sessionId: string) => Promise<void>
  /** Before a session is deleted. A failure keeps the session. */
  beforeSessionDelete?: (sessionId: string) => Promise<void>
}>

export async function settleSessionTurn(hooks: readonly SessionLifecycleHooks[] | undefined, sessionId: string): Promise<void> {
  for (const hook of hooks ?? []) {
    try {
      await hook.turnSettled?.(sessionId)
    } catch (error) {
      console.error(`[session-lifecycle] end-of-turn work failed for ${sessionId}:`, error)
    }
  }
}

export async function prepareSessionDelete(hooks: readonly SessionLifecycleHooks[] | undefined, sessionId: string): Promise<void> {
  for (const hook of hooks ?? []) await hook.beforeSessionDelete?.(sessionId)
}
