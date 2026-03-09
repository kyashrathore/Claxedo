import * as Sentry from "@sentry/bun"

const SENTRY_DSN =
  process.env.SENTRY_DSN || "https://2192aa324af989b3ac64c2c6950d04e1@o4509734987694080.ingest.us.sentry.io/4510886124716032"

let initialized = false

export function initSentry(): void {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT || "production",
    release: process.env.SENTRY_RELEASE || undefined,
    tracesSampleRate: 0.1,
    sampleRate: 1.0,
    serverName: process.env.SENTRY_SERVER_NAME || undefined,
    ignoreErrors: [
      "ECONNRESET",
      "EPIPE",
      "ETIMEDOUT",
      "ResizeObserver loop limit exceeded",
    ],
    beforeSend(event) {
      event.tags = {
        ...event.tags,
        client: "desktop-sidecar",
        os_platform: process.platform,
        os_arch: process.arch,
      }
      return event
    },
  })
  initialized = true
}

export async function shutdownSentry(): Promise<void> {
  if (initialized) {
    await Sentry.close(2000)
    initialized = false
  }
}

export function captureException(error: Error, context?: Record<string, any>): void {
  if (!initialized) return
  Sentry.captureException(error, { extra: context })
}

export function captureMessage(message: string, level: "error" | "warning" | "info" = "error"): void {
  if (!initialized) return
  Sentry.captureMessage(message, level)
}

export { Sentry }
