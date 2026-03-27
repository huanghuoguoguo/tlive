/**
 * CodexAdapter — maps Codex SDK ThreadEvent objects to CanonicalEvent[].
 * Mirrors ClaudeAdapter's pattern but for OpenAI Codex.
 */

import { canonicalEventSchema, type CanonicalEvent } from './schema.js';

export class CodexAdapter {
  private lastAgentText = '';
  private itemIdToToolId = new Map<string, string>();
  private toolIdCounter = 0;

  adapt(event: any): CanonicalEvent[] {
    switch (event.type) {
      case 'thread.started':
        return this.adaptThreadStarted(event);
      case 'turn.started':
        return [];
      case 'item.started':
        return this.adaptItemStarted(event);
      case 'item.updated':
        return this.adaptItemUpdated(event);
      case 'item.completed':
        return this.adaptItemCompleted(event);
      case 'turn.completed':
        return this.adaptTurnCompleted(event);
      case 'turn.failed':
        return this.adaptTurnFailed(event);
      case 'error':
        return [this.validate({ kind: 'error', message: event.message || 'Unknown Codex error' })];
      default:
        return [];
    }
  }

  private validate(event: CanonicalEvent): CanonicalEvent {
    return canonicalEventSchema.parse(event) as CanonicalEvent;
  }

  private nextToolId(): string {
    return `codex-tool-${++this.toolIdCounter}`;
  }

  private adaptThreadStarted(event: any): CanonicalEvent[] {
    return [this.validate({
      kind: 'status',
      sessionId: event.thread_id || '',
      model: event.model || 'codex',
    })];
  }

  private adaptItemStarted(event: any): CanonicalEvent[] {
    const item = event.item;
    if (!item) return [];

    switch (item.type) {
      case 'agent_message': {
        this.lastAgentText = '';
        return [];
      }
      case 'command_execution': {
        const toolId = this.nextToolId();
        if (item.id) this.itemIdToToolId.set(item.id, toolId);
        const command = Array.isArray(item.command) ? item.command.join(' ') : (item.command || '');
        return [this.validate({
          kind: 'tool_start',
          id: toolId,
          name: 'Bash',
          input: { command },
        })];
      }
      case 'file_change': {
        const toolId = this.nextToolId();
        if (item.id) this.itemIdToToolId.set(item.id, toolId);
        const toolName = item.kind === 'add' ? 'Write' : 'Edit';
        return [this.validate({
          kind: 'tool_start',
          id: toolId,
          name: toolName,
          input: { file_path: item.path || '' },
        })];
      }
      case 'reasoning':
        return [];
      case 'mcp_tool_call': {
        const toolId = this.nextToolId();
        if (item.id) this.itemIdToToolId.set(item.id, toolId);
        return [this.validate({
          kind: 'tool_start',
          id: toolId,
          name: item.tool || 'MCP',
          input: item.arguments || {},
        })];
      }
      default:
        return [];
    }
  }

  private adaptItemUpdated(event: any): CanonicalEvent[] {
    const item = event.item;
    if (!item) return [];

    if (item.type === 'agent_message') {
      const fullText = item.text || item.content || '';
      const delta = fullText.slice(this.lastAgentText.length);
      this.lastAgentText = fullText;
      if (delta) {
        return [this.validate({ kind: 'text_delta', text: delta })];
      }
    }

    if (item.type === 'reasoning') {
      const text = item.summary || item.text || '';
      if (text) {
        return [this.validate({ kind: 'thinking_delta', text })];
      }
    }

    return [];
  }

  private adaptItemCompleted(event: any): CanonicalEvent[] {
    const item = event.item;
    if (!item) return [];

    if (item.type === 'command_execution') {
      const toolId = this.itemIdToToolId.get(item.id) || item.id || '';
      const output = item.output || '';
      return [this.validate({
        kind: 'tool_result',
        toolUseId: toolId,
        content: output,
        isError: (item.exit_code !== undefined && item.exit_code !== 0) || item.status === 'failed',
      })];
    }

    if (item.type === 'file_change') {
      const toolId = this.itemIdToToolId.get(item.id) || item.id || '';
      return [this.validate({
        kind: 'tool_result',
        toolUseId: toolId,
        content: item.status === 'completed' ? 'Applied' : (item.status || 'done'),
        isError: item.status === 'failed',
      })];
    }

    if (item.type === 'mcp_tool_call') {
      const toolId = this.itemIdToToolId.get(item.id) || item.id || '';
      return [this.validate({
        kind: 'tool_result',
        toolUseId: toolId,
        content: typeof item.result === 'string' ? item.result : JSON.stringify(item.result || ''),
        isError: false,
      })];
    }

    if (item.type === 'agent_message') {
      // Final text — if we didn't get updates, emit the full text
      const text = item.text || item.content || '';
      if (text && !this.lastAgentText) {
        return [this.validate({ kind: 'text_delta', text })];
      }
    }

    return [];
  }

  private adaptTurnCompleted(event: any): CanonicalEvent[] {
    const usage = event.usage;
    return [this.validate({
      kind: 'query_result',
      sessionId: event.thread_id || '',
      isError: false,
      usage: {
        inputTokens: usage?.input_tokens || usage?.inputTokens || 0,
        outputTokens: usage?.output_tokens || usage?.outputTokens || 0,
        costUsd: usage?.cost_usd || usage?.costUsd,
      },
    })];
  }

  private adaptTurnFailed(event: any): CanonicalEvent[] {
    const error = event.error;
    return [this.validate({
      kind: 'error',
      message: error?.message || error?.code || 'Codex turn failed',
    })];
  }
}
