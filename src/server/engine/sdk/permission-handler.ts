/**
 * SDK Permission Handler — handles tool permission requests during query execution.
 * Extracted from QueryOrchestrator for cleaner architecture.
 */

import type { BaseChannelAdapter } from '../../channels/base.js';
import type { InboundMessage } from '../../channels/types.js';
import type { PermissionCoordinator } from '../coordinators/permission.js';
import type { SessionStateManager } from '../state/session-state.js';
import type { MessageRenderer } from '../messages/renderer.js';
import type { Button } from '../../../shared/ui/types.js';
import { getToolCommand } from './tool-registry.js';
import type { ChannelRouter } from '../channel-router.js';
import type { ChannelBinding } from '../../store/interface.js';
import { generateId } from '../../../shared/core/id.js';
import { DEFAULT_PERMISSION_TIMEOUT_MS } from '../../../shared/core/timing.js';
import { permissionButtons } from '../../../shared/ui/buttons.js';
import { conversationScopeId } from '../../channels/conversation-context.js';

interface SDKPermissionHandlerContext {
  adapter: BaseChannelAdapter;
  msg: InboundMessage;
  binding: ChannelBinding;
  permissions: PermissionCoordinator;
  state: SessionStateManager;
  router: ChannelRouter;
  renderer: MessageRenderer;
  reactions: { permission: string; processing: string };
  /** Set to true after AskUserQuestion approval to auto-allow next tool */
  askQuestionApproved: boolean;
}

export class SDKPermissionHandler {
  private context: SDKPermissionHandlerContext;

  constructor(context: SDKPermissionHandlerContext) {
    this.context = context;
  }

  /** Set askQuestionApproved flag after AskUserQuestion approval */
  setAskQuestionApproved(value: boolean): void {
    this.context.askQuestionApproved = value;
  }

  /** Main handler for SDK permission requests */
  async handle(
    toolName: string,
    toolInput: Record<string, unknown>,
    _promptSentence: string,
    signal?: AbortSignal,
  ): Promise<'allow' | 'allow_always' | 'deny'> {
    const { msg, binding, permissions, state, renderer } = this.context;
    const scopeId = conversationScopeId(msg);

    // Check perm mode dynamically (so /perm off mid-query takes effect)
    const permMode = state.getPermMode(msg.channelType, scopeId, binding.sessionId);
    if (permMode === 'off') {
      return 'allow' as const;
    }

    if (permissions.isToolAllowed(binding.sessionId, toolName, toolInput)) {
      console.log(`[bridge] Auto-allowed ${toolName} via session whitelist`);
      return 'allow' as const;
    }

    if (this.context.askQuestionApproved) {
      this.context.askQuestionApproved = false;
      console.log(`[bridge] Auto-allowed ${toolName} after AskUserQuestion approval`);
      return 'allow' as const;
    }

    const permId = generateId('sdk');
    const chatKey = state.stateKey(msg.channelType, scopeId);
    permissions.setPendingSdkPerm(chatKey, permId);
    console.log(`[bridge] Permission request: ${toolName} (${permId}) for ${chatKey}`);

    const abortCleanup = () => {
      console.log(`[bridge] Permission cancelled by SDK: ${toolName} (${permId})`);
      permissions.getGateway().resolve(permId, 'deny', 'Cancelled by SDK');
      permissions.clearPendingSdkPerm(chatKey);
      permissions.notePermissionResolved(chatKey, binding.sessionId, toolName, 'cancelled', permId);
      renderer.onPermissionResolved(permId);
    };
    if (signal?.aborted) {
      abortCleanup();
      return 'deny' as const;
    }
    signal?.addEventListener('abort', abortCleanup, { once: true });

    const inputStr = getToolCommand(toolName, toolInput) || JSON.stringify(toolInput, null, 2);
    permissions.notePermissionPending(chatKey, permId, binding.sessionId, toolName, inputStr);
    const buttons: Button[] = permissionButtons(permId, this.context.adapter.getLocale());
    renderer.onPermissionNeeded(toolName, inputStr, permId, buttons);

    const result = await permissions.getGateway().waitFor(permId, {
      timeoutMs: DEFAULT_PERMISSION_TIMEOUT_MS,
      onTimeout: () => {
        permissions.clearPendingSdkPerm(chatKey);
        permissions.clearPendingPermissionSnapshot(chatKey, permId);
        console.warn(`[bridge] Permission timeout: ${toolName} (${permId})`);
      },
    });
    signal?.removeEventListener('abort', abortCleanup);
    renderer.onPermissionResolved(permId);

    permissions.clearPendingSdkPerm(chatKey);
    if (result.grantScope === 'same_command') {
      permissions.rememberSameCommandAllowance(binding.sessionId, toolName, toolInput);
    }
    if (result.grantScope === 'session_all' && binding.sessionId) {
      state.setPermMode(msg.channelType, scopeId, binding.sessionId, 'off');
    }
    if (result.behavior === 'allow_always') {
      permissions.rememberSessionAllowance(binding.sessionId, toolName, toolInput);
    }
    permissions.notePermissionResolved(
      chatKey,
      binding.sessionId,
      toolName,
      result.behavior === 'deny' && signal?.aborted ? 'cancelled' : result.behavior,
      permId,
    );
    console.log(`[bridge] Permission resolved: ${toolName} (${permId}) → ${result.behavior}`);
    return result.behavior as 'allow' | 'allow_always' | 'deny';
  }
}
