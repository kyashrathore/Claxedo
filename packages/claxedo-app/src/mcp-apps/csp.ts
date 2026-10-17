import { mcpAppCsp, type McpAppCsp } from "@claxedo/agent-runtime-contract"
import { MCP_APP_BOOTSTRAP_HASH } from "./bootstrap"

type DomainList = readonly string[]

function cspSourceList(fixed: DomainList, declared: DomainList | undefined): string {
  return [...fixed, ...(declared ?? [])].join(" ")
}

function orNone(declared: DomainList | undefined): string {
  return declared && declared.length > 0 ? declared.join(" ") : "'none'"
}

export function mcpAppPolicy(declared: McpAppCsp | undefined): string {
  const csp = mcpAppCsp(declared)
  const resources = csp?.resourceDomains
  return [
    "default-src 'none'",
    `script-src ${cspSourceList([`'${MCP_APP_BOOTSTRAP_HASH}'`, "blob:"], resources)}`,
    `style-src ${cspSourceList(["'unsafe-inline'"], resources)}`,
    `img-src ${cspSourceList(["data:"], resources)}`,
    `media-src ${cspSourceList(["data:"], resources)}`,
    `font-src ${cspSourceList(["data:"], resources)}`,
    `connect-src ${orNone(csp?.connectDomains)}`,
    `frame-src ${orNone(csp?.frameDomains)}`,
    "object-src 'none'",
    "form-action 'none'",
    `base-uri ${orNone(csp?.baseUriDomains)}`,
  ].join("; ")
}
