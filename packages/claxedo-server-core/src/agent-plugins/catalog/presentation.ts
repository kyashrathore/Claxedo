import type {
  AgentPluginCatalogCandidate,
  AgentPluginManifest,
  AgentPluginSkill,
  AgentPluginSourceKind,
  ValidatedAgentPlugin,
} from "./types"

export type AgentPluginIcon =
  | { kind: "url"; url: string }
  | { kind: "monogram"; text: string }

export type AgentPluginSourceView = {
  id: string
  kind: AgentPluginSourceKind
  label: string
  /** `owner/repository` when the source is a GitHub repository. */
  repository?: string
}

/** The presentation fields every catalog view projects, produced here and nowhere else. */
export type AgentPluginCandidatePresentation = {
  icon?: AgentPluginIcon
  skills: AgentPluginSkill[]
  source: AgentPluginSourceView | null
}

/**
 * Reverse-domain-free product namespace inside the open `extensions` record.
 * The manifest schema is unchanged: `extensions` already accepts any namespace.
 */
const ICON_NAMESPACE = "claxedo"

function iconUrl(manifest: AgentPluginManifest): string | undefined {
  const declared = manifest.extensions?.[ICON_NAMESPACE]?.icon
  if (typeof declared !== "string") return undefined
  try {
    // An icon is fetched by the renderer, so only https is a usable source.
    return new URL(declared).protocol === "https:" ? declared : undefined
  } catch {
    return undefined
  }
}

/** First letter of each of the first two name words: `code-review` → `CR`, `review` → `R`. */
function monogram(name: string) {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!)
    .join("")
    .toUpperCase()
}

function icon(manifest: AgentPluginManifest | null | undefined): AgentPluginIcon | undefined {
  if (!manifest) return undefined
  const declared = iconUrl(manifest)
  if (declared) return { kind: "url", url: declared }
  const text = monogram(manifest.name)
  return text ? { kind: "monogram", text } : undefined
}

/**
 * A candidate its source still serves. Skills come from the retained artifact
 * whenever one is pinned, for the same reason MCP servers already do: that tree
 * is what the runtime materializes and the only tree the skill route reads.
 */
export function candidatePresentation(input: {
  candidate: AgentPluginCatalogCandidate
  retained?: ValidatedAgentPlugin | undefined
}): AgentPluginCandidatePresentation {
  const glyph = icon(input.candidate.manifest)
  return {
    ...(glyph ? { icon: glyph } : {}),
    skills: [...(input.retained?.skills ?? input.candidate.skills)],
    source: {
      id: input.candidate.sourceId,
      kind: input.candidate.sourceKind,
      label: input.candidate.sourceLabel,
      ...(input.candidate.sourceRepository ? { repository: input.candidate.sourceRepository } : {}),
    },
  }
}

/**
 * A plugin no source serves any more. Everything readable comes from the
 * retained artifact, and the view names no source: the pin records which source
 * it came from, but not that source's kind or label, and inventing one would be
 * presenting a collection the caller can no longer read.
 */
export function retainedPresentation(retained: ValidatedAgentPlugin | undefined): AgentPluginCandidatePresentation {
  const glyph = icon(retained?.manifest)
  return {
    ...(glyph ? { icon: glyph } : {}),
    skills: [...(retained?.skills ?? [])],
    source: null,
  }
}
