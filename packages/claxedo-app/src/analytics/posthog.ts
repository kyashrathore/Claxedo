let initialized = false
let ready = false
let posthog: typeof import("posthog-js").default | undefined
let posthogp: Promise<typeof import("posthog-js").default | undefined> | undefined
const queue: Array<(client: typeof import("posthog-js").default) => void> = []

function loadPostHog() {
  if (import.meta.env.DEV) return Promise.resolve(undefined)
  if (posthog) return Promise.resolve(posthog)
  return (posthogp ??= import("posthog-js").then((mod) => {
    posthog = mod.default
    return posthog
  }))
}

function flush() {
  if (!ready || !posthog || queue.length === 0) return
  const next = queue.splice(0)
  for (const run of next) run(posthog)
}

function enqueue(run: (client: typeof import("posthog-js").default) => void) {
  if (!initialized) return
  if (ready && posthog) {
    run(posthog)
    return
  }
  queue.push(run)
}

export function initPostHog() {
  // Never send analytics from dev builds
  if (import.meta.env.DEV) return
  const key = import.meta.env.VITE_POSTHOG_KEY
  if (!key || initialized) return
  initialized = true
  void loadPostHog().then((client) => {
    if (!client) return
    client.init(key, {
      api_host: import.meta.env.VITE_POSTHOG_HOST ?? "https://app.posthog.com",
      person_profiles: "identified_only",
      capture_pageview: false,
      // Replaces Sentry: automatically captures unhandled exceptions and
      // promise rejections, visible under PostHog → Error Tracking
      capture_exceptions: true,
    })
    ready = true
    flush()
  })
}

export function capture(event: string, properties?: Record<string, unknown>) {
  enqueue((client) => client.capture(event, properties))
}

export function identify(distinctId: string, properties?: Record<string, unknown>) {
  enqueue((client) => client.identify(distinctId, properties))
}

/** Replaces Sentry.captureException — use for caught errors you want to track */
export function captureException(error: unknown, properties?: Record<string, unknown>) {
  enqueue((client) => client.captureException(error, properties))
}
