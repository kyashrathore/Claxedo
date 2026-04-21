/**
 * Append-only in-memory audit log of agent-initiated browser tool calls.
 *
 * Unit 4 wires `browser_screenshot` / `browser_evaluate_js` / `browser_navigate`
 * tool calls to also append to this log — downstream, the bound session shows
 * each entry as a system message so the user can *see* every agent-side action
 * (prompt-injection audit trail).
 *
 * Keeping this as a process-local, in-memory ring for now is deliberate: it
 * must never block a tool call, and a desktop crash is cheap to recover from
 * (re-running the agent will re-log). Durable persistence can move to sqlite
 * later (see project_bun_migration / server-side stores).
 */

export const MAX_AUDIT_ENTRIES = 500

export type AgentAuditAction = "screenshot" | "evaluate" | "navigate" | "console-read"

export type AgentAuditResult = "allowed" | "denied"

export type AgentAuditEntry = {
  id: number
  /** `Date.now()` at append time. */
  time: number
  paneId: string
  action: AgentAuditAction
  /** Short user-visible summary, e.g. the URL for a navigate, the expression prefix for evaluate. */
  summary: string
  result: AgentAuditResult
  /** Denial reason code or runtime error message, if any. */
  reason?: string
}

export type AgentAuditEntryInput = Omit<AgentAuditEntry, "id" | "time"> & {
  time?: number
}

export type AgentAuditListener = (entry: AgentAuditEntry) => void

export class AgentAuditLog {
  #entries: AgentAuditEntry[] = []
  #nextId = 1
  #cap: number
  #listeners: Set<AgentAuditListener> = new Set()

  constructor(cap = MAX_AUDIT_ENTRIES) {
    this.#cap = cap
  }

  get size(): number {
    return this.#entries.length
  }

  append(input: AgentAuditEntryInput): AgentAuditEntry {
    const entry: AgentAuditEntry = {
      id: this.#nextId++,
      time: input.time ?? Date.now(),
      paneId: input.paneId,
      action: input.action,
      summary: input.summary,
      result: input.result,
      reason: input.reason,
    }
    this.#entries.push(entry)
    if (this.#entries.length > this.#cap) {
      const overflow = this.#entries.length - this.#cap
      this.#entries.splice(0, overflow)
    }
    for (const fn of this.#listeners) {
      try {
        fn(entry)
      } catch {
        // Listeners must not break the append path.
      }
    }
    return entry
  }

  snapshot(): AgentAuditEntry[] {
    return this.#entries.slice()
  }

  forPane(paneId: string): AgentAuditEntry[] {
    return this.#entries.filter((e) => e.paneId === paneId)
  }

  subscribe(fn: AgentAuditListener): () => void {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  clear(): void {
    this.#entries.length = 0
  }
}

// Singleton — Unit 4 consumers import `agentAuditLog` directly.
export const agentAuditLog = new AgentAuditLog()
