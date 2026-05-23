import { t, type Locale } from '../../shared/i18n/index.js';

export interface ModelUsageEntry {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
}

export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
  costUsd: number;
  costEstimated: boolean;
  durationMs: number;
  sessionTotalUsd?: number;
  queryCount?: number;
  modelUsage?: Record<string, ModelUsageEntry>;
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

function positiveNumber(n: number | undefined): number {
  return n !== undefined && Number.isFinite(n) && n > 0 ? n : 0;
}

/** Format per-model cost breakdown. Returns null if only one model or no data. */
function formatModelBreakdown(modelUsage?: Record<string, ModelUsageEntry>): string | null {
  if (!modelUsage) return null;
  const entries = Object.entries(modelUsage).filter(([, u]) => u.costUSD && u.costUSD > 0);
  if (entries.length <= 1) return null;
  return entries
    .map(([model, u]) => {
      const short = model.replace(/-\d{8}$/, '');
      return `${short} $${u.costUSD!.toFixed(2)}`;
    })
    .join(' + ');
}

export class CostTracker {
  private startTime = 0;
  private sessionTotal = 0;
  private _queryCount = 0;

  start(): void {
    this.startTime = Date.now();
  }

  finish(usage: {
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens?: number;
    reasoning_output_tokens?: number;
    cost_usd?: number;
    model_usage?: Record<string, ModelUsageEntry>;
  }): UsageStats {
    const durationMs = Date.now() - this.startTime;
    const estimatedCost =
      usage.cost_usd === undefined
        ? this.estimateCost(usage.input_tokens, usage.output_tokens)
        : undefined;
    const costUsd = usage.cost_usd ?? estimatedCost ?? 0;
    this._queryCount++;
    this.sessionTotal += costUsd;
    return {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      ...(usage.cached_input_tokens !== undefined
        ? { cachedInputTokens: usage.cached_input_tokens }
        : {}),
      ...(usage.reasoning_output_tokens !== undefined
        ? { reasoningOutputTokens: usage.reasoning_output_tokens }
        : {}),
      costUsd,
      costEstimated: estimatedCost !== undefined,
      durationMs,
      sessionTotalUsd: this.sessionTotal,
      queryCount: this._queryCount,
      ...(usage.model_usage ? { modelUsage: usage.model_usage } : {}),
    };
  }

  get queryCount(): number {
    return this._queryCount;
  }

  static format(stats: UsageStats, _locale: Locale = 'zh'): string {
    const duration = formatDuration(stats.durationMs);
    // When tokens are 0, show only duration.
    if (stats.inputTokens === 0 && stats.outputTokens === 0) {
      return duration;
    }

    const cachedInputTokens = positiveNumber(stats.cachedInputTokens);
    const freshInputTokens = Math.max(0, stats.inputTokens - cachedInputTokens);
    const reasoningOutputTokens = positiveNumber(stats.reasoningOutputTokens);
    const tokenParts = [
      `${t('cost.input')} ${formatTokens(freshInputTokens)}`,
      `${t('cost.output')} ${formatTokens(stats.outputTokens)}`,
    ];
    if (reasoningOutputTokens > 0) {
      tokenParts.push(`${t('cost.reasoning')} ${formatTokens(reasoningOutputTokens)}`);
    }
    if (cachedInputTokens > 0) {
      tokenParts.push(`${t('cost.cached')} ${formatTokens(cachedInputTokens)}`);
    }
    const tokens = tokenParts.join(' / ');

    // Only show cost when non-zero (providers without cost_usd report 0)
    if (stats.costUsd > 0 && !stats.costEstimated) {
      const cost = `$${stats.costUsd.toFixed(2)}`;
      // Per-model breakdown when multiple models used
      const modelBreakdown = formatModelBreakdown(stats.modelUsage);
      const costPart = modelBreakdown || cost;
      if (stats.queryCount && stats.queryCount > 1 && stats.sessionTotalUsd != null) {
        return `${tokens} | ${costPart} (Σ $${stats.sessionTotalUsd.toFixed(2)}) | ${duration}`;
      }
      return `${tokens} | ${costPart} | ${duration}`;
    }
    return `${tokens} | ${duration}`;
  }

  private estimateCost(inputTokens: number, outputTokens: number): number | undefined {
    if (!process.env.TL_COST_INPUT_PER_M || !process.env.TL_COST_OUTPUT_PER_M) return undefined;
    const inputRate = parseFloat(process.env.TL_COST_INPUT_PER_M);
    const outputRate = parseFloat(process.env.TL_COST_OUTPUT_PER_M);
    if (!Number.isFinite(inputRate) || !Number.isFinite(outputRate)) return undefined;
    return (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000;
  }
}
