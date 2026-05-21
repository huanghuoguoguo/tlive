import { Logger } from '../../logger.js';
import type { AutomationBridge } from '../types/automation-bridge.js';
import type { WebhookRequest } from './webhook.js';
import type { ResolvedWebhookRoute } from './webhook-route-resolver.js';

export interface WebhookPromptDeliveryResult {
  success: boolean;
  sessionId?: string;
  error?: string;
}

export interface WebhookPromptDelivererOptions {
  bridge: AutomationBridge;
  sessionStrategy: 'reject' | 'create';
}

/** Delivers an already-routed webhook prompt into the bridge. */
export class WebhookPromptDeliverer {
  constructor(private readonly options: WebhookPromptDelivererOptions) {}

  async deliver(
    request: WebhookRequest,
    route: ResolvedWebhookRoute,
    injectedPrompt: string,
    requestId: string,
  ): Promise<WebhookPromptDeliveryResult> {
    const { event, silent } = request;
    const { channelType, chatId, workdir, projectName, settingSources } = route;

    const adapter = this.options.bridge.getAdapter(channelType);
    if (!adapter) {
      const enabledChannels =
        this.options.bridge
          .getAdapters()
          .map((a) => a.channelType)
          .join(', ') || 'none';
      return {
        success: false,
        error: `Channel '${channelType}' not available. Enabled channels: ${enabledChannels}`,
      };
    }

    if (this.options.sessionStrategy === 'reject') {
      const existingBinding = request.sessionId
        ? await this.options.bridge.getBindingBySessionId(request.sessionId)
        : await this.options.bridge.getBinding(channelType, chatId);
      const hasActiveSession = existingBinding
        ? this.options.bridge.hasActiveSession(channelType, chatId, existingBinding.cwd ?? workdir)
        : false;
      if (!existingBinding || !hasActiveSession) {
        return {
          success: false,
          error: `No active session for ${channelType}:${chatId}. Start a conversation in IM first, or set webhook.sessionStrategy='create'.`,
        };
      }
    }

    if (!silent) {
      const projectHint = request.projectName ? ` [${request.projectName}]` : '';
      const payloadPreview = request.payload
        ? `\n📦 Payload: ${JSON.stringify(request.payload).slice(0, 100)}`
        : '';
      const feedbackText = `🔔 Webhook${projectHint}: ${event}${payloadPreview}\n\n📝 ${injectedPrompt.slice(0, 200)}${injectedPrompt.length > 200 ? '...' : ''}`;
      await adapter.send({ chatId, text: feedbackText }).catch((err) => {
        console.warn(`[webhook] ${requestId} Failed to send feedback: ${Logger.formatError(err)}`);
      });
    }

    try {
      const result = await this.options.bridge.injectAutomationPrompt({
        channelType,
        chatId,
        text: injectedPrompt,
        requestId,
        messageId: `webhook-${requestId}`,
        userId: 'webhook',
        workdir,
        projectName,
        settingSources,
      });

      return {
        success: true,
        sessionId: result.sessionId,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: `Failed to deliver prompt: ${errorMessage}`,
      };
    }
  }
}
