export interface CapabilityDescription {
  id: string;
  description: string;
}

export interface RouteResult {
  selected_id: string | null;
  confidence: number;
}

export interface RouteConfig {
  minConfidence: number; // default 0.55
  fallbackTeamId?: string;
}

/**
 * Score a goal against a single capability using keyword heuristics.
 * Returns a confidence score between 0 and 1.
 */
function scoreCapability(goal: string, capability: CapabilityDescription): number {
  const lowerGoal = goal.toLowerCase();
  const lowerDesc = capability.description.toLowerCase();
  const capId = capability.id.toLowerCase();

  // Define keyword groups and their associated capability patterns
  const keywordGroups: Array<{ keywords: string[]; capPatterns: string[]; score: number }> = [
    {
      keywords: ["css", "ui", "button", "html", "frontend", "react", "solidjs", "browser", "layout", "style"],
      capPatterns: ["frontend", "ui", "css", "html", "browser", "react", "solidjs"],
      score: 0.85,
    },
    {
      keywords: ["sql", "api", "endpoint", "database", "server", "backend", "rest", "graphql", "migration"],
      capPatterns: ["backend", "api", "sql", "database", "server", "endpoint"],
      score: 0.90,
    },
    {
      keywords: ["test", "qa", "quality", "spec", "assertion", "coverage", "unit test", "integration test"],
      capPatterns: ["test", "qa", "quality", "spec", "coverage"],
      score: 0.80,
    },
    {
      keywords: ["research", "document", "search", "summarize", "summarizing", "documentation", "reading", "web search"],
      capPatterns: ["research", "document", "search", "summariz", "reading"],
      score: 0.80,
    },
  ];

  let bestScore = 0;

  for (const group of keywordGroups) {
    const goalMatches = group.keywords.some(kw => lowerGoal.includes(kw));
    if (!goalMatches) continue;

    const capMatches =
      group.capPatterns.some(pat => lowerDesc.includes(pat)) ||
      group.capPatterns.some(pat => capId.includes(pat));

    if (capMatches && group.score > bestScore) {
      bestScore = group.score;
    }
  }

  return bestScore;
}

/**
 * In a real implementation, this would call an LLM (e.g., using AI SDK)
 * to score descriptions against the goal. For TDD Phase 1, we use a
 * heuristic keyword matcher to satisfy the interface tests.
 */
export async function resolveRoute(
  goal: string,
  capabilities: CapabilityDescription[]
): Promise<RouteResult> {
  const scored = capabilities.map(cap => ({
    id: cap.id,
    confidence: scoreCapability(goal, cap),
  }));

  scored.sort((a, b) => b.confidence - a.confidence);

  const best = scored[0];
  if (!best || best.confidence === 0) {
    return { selected_id: null, confidence: 0.1 };
  }

  return { selected_id: best.id, confidence: best.confidence };
}

/**
 * Returns scores for ALL capabilities, sorted by confidence descending.
 */
export async function previewRoutes(
  goal: string,
  capabilities: CapabilityDescription[],
  config?: RouteConfig
): Promise<Array<{ id: string; confidence: number }>> {
  const scored = capabilities.map(cap => ({
    id: cap.id,
    confidence: scoreCapability(goal, cap),
  }));

  scored.sort((a, b) => b.confidence - a.confidence);
  return scored;
}

/**
 * Wraps resolveRoute with fallback logic.
 * If best confidence is below minConfidence, returns the fallbackTeamId.
 */
export async function routeWithFallback(
  goal: string,
  capabilities: CapabilityDescription[],
  config?: RouteConfig
): Promise<RouteResult> {
  const minConfidence = config?.minConfidence ?? 0.55;

  const result = await resolveRoute(goal, capabilities);

  if (result.confidence < minConfidence) {
    if (config?.fallbackTeamId) {
      return { selected_id: config.fallbackTeamId, confidence: 0.55 };
    }
    // No fallback configured — return original low confidence result
    return result;
  }

  return result;
}
