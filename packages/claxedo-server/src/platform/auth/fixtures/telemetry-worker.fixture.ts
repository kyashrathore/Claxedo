import { Hono } from "hono"
import { keepAlivePastResponse } from "@claxedo/server-core/platform/http/background-work"
import { workerTelemetry } from "../worker-telemetry"

/**
 * The hosted core's telemetry shape, small enough to boot under workerd: the
 * sink, the keep-alive flush after every response, a route whose background
 * work captures after the response, and a plain route. Each flush records how
 * long it took to settle, so a test can see one that never does.
 */
const telemetry = workerTelemetry({ CLAXEDO_TELEMETRY_MODE: "on", CLAXEDO_POSTHOG_KEY: "phc_fixture", CLAXEDO_POSTHOG_HOST: "https://analytics.fixture.test" })
const flushes: Array<{ id: string; ms: number }> = []

const app = new Hono()
  .use(async (c, next) => {
    await next()
    const id = c.req.query("id")
    if (!id) return
    const begun = Date.now()
    keepAlivePastResponse(c, telemetry.flush!().then(() => { flushes.push({ id, ms: Date.now() - begun }) }))
  })
  .get("/background", (c) => {
    const id = c.req.query("id") ?? ""
    keepAlivePastResponse(c, new Promise((resolve) => setTimeout(resolve, 50)).then(() => telemetry.capture("system", "background.done", { id })))
    return c.json({ ok: true })
  })
  .get("/plain", (c) => {
    telemetry.capture("user_1", "plain.hit", { id: c.req.query("id") ?? "" })
    return c.json({ ok: true })
  })
  .get("/flushes", (c) => c.json(flushes))

export default app
