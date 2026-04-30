import { PostHog } from "posthog-node"

let client: PostHog | null = null

export function initPostHog(): PostHog | null {
  const key = process.env.POSTHOG_KEY
  if (!key) return null
  if (client) return client
  client = new PostHog(key, {
    host: process.env.POSTHOG_HOST ?? "https://app.posthog.com",
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
