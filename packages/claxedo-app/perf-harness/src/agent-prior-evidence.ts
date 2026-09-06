import { readFile } from "node:fs/promises";
import { isRecord, recordField, recordsField, textField } from "./json-fields";

export const REQUIRED_PRIOR_EVIDENCE_IDS = [
  ...Array.from({ length: 6 }, (_, index) => `F${index + 1}`),
  ...Array.from({ length: 14 }, (_, index) => String(index + 1)),
  ...Array.from({ length: 22 }, (_, index) => `V${index + 1}`),
];

type PriorEntry = { id: string; action: string; provenance: Record<string, unknown>; inheritance: { status: string; missing: string[] } };
export type PriorEvidenceManifest = { schemaVersion: 1; requiredIds: string[]; entries: PriorEntry[] };

export async function loadPriorEvidence(path: string): Promise<PriorEvidenceManifest> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  const entries = isRecord(parsed) ? recordsField(parsed, "entries") : undefined;
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !entries) throw new Error("invalid prior-evidence manifest");
  const value: PriorEvidenceManifest = {
    schemaVersion: 1,
    requiredIds: (Array.isArray(parsed.requiredIds) ? parsed.requiredIds : []).filter(
      (id) => typeof id === "string",
    ),
    entries: entries.flatMap((entry) => {
      const id = textField(entry, "id");
      const action = textField(entry, "action");
      const provenance = recordField(entry, "provenance");
      const inheritance = recordField(entry, "inheritance");
      const status = inheritance && textField(inheritance, "status");
      const missing = inheritance?.missing;
      if (id === undefined || action === undefined || !provenance || status === undefined || !Array.isArray(missing)) {
        return [];
      }
      return [{
        id,
        action,
        provenance,
        inheritance: { status, missing: missing.filter((entryId) => typeof entryId === "string") },
      }];
    }),
  };
  if (value.entries.length !== entries.length) throw new Error("invalid prior-evidence manifest");
  const ids = value.entries.map((entry) => entry.id);
  const missing = REQUIRED_PRIOR_EVIDENCE_IDS.filter((id) => !ids.includes(id));
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (missing.length || duplicate || ids.length !== REQUIRED_PRIOR_EVIDENCE_IDS.length) throw new Error(`prior-evidence manifest is incomplete (missing=${missing.join(",")}, duplicate=${duplicate ?? "none"})`);
  for (const entry of value.entries) {
    if (entry.inheritance.status === "verified" && entry.inheritance.missing.length > 0) throw new Error(`verified prior-evidence entry ${entry.id} has missing provenance`);
  }
  return value;
}

export function checkExperimentProposal(manifest: PriorEvidenceManifest, proposal: {
  question: string;
  priorEvidenceId?: string;
  invalidatedBoundary?: string;
  newMetric?: string;
}) {
  if (!proposal.question.trim()) throw new Error("experiment question is required");
  const explicit = proposal.priorEvidenceId ? manifest.entries.find((entry) => entry.id === proposal.priorEvidenceId) : undefined;
  if (proposal.priorEvidenceId && !explicit) throw new Error(`unknown prior evidence: ${proposal.priorEvidenceId}`);
  const normalizedQuestion = tokens(proposal.question);
  const inferred = manifest.entries
    .map((entry) => ({ entry, overlap: jaccard(normalizedQuestion, tokens(entry.action)) }))
    .toSorted((left, right) => right.overlap - left.overlap)[0];
  const duplicate = explicit ?? (inferred && inferred.overlap >= 0.45 ? inferred.entry : undefined);
  if (duplicate && !proposal.invalidatedBoundary?.trim() && !proposal.newMetric?.trim()) {
    throw new Error(`duplicate experiment rejected: ${duplicate.id} (${duplicate.action}); declare the invalidated current-tree boundary or a genuinely new metric`);
  }
  return {
    decision: duplicate ? "allowed-with-new-question" as const : "new-question" as const,
    linkedPriorEvidenceId: duplicate?.id,
    rationale: proposal.invalidatedBoundary?.trim() || proposal.newMetric?.trim() || "no matching prior action",
  };
}

function tokens(value: string) {
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/u).filter((item) => item.length >= 4));
}
function jaccard(left: Set<string>, right: Set<string>) {
  const union = new Set([...left, ...right]);
  if (!union.size) return 0;
  return [...left].filter((item) => right.has(item)).length / union.size;
}
