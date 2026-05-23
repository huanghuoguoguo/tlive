import type {
  AgentProvider,
  AgentProviderCapabilities,
  CreateSessionParams,
  EffortLevel,
  StreamChatParams,
  StreamChatResult,
} from '../../shared/providers/base.js';
import { CodexLiveSession, type CodexRuntimeOptions } from './codex-live-session.js';

export class CodexSDKProvider implements AgentProvider {
  readonly kind = 'codex' as const;
  readonly displayName = 'Codex';
  readonly capabilities = {
    runtimeMode: 'turn-based',
    nativeSteer: false,
    nativeQueue: false,
    interactivePermissions: false,
    askUserQuestion: false,
    deferredTools: false,
    settingSources: false,
    sessionResume: true,
    imageInputs: true,
  } satisfies AgentProviderCapabilities;

  constructor(private readonly runtimeOptions: CodexRuntimeOptions = {}) {
    const model = runtimeOptions.model ? ` model=${runtimeOptions.model}` : '';
    const sandbox = runtimeOptions.sandboxMode ? ` sandbox=${runtimeOptions.sandboxMode}` : '';
    console.log(`[codex-sdk] Using Codex provider${model}${sandbox}`);
  }

  createSession(params: CreateSessionParams): CodexLiveSession {
    return new CodexLiveSession({
      ...this.runtimeOptions,
      ...params,
      model: params.model ?? this.runtimeOptions.model,
      modelReasoningEffort:
        this.runtimeOptions.modelReasoningEffort ?? toCodexReasoningEffort(params.effort),
    });
  }

  streamChat(params: StreamChatParams): StreamChatResult {
    const session = this.createSession({
      workingDirectory: params.workingDirectory,
      sessionId: params.sessionId,
      model: params.model,
      effort: params.effort,
    });
    return session.startTurn(params.prompt, {
      attachments: params.attachments,
      model: params.model,
      effort: params.effort,
    });
  }
}

export function toCodexReasoningEffort(
  effort: EffortLevel | undefined,
): CodexRuntimeOptions['modelReasoningEffort'] {
  if (effort === 'max') return 'xhigh';
  return effort;
}
