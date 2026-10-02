import { asRecord } from "@claxedo/helpers/guards"
import { asText as text } from "@claxedo/agent-runtime-contract"
import type { CodexHandlers } from "./frame"
import { harnessNotice } from "./notices"

function spoken(entries: unknown) {
  return (Array.isArray(entries) ? entries : []).flatMap((value) => {
    const entry = asRecord(value)
    return entry && entry.kind !== "context" ? text(entry.text) ?? [] : []
  })
}

export const hookHandlers: CodexHandlers = {
  "hook/started": () => [],
  "hook/completed": ({ row }) => {
    const run = asRecord(row.run) ?? {}
    const status = text(run.status) ?? "completed"
    const said = [text(run.statusMessage), ...spoken(run.entries)].flatMap((value) => value ?? [])
    if (status === "completed" && said.length === 0) return []
    const eventName = text(run.eventName) ?? "Codex"
    return [harnessNotice({
      code: `codex_app_server.hook_${status}`,
      message: `${eventName} hook ${status}${said.length ? `: ${said.join("\n")}` : ""}`,
      severity: status === "completed" ? "info" : "warn",
      details: { hookRunId: text(run.id), eventName, status },
    })]
  },
}
