import type { Machine } from "@/lib/machine"
import type { Server, SessionReaderCommand, SessionRow } from "@/server"
import type { SessionList } from "@/session"
import type { ListEvent, ListState } from "./model"

export function createReaderActions(server: Server, list: Machine<ListState, ListEvent>, reload: () => Promise<void>): Pick<SessionList, "settle" | "returnToActive" | "markSeen"> {
  const write = async (row: SessionRow, command: SessionReaderCommand) => {
    const reader = await server.sessions.reader(row.ref, command)
    list.send({ type: "rowRead", row: { ...row, reader } })
    await reload()
  }
  const facts = (row: SessionRow) => {
    if (!row.attention) throw new Error("Session activity is unavailable")
    return row.attention
  }
  return {
    settle: (row) => {
      const attention = facts(row)
      return write(row, { kind: "settle", generation: attention.generation, activitySequence: attention.activitySequence, outcomeSequence: attention.outcome?.sequence, revision: row.reader?.generation === attention.generation ? row.reader.revision : 0 })
    },
    returnToActive: (row) => write(row, { kind: "return", generation: facts(row).generation, revision: row.reader?.generation === facts(row).generation ? row.reader.revision : 0 }),
    markSeen: async (row) => {
      const attention = facts(row)
      if (!attention.outcome || attention.outcome.sequence <= (row.reader?.generation === attention.generation ? row.reader.seenThrough : 0)) return
      await write(row, { kind: "seen", generation: attention.generation, outcomeSequence: attention.outcome.sequence })
    },
  }
}
