import type { StepUsage } from '../../../shared/canonical/schema.js';

/** One group row, one line: 3.2k reads narrower than 3,200 and 64k than 64.0k. */
function tokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  const thousands = tokens / 1000;
  return `${Number(thousands.toFixed(thousands < 100 ? 1 : 0))}k`;
}

/**
 * Cost of the round-trips behind a group. Parallel calls share one round-trip, so each step counts
 * once; context is cumulative rather than additive, so the newest step wins over the sum.
 */
export function stepUsageSuffix(tools: readonly { usage?: StepUsage }[]): string {
  const steps = new Map<number, StepUsage>();
  for (const tool of tools) if (tool.usage) steps.set(tool.usage.step, tool.usage);
  if (!steps.size) return '';
  let input = 0;
  let output = 0;
  let latest: StepUsage | undefined;
  for (const usage of steps.values()) {
    input += usage.inputTokens;
    output += usage.outputTokens;
    if (!latest || usage.step > latest.step) latest = usage;
  }
  const context = latest!.contextTokens;
  const window = latest!.contextWindow ?? 0;
  // A rounding-to-zero group still used context; 0% would read as "nothing loaded".
  const percent = window > 0 ? ` ${Math.max(1, Math.round((context / window) * 100))}%` : '';
  return ` ↓${tokenCount(input)} ↑${tokenCount(output)} ${tokenCount(context)}${percent}`;
}
