import { Hono } from "hono"
import { parseAgentPluginRuntimeApplyRequest } from "../runtime/runtime-contribution"
import type { LocalAgentPluginsComposition, SignedAgentPluginRuntime } from "../local-composition"

const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,127}$/
const MAX_SECRETS = 256

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function secrets(value: unknown): SignedAgentPluginRuntime["secrets"] | undefined {
  if (!Array.isArray(value) || value.length > MAX_SECRETS) return undefined
  const result: Array<{ name: string; value: string }> = []
  for (const entry of value) {
    if (!record(entry)
      || typeof entry.name !== "string"
      || !SECRET_NAME.test(entry.name)
      || typeof entry.value !== "string"
      || !entry.value) return undefined
    result.push({ name: entry.name, value: entry.value })
  }
  return result
}

/**
 * Loopback control surface for the signed world.
 *
 * Electron main is the only intended caller: it pulls the signed user's
 * runtime from the control plane with the account credential it alone holds
 * and pushes the result here, because the DAEMON owns the machine's runtimes
 * and harness launch. The body is the control plane's `GET /runtime/self`
 * answer verbatim — the same apply request a cloud VM receives — plus the
 * gateway credentials the VM would have had brokered. `null` withdraws the
 * signed world (sign-out), and the machine world launches again. Reachability
 * is the daemon's existing loopback gate, like `/api/claxedo/host-serving`.
 */
export function SignedAgentPluginRuntimeRoutes(signed: LocalAgentPluginsComposition["signedRuntime"]) {
  return new Hono()
    .get("/", (c) => c.json(signed.state()))
    .put("/", async (c) => {
      const raw: unknown = await c.req.json().catch(() => undefined)
      if (raw === null) return c.json(await signed.clear())
      const request = parseAgentPluginRuntimeApplyRequest(raw)
      const carried = record(raw) ? secrets(raw.secrets) : undefined
      if (!request || !carried) {
        return c.json({ error: { code: "agent_plugins_signed_runtime_invalid", message: "signed runtime failed validation" } }, 400)
      }
      try {
        return c.json(await signed.apply({ ...request, secrets: carried }))
      } catch (cause) {
        return c.json({
          error: {
            code: "agent_plugins_signed_runtime_apply_failed",
            message: cause instanceof Error ? cause.message : String(cause),
          },
        }, 500)
      }
    })
}
