import type { CanonicalEvent } from '../../shared/canonical/schema.js';

interface SdkLogMessage {
  type: string;
  subtype?: string;
  num_turns?: unknown;
}

export class ClaudeEventLogger {
  private pendingStreamEventCount = 0;
  private pendingStreamEventSubtypes = new Map<string, number>();

  constructor(private readonly prefix: string) {}

  logSdkMessage(msg: SdkLogMessage): void {
    const subtype = msg.subtype ? `.${msg.subtype}` : '';
    if (msg.type === 'stream_event') {
      this.pendingStreamEventCount++;
      this.pendingStreamEventSubtypes.set(
        subtype,
        (this.pendingStreamEventSubtypes.get(subtype) ?? 0) + 1,
      );
      return;
    }

    this.flush();
    const turns = msg.num_turns !== undefined ? ` turns=${msg.num_turns}` : '';
    console.log(`[${this.prefix}] msg: ${msg.type}${subtype}${turns}`);
  }

  logMappedEvents(events: CanonicalEvent[]): void {
    if (process.env.TL_DEBUG_EVENTS !== '1' || events.length === 0) return;

    const summary = events
      .map((event) => {
        switch (event.kind) {
          case 'thinking_delta':
          case 'text_delta':
            return `${event.kind}:${event.text.length}`;
          case 'tool_start':
            return `tool_start:${event.name}`;
          case 'tool_result':
            return `tool_result:${event.toolUseId}:${event.content.length}`;
          case 'agent_start':
          case 'agent_progress':
            return `${event.kind}:${event.description}`;
          case 'agent_complete':
            return `agent_complete:${event.status}`;
          default:
            return event.kind;
        }
      })
      .join(', ');
    console.log(`[${this.prefix}] mapped events: ${summary}`);
  }

  flush(): void {
    if (this.pendingStreamEventCount === 0) return;

    const subtypeSummary = [...this.pendingStreamEventSubtypes.entries()]
      .filter(([, count]) => count > 0)
      .map(([subtype, count]) => (subtype ? `${subtype}×${count}` : `plain×${count}`))
      .join(', ');
    const suffix =
      subtypeSummary && this.pendingStreamEventSubtypes.size > 1 ? ` (${subtypeSummary})` : '';

    console.log(`[${this.prefix}] msg: stream_event ×${this.pendingStreamEventCount}${suffix}`);
    this.pendingStreamEventCount = 0;
    this.pendingStreamEventSubtypes.clear();
  }
}
