export function wilson95(passed: number, total: number): { lower: number; upper: number; method: string; total: number } | null;
export function observedAttempts(rows: Array<Record<string, unknown>>): Record<string, unknown>;
export function classificationMetrics(rows: Array<Record<string, unknown>>, expected: (row: Record<string, unknown>) => unknown,
  actual: (row: Record<string, unknown>) => unknown, labels: string[]): Record<string, unknown>;
export function buildEvaluationMetrics(cases: Array<Record<string, unknown>>, session: string): Record<string, unknown>;
export function teamPlanContract(tasks: unknown): boolean;
export function intentSlotAvailable(boundary: unknown, options?: { searchSelected?: boolean; searchCompleted?: boolean; searchMode?: string }): { allowed: boolean; searchReserve: number };
