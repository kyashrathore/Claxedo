/**
 * Loopback control surface for the provider rows the owner pushed to this
 * machine.
 *
 * Electron main is the only intended caller: the connector child opens the
 * control plane's sealed revision and main forwards the text here, because
 * the daemon owns the workspace runtimes whose turns resolve credentials.
 *
 * There is no caller credential, only the daemon's local gate — the same
 * protection its sibling `/api/claxedo/host-serving` relies on, and
 * `host-serving/src/surface.ts` denies the whole `/api/claxedo` prefix to a
 * relayed caller, so this is reachable from local processes alone. What such a
 * process can do with it is worth stating plainly: a row carries a `baseUrl`,
 * so it can point every agent turn in this daemon at an endpoint it controls
 * and read the prompts. That is accepted because any local process that can
 * reach this port can already read the daemon's own harness profiles and its
 * data directory; a credential held on the same machine would gate nothing it
 * could not lift. What is NOT accepted is a rollback, which a stolen blob
 * would otherwise make free: a revision below the held one is refused.
 *
 * The body's `providers` is the sealed payload's plaintext VERBATIM — the
 * `{"version":1,"providers":{...}}` text `serializeHostProviderConfig` wrote
 * at the control plane — and it is validated with the same reader the
 * runtime applies rows with, so a row that would be refused on a turn is
 * refused on arrival, with nothing held from the revision that carried it.
 */

import { Hono } from "hono"
import { z } from "zod"
import {
  HostProviderConfigStaleError,
  hostProviderConfigState,
  installHostProviderConfigRevision,
} from "./host-provider-config"

const providerConfigBody = z
  .object({
    revision: z.number().int().nonnegative(),
    providers: z.string().max(64_000),
  })
  .strict()

export function HostProviderConfigRoutes() {
  return new Hono()
    .get("/", (c) => c.json(hostProviderConfigState()))
    .put("/", async (c) => {
      const parsed = providerConfigBody.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) {
        return c.json({ error: { code: "invalid_request_body", message: "provider configuration failed validation" } }, 400)
      }
      try {
        return c.json(installHostProviderConfigRevision(parsed.data))
      } catch (error) {
        if (error instanceof HostProviderConfigStaleError) {
          return c.json({ error: { code: "provider_config_revision_stale", message: error.message } }, 409)
        }
        return c.json(
          { error: { code: "invalid_provider_config", message: error instanceof Error ? error.message : String(error) } },
          400,
        )
      }
    })
}
