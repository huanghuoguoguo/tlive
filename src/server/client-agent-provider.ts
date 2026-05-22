import type {
  AgentProvider,
  AgentProviderCapabilities,
  CreateSessionParams,
  StreamChatParams,
  StreamChatResult,
  LiveSession,
} from '../providers/base.js';
import type { AgentProviderKind } from '../providers/kinds.js';
import { RemoteAgentProvider } from './remote-agent-provider.js';
import type { RemoteClientRegistry } from './client-registry.js';

export const LOCAL_CLIENT_ID = 'local';

export interface ClientBackedAgentProviderOptions {
  kind: AgentProviderKind;
  localProvider?: AgentProvider;
  remoteClientRegistry?: RemoteClientRegistry;
}

export class ClientBackedAgentProvider implements AgentProvider {
  readonly kind: AgentProviderKind;
  readonly displayName: string;
  readonly capabilities: AgentProviderCapabilities;
  private readonly remoteProvider?: RemoteAgentProvider;

  constructor(private readonly options: ClientBackedAgentProviderOptions) {
    this.kind = options.kind;
    this.displayName =
      options.localProvider?.displayName ??
      (options.kind === 'claude' ? 'Remote Claude Code' : 'Remote Codex');
    this.capabilities =
      options.localProvider?.capabilities ??
      (options.kind === 'claude'
        ? {
            runtimeMode: 'interactive',
            nativeSteer: true,
            nativeQueue: true,
            interactivePermissions: true,
            askUserQuestion: true,
            deferredTools: true,
            settingSources: true,
            sessionResume: true,
            imageInputs: true,
          }
        : {
            runtimeMode: 'turn-based',
            nativeSteer: false,
            nativeQueue: false,
            interactivePermissions: false,
            askUserQuestion: false,
            deferredTools: false,
            settingSources: false,
            sessionResume: true,
            imageInputs: true,
          });
    this.remoteProvider = options.remoteClientRegistry
      ? new RemoteAgentProvider(options.kind, options.remoteClientRegistry)
      : undefined;
  }

  createSession(params: CreateSessionParams): LiveSession {
    if (params.clientId && params.clientId !== LOCAL_CLIENT_ID) {
      if (!this.remoteProvider) {
        throw new Error(`Remote client provider is not enabled: ${params.clientId}`);
      }
      return this.remoteProvider.createSession(params);
    }
    if (!this.options.localProvider) {
      if (!this.remoteProvider) throw new Error(`No provider is configured: ${this.kind}`);
      return this.remoteProvider.createSession(params);
    }
    return this.options.localProvider.createSession(params);
  }

  streamChat(params: StreamChatParams): StreamChatResult {
    const session = this.createSession({
      workingDirectory: params.workingDirectory,
      sessionId: params.sessionId,
      clientId: params.clientId,
      model: params.model,
      effort: params.effort,
      settingSources: params.settingSources,
    });
    return session.startTurn(params.prompt, {
      attachments: params.attachments,
      onPermissionRequest: params.onPermissionRequest,
      onAskUserQuestion: params.onAskUserQuestion,
      onDeferredTool: params.onDeferredTool,
      effort: params.effort,
      model: params.model,
    });
  }
}
