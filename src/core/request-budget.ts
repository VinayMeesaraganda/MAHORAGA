export interface DailyRequestBudget {
  day: string;
  calls: number;
}

/** Reserve before sending: failed or interrupted requests still consume the allowance. */
export function reserveRequest(
  current: DailyRequestBudget | undefined,
  day: string,
  limit: number
): DailyRequestBudget {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Invalid daily LLM request limit");
  const calls = current?.day === day ? current.calls : 0;
  if (!Number.isInteger(calls) || calls < 0 || calls >= limit) throw new Error("Daily LLM request limit reached");
  return { day, calls: calls + 1 };
}
