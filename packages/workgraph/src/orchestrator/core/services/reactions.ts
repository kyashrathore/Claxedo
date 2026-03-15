export interface ReactionRule {
  id: string;
  trigger: string; // event type that triggers this rule
  condition: (event: any, state: any) => boolean;
  action: (event: any, state: any) => { type: string; payload: any };
  cooldownMs: number; // minimum time between firings
}

export class ReactionEngine {
  private rules: ReactionRule[] = [];
  private lastFired: Map<string, number> = new Map(); // ruleId -> timestamp

  addRule(rule: ReactionRule): void {
    this.rules.push(rule);
  }

  removeRule(ruleId: string): void {
    this.rules = this.rules.filter(r => r.id !== ruleId);
  }

  evaluate(event: any, state: any): Array<{ ruleId: string; action: { type: string; payload: any } }> {
    const now = Date.now();
    const results: Array<{ ruleId: string; action: { type: string; payload: any } }> = [];

    for (const rule of this.rules) {
      if (rule.trigger !== event.type) continue;

      const lastTime = this.lastFired.get(rule.id) || 0;
      if (now - lastTime < rule.cooldownMs) continue;

      if (rule.condition(event, state)) {
        results.push({ ruleId: rule.id, action: rule.action(event, state) });
        this.lastFired.set(rule.id, now);
      }
    }
    return results;
  }

  getRules(): ReactionRule[] {
    return [...this.rules];
  }
}
