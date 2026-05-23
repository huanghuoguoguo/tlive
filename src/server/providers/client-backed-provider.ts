import type {
  AgentProvider,
  AgentProviderCapabilities,
  CreateSessionParams,
  StreamChatParams,
  StreamChatResult,
  LiveSession,
} from '../../shared/providers/base.js';
import type { AgentProviderKind } from '../../shared/providers/kinds.js';
import { RemoteAgentProvider } from './remote-agent-provider.js';
import type { RemoteClientRegistry } from '../clients/client-registry.js';

export interface ClientBackedAgentProviderOptions {
  kind: AgentProviderKind;
  remoteClientRegistry: RemoteClientRegistry;
}

export class ClientBackedAgentProvider implements AgentProvider {
  readonly kind: AgentProviderKind;
  readonly displayName: string;
  readonly capabilities: AgentProviderCapabilities;
  private readonly remoteProvider: RemoteAgentProvider;

  constructor(options: ClientBackedAgentProviderOptions) {
    this.kind = options.kind;
    this.remoteProvider = new RemoteAgentProvider(options.kind, options.remoteClientRegistry);
    this.displayName = this.remoteProvider.displayName;
    this.capabilities = this.remoteProvider.capabilities;
  }

  createSession(params: CreateSessionParams): LiveSession {
    return this.remoteProvider.createSession(params);
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
