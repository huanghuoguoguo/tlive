import WebSocket from 'ws';
import { BaseChannelAdapter, registerAdapterFactory } from './base.js';
import type { InboundMessage, OutboundMessage, SendResult, FileAttachment } from './types.js';
import { loadConfig } from '../config.js';
import { markdownToQQBot } from '../markdown/qqbot.js';
import { chunkMarkdown } from '../delivery/delivery.js';
import { classifyError } from './errors.js';
import { maskProxyUrl } from '../proxy.js';

interface QQBotConfig {
  appId: string;
  clientSecret: string;
  allowedUsers: string[];
  proxy: string;
}

// QQ Bot API endpoints
const API_BASE = 'https://api.sgroup.qq.com';
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';

// QQ Bot intents
const INTENTS = {
  PUBLIC_GUILD_MESSAGES: 1 << 30,
  DIRECT_MESSAGE: 1 << 12,
  GROUP_AND_C2C: 1 << 25,
  INTERACTION: 1 << 26, // For button interactions
};
const FULL_INTENTS = INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.DIRECT_MESSAGE | INTENTS.GROUP_AND_C2C | INTENTS.INTERACTION;

// WebSocket event types
interface WSPayload {
  op: number;
  d?: unknown;
  s?: number;
  t?: string;
}

interface C2CMessageEvent {
  author: {
    id: string;
    user_openid: string;
  };
  content: string;
  id: string;
  timestamp: string;
  attachments?: Array<{
    content_type: string;
    url: string;
    filename?: string;
  }>;
}

interface GroupMessageEvent {
  author: {
    id: string;
    member_openid: string;
  };
  content: string;
  id: string;
  timestamp: string;
  group_openid: string;
  attachments?: Array<{
    content_type: string;
    url: string;
    filename?: string;
  }>;
}

interface GuildMessageEvent {
  id: string;
  channel_id: string;
  guild_id: string;
  content: string;
  timestamp: string;
  author: {
    id: string;
    username?: string;
  };
  attachments?: Array<{
    content_type: string;
    url: string;
    filename?: string;
  }>;
}

interface InteractionEvent {
  id: string;
  type: number; // 2 = BUTTON_CLICK
  data: {
    resolved: {
      button_id: string;
      user_id: string;
    };
  };
  msg_id: string;
  guild_id?: string;
  channel_id?: string;
  group_openid?: string;
  user_openid?: string;
}

// QQ Bot Keyboard button style
enum ButtonStyle {
  PRIMARY = 1,    // 蓝色
  SECONDARY = 2,  // 灰色
  DANGER = 3,     // 红色
}

// Token cache
interface TokenCache {
  token: string;
  expiresAt: number;
}

export class QQBotAdapter extends BaseChannelAdapter {
  readonly channelType = 'qqbot' as const;
  private config: QQBotConfig;
  private messageQueue: InboundMessage[] = [];
  private ws: WebSocket | null = null;
  private tokenCache: TokenCache | null = null;
  private tokenFetchPromise: Promise<string> | null = null; // Prevent race conditions
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private sessionId: string | null = null;
  private lastSeq: number | null = null;
  private reconnectAttempts = 0;
  private isConnecting = false;
  private aborted = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Track message type per chatId: 'c2c' | 'group' | 'channel' | 'dm'
  private chatTypeMap = new Map<string, 'c2c' | 'group' | 'channel' | 'dm'>();

