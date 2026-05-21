import type { BaseChannelAdapter } from '../../channels/base.js';
import type { InboundMessage } from '../../channels/types.js';
import type {
  AskUserQuestionHandler,
  DeferredToolHandler,
  PermissionRequestHandler,
} from '../../providers/base.js';
import type { ChannelBinding } from '../../store/interface.js';
import type { ChannelRouter } from '../../utils/router.js';
import type { MessageRenderer } from '../messages/renderer.js';
import { SDKAskQuestionHandler } from '../sdk/ask-question-handler.js';
import { SDKDeferredToolHandler } from '../sdk/deferred-tool-handler.js';
import { SDKPermissionHandler } from '../sdk/permission-handler.js';
import type { InteractionState } from '../state/interaction-state.js';
import type { SessionStateManager } from '../state/session-state.js';
import type { PermissionCoordinator } from './permission.js';

interface QuerySdkInteractionsFactoryOptions {
  permissions: PermissionCoordinator;
  state: SessionStateManager;
  router: ChannelRouter;
  interactionState: InteractionState;
}

interface QuerySdkInteractionsOptions {
  adapter: BaseChannelAdapter;
  msg: InboundMessage;
  binding: ChannelBinding;
  renderer: MessageRenderer;
  reactions: { permission: string; processing: string };
}

export interface QuerySdkInteractions {
  permission: PermissionRequestHandler;
  askQuestion: AskUserQuestionHandler;
  deferredTool: DeferredToolHandler;
}

/** Builds the per-turn SDK interaction handlers and their cross-handler wiring. */
export class QuerySdkInteractionsFactory {
  constructor(private readonly options: QuerySdkInteractionsFactoryOptions) {}

  create({
    adapter,
    msg,
    binding,
    renderer,
    reactions,
  }: QuerySdkInteractionsOptions): QuerySdkInteractions {
    const permissionHandler = new SDKPermissionHandler({
      adapter,
      msg,
      binding,
      permissions: this.options.permissions,
      state: this.options.state,
      router: this.options.router,
      renderer,
      reactions,
      askQuestionApproved: false,
    });

    const askQuestionHandler = new SDKAskQuestionHandler({
      adapter,
      msg,
      binding,
      permissions: this.options.permissions,
      interactionState: this.options.interactionState,
    });

    const deferredToolHandler = new SDKDeferredToolHandler({
      adapter,
      msg,
      binding,
      permissions: this.options.permissions,
      interactionState: this.options.interactionState,
    });

    askQuestionHandler.setOnApproved(() => permissionHandler.setAskQuestionApproved(true));

    return {
      permission: permissionHandler.handle.bind(permissionHandler),
      askQuestion: askQuestionHandler.handle.bind(askQuestionHandler),
      deferredTool: deferredToolHandler.handle.bind(deferredToolHandler),
    };
  }
}
