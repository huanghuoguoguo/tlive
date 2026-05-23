/** Agent tools that need an interactive bridge-side answer before execution. */
export const DEFERRED_TOOLS = ['EnterPlanMode', 'EnterWorktree'] as const;

export type DeferredToolName = (typeof DEFERRED_TOOLS)[number];

export function isDeferredToolName(toolName: string): toolName is DeferredToolName {
  return DEFERRED_TOOLS.includes(toolName as DeferredToolName);
}