  // Reconnect configuration
  private static RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000];
  private static MAX_RECONNECT_ATTEMPTS = 100;

  constructor(config: QQBotConfig) {
    super();
    this.config = config;
  }

  private async getAccessToken(): Promise<string> {
    // Check cache
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt - 5 * 60 * 1000) {
      return this.tokenCache.token;
    }

    // Prevent race conditions: if a fetch is already in progress, wait for it
    if (this.tokenFetchPromise) {
      return this.tokenFetchPromise;
    }

    // Fetch new token
    this.tokenFetchPromise = (async () => {
      try {
        const response = await fetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            appId: this.config.appId,
            clientSecret: this.config.clientSecret,
          }),
        });

        if (!response.ok) {
          throw new Error(`Failed to get access token: ${response.status}`);
        }

        const data = await response.json() as { access_token?: string; expires_in?: number };
        if (!data.access_token) {
          throw new Error('No access_token in response');
        }

        this.tokenCache = {
          token: data.access_token,
          expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000,
        };

        console.log(`[qqbot] Token obtained, expires in ${data.expires_in ?? 7200}s`);
        return this.tokenCache.token;
      } finally {
        this.tokenFetchPromise = null;
      }
    })();

    return this.tokenFetchPromise;
  }

  private async apiRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.getAccessToken();
    const url = `${API_BASE}${path}`;

    const response = await fetch(url, {
      method,
      headers: {
        'Authorization': `QQBot ${token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw classifyError('qqbot', new Error(`API error ${response.status}: ${errorText}`));
    }

    return response.json() as T;
  }

  private async getGatewayUrl(): Promise<string> {
    const data = await this.apiRequest<{ url: string }>('GET', '/gateway');
    return data.url;
  }

  private getNextMsgSeq(): number {
    const timePart = Date.now() % 100000000;
    const random = Math.floor(Math.random() * 65536);
    return (timePart ^ random) % 65535;
  }

  async start(): Promise<void> {
    if (this.config.proxy) {
      console.log(`[qqbot] Using proxy: ${maskProxyUrl(this.config.proxy)}`);
      // Note: ws library doesn't directly support HTTP agent for WebSocket.
      // For proxy support, configure system-level proxy (e.g., TUN mode) or use socks-proxy-agent.
    }

    if (!this.config.appId || !this.config.clientSecret) {
      throw new Error('QQBot not configured (missing appId or clientSecret)');
    }

    console.log(`[qqbot] Starting with appId: ${this.config.appId.slice(0, 8)}...`);
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.isConnecting) return;
    this.isConnecting = true;

    try {
      // Get token and gateway URL
      const token = await this.getAccessToken();
      const gatewayUrl = await this.getGatewayUrl();

      console.log(`[qqbot] Connecting to gateway: ${gatewayUrl}`);

      // Create WebSocket connection
      const wsOptions: WebSocket.ClientOptions = {
        headers: { 'User-Agent': `TLiveQQBot/1.0 (${this.config.appId})` },
      };

      this.ws = new WebSocket(gatewayUrl, wsOptions);

      this.ws.on('open', () => {
        console.log('[qqbot] WebSocket connected');
        this.isConnecting = false;
        this.reconnectAttempts = 0;
      });

      this.ws.on('message', (data) => {
        try {
          const payload = JSON.parse(data.toString()) as WSPayload;
          this.handleWSPayload(payload, token);
        } catch (err) {
          console.error(`[qqbot] Message parse error: ${err}`);
        }
      });

      this.ws.on('close', (code, reason) => {
        console.log(`[qqbot] WebSocket closed: ${code} ${reason.toString()}`);
        this.isConnecting = false;
        this.cleanup();
        if (!this.aborted && code !== 1000) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        console.error(`[qqbot] WebSocket error: ${err.message}`);
        this.isConnecting = false;
      });

    } catch (err) {
      this.isConnecting = false;
      console.error(`[qqbot] Connection failed: ${err}`);
      this.scheduleReconnect();
    }
  }

  private handleWSPayload(payload: WSPayload, token: string): void {
    const { op, d, s, t } = payload;

    if (s) this.lastSeq = s;

    switch (op) {
      case 10: // Hello
        console.log('[qqbot] Hello received');
        // Send identify or resume
        if (this.sessionId && this.lastSeq !== null) {
          console.log(`[qqbot] Attempting resume session ${this.sessionId}`);
          this.ws?.send(JSON.stringify({
            op: 6, // Resume
            d: {
              token: `QQBot ${token}`,
              session_id: this.sessionId,
              seq: this.lastSeq,
            },
          }));
        } else {
          console.log(`[qqbot] Sending identify with intents`);
          this.ws?.send(JSON.stringify({
            op: 2, // Identify
            d: {
              token: `QQBot ${token}`,
              intents: FULL_INTENTS,
              shard: [0, 1],
            },
          }));
        }

        // Start heartbeat
        const interval = (d as { heartbeat_interval: number })?.heartbeat_interval ?? 30000;
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ op: 1, d: this.lastSeq }));
          }
        }, interval);
        break;

      case 0: // Dispatch
        this.handleDispatch(t, d);
        break;

      case 11: // Heartbeat ACK
        // Silently handled
        break;

      case 7: // Reconnect
        console.log('[qqbot] Server requested reconnect');
        this.cleanup();
        this.scheduleReconnect();
        break;

      case 9: // Invalid Session
        console.log(`[qqbot] Invalid session, will re-identify`);
        this.sessionId = null;
        this.lastSeq = null;
        this.cleanup();
        this.scheduleReconnect(3000);
        break;
    }
  }

  private handleDispatch(t: string | undefined, d: unknown): void {
    if (t === 'READY') {
      this.sessionId = (d as { session_id: string })?.session_id;
      console.log(`[qqbot] Ready, session: ${this.sessionId}`);
    } else if (t === 'RESUMED') {
      console.log('[qqbot] Session resumed');
    } else if (t === 'C2C_MESSAGE_CREATE') {
      this.handleC2CMessage(d as C2CMessageEvent);
    } else if (t === 'GROUP_AT_MESSAGE_CREATE') {
      this.handleGroupMessage(d as GroupMessageEvent);
    } else if (t === 'AT_MESSAGE_CREATE') {
      this.handleGuildMessage(d as GuildMessageEvent);
    } else if (t === 'DIRECT_MESSAGE_CREATE') {
      this.handleDirectMessage(d as GuildMessageEvent);
    } else if (t === 'INTERACTION_CREATE') {
      this.handleInteraction(d as InteractionEvent);
    }
  }

  private handleInteraction(event: InteractionEvent): void {
    const buttonId = event.data?.resolved?.button_id;
    if (!buttonId) return;

    console.log(`[qqbot] Button clicked: ${buttonId}`);

    // Determine chatId based on message source
    let chatId: string;
    if (event.group_openid) {
      chatId = event.group_openid;
    } else if (event.channel_id) {
      chatId = event.channel_id;
    } else if (event.user_openid) {
      chatId = event.user_openid;
    } else {
      chatId = event.guild_id ?? '';
    }

    const userId = event.data.resolved.user_id || event.user_openid || '';

    this.messageQueue.push({
      channelType: 'qqbot',
      chatId,
      userId,
      text: '',
      callbackData: buttonId,
      messageId: event.msg_id,
    });
  }

  private handleC2CMessage(event: C2CMessageEvent): void {
    console.log(`[qqbot] C2C message from ${event.author.user_openid}: ${event.content.slice(0, 50)}...`);

    // Track chat type
    this.chatTypeMap.set(event.author.user_openid, 'c2c');

    const attachments: FileAttachment[] = [];
    for (const att of event.attachments ?? []) {
      if (att.content_type.startsWith('image/')) {
        attachments.push({
          type: 'image',
          name: att.filename ?? 'image',
          mimeType: att.content_type,
          base64Data: '', // Will be fetched later if needed
        });
      }
    }

    this.messageQueue.push({
      channelType: 'qqbot',
      chatId: event.author.user_openid, // Use openid as chatId for C2C
      userId: event.author.user_openid,
      text: event.content,
      messageId: event.id,
      attachments: attachments.length > 0 ? attachments : undefined,
    });
  }

  private handleGroupMessage(event: GroupMessageEvent): void {
    console.log(`[qqbot] Group message from ${event.author.member_openid} in ${event.group_openid}`);

    // Track chat type
    this.chatTypeMap.set(event.group_openid, 'group');

    // Strip @mention prefix
    let content = event.content;
    if (content.includes(`<@${this.config.appId}>`)) {
      content = content.replace(`<@${this.config.appId}>`, '').trim();
    }

    const attachments: FileAttachment[] = [];
    for (const att of event.attachments ?? []) {
      if (att.content_type.startsWith('image/')) {
        attachments.push({
          type: 'image',
          name: att.filename ?? 'image',
          mimeType: att.content_type,
          base64Data: '',
        });
      }
    }

    this.messageQueue.push({
      channelType: 'qqbot',
      chatId: event.group_openid, // Use group_openid as chatId
      userId: event.author.member_openid,
      text: content,
      messageId: event.id,
      attachments: attachments.length > 0 ? attachments : undefined,
    });
  }

  private handleGuildMessage(event: GuildMessageEvent): void {
    console.log(`[qqbot] Guild channel message from ${event.author.id} in ${event.channel_id}`);

    // Track chat type
    this.chatTypeMap.set(event.channel_id, 'channel');

    // Strip @mention prefix
    let content = event.content;
    if (content.includes(`<@${this.config.appId}>`)) {
      content = content.replace(`<@${this.config.appId}>`, '').trim();
    }

    this.messageQueue.push({
      channelType: 'qqbot',
      chatId: event.channel_id,
      userId: event.author.id,
      text: content,
      messageId: event.id,
    });
  }

  private handleDirectMessage(event: GuildMessageEvent): void {
    console.log(`[qqbot] Direct message (guild DM) from ${event.author.id}`);

    // Track chat type
    this.chatTypeMap.set(event.guild_id, 'dm');

    this.messageQueue.push({
      channelType: 'qqbot',
      chatId: event.guild_id, // guild_id for DM
      userId: event.author.id,
      text: event.content,
      messageId: event.id,
    });
  }

  private scheduleReconnect(customDelay?: number): void {
    if (this.aborted || this.reconnectAttempts >= QQBotAdapter.MAX_RECONNECT_ATTEMPTS) {
      console.error('[qqbot] Max reconnect attempts reached or aborted');
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const idx = Math.min(this.reconnectAttempts, QQBotAdapter.RECONNECT_DELAYS.length - 1);
    const delay = customDelay ?? QQBotAdapter.RECONNECT_DELAYS[idx];
    this.reconnectAttempts++;

    console.log(`[qqbot] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.aborted) {
        this.connect();
      }
    }, delay);
  }

  private cleanup(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.ws.close();
    }
    this.ws = null;
  }

  async stop(): Promise<void> {
    this.aborted = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.chatTypeMap.clear(); // Prevent memory leak
    this.cleanup();
  }

  async consumeOne(): Promise<InboundMessage | null> {
    return this.messageQueue.shift() ?? null;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const content = markdownToQQBot(message.text ?? message.html ?? '');
    const chunks = chunkMarkdown(content, 2000);

    let lastMessageId = '';

    // Build keyboard if buttons are provided
    const keyboard = message.buttons ? this.buildKeyboard(message.buttons) : undefined;

    // Determine message type from tracked chat or try all
    const chatType = this.chatTypeMap.get(message.chatId);

    for (let i = 0; i < chunks.length; i++) {
      const msgSeq = this.getNextMsgSeq();
      const body: Record<string, unknown> = {
        markdown: { content: chunks[i] },
        msg_type: 2, // Markdown type
        msg_seq: msgSeq,
      };

      // Add keyboard buttons only on last chunk
      if (i === chunks.length - 1 && keyboard) {
        body.keyboard = keyboard;
      }

      // Use tracked type if available, otherwise try all
      if (chatType === 'c2c') {
        const result = await this.apiRequest<{ id: string; timestamp: number }>(
          'POST',
          `/v2/users/${message.chatId}/messages`,
          body
        );
        lastMessageId = result.id;
      } else if (chatType === 'group') {
        const result = await this.apiRequest<{ id: string; timestamp: number }>(
          'POST',
          `/v2/groups/${message.chatId}/messages`,
          body
        );
        lastMessageId = result.id;
      } else if (chatType === 'channel') {
        const result = await this.apiRequest<{ id: string; timestamp: string }>(
          'POST',
          `/channels/${message.chatId}/messages`,
          { content: chunks[i] }
        );
        lastMessageId = result.id;
      } else if (chatType === 'dm') {
        const result = await this.apiRequest<{ id: string; timestamp: string }>(
          'POST',
          `/dms/${message.chatId}/messages`,
          { content: chunks[i] }
        );
        lastMessageId = result.id;
      } else {
        // Unknown type, try C2C first, then group, then channel
        try {
          const result = await this.apiRequest<{ id: string; timestamp: number }>(
            'POST',
            `/v2/users/${message.chatId}/messages`,
            body
          );
          lastMessageId = result.id;
          this.chatTypeMap.set(message.chatId, 'c2c');
        } catch {
          try {
            const result = await this.apiRequest<{ id: string; timestamp: number }>(
              'POST',
              `/v2/groups/${message.chatId}/messages`,
              body
            );
            lastMessageId = result.id;
            this.chatTypeMap.set(message.chatId, 'group');
          } catch {
            try {
              const result = await this.apiRequest<{ id: string; timestamp: string }>(
                'POST',
                `/channels/${message.chatId}/messages`,
                { content: chunks[i] }
              );
              lastMessageId = result.id;
              this.chatTypeMap.set(message.chatId, 'channel');
            } catch (channelErr) {
              throw classifyError('qqbot', channelErr);
            }
          }
        }
      }
    }

    return { messageId: lastMessageId, success: true };
  }

  /** Build QQ Bot keyboard from tlive buttons */
  private buildKeyboard(buttons: NonNullable<OutboundMessage['buttons']>): { content: { rows: Array<{ buttons: unknown[] }> } } {
    const rows: Array<{ buttons: unknown[] }> = [];
    let currentRow: unknown[] = [];

    for (const btn of buttons) {
      if (currentRow.length >= 4) {
        rows.push({ buttons: currentRow });
        currentRow = [];
      }

      const qqButton = {
        id: btn.callbackData,
        render_data: {
          label: btn.label,
          style: btn.style === 'danger' ? ButtonStyle.DANGER
               : btn.style === 'primary' ? ButtonStyle.PRIMARY
               : ButtonStyle.SECONDARY,
        },
        action: {
          type: 1, // BUTTON_CLICK
          data: btn.callbackData,
        },
      };
      currentRow.push(qqButton);
    }

    if (currentRow.length > 0) {
      rows.push({ buttons: currentRow });
    }

    return { content: { rows } };
  }

  async editMessage(chatId: string, messageId: string, message: OutboundMessage): Promise<void> {
    // QQ Bot doesn't support message editing directly
    // We would need to delete and resend, but that's not ideal
    console.warn('[qqbot] Message editing not supported');
  }

  async sendTyping(chatId: string): Promise<void> {
    try {
      const msgSeq = this.getNextMsgSeq();
      await this.apiRequest(
        'POST',
        `/v2/users/${chatId}/messages`,
        {
          msg_type: 6, // Input notify
          input_notify: {
            input_type: 1,
            input_second: 60,
          },
          msg_seq: msgSeq,
        }
      );
    } catch {
      // Non-critical
    }
  }

  validateConfig(): string | null {
    if (!this.config.appId) return 'TL_QQ_APP_ID is required for QQBot';
    if (!this.config.clientSecret) return 'TL_QQ_CLIENT_SECRET is required for QQBot';
    return null;
  }

  isAuthorized(userId: string, chatId: string): boolean {
    if (this.config.allowedUsers.length === 0) return true;
    return this.config.allowedUsers.includes(userId);
  }
}

// Self-register
registerAdapterFactory('qqbot', () => new QQBotAdapter(loadConfig().qqbot));