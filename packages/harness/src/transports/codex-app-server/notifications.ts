import { asRecordOrEmpty, asString } from "@claxedo/helpers/guards"
import type { Entry } from "./entry"
import { CodexEvents, publishCodexQuota } from "./events"
import { snapshotFromCodexGoal } from "./goals"
import { codexChildFrame, observeNativeChildren } from "./native-children"
import { admitCodexProviderTurn } from "./provider-turn"
import type { RpcMessage } from "./rpc"
import { incorporatedSteer } from "./turn"
import type { ThreadOwnership } from "./usage"

function usageOwnership(entry: Entry, threadId: string | undefined): ThreadOwnership {
  if (!threadId) return "unknown"
  if (entry.children.has(threadId)) return "owned"
  if (threadId === entry.session.binding.upstreamSessionId) return parentRunning(entry) ? "owned" : "detached"
  return entry.sideThreads.has(threadId) ? "side" : "unknown"
}

function observeUsage(entry: Entry, message: RpcMessage): void {
  const { usage, unbilled } = entry.usage.observe(message, usageOwnership(entry, asString(asRecordOrEmpty(message.params).threadId)))
  if (usage) entry.broker.meter(usage)
  if (unbilled) void entry.broker.publish({ type: "diagnostic", diagnostic: { code: "codex.usage_unbilled", severity: "warn", source: "codex.app-server",
    method: "thread/tokenUsage/updated", message: `Codex reported usage for thread ${unbilled}, which no turn of this session can be billed for` } })
    .catch((error: unknown) => entry.broker.reportFailure(error))
}

export function codexNotificationOutsideTurn(entry: Entry, message: RpcMessage): void {
  const params = asRecordOrEmpty(message.params)
  entry.terminals.observe(message)
  observeNativeChildren(entry, message)
  observeUsage(entry, message)
  if (message.method === "account/rateLimits/updated") {
    if (entry.state !== "busy" && !entry.providerTurn) {
      void publishCodexQuota(entry.broker, entry.session.binding.upstreamSessionId, message)
        .catch((error: unknown) => entry.broker.reportFailure(error))
    }
    return
  }
  const threadId = asString(params.threadId)
  const child = entry.children.get(threadId)
  if (child) {
    codexChildFrame(entry, child, message)
    return
  }
  if (threadId === entry.session.binding.upstreamSessionId) sessionThreadNotification(entry, message)
}

function parentRunning(entry: Entry): boolean {
  return entry.state === "busy" || entry.providerTurn !== undefined
}

function sessionThreadNotification(entry: Entry, message: RpcMessage): void {
  const params = asRecordOrEmpty(message.params)
  if (message.method === "thread/goal/updated" || message.method === "thread/goal/cleared") {
    entry.goal = message.method === "thread/goal/cleared" ? null : snapshotFromCodexGoal(entry.session.binding.sessionId, params.goal)
    void entry.broker.goal.publish(entry.goal).catch((error: unknown) => entry.broker.reportFailure(error))
    return
  }
  const provider = entry.providerTurn
  if (provider) {
    const steered = incorporatedSteer(message, entry.steers)
    if (steered) provider.push(steered)
    for (const event of provider.events.ingest(message)) provider.push(event)
    if (message.method === "turn/completed" && asString(asRecordOrEmpty(params.turn).id) === provider.id) {
      provider.end()
      entry.providerTurn = undefined
    }
    return
  }
  const id = asString(asRecordOrEmpty(params.turn).id)
  const continuation = message.method === "turn/started" && (!entry.turn || (entry.turn.id !== undefined && entry.turn.id !== id))
  if (continuation && entry.goal?.status === "active") {
    admitCodexProviderTurn(entry, message)
    return
  }
  if (entry.state !== "busy" && message.method !== "turn/started") {
    for (const item of new CodexEvents(entry.session.binding.upstreamSessionId).ingest(message)) {
      if (item.event.type === "diagnostic" && item.event.diagnostic.code === "unrecognized-event") {
        void entry.broker.publish(item.event).catch((error: unknown) => entry.broker.reportFailure(error))
      }
    }
  }
}
