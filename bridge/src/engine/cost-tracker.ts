export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

export class CostTracker {
  private startTime = 0;

  start(): void {
    this.startTime = Date.now();
  }

  finish(usage: { input_tokens: number; output_tokens: number; cost_usd?: number }): UsageStats {
    const durationMs = Date.now() - this.startTime;
    const costUsd = usage.cost_usd ?? this.estimateCost(usage.input_tokens, usage.output_tokens);
    return {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      costUsd,
      durationMs,
    };
  }

  static format(stats: UsageStats): string {
    const tokens = `${formatTokens(stats.inputTokens)}/${formatTokens(stats.outputTokens)} tok`;
    const cost = `$${stats.costUsd.toFixed(2)}`;
    const duration = formatDuration(stats.durationMs);
    return `📊 ${tokens} | ${cost} | ${duration}`;
  }

  private estimateCost(inputTokens: number, outputTokens: number): number {
    const inputRate = process.env.TL_COST_INPUT_PER_M ? parseFloat(process.env.TL_COST_INPUT_PER_M) : 3;
    const outputRate = process.env.TL_COST_OUTPUT_PER_M ? parseFloat(process.env.TL_COST_OUTPUT_PER_M) : 15;
    return (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000;
  }
}
