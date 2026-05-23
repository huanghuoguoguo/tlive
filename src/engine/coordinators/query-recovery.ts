import type { BaseChannelAdapter } from '../../channels/base.js';
import { withInboundReplyContext } from '../../channels/reply-context.js';
import type { InboundMessage } from '../../channels/types.js';
import { shortPath } from '../../core/path.js';
import type { ChannelBinding, BridgeStore } from '../../store/interface.js';
import type { SDKEngine, ResolvedSessionTarget } from '../sdk/engine.js';
import type { SessionStateManager } from '../state/session-state.js';
import { SessionStaleError } from '../state/session-stale-error.js';
import { t } from '../../i18n/index.js';

interface QueryRecoveryPolicyOptions {
  defaultWorkdir: string;
  sdkEngine: SDKEngine;
  state: SessionStateManager;
  store: BridgeStore;
}

interface RecoverStaleSessionInput {
  adapter: BaseChannelAdapter;
  msg: InboundMessage;
  scopeId: string;
  currentBinding: ChannelBinding;
  sessionTarget: ResolvedSessionTarget;
  requestId?: string;
  renderer: { dispose(): void };
  presenter: { dispose(): void | Promise<void> };
}

interface StaleSessionRecoveryResult {
  routeBinding: ChannelBinding;
  sessionTarget: ResolvedSessionTarget;
  resumeFallbackMessage: string;
}

/** Owns retry policy for provider/session failures that should be recovered in-place. */
export class QueryRecoveryPolicy {
  constructor(private readonly options: QueryRecoveryPolicyOptions) {}

  canRetryStaleSession(err: unknown, attemptCount: number, maxAttempts: number): boolean {
    return err instanceof SessionStaleError && attemptCount < maxAttempts;
  }

  async recoverStaleSession({
    adapter,
    msg,
    scopeId,
    currentBinding,
    sessionTarget,
    requestId,
    renderer,
    presenter,
  }: RecoverStaleSessionInput): Promise<StaleSessionRecoveryResult> {
    console.log(`[query] ${requestId} SESSION_STALE retrying with fresh session`);

    currentBinding.sdkSessionId = undefined;
    this.options.sdkEngine.updateSessionSdkSessionId?.(sessionTarget.sessionKey, undefined);
    this.options.sdkEngine.resetSessionRuntime?.(sessionTarget.sessionKey, 'expire');

    const recoveredTarget: ResolvedSessionTarget = {
      ...sessionTarget,
      sdkSessionId: undefined,
    };
    const routeBinding = { ...currentBinding };
    if (sessionTarget.source === 'current') {
      await this.options.store.saveBinding(currentBinding);
    }

    const staleTaskStartMsg = adapter.format({
      type: 'taskStart',
      chatId: msg.chatId,
      data: {
        cwd: shortPath(currentBinding.cwd || this.options.defaultWorkdir),
        permissionMode: this.options.state.getPermMode(
          msg.channelType,
          scopeId,
          currentBinding.sessionId,
        ),
        isNewSession: true,
        reason: 'stale',
      },
    });
    await adapter.send(withInboundReplyContext(staleTaskStartMsg, msg));

    renderer.dispose();
    await presenter.dispose();
    this.options.sdkEngine.setControlsForChat(
      this.options.state.stateKey(msg.channelType, scopeId),
      undefined,
      sessionTarget.sessionKey,
    );

    return {
      routeBinding,
      sessionTarget: recoveredTarget,
      resumeFallbackMessage: t('queryRecovery.staleSessionFallback'),
    };
  }
}
