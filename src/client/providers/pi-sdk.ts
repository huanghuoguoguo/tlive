import { VERSION as PI_VERSION } from '@earendil-works/pi-coding-agent';
import type {
  AgentProvider,
  AgentProviderCapabilities,
  CreateSessionParams,
  StreamChatParams,
  StreamChatResult,
} from '../../shared/providers/base.js';
import { PiLiveSession, toPiThinkingLevel, type PiSessionOptions } from './pi-live-session.js';
import type { PiRuntimeOptions } from './pi-config.js';

export { PI_VERSION };

export class PiSDKProvider implements AgentProvider {
  readonly kind = 'pi' as const;
  readonly displayName = 'Pi';
  readonly capabilities = {
    runtimeMode: 'interactive',
    nativeSteer: true,
    nativeQueue: true,
    interactivePermissions: false,
    askUserQuestion: false,
    deferredTools: false,
    settingSources: false,
    sessionResume: true,
    imageInputs: true,
  } satisfies AgentProviderCapabilities;

  constructor(private readonly runtimeOptions: PiRuntimeOptions = {}) {
    const model = runtimeOptions.model ? ` model=${runtimeOptions.model}` : '';
    console.log(`[pi-sdk] Using Pi provider${model}`);
  }

  createSession(params: CreateSessionParams): PiLiveSession {
    return new PiLiveSession({
      ...this.runtimeOptions,
      ...params,
      model: params.model ?? this.runtimeOptions.model,
      thinkingLevel:
        this.runtimeOptions.thinkingLevel ?? toPiThinkingLevel(params.effort),
    });
  }

  streamChat(params: StreamChatParams): StreamChatResult {
    const session = this.createSession({
      workingDirectory: params.workingDirectory,
      sessionId: params.sessionId,
      model: params.model,
      effort: params.effort,
      appendSystemPrompt: undefined,
    } satisfies PiSessionOptions);
    return session.startTurn(params.prompt, {
      attachments: params.attachments,
      model: params.model,
      effort: params.effort,
    });
  }
}
