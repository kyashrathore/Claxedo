import { isFiniteNumber, isRecord } from "@claxedo/helpers/guards"
import { PUBLISHED_DEPLOYMENT_ELEMENT_ID, type PublishedDeployment } from "./src/server/published-deployment"

type DeploymentRequest = (url: string) => Promise<Response>

const ELEMENT_OPEN = `<script id="${PUBLISHED_DEPLOYMENT_ELEMENT_ID}" type="application/json">`
const ELEMENT = new RegExp(`${ELEMENT_OPEN.replace(/[/]/g, "\\/")}[^<]*</script>`)

export class PublishedDeploymentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PublishedDeploymentError"
  }
}

async function readJson(request: DeploymentRequest, url: string): Promise<Record<string, unknown>> {
  const response = await request(url)
  if (!response.ok) throw new PublishedDeploymentError(`${url} answered HTTP ${response.status}`)
  const body: unknown = await response.json()
  if (!isRecord(body)) throw new PublishedDeploymentError(`${url} answered no JSON object`)
  return body
}

function sameForEveryVisitor(bootstrap: Record<string, unknown>, url: string) {
  const deployment = isRecord(bootstrap.deployment) ? bootstrap.deployment : {}
  if (deployment.serverKind !== "hosted" || "project" in bootstrap || "host" in bootstrap) {
    throw new PublishedDeploymentError(`${url} is not a hosted deployment's bootstrap, whose answer is the same for every visitor`)
  }
}

export async function readPublishedDeployment(apiOrigin: string, request: DeploymentRequest = fetch): Promise<PublishedDeployment> {
  const server = new URL(apiOrigin).origin
  if (server !== apiOrigin) throw new PublishedDeploymentError(`${apiOrigin} is not an origin`)
  const bootstrapUrl = `${server}/api/claxedo/bootstrap`
  const descriptorUrl = `${server}/api/claxedo/auth/descriptor`
  const [bootstrap, authDescriptor] = await Promise.all([readJson(request, bootstrapUrl), readJson(request, descriptorUrl)])
  sameForEveryVisitor(bootstrap, bootstrapUrl)
  if (!isFiniteNumber(authDescriptor.expiresAt) || authDescriptor.expiresAt <= Date.now()) {
    throw new PublishedDeploymentError(`${descriptorUrl} answered an expired descriptor`)
  }
  return { server, bootstrap, authDescriptor }
}

export function publishDeployment(html: string, deployment: PublishedDeployment): string {
  const element = `${ELEMENT_OPEN}${JSON.stringify(deployment).replace(/</g, "\\u003c")}</script>`
  if (ELEMENT.test(html)) return html.replace(ELEMENT, () => element)
  if (!html.includes("</head>")) throw new PublishedDeploymentError("the app shell has no </head> to publish the deployment into")
  return html.replace("</head>", () => `${element}</head>`)
}
