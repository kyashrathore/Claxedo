import type { EvidenceLink } from "./capabilities";

export interface QualityRubric {
  requireEvidence: boolean;
  requireNodeResults: boolean;
  minEvidencePerDecision: number;
  requireSourceLinks: boolean;
}

export const defaultRubric: QualityRubric = {
  requireEvidence: true,
  requireNodeResults: true,
  minEvidencePerDecision: 1,
  requireSourceLinks: false,
};

export interface QualityCheckResult {
  passed: boolean;
  score: number;
  violations: string[];
}

export function checkQuality(
  nodes: Array<{ name: string; result: string }>,
  decisions: Array<{ proposal: string; evidence: EvidenceLink[] }>,
  rubric?: QualityRubric
): QualityCheckResult {
  const r = rubric ?? defaultRubric;
  const violations: string[] = [];
  let checks = 0;
  let passed = 0;

  if (r.requireNodeResults) {
    for (const node of nodes) {
      checks++;
      if (node.result && node.result.trim()) {
        passed++;
      } else {
        violations.push(`Node "${node.name}" has empty result`);
      }
    }
  }

  if (r.requireEvidence) {
    for (const d of decisions) {
      checks++;
      if (d.evidence.length >= r.minEvidencePerDecision) {
        passed++;
      } else {
        violations.push(
          `Decision "${d.proposal}" has insufficient evidence (${d.evidence.length}/${r.minEvidencePerDecision})`
        );
      }

      if (r.requireSourceLinks) {
        for (const e of d.evidence) {
          if ((e.type === "external" || e.type === "source_code") && !e.url) {
            checks++;
            violations.push(
              `Evidence "${e.description}" missing URL for type ${e.type}`
            );
          } else {
            checks++;
            passed++;
          }
        }
      }
    }
  }

  const score = checks > 0 ? passed / checks : 1;
  return { passed: violations.length === 0, score, violations };
}
