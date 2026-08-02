import { buildTrustedConnectionContext } from "./run-prompt"

/** The one authority-envelope sentence every master operates under. Local and
 *  hosted runtimes must deliver identical guardrail text — a drifted copy means
 *  masters on different deployments run under different standing instructions. */
export const MASTER_AUTHORITY_ENVELOPE =
  "Hard authority envelope: never approve agent-proposed work; never push, merge, or force-push a protected ref; externally visible changes require charter authority and durable receipts."

/** Extract the first substantive charter line as the default citable clause. */
export function charterClause(text: string): string {
  return text.split("\n").find((line) => line.trim())?.trim() || "Act within the Stream charter."
}

/** The single master prompt used by every runtime. `capabilities.landing`
 *  gates the merge-queue duty: a master without the landing tool must never be
 *  instructed to land — an un-toolable duty invites ungated raw-git landing. */
export function buildMasterPrompt(input: Readonly<{
  stream: Readonly<{ id: string; title: string }>
  charter: Readonly<{ text: string; hash: string }>
  mailbox: readonly Readonly<{ message: string }>[]
  runs: readonly Readonly<{ id: string; workItemId: string; state: string; result: string }>[]
  agents?: readonly Readonly<{ name: string; brief: string }>[]
  connectionIds: readonly string[]
  capabilities: Readonly<{ landing: boolean }>
}>) {
  const duties = [
    ...(input.capabilities.landing
      ? ["maintain the envelope merge queue via workgraph_land_candidate, revalidate against its moving head"]
      : ["report merge-ready candidate revisions in your status and notes (landing runs elsewhere; never merge by hand)"]),
    "keep structured notes",
    "create draft PRs by default",
    "notify the owner within charter cadence",
    "escalate unresolved conflicts once",
  ].join(", ")
  return [
    `You are the long-lived master for Stream ${input.stream.id}: ${input.stream.title}.`,
    `Charter hash: ${input.charter.hash}`,
    "Charter:",
    input.charter.text,
    MASTER_AUTHORITY_ENVELOPE,
    `Duties: ${duties}.`,
    `Mailbox:\n${input.mailbox.length ? input.mailbox.map((message) => `- ${message.message}`).join("\n") : "- (empty)"}`,
    `Recent terminal runs:\n${input.runs.length ? input.runs.map((run) => `- ${run.id} (${run.state}) task=${run.workItemId} result=${run.result}`).join("\n") : "- (none)"}`,
    `Your agents:\n${input.agents?.length ? input.agents.map((agent) => `- ${agent.name}: ${agent.brief || "(no brief)"}`).join("\n") : "- (none configured)"}`,
    buildTrustedConnectionContext(input.connectionIds),
    "For each action, cite the charter clause and include working file/diff/PR receipt references in your status.",
  ].filter((section): section is string => !!section).join("\n\n")
}
