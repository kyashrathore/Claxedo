export interface ScopedQuestion {
  id: string;
  question: string;
  scope: string;
  confidence?: number;
}

export interface PlanResult {
  runId: string;
  questions: ScopedQuestion[];
  maxQuestions: number;
}

export class PlanningService {
  private maxQuestions: number;

  constructor(maxQuestions: number = 7) {
    this.maxQuestions = maxQuestions;
  }

  decompose(goal: string): ScopedQuestion[] {
    // Simple heuristic decomposition: split by natural boundaries
    // In production this would use an LLM
    const keywords = goal.toLowerCase();
    const questions: ScopedQuestion[] = [];
    let qId = 1;

    // Generate scoped questions based on goal keywords
    if (
      keywords.includes("ui") ||
      keywords.includes("frontend") ||
      keywords.includes("design")
    ) {
      questions.push({
        id: `q_${qId++}`,
        question: "What UI components need to be created or modified?",
        scope: "frontend",
      });
    }
    if (
      keywords.includes("api") ||
      keywords.includes("backend") ||
      keywords.includes("server")
    ) {
      questions.push({
        id: `q_${qId++}`,
        question: "What API endpoints are required?",
        scope: "backend",
      });
    }
    if (
      keywords.includes("database") ||
      keywords.includes("data") ||
      keywords.includes("schema")
    ) {
      questions.push({
        id: `q_${qId++}`,
        question: "What data model changes are needed?",
        scope: "data",
      });
    }
    if (keywords.includes("test") || keywords.includes("quality")) {
      questions.push({
        id: `q_${qId++}`,
        question: "What test coverage is required?",
        scope: "testing",
      });
    }
    if (
      keywords.includes("deploy") ||
      keywords.includes("infrastructure")
    ) {
      questions.push({
        id: `q_${qId++}`,
        question: "What infrastructure changes are needed?",
        scope: "infra",
      });
    }
    // Always add a general question
    questions.push({
      id: `q_${qId++}`,
      question: "What are the acceptance criteria?",
      scope: "general",
    });

    return questions.slice(0, this.maxQuestions);
  }

  plan(runId: string, goal: string): PlanResult {
    const questions = this.decompose(goal);
    return { runId, questions, maxQuestions: this.maxQuestions };
  }

  dispatch(
    plan: PlanResult
  ): Array<{ questionId: string; scope: string; ready: boolean }> {
    // Mark all questions as ready for dispatch
    return plan.questions.map((q) => ({
      questionId: q.id,
      scope: q.scope,
      ready: true,
    }));
  }
}
