import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { AGENT_PLUGINS_ROUTE_PATH } from "@claxedo/server-core/agent-plugins/module"

const serverRoot = path.resolve(import.meta.dirname, "../..")
const defaultOutput = path.join(serverRoot, ".artifacts/agent-plugins-worker-profile/wrangler.toml")

type GatewayDeployment = {
  origin: string
  routePattern: string
  zoneName: string
}

function required(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim()
  if (!value) throw new Error(`Agent Plugins deployment requires ${name}`)
  return value
}

function gatewayDeployment(env: NodeJS.ProcessEnv, staging: boolean): GatewayDeployment {
  const urlName = staging
    ? "CLAXEDO_AGENT_PLUGINS_MCP_GATEWAY_URL_STAGING"
    : "CLAXEDO_AGENT_PLUGINS_MCP_GATEWAY_URL"
  const zoneName = required(env, "CLAXEDO_AGENT_PLUGINS_MCP_GATEWAY_ZONE_NAME").toLowerCase()
  const url = new URL(required(env, urlName))
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.port
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new Error(`${urlName} must be an HTTPS origin without credentials, port, path, query, or fragment`)
  }
  const hostname = url.hostname.toLowerCase()
  if (hostname === zoneName || !hostname.endsWith(`.${zoneName}`)) {
    throw new Error(`${urlName} hostname must be a subdomain of CLAXEDO_AGENT_PLUGINS_MCP_GATEWAY_ZONE_NAME`)
  }
  const gatewayLabel = hostname.slice(0, -(zoneName.length + 1))
  if (gatewayLabel.includes(".")) {
    throw new Error(`${urlName} hostname must be exactly one label below CLAXEDO_AGENT_PLUGINS_MCP_GATEWAY_ZONE_NAME`)
  }
  // Runtime endpoints prepend `mcp-<32 hex>-` to this label. Enforce DNS's
  // 63-byte label limit at deployment generation rather than discovering an
  // unusable hostname while provisioning a workspace.
  if (`mcp-${"0".repeat(32)}-${gatewayLabel}`.length > 63) {
    throw new Error(`${urlName} hostname label is too long for generated MCP gateway hosts`)
  }
  return {
    origin: `https://${hostname}/`,
    routePattern: `https://*.${zoneName}${AGENT_PLUGINS_ROUTE_PATH}/mcp/*`,
    zoneName,
  }
}

function publicControlPlaneUrl(env: NodeJS.ProcessEnv, staging: boolean) {
  const name = staging ? "CLAXEDO_PUBLIC_URL_STAGING" : "CLAXEDO_PUBLIC_URL"
  const url = new URL(required(env, name))
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${name} must be a public HTTPS origin without credentials, path, query, or fragment`)
  }
  return url.toString()
}

function addTableValue(source: string, table: string, value: string) {
  const header = `[${table}]`
  const index = source.indexOf(header)
  if (index < 0) throw new Error(`Hosted Worker config is missing ${header}`)
  const lineEnd = source.indexOf("\n", index)
  return `${source.slice(0, lineEnd + 1)}${value}\n${source.slice(lineEnd + 1)}`
}

export function buildAgentPluginsWorkerProfile(input: {
  output?: string
  staging?: boolean
  env?: NodeJS.ProcessEnv
} = {}) {
  const output = path.resolve(input.output ?? defaultOutput)
  const staging = input.staging ?? false
  const env = input.env ?? process.env
  const gateway = gatewayDeployment(env, staging)
  const publicUrl = publicControlPlaneUrl(env, staging)
  const credentialsNamespaceId = required(
    env,
    staging ? "CLAXEDO_CREDENTIALS_KV_NAMESPACE_ID_STAGING" : "CLAXEDO_CREDENTIALS_KV_NAMESPACE_ID",
  )
  const base = fs.readFileSync(path.join(serverRoot, "wrangler.toml"), "utf8")
  const main = 'main = "src/deployments/hosted-workerd/worker.ts"'
  if (!base.includes(main)) throw new Error("Hosted Worker entrypoint is missing from wrangler.toml")
  const featureEntry = path.relative(
    path.dirname(output),
    path.join(serverRoot, "src/deployments/hosted-workerd/worker.agent-plugins.ts"),
  ).split(path.sep).join("/")
  const profileEntry = featureEntry.startsWith(".") ? featureEntry : `./${featureEntry}`
  const withEntry = base.replace(
    main,
    `main = ${JSON.stringify(profileEntry)}\nworkers_dev = true`,
  )
  const withGatewayVar = addTableValue(
    withEntry,
    staging ? "env.staging.vars" : "vars",
    `CLAXEDO_AGENT_PLUGINS_MCP_GATEWAY_URL = ${JSON.stringify(gateway.origin)}`,
  )
  const withCredentialsFlag = addTableValue(
    withGatewayVar,
    staging ? "env.staging.vars" : "vars",
    'CLAXEDO_HOSTED_CREDENTIALS_ENABLED = "1"',
  )
  const withPublicUrl = addTableValue(
    withCredentialsFlag,
    staging ? "env.staging.vars" : "vars",
    `CLAXEDO_PUBLIC_URL = ${JSON.stringify(publicUrl)}`,
  )
  const routeTable = staging ? "env.staging.routes" : "routes"
  const credentialsTable = staging ? "env.staging.kv_namespaces" : "kv_namespaces"
  const profile = `${withPublicUrl.trimEnd()}

[[r2_buckets]]
binding = "CLAXEDO_AGENT_PLUGINS"
bucket_name = "claxedo-agent-plugins"

[[env.staging.r2_buckets]]
binding = "CLAXEDO_AGENT_PLUGINS"
bucket_name = "claxedo-agent-plugins-staging"

[[${credentialsTable}]]
binding = "CLAXEDO_CREDENTIALS"
id = ${JSON.stringify(credentialsNamespaceId)}

[[${routeTable}]]
pattern = ${JSON.stringify(gateway.routePattern)}
zone_name = ${JSON.stringify(gateway.zoneName)}
`
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, profile)
  return output
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  console.log(buildAgentPluginsWorkerProfile({ staging: process.argv.includes("--staging") }))
}
