import fs from "node:fs"
import type { BrowserContext, Page, TestInfo } from "@playwright/test"

export type Destination = { origin: string; kind: string }

export type DestinationRecord = { readonly list: () => Destination[] }

function originOf(url: string) {
  if (/^(data|blob|about|chrome-extension):/.test(url)) return url.slice(0, url.indexOf(":") + 1)
  return URL.canParse(url) ? new URL(url).origin : url
}

export function recordDestinations(context: BrowserContext): DestinationRecord {
  const seen = new Map<string, Destination>()
  const add = (url: string, kind: string) => {
    const destination = { origin: originOf(url), kind }
    seen.set(`${destination.kind} ${destination.origin}`, destination)
  }
  const watchPage = (page: Page) => page.on("websocket", (socket) => add(socket.url(), "websocket"))
  context.on("request", (request) => add(request.url(), request.resourceType()))
  context.on("page", watchPage)
  for (const page of context.pages()) watchPage(page)
  return { list: () => [...seen.values()].sort((a, b) => `${a.origin} ${a.kind}`.localeCompare(`${b.origin} ${b.kind}`)) }
}

export async function reportDestinations(testInfo: TestInfo, record: DestinationRecord) {
  const destinations = record.list()
  await testInfo.attach("destinations.json", { body: JSON.stringify(destinations, null, 2), contentType: "application/json" })
  const out = process.env.CLAXEDO_E2E_DESTINATIONS
  if (out) fs.appendFileSync(out, `${JSON.stringify({ spec: testInfo.titlePath.slice(1).join(" › "), project: testInfo.project.name, destinations })}\n`)
}
