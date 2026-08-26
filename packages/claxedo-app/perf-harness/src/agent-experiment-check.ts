#!/usr/bin/env bun
import path from "node:path";
import { checkExperimentProposal, loadPriorEvidence } from "./agent-prior-evidence";

const args = new Map<string, string>();
for (let index = 0; index < process.argv.slice(2).length; index += 2) {
  const key = process.argv.slice(2)[index];
  const value = process.argv.slice(2)[index + 1];
  if (!key?.startsWith("--") || !value) throw new Error("options must be --name value pairs");
  args.set(key, value);
}
const question = args.get("--question");
if (!question) throw new Error("--question is required");
const manifest = await loadPriorEvidence(path.resolve(import.meta.dir, "../evidence/prior-evidence.json"));
const result = checkExperimentProposal(manifest, {
  question,
  ...(args.get("--prior-evidence-id") ? { priorEvidenceId: args.get("--prior-evidence-id")! } : {}),
  ...(args.get("--invalidated-boundary") ? { invalidatedBoundary: args.get("--invalidated-boundary")! } : {}),
  ...(args.get("--new-metric") ? { newMetric: args.get("--new-metric")! } : {}),
});
console.log(JSON.stringify(result, null, 2));
