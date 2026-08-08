/**
 * Curated Agent Extensions catalog.
 *
 * Each `source` MUST be installable today: either an `owner/repo` shorthand or
 * a `https://github.com/owner/repo/tree/<ref>/<path>` URL pointing at a real
 * package. Adding fake placeholders breaks the install flow with
 * "Repository not found" and erodes trust in the marketplace.
 *
 * The current set draws from:
 *   - Anthropic's reference Claude skills (https://github.com/anthropics/skills)
 *   - The official MCP servers monorepo (https://github.com/modelcontextprotocol/servers)
 *
 * When a vendor moves their server out of the MCP monorepo, update the URL
 * here and bump nothing else — the install path is the single point of truth.
 */

export type CatalogCategory =
  | "featured"
  | "skills"
  | "mcp-servers"
  | "infrastructure"
  | "data-and-analytics"
  | "productivity"
  | "agent-orchestration"

export type CatalogTarget = "claude" | "codex" | "cursor" | "opencode"

export type CatalogEntry = {
  id: string
  name: string
  description: string
  source: string
  kind: "skill" | "plugin" | "mcp" | "package"
  icon?: string
  badge?: string
  categories: CatalogCategory[]
  recommendedScope: "machine" | "project" | "workspace"
  recommendedTargets: CatalogTarget[]
  featured?: boolean
  firstParty?: "claxedo"
}

export type Catalog = {
  version: 1
  categories: Array<{ id: CatalogCategory; label: string }>
  entries: CatalogEntry[]
}

export const CATALOG_CATEGORIES: Catalog["categories"] = [
  { id: "featured", label: "Featured" },
  { id: "skills", label: "Skills" },
  { id: "mcp-servers", label: "MCP Servers" },
  { id: "infrastructure", label: "Infrastructure" },
  { id: "data-and-analytics", label: "Data & Analytics" },
  { id: "productivity", label: "Productivity" },
  { id: "agent-orchestration", label: "Agent Orchestration" },
]

// Deliberately tiny, fully-testable set. Every source below was verified to
// resolve (HTTP 200) so the install flow works end-to-end. Third-party vendor
// servers that were removed from the modelcontextprotocol/servers monorepo
// (github, slack, postgres, sqlite, gdrive, puppeteer, brave-search,
// google-maps, gitlab, …) are intentionally excluded — their `source` URLs now
// 404 and would break install. Reinstate individually only after re-verifying
// the source resolves.
const ENTRIES: CatalogEntry[] = [
  // ── First-party (the canonical install-flow test target) ─────────────────
  {
    id: "claxedo-mcp",
    name: "Claxedo",
    description: "Claxedo tools for process management, terminal logs, session messages, log summaries, and browser panes.",
    source: "https://github.com/kyashrathore/Claxedo/tree/dev/packages/claxedo-mcp",
    kind: "mcp",
    icon: "C",
    categories: ["featured", "mcp-servers", "agent-orchestration"],
    recommendedScope: "machine",
    recommendedTargets: ["opencode", "claude", "codex", "cursor"],
    featured: true,
    firstParty: "claxedo",
  },

  // ── Official Anthropic skill ─────────────────────────────────────────────
  {
    id: "anthropic-skill-pdf",
    name: "PDF",
    description: "Read, write, and edit PDFs across local files and URLs.",
    source: "https://github.com/anthropics/skills/tree/main/skills/pdf",
    kind: "skill",
    icon: "📄",
    categories: ["featured", "skills", "productivity"],
    recommendedScope: "machine",
    recommendedTargets: ["claude"],
    featured: true,
  },

  // ── Official MCP reference servers (still in the monorepo) ────────────────
  {
    id: "mcp-filesystem",
    name: "Filesystem",
    description: "Read, write, and search files within a sandboxed root.",
    source: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    kind: "mcp",
    icon: "📁",
    categories: ["featured", "mcp-servers", "productivity"],
    recommendedScope: "machine",
    recommendedTargets: ["opencode", "claude", "codex", "cursor"],
    featured: true,
  },
  {
    id: "mcp-fetch",
    name: "Fetch",
    description: "Fetch arbitrary URLs and convert HTML to markdown.",
    source: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    kind: "mcp",
    icon: "🌐",
    categories: ["mcp-servers", "productivity"],
    recommendedScope: "machine",
    recommendedTargets: ["opencode", "claude", "codex", "cursor"],
  },
]

export function loadAgentExtensionsCatalog(): Catalog {
  return {
    version: 1,
    categories: CATALOG_CATEGORIES,
    entries: ENTRIES,
  }
}
