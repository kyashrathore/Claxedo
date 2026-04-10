/**
 * Minimal cron next-run calculator.
 * Handles named presets and standard 5-field cron expressions.
 * Fields: minute hour dom month dow
 */

/**
 * Compute the next run time after `after` (defaults to now).
 * Named presets supported: @hourly, @daily, @weekly, @monthly.
 * For raw cron strings the five-field format is parsed.
 */
export function computeNextRun(schedule: string, after: Date = new Date()): Date {
  const s = schedule.trim().toLowerCase();

  switch (s) {
    case "@hourly": {
      const next = new Date(after);
      next.setSeconds(0, 0);
      next.setMinutes(0);
      next.setHours(next.getHours() + 1);
      return next;
    }
    case "@daily": {
      const next = new Date(after);
      next.setHours(0, 0, 0, 0);
      next.setDate(next.getDate() + 1);
      return next;
    }
    case "@weekly": {
      const next = new Date(after);
      next.setHours(0, 0, 0, 0);
      // Advance to next Sunday (day 0)
      const daysUntilSunday = (7 - next.getDay()) % 7 || 7;
      next.setDate(next.getDate() + daysUntilSunday);
      return next;
    }
    case "@monthly": {
      const next = new Date(after);
      next.setDate(1);
      next.setHours(0, 0, 0, 0);
      next.setMonth(next.getMonth() + 1);
      return next;
    }
    default:
      return parseCronNext(schedule, after);
  }
}

/**
 * Minimal 5-field cron parser.
 * Only handles numeric values, `*`, and `*\/n` step syntax.
 * Sufficient for common trigger schedules; not a full POSIX cron engine.
 */
function parseCronNext(expr: string, after: Date): Date {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    // Unrecognised format — fall back to +1 hour as a safe default
    const fallback = new Date(after);
    fallback.setHours(fallback.getHours() + 1, 0, 0, 0);
    return fallback;
  }

  const [minuteExpr, hourExpr, domExpr, monthExpr, dowExpr] =
    parts as [string, string, string, string, string];

  // Advance by 1 minute so we don't fire immediately if now matches
  const candidate = new Date(after.getTime() + 60_000);
  candidate.setSeconds(0, 0);

  // Search forward up to 2 years in minute increments (bounded)
  const limit = new Date(after.getTime() + 2 * 365 * 24 * 60 * 60 * 1000);

  while (candidate <= limit) {
    if (
      matchField(minuteExpr, candidate.getMinutes(), 0, 59) &&
      matchField(hourExpr, candidate.getHours(), 0, 23) &&
      matchField(domExpr, candidate.getDate(), 1, 31) &&
      matchField(monthExpr, candidate.getMonth() + 1, 1, 12) &&
      matchField(dowExpr, candidate.getDay(), 0, 6)
    ) {
      return candidate;
    }
    candidate.setTime(candidate.getTime() + 60_000);
  }

  // Should never reach here for valid cron expressions
  throw new Error(`Unable to compute next run for cron expression: "${expr}"`);
}

function matchField(expr: string, value: number, _min: number, _max: number): boolean {
  if (expr === "*") return true;

  // Step syntax: */n
  if (expr.startsWith("*/")) {
    const step = parseInt(expr.slice(2), 10);
    return Number.isFinite(step) && value % step === 0;
  }

  // Range: a-b
  if (expr.includes("-")) {
    const [lo, hi] = expr.split("-").map(Number) as [number, number];
    return value >= lo && value <= hi;
  }

  // List: a,b,c
  if (expr.includes(",")) {
    return expr.split(",").map(Number).includes(value);
  }

  // Single value
  return parseInt(expr, 10) === value;
}
