import { Resolver } from "node:dns/promises"
import { request as httpsRequest } from "node:https"

const publicDnsResolver = new Resolver()
publicDnsResolver.setServers(["1.1.1.1", "1.0.0.1"])

function resolvePublicIpv4(hostname: string) {
  return publicDnsResolver.resolve4(hostname)
}

async function fetchHttpsAddress(url: string, address: string, init: RequestInit) {
  const target = new URL(url)
  if (target.protocol !== "https:") throw new Error("deploy probes require HTTPS")
  return await new Promise<Response>((resolve, reject) => {
    const request = httpsRequest(
      target,
      {
        method: init.method ?? "GET",
        headers: init.headers === undefined ? undefined : Object.fromEntries(new Headers(init.headers)),
        lookup: (_hostname, options, callback) => {
          if (typeof options === "object" && options.all) {
            callback(null, [{ address, family: 4 }])
            return
          }
          callback(null, address, 4)
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("error", reject)
        response.on("end", () => {
          const headers = new Headers()
          for (let index = 0; index < response.rawHeaders.length; index += 2) {
            headers.append(response.rawHeaders[index], response.rawHeaders[index + 1])
          }
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode ?? 500,
              statusText: response.statusMessage,
              headers,
            }),
          )
        })
      },
    )
    request.setTimeout(15_000, () => request.destroy(new Error("deploy probe timed out")))
    if (init.signal) {
      if (init.signal.aborted) request.destroy(init.signal.reason)
      else init.signal.addEventListener("abort", () => request.destroy(init.signal?.reason), { once: true })
    }
    request.on("error", reject)
    request.end()
  })
}

/**
 * Fetch a freshly attached custom domain. The machine's resolver can cache
 * the NXDOMAIN it saw before `wrangler deploy --domain` created the record,
 * so a failed fetch retries through Cloudflare's public resolver while
 * keeping the hostname for TLS and routing.
 */
export async function fetchReleaseProbe(
  url: string,
  init: RequestInit = {},
  dependencies: Readonly<{
    fetcher?: (input: string, init?: RequestInit) => Promise<Response>
    resolver?: (hostname: string) => Promise<readonly string[]>
    addressFetcher?: (url: string, address: string, init: RequestInit) => Promise<Response>
  }> = {},
) {
  try {
    return await (dependencies.fetcher ?? fetch)(url, init)
  } catch (primaryFailure) {
    const target = new URL(url)
    const addresses = await (dependencies.resolver ?? resolvePublicIpv4)(target.hostname)
    let lastFailure: unknown = primaryFailure
    for (const address of addresses) {
      try {
        return await (dependencies.addressFetcher ?? fetchHttpsAddress)(url, address, init)
      } catch (error) {
        lastFailure = error
      }
    }
    throw new Error(
      `deploy probe failed through normal and public DNS resolution: ${lastFailure instanceof Error ? lastFailure.message : JSON.stringify(lastFailure)}`,
      { cause: primaryFailure },
    )
  }
}

export type ProbeOptions = Readonly<{
  attempts?: number
  intervalMs?: number
  fetcher?: (url: string) => Promise<Response>
  wait?: (milliseconds: number) => Promise<void>
}>

/**
 * Poll `url` until `accept` passes on its JSON body. A new version and a new
 * custom domain reach every edge a little after the upload returns; on
 * 2026-09-23 a custom domain first served the new build after about a minute,
 * so the default budget is 40 attempts 3 s apart.
 */
export async function waitForProbe(
  url: string,
  accept: (response: Response, body: unknown) => void,
  options: ProbeOptions = {},
) {
  const fetcher = options.fetcher ?? ((target: string) => fetchReleaseProbe(target, { signal: AbortSignal.timeout(15_000) }))
  const wait = options.wait ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  const attempts = options.attempts ?? 40
  let failure: unknown = new Error(`${url} was not probed`)
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetcher(url)
      const text = await response.text()
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        body = undefined
      }
      accept(response, body)
      return
    } catch (error) {
      failure = error
    }
    if (attempt < attempts) await wait(options.intervalMs ?? 3_000)
  }
  throw new Error(`${url} did not converge after ${attempts} attempts`, { cause: failure })
}
