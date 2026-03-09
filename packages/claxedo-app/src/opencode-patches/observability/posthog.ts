import posthog from "posthog-js"

const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined
const POSTHOG_HOST = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) || "https://us.i.posthog.com"

let initialized = false

export function initPostHog(): void {
  if (!POSTHOG_KEY || initialized) return

  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: true,
    persistence: "localStorage",
    disable_session_recording: true,
  })

  initialized = true
}

export function identifyUser(userId: string, properties?: Record<string, any>): void {
  if (!initialized) return
  posthog.identify(userId, properties)
}

export function resetUser(): void {
  if (!initialized) return
  posthog.reset()
}

export function capture(event: string, properties?: Record<string, any>): void {
  if (!initialized) return
  posthog.capture(event, properties)
}

export function setUserProperties(properties: Record<string, any>): void {
  if (!initialized) return
  posthog.people.set(properties)
}

export function shutdownPostHog(): void {
  if (!initialized) return
  posthog.reset()
  initialized = false
}

export { posthog }
