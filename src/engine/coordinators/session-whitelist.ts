/**
 * Manages dynamic session whitelist for allowed tools and Bash prefixes.
 *
 * Handles:
 * - exactCommandsBySession: Exact tool-input approvals keyed by bridge sessionId
 * - allowedToolsBySession: Dynamic tool whitelist keyed by bridge sessionId
 * - allowedBashPrefixesBySession: Dynamic Bash prefix whitelist keyed by bridge sessionId
 */
export class SessionWhitelist {
  /** Exact tool/input approvals keyed by bridge sessionId */
  private exactCommandsBySession = new Map<string, Set<string>>();
  /** Dynamic session whitelist — keyed by bridge sessionId */
  private allowedToolsBySession = new Map<string, Set<string>>();
  /** Dynamic Bash prefix whitelist — keyed by bridge sessionId */
  private allowedBashPrefixesBySession = new Map<string, Set<string>>();

  // --- Tool whitelist ---

  /** Check if a tool is allowed by the dynamic session whitelist */
  isToolAllowed(sessionId: string | undefined, toolName: string, toolInput: Record<string, unknown>): boolean {
    if (!sessionId) return false;
    const exactCommands = this.exactCommandsBySession.get(sessionId);
    if (exactCommands?.has(this.commandKey(toolName, toolInput))) return true;

    const allowedTools = this.allowedToolsBySession.get(sessionId);
    if (allowedTools?.has(toolName)) return true;
    if (toolName === 'Bash') {
      const cmd = typeof toolInput.command === 'string' ? toolInput.command : '';
      const prefix = this.extractBashPrefix(cmd);
      const allowedPrefixes = this.allowedBashPrefixesBySession.get(sessionId);
      if (prefix && allowedPrefixes?.has(prefix)) return true;
    }
    return false;
  }

  /** Remember the exact current tool invocation for this bridge session. */
  rememberSameCommandAllowance(
    sessionId: string | undefined,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): void {
    if (!sessionId) return;
    let commands = this.exactCommandsBySession.get(sessionId);
    if (!commands) {
      commands = new Set<string>();
      this.exactCommandsBySession.set(sessionId, commands);
    }
    commands.add(this.commandKey(toolName, toolInput));
  }

  /** Add a tool to the session whitelist */
  addAllowedTool(sessionId: string | undefined, toolName: string): void {
    if (!sessionId) return;
    let tools = this.allowedToolsBySession.get(sessionId);
    if (!tools) {
      tools = new Set<string>();
      this.allowedToolsBySession.set(sessionId, tools);
    }
    tools.add(toolName);
  }

  /** Add a Bash command prefix to the session whitelist */
  addAllowedBashPrefix(sessionId: string | undefined, prefix: string): void {
    if (!sessionId || !prefix) return;
    let prefixes = this.allowedBashPrefixesBySession.get(sessionId);
    if (!prefixes) {
      prefixes = new Set<string>();
      this.allowedBashPrefixesBySession.set(sessionId, prefixes);
    }
    prefixes.add(prefix);
  }

  /** Remember an allow_always decision for the current bridge session. */
  rememberSessionAllowance(
    sessionId: string | undefined,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): void {
    if (!sessionId) return;
    if (toolName === 'Bash') {
      const cmd = typeof toolInput.command === 'string' ? toolInput.command : '';
      const prefix = this.extractBashPrefix(cmd);
      if (prefix) {
        this.addAllowedBashPrefix(sessionId, prefix);
      }
      return;
    }
    this.addAllowedTool(sessionId, toolName);
  }

  /** Extract the first word of a Bash command as a prefix */
  extractBashPrefix(command: string): string {
    return command.trim().split(/\s+/)[0] || '';
  }

  /** Get the size of allowed tools set for a session */
  getAllowedToolsSize(sessionId?: string): number {
    if (!sessionId) return 0;
    return this.allowedToolsBySession.get(sessionId)?.size ?? 0;
  }

  /** Get the size of allowed Bash prefixes set for a session */
  getAllowedBashPrefixesSize(sessionId?: string): number {
    if (!sessionId) return 0;
    return this.allowedBashPrefixesBySession.get(sessionId)?.size ?? 0;
  }

  /** Clear the dynamic session whitelist (called on /new or session expiry) */
  clearSessionWhitelist(sessionId?: string): void {
    if (!sessionId) {
      this.exactCommandsBySession.clear();
      this.allowedToolsBySession.clear();
      this.allowedBashPrefixesBySession.clear();
      return;
    }
    this.exactCommandsBySession.delete(sessionId);
    this.allowedToolsBySession.delete(sessionId);
    this.allowedBashPrefixesBySession.delete(sessionId);
  }

  private commandKey(toolName: string, toolInput: Record<string, unknown>): string {
    if (toolName === 'Bash' && typeof toolInput.command === 'string') {
      return `${toolName}\0${toolInput.command.trim()}`;
    }
    return `${toolName}\0${this.stableStringify(toolInput)}`;
  }

  private stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return `[${value.map(item => this.stableStringify(item)).join(',')}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${this.stableStringify(item)}`);
    return `{${entries.join(',')}}`;
  }
}
