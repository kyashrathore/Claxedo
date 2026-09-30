import { asRecordOrEmpty, asString } from "@claxedo/helpers/guards"
import type { Entry } from "./entry"
import { CodexEvents, publishCodexQuota } from "./events"
import { snapshotFromCodexGoal } from "./goals"
import { admitCodexProviderTurn } from "./provider-turn"
import type { RpcMessage } from "./rpc"
import type { ThreadOwnership } from "./usage"

function observeUsage(entry: Entry, message: RpcMessage): void {
  const threadId = asString(asRecordOrEmpty(message.params).threadId)
  const streaming = entry.state === "busy" || entry.providerTurn !== undefined
  const ownership: ThreadOwnership = !threadId ? "unknown"
    : threadId === entry.session.binding.upstreamSessionId || entry.children.has(threadId) ? (streaming ? "owned" : "detached")
      : entry.sideThreads.has(threadId) ? "side" : "unknown"
  const { usage, unbilled } = entry.usage.observe(message, ownership)
  if (usage) entry.broker.meter(usage)
  if (unbilled) void entry.broker.publish({ type: "diagnostic", diagnostic: { code: "codex.usage_unbilled", severity: "warn", source: "codex.app-server",
    method: "thread/tokenUsage/updated", message: `Codex reported usage for thread ${unbilled}, which no turn of this session can be billed for` } })
    .catch((error: unknown) => entry.broker.reportFailure(error))
}

export function codexNotificationOutsideTurn(entry: Entry, message: RpcMessage): void {
  const params = asRecordOrEmpty(message.params)
  entry.terminals.observe(message)
  observeUsage(entry, message)
  if (message.method === "account/rateLimits/updated") {
    if (entry.state !== "busy" && !entry.providerTurn) {
      void publishCodexQuota(entry.broker, entry.session.binding.upstreamSessionId, message)
        .catch((error: unknown) => entry.broker.reportFailure(error))
    }
    return
  }
  const threadId = asString(params.threadId)
  const child = threadId ? entry.children.get(threadId) : undefined
  if (threadId && child) {
    if (entry.providerTurn) for (const event of child.ingest(message)) entry.providerTurn.queue.push({ ...event, route: { kind: "child", correlationKey: threadId } })
    return
  }
  if (threadId === entry.session.binding.upstreamSessionId) sessionThreadNotification(entry, message)
}

function sessionThreadNotification(entry: Entry, message: RpcMessage): void {
  const params = asRecordOrEmpty(message.params)
  if (message.method === "thread/goal/updated" || message.method === "thread/goal/cleared") {
    entry.goal = message.method === "thread/goal/cleared" ? null : snapshotFromCodexGoal(entry.session.binding.sessionId, params.goal)
    void entry.broker.goal.publish(entry.goal).catch((error: unknown) => entry.broker.reportFailure(error))
    return
  }
  if (entry.providerTurn) {
    const events = entry.providerTurn.events.ingest(message)
    for (const event of events) entry.providerTurn.queue.push(event)
    if (message.method === "turn/completed" && asString(asRecordOrEmpty(params.turn).id) === entry.providerTurn.id) {
      entry.providerTurn.queue.end()
      entry.providerTurn = undefined
    }
    return
  }
  if (entry.state !== "busy" && message.method !== "turn/started") {
    for (const item of new CodexEvents(entry.session.binding.upstreamSessionId).ingest(message)) {
      if (item.event.type === "diagnostic" && item.event.diagnostic.code === "unrecognized-event") {
        void entry.broker.publish(item.event).catch((error: unknown) => entry.broker.reportFailure(error))
      }
    }
  }
  if (message.method !== "turn/started" || entry.state === "busy" || entry.goal?.status !== "active") return
  admitCodexProviderTurn(entry, message)
}
