import { isRecord } from "@claxedo/helpers/guards"

export const PUBLISHED_DEPLOYMENT_ELEMENT_ID = "claxedo-deployment"

export type PublishedDeployment = {
  readonly server: string
  readonly bootstrap: unknown
  readonly authDescriptor: unknown
}

export function publishedDeployment(serverUrl: string): PublishedDeployment | undefined {
  if (typeof document === "undefined") return undefined
  const text = document.getElementById(PUBLISHED_DEPLOYMENT_ELEMENT_ID)?.textContent
  if (!text) return undefined
  const value: unknown = JSON.parse(text)
  if (!isRecord(value) || value.server !== serverUrl) return undefined
  return { server: value.server, bootstrap: value.bootstrap, authDescriptor: value.authDescriptor }
}
