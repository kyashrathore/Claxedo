/**
 * The Node server's single PostHog client. Product analytics and error tracking
 * share it (observability/node.ts registers the error seam's sink over this
 * same client), so there is one connection, one flush schedule, and one
 * shutdown path.
 *
 * Key absent ⇒ no client is constructed and nothing is sent. That branch is the
 * self-host promise, not an optimization.
 */

import { PostHog } from "posthog-node"
import { resolveTelemetryHost, resolveTelemetryKey, type ObservabilityEnv } from "./observability/config"

let client: PostHog | null = null

export function initPostHog(env: ObservabilityEnv = process.env): PostHog | null {
  const key = resolveTelemetryKey(env)
  if (!key) return null
  if (client) return client
  client = new PostHog(key, {
    host: resolveTelemetryHost(env),
    flushAt: 20,
    flushInterval: 10000,
  })
  return client
}

export function getPostHog(): PostHog | null {
  return client
}

export async function shutdownPostHog() {
  if (!client) return
  await client.shutdown()
  client = null
}

export function capture(distinctId: string, event: string, properties?: Record<string, unknown>) {
  client?.capture({ distinctId, event, properties })
}
