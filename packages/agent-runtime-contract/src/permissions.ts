export type PermissionDecision = "allow_once" | "allow_always" | "deny" | "reject_always"

/**
 * The three rungs every harness's permission surface is mapped onto.
 *
 * A LADDER, not a taxonomy: the rungs are ordered by how much runs without
 * asking, and that ordering is the only thing shared across harnesses. What each
 * rung concretely does is the harness's business and differs wildly — `auto` is
 * an OS sandbox on codex and a model classifier on claude and cursor.
 *
 * `level` is therefore a HINT for choosing a default, never a promise about
 * behaviour. Anything user-facing must show `AgentPermissionMode.name` — the
 * harness's own word for it — because that is the only label guaranteed to
 * describe what actually happens.
 */
export type AutoLevel = "ask" | "auto" | "full"

/** One selectable permission mode, in the harness's own vocabulary. */
export type AgentPermissionMode = {
  id: string
  /** The harness's own name. Rendered as-is; never paraphrased. */
  name: string
  description?: string
  /**
   * Which rung this is, when it maps to one at all. Absent means the harness
   * offers it but it does not correspond to a rung — still selectable, just not
   * a candidate for the default.
   */
  level?: AutoLevel
}

export type AgentPermissionModeState = {
  modes: AgentPermissionMode[]
  /**
   * Read back from the harness, never assumed from the last write. An ACP agent
   * may clamp this to a different mode when its available set changes.
   */
  currentModeId?: string
  /**
   * Set when this harness has no mode surface. Distinct from `modes: []`, which
   * means it has one and reported nothing — greying out for the right reason
   * requires telling those apart.
   */
  unsupported?: string
  /**
   * When the harness applies a change: acknowledged live control, next turn,
   * or next agent session.
   */
  appliesFrom: "immediate" | "next-turn" | "next-session"
}
