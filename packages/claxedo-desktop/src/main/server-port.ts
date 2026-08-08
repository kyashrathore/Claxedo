import { createServer } from "node:net"

/**
 * The base port for the local Claxedo server.
 *
 * NOT 3001. That is the default of half the dev tooling on a developer's
 * machine (create-react-app's second tab, Express boilerplate, NestJS, Payload,
 * Directus, Grafana's docker-compose…). Two failure modes came out of it:
 *
 *   1. Packaged: the desktop app loses the race and has to relocate, which was
 *      previously an EPHEMERAL port (see `findFreePort`) — unpredictable for
 *      anything that has to find the server again.
 *   2. Development: the attach probe in `setupServerConnection` health-checks
 *      the base port and treats a hit as "our server is already up". A
 *      *different* project's server answering on 3001 could be adopted as the
 *      Claxedo server.
 *
 * 2593 is "clxd" on a phone keypad (c=2, l=5, x=9, d=3) — memorable, and not a
 * default anything else reaches for.
 *
 * Keep in sync with the standalone server default in
 * `packages/claxedo-server/src/deployments/self-hosted-node/index.ts`. The two must agree or
 * the development attach path breaks: the desktop app probes one port while
 * `claxedo-server dev` listens on another, so every `bun dev` silently gets a
 * second, embedded server instead of attaching to the one already running.
 */
export const DEFAULT_CLAXEDO_SERVER_PORT = 2593

/**
 * How far above the base port the scan will walk before giving up. Every
 * candidate in the window has to be occupied for this to be reached, so a
 * failure here is a real signal (a port-exhausted machine, or something binding
 * a whole range) and not a case worth papering over with a random port.
 */
const PORT_SCAN_WINDOW = 64

export function resolveBaseServerPort(env: NodeJS.ProcessEnv = process.env): number {
  const configured = env.CLAXEDO_SERVER_PORT?.trim()
  if (!configured) return DEFAULT_CLAXEDO_SERVER_PORT
  const parsed = Number(configured)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`CLAXEDO_SERVER_PORT must be a port number between 0 and 65535, got "${configured}"`)
  }
  return parsed
}

function tryListen(port: number, probe: Probe): Promise<number | "in-use"> {
  return probe(port).then(
    (bound) => bound,
    (error: NodeJS.ErrnoException) => {
      // EACCES shows up for privileged ports and for ports the OS has excluded
      // (Windows reserves ranges for Hyper-V). Both mean "not this one" just as
      // much as EADDRINUSE does, so both advance the scan.
      if (error.code === "EADDRINUSE" || error.code === "EACCES") return "in-use" as const
      throw error
    },
  )
}

export type Probe = (port: number) => Promise<number>

const bindProbe: Probe = (port) =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || !address) {
        server.close()
        reject(new Error("Failed to get port"))
        return
      }
      const bound = address.port
      server.close(() => resolve(bound))
    })
  })

/**
 * Walk UP from `preferred` one port at a time until one binds.
 *
 * The previous behavior fell back to `listen(0)` — an arbitrary ephemeral port
 * somewhere above 32768. That made a second instance land somewhere nobody
 * could predict; the +1 walk keeps instances clustered and orderly (2593, 2594,
 * 2595…), which is what makes "which one is the second window on?" answerable.
 *
 * Port 0 is honored as-is: it is the explicit "give me any port" request and
 * scanning up from it would be nonsense.
 */
export async function findFreePort(
  preferred: number,
  options: { window?: number; probe?: Probe } = {},
): Promise<number> {
  const probe = options.probe ?? bindProbe
  if (preferred === 0) return probe(0)

  const window = options.window ?? PORT_SCAN_WINDOW
  for (let offset = 0; offset < window; offset++) {
    const candidate = preferred + offset
    if (candidate > 65535) break
    const result = await tryListen(candidate, probe)
    if (result !== "in-use") return result
  }
  throw new Error(
    `No free port found in ${String(window)} attempts starting at ${String(preferred)}. ` +
      `Set CLAXEDO_SERVER_PORT to pick a different range.`,
  )
}
