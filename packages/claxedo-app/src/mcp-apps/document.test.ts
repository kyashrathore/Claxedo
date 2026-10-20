import { describe, expect, test } from "bun:test"
import { MCP_APP_MAX_BYTES } from "@claxedo/agent-runtime-contract"
import { mcpAppPolicy } from "./csp"
import { MCP_APP_BOOTSTRAP_HASH } from "./bootstrap"
import { decodeDocumentDataUrl } from "./document"

const SPEC_DEFAULT =
  `default-src 'none'; script-src '${MCP_APP_BOOTSTRAP_HASH}' blob:; style-src 'unsafe-inline'; img-src data:; media-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'`

function directive(policy: string, name: string) {
  return policy.split("; ").find((entry) => entry.startsWith(`${name} `))
}

describe("the app document policy", () => {
  test("is the spec default when the resource declares nothing", () => {
    expect(mcpAppPolicy(undefined)).toBe(SPEC_DEFAULT)
    expect(mcpAppPolicy({})).toBe(SPEC_DEFAULT)
  })

  test("adds each declared list to its directives", () => {
    const policy = mcpAppPolicy({
      connectDomains: ["https://api.example.com", "wss://live.example.com"],
      resourceDomains: ["https://cdn.example.com"],
      frameDomains: ["https://embed.example.com"],
      baseUriDomains: ["https://base.example.com"],
    })
    expect(directive(policy, "connect-src")).toBe("connect-src https://api.example.com wss://live.example.com")
    expect(directive(policy, "script-src")).toBe(`script-src '${MCP_APP_BOOTSTRAP_HASH}' blob: https://cdn.example.com`)
    expect(directive(policy, "style-src")).toBe("style-src 'unsafe-inline' https://cdn.example.com")
    for (const name of ["img-src", "font-src", "media-src"]) expect(directive(policy, name)).toBe(`${name} data: https://cdn.example.com`)
    expect(directive(policy, "frame-src")).toBe("frame-src https://embed.example.com")
    expect(directive(policy, "base-uri")).toBe("base-uri https://base.example.com")
    expect(directive(policy, "default-src")).toBe("default-src 'none'")
    expect(directive(policy, "object-src")).toBe("object-src 'none'")
  })

  test("drops wildcards, paths, keywords and anything that could end a directive", () => {
    const policy = mcpAppPolicy({
      connectDomains: ["*", "https://*.example.com", "https://ok.example.com/path", "'self'", "https://a.example.com; script-src *", "data:", "https://good.example.com"],
    })
    expect(directive(policy, "connect-src")).toBe("connect-src https://good.example.com")
    expect(policy.split("; ")).toHaveLength(11)
    expect(policy).not.toContain("*")
  })
})

describe("decoding the stored document", () => {
  const encode = (html: string) => `data:text/html;profile=mcp-app;base64,${Buffer.from(html, "utf8").toString("base64")}`

  test("reads a base64 data URL as UTF-8", () => {
    expect(decodeDocumentDataUrl(encode("<p>héllo ✓</p>"))).toBe("<p>héllo ✓</p>")
  })

  test("refuses a URL that is not base64 data, invalid UTF-8 or larger than the cap", () => {
    expect(decodeDocumentDataUrl("https://example.com/app.html")).toBeUndefined()
    expect(decodeDocumentDataUrl("data:text/html,<p>plain</p>")).toBeUndefined()
    expect(decodeDocumentDataUrl(`data:text/html;base64,${Buffer.from([0xff, 0xfe, 0xfd]).toString("base64")}`)).toBeUndefined()
    expect(decodeDocumentDataUrl("data:text/html;base64,%%%")).toBeUndefined()
    expect(decodeDocumentDataUrl(encode("x".repeat(MCP_APP_MAX_BYTES + 1)))).toBeUndefined()
    expect(decodeDocumentDataUrl(encode("x".repeat(MCP_APP_MAX_BYTES)))).toHaveLength(MCP_APP_MAX_BYTES)
  })
})
