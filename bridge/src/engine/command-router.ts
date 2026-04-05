import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage } from '../channels/types.js';
import type { SessionStateManager } from './session-state.js';
import type { ChannelRouter } from './router.js';
import type { QueryControls } from '../providers/base.js';
import type { VerboseLevel } from './session-state.js';
import { getBridgeContext } from '../context.js';
import { ClaudeSDKProvider } from '../providers/claude-sdk.js';
import { escapeHtml } from '../formatting/escape.js';
import type { ClaudeSettingSource } from '../config.js';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { scanClaudeSessions } from '../session-scanner.js';
import { truncate } from '../utils/string.js';
import { generateSessionId } from '../utils/id.js';

const execAsync = promisify(exec);

/** Shorten path by replacing home directory with ~ */
function shortPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? path.replace(home, '~') : path;
}

/** Format file size in human-readable format */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export class CommandRouter {
  constructor(
    private state: SessionStateManager,
    private getAdapters: () => Map<string, BaseChannelAdapter>,
    private router: ChannelRouter,
    private coreAvailable: () => boolean,
    private activeControls: Map<string, QueryControls>,
    private permissions: { clearSessionWhitelist(): void },
  ) {}

  async handle(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<boolean> {
    const parts = msg.text.split(' ');
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case '/status': {
        const ctx = getBridgeContext();
        const healthy = ctx.core?.isHealthy() ?? false;
        const coreStatus = healthy ? '🟢 connected' : '🔴 disconnected';
        const channelList = Array.from(this.getAdapters().keys()).join(', ') || 'none';

        if (adapter.channelType === 'telegram') {
          const html = [
            `📡 <b>TLive Status</b>`,
            '',
            `<b>Bridge:</b>    🟢 running`,
            `<b>Core:</b>      ${coreStatus}`,
            `<b>Channels:</b>  <code>${channelList}</code>`,
          ].join('\n');
          await adapter.send({ chatId: msg.chatId, html });
        } else if (adapter.channelType === 'discord') {
          await adapter.send({
            chatId: msg.chatId,
            embed: {
              title: '📡 TLive Status',
              color: 0x3399FF,
              fields: [
                { name: 'Bridge', value: '🟢 Running', inline: true },
                { name: 'Core', value: coreStatus, inline: true },
                { name: 'Channels', value: `\`${channelList}\``, inline: true },
              ],
            },
          });
        } else {
          await adapter.send({
            chatId: msg.chatId,
            text: `**Bridge:** 🟢 running\n**Core:** ${coreStatus}\n**Channels:** ${channelList}`,
            feishuHeader: { template: 'blue', title: '📡 TLive Status' },
          });
        }
        return true;
      }
      case '/new': {
        // Just clear session, keep current cwd
        const { store } = getBridgeContext();
        const binding = await store.getBinding(msg.channelType, msg.chatId);

        const newSessionId = generateSessionId();
        await this.router.rebind(msg.channelType, msg.chatId, newSessionId, {
          cwd: binding?.cwd,
        });

        this.state.clearLastActive(msg.channelType, msg.chatId);
        this.state.clearThread(msg.channelType, msg.chatId);
        this.permissions.clearSessionWhitelist();

        const cwdLabel = binding?.cwd ? ` in ${shortPath(binding.cwd)}` : '';
        if (adapter.channelType === 'feishu') {
          await adapter.send({
            chatId: msg.chatId,
            text: `Session cleared${cwdLabel}. Send a message to begin.`,
            feishuHeader: { template: 'green', title: '🆕 New Session' },
          });
        } else if (adapter.channelType === 'discord') {
          await adapter.send({
            chatId: msg.chatId,
            embed: { title: '🆕 New Session', description: `Session cleared${cwdLabel}. Send a message to begin.`, color: 0x00CC66 },
          });
        } else {
          await adapter.send({ chatId: msg.chatId, html: `🆕 <b>New session started${cwdLabel}.</b> Send a message to begin.` });
        }
        return true;
      }
      case '/verbose': {
        const level = parseInt(parts[1], 10) as VerboseLevel;
        if ([0, 1].includes(level)) {
          this.state.setVerboseLevel(msg.channelType, msg.chatId, level);
          const labels = ['🤫 quiet', '📝 terminal card'];
          const text = `Verbose: ${labels[level]}`;
          if (adapter.channelType === 'discord') {
            await adapter.send({ chatId: msg.chatId, embed: { description: text, color: 0x3399FF } });
          } else {
            await adapter.send({ chatId: msg.chatId, text });
          }
        } else {
          const usage = 'Usage: `/verbose 0|1`\n0=quiet, 1=terminal card';
          if (adapter.channelType === 'discord') {
            await adapter.send({ chatId: msg.chatId, embed: { description: usage, color: 0x888888 } });
          } else {
            await adapter.send({ chatId: msg.chatId, text: usage });
          }
        }
        return true;
      }
      case '/perm': {
        const sub = parts[1]?.toLowerCase();
        if (sub === 'on' || sub === 'off') {
          this.state.setPermMode(msg.channelType, msg.chatId, sub);
          const text = sub === 'on'
            ? '🔐 Permission prompts: ON — dangerous tools will ask for confirmation'
            : '⚡ Permission prompts: OFF — all tools auto-allowed';
          if (adapter.channelType === 'discord') {
            await adapter.send({ chatId: msg.chatId, embed: { description: text, color: sub === 'on' ? 0xFFA500 : 0x00CC00 } });
          } else {
            await adapter.send({ chatId: msg.chatId, text });
          }
        } else {
          const current = this.state.getPermMode(msg.channelType, msg.chatId);
          const text = `🔐 Permission mode: **${current}**\nUsage: \`/perm on|off\`\non = prompt for dangerous tools (default)\noff = auto-allow all`;
          if (adapter.channelType === 'discord') {
            await adapter.send({ chatId: msg.chatId, embed: { description: text, color: 0x888888 } });
          } else {
            await adapter.send({ chatId: msg.chatId, text });
          }
        }
        return true;
      }
      case '/stop': {
        const chatKey = this.state.stateKey(msg.channelType, msg.chatId);
        const ctrl = this.activeControls.get(chatKey);
        if (ctrl) {
          this.activeControls.delete(chatKey);
          await ctrl.interrupt();
          await adapter.send({ chatId: msg.chatId, text: '⏹ Interrupted current execution' });
        } else {
          await adapter.send({ chatId: msg.chatId, text: '⚠️ No active execution to stop' });
        }
        return true;
      }
      case '/effort': {
        const LEVELS = ['low', 'medium', 'high', 'max'] as const;
        const level = parts[1]?.toLowerCase();
        if (level && LEVELS.includes(level as typeof LEVELS[number])) {
          this.state.setEffort(msg.channelType, msg.chatId, level as typeof LEVELS[number]);
          const icons: Record<string, string> = { low: '⚡', medium: '🧠', high: '💪', max: '🔥' };
          const text = `${icons[level] || '🧠'} Effort: **${level}**`;
          await adapter.send({ chatId: msg.chatId, text });
        } else {
          const current = this.state.getEffort(msg.channelType, msg.chatId) || 'default';
          const text = `🧠 Effort: **${current}**\nUsage: \`/effort low|medium|high|max\`\nlow = fast · medium = balanced · high = thorough · max = maximum`;
          await adapter.send({ chatId: msg.chatId, text });
        }
        return true;
      }
      case '/hooks': {
        const pauseFile = join(homedir(), '.tlive', 'hooks-paused');
        const sub = parts[1]?.toLowerCase();
        if (sub === 'pause') {
          mkdirSync(dirname(pauseFile), { recursive: true });
          writeFileSync(pauseFile, '');
          await adapter.send({ chatId: msg.chatId, text: '⏸ Hooks paused — auto-allow, no notifications.' });
        } else if (sub === 'resume') {
          try { unlinkSync(pauseFile); } catch {}
          await adapter.send({ chatId: msg.chatId, text: '▶ Hooks resumed — forwarding to IM.' });
        } else {
          const paused = existsSync(pauseFile);
          await adapter.send({ chatId: msg.chatId, text: `Hooks: ${paused ? '⏸ paused' : '▶ active'}` });
        }
        return true;
      }
      case '/sessions': {
        const { store, defaultWorkdir } = getBridgeContext();
        const binding = await store.getBinding(msg.channelType, msg.chatId);
        const currentCwd = binding?.cwd || defaultWorkdir;
        const showAll = parts[1]?.toLowerCase() === '--all' || parts[1]?.toLowerCase() === '-a';

        const sessions = scanClaudeSessions(10, showAll ? undefined : currentCwd);
        const currentSdkId = binding?.sdkSessionId;

        if (sessions.length === 0) {
          const hint = showAll ? '' : ` in ${shortPath(currentCwd)}\nUse /sessions --all to see all projects.`;
          await adapter.send({ chatId: msg.chatId, text: `No sessions found${hint}` });
          return true;
        }

        const lines: string[] = [];
        for (let i = 0; i < sessions.length; i++) {
          const s = sessions[i];
          const isCurrent = currentSdkId === s.sdkSessionId;
          const marker = isCurrent ? ' ◀' : '';
          const date = new Date(s.mtime).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
          const cwdShort = shortPath(s.cwd);
          const sizeStr = formatSize(s.size);
          lines.push(`${i + 1}. ${date} · ${cwdShort} · ${sizeStr} · ${s.preview}${marker}`);
        }

        const filterHint = showAll ? ' (all projects)' : ` (${shortPath(currentCwd)})`;
        const footer = '\nUse /session <n> to switch';

        if (adapter.channelType === 'telegram') {
          await adapter.send({ chatId: msg.chatId, html: `<b>📋 Sessions${filterHint}</b>\n\n${lines.join('\n')}${footer}` });
        } else if (adapter.channelType === 'discord') {
          await adapter.send({
            chatId: msg.chatId,
            embed: {
              title: `📋 Sessions${filterHint}`,
              color: 0x3399FF,
              description: lines.join('\n') + footer,
            },
          });
        } else {
          await adapter.send({
            chatId: msg.chatId,
            text: `${lines.join('\n')}${footer}`,
            feishuHeader: { template: 'blue', title: `📋 Sessions${filterHint}` },
          });
        }
        return true;
      }
      case '/session': {
        const idx = parseInt(parts[1], 10);
        if (isNaN(idx) || idx < 1) {
          await adapter.send({ chatId: msg.chatId, text: 'Usage: /session <number>\nUse /sessions to list.' });
          return true;
        }

        const { store, defaultWorkdir } = getBridgeContext();
        const binding = await store.getBinding(msg.channelType, msg.chatId);
        const currentCwd = binding?.cwd || defaultWorkdir;
        const sessions = scanClaudeSessions(10, currentCwd);

        if (idx > sessions.length) {
          await adapter.send({ chatId: msg.chatId, text: `Session ${idx} not found. Use /sessions to list.` });
          return true;
        }

        const target = sessions[idx - 1];

        const newBindingId = generateSessionId();
        await this.router.rebind(msg.channelType, msg.chatId, newBindingId, {
          sdkSessionId: target.sdkSessionId,
          cwd: target.cwd, // update cwd to session's directory
        });

        this.state.clearLastActive(msg.channelType, msg.chatId);

        await adapter.send({
          chatId: msg.chatId,
          text: `🔄 Switched to session ${idx}\n${shortPath(target.cwd)} · ${target.preview}`,
        });
        return true;
      }
      case '/bash': {
        const cmdText = msg.text.slice('/bash '.length).trim();
        if (!cmdText) {
          await adapter.send({ chatId: msg.chatId, text: 'Usage: /bash <command>' });
          return true;
        }

        const { store, defaultWorkdir } = getBridgeContext();
        const binding = await store.getBinding(msg.channelType, msg.chatId);
        const cwd = binding?.cwd || defaultWorkdir;

        try {
          const { stdout, stderr } = await execAsync(cmdText, {
            cwd,
            timeout: 30_000,
            maxBuffer: 4 * 1024 * 1024,
          });

          const output = (stdout + (stderr ? '\n⚠️ stderr:\n' + stderr : '')).trim();
          const truncated = truncate(output, 3000);

          if (adapter.channelType === 'telegram') {
            await adapter.send({ chatId: msg.chatId, html: `<pre>${escapeHtml(truncated || '(no output)')}</pre>` });
          } else {
            await adapter.send({ chatId: msg.chatId, text: '```\n' + (truncated || '(no output)') + '\n```' });
          }
        } catch (err: any) {
          const errMsg = err.stderr || err.message || String(err);
          const truncated = truncate(errMsg, 1000);
          await adapter.send({ chatId: msg.chatId, text: `❌ ${truncated}` });
        }
        return true;
      }
      case '/cd': {
        const path = parts.slice(1).join(' ').trim();
        const { store, defaultWorkdir } = getBridgeContext();

        if (!path) {
          // Show current directory
          const binding = await store.getBinding(msg.channelType, msg.chatId);
          const current = binding?.cwd || defaultWorkdir;
          await adapter.send({ chatId: msg.chatId, text: `📂 ${shortPath(current)}` });
          return true;
        }

        // Handle ~ expansion
        const expandedPath = path.startsWith('~') ? join(homedir(), path.slice(1)) : path;

        // Resolve relative paths
        const binding = await store.getBinding(msg.channelType, msg.chatId);
        const baseCwd = binding?.cwd || defaultWorkdir;
        const resolvedPath = expandedPath.startsWith('/') ? expandedPath : join(baseCwd, expandedPath);

        if (!existsSync(resolvedPath)) {
          await adapter.send({ chatId: msg.chatId, text: `❌ Directory not found: ${shortPath(resolvedPath)}` });
          return true;
        }

        // Update binding
        if (binding) {
          binding.cwd = resolvedPath;
          await store.saveBinding(binding);
        } else {
          await this.router.rebind(msg.channelType, msg.chatId, generateSessionId(), { cwd: resolvedPath });
        }

        await adapter.send({ chatId: msg.chatId, text: `📂 ${shortPath(resolvedPath)}` });
        return true;
      }
      case '/pwd': {
        const { store, defaultWorkdir } = getBridgeContext();
        const binding = await store.getBinding(msg.channelType, msg.chatId);
        const current = binding?.cwd || defaultWorkdir;
        await adapter.send({ chatId: msg.chatId, text: shortPath(current) });
        return true;
      }
      case '/model': {
        const model = parts.slice(1).join(' ').trim();
        if (model) {
          if (model === 'reset' || model === 'default') {
            this.state.setModel(msg.channelType, msg.chatId, undefined);
            await adapter.send({ chatId: msg.chatId, text: '🤖 Model: reset to default' });
          } else {
            this.state.setModel(msg.channelType, msg.chatId, model);
            await adapter.send({ chatId: msg.chatId, text: `🤖 Model: **${model}**` });
          }
        } else {
          const current = this.state.getModel(msg.channelType, msg.chatId) || 'default';
          const text = `🤖 Model: **${current}**\nUsage: \`/model <name>\` or \`/model reset\`\nExamples: \`claude-sonnet-4-6\`, \`claude-opus-4-6\``;
          await adapter.send({ chatId: msg.chatId, text });
        }
        return true;
      }
      case '/settings': {
        const llm = getBridgeContext().llm;
        const arg = parts[1]?.toLowerCase();

        if (!(llm instanceof ClaudeSDKProvider)) {
          await adapter.send({ chatId: msg.chatId, text: '⚠️ Settings only available for Claude provider' });
          return true;
        }

        const PRESETS: Record<string, ClaudeSettingSource[]> = {
          user: ['user'],
          full: ['user', 'project', 'local'],
          isolated: [],
        };

        if (arg && arg in PRESETS) {
          llm.setSettingSources(PRESETS[arg]);
          const labels: Record<string, string> = {
            user: '👤 user — auth & model only',
            full: '📦 full — auth, CLAUDE.md, MCP, skills',
            isolated: '🔒 isolated — no external settings',
          };
          await adapter.send({ chatId: msg.chatId, text: `⚙️ Settings: ${labels[arg]}` });
        } else {
          const current = llm.getSettingSources();
          const preset = current.length === 0 ? 'isolated'
            : current.length === 1 && current[0] === 'user' ? 'user'
            : current.includes('project') ? 'full'
            : current.join(',');
          const text = [
            `⚙️ Settings: **${preset}** (${current.join(', ') || 'none'})`,
            'Usage: `/settings user|full|isolated`',
            '  user — ~/.claude/settings.json (auth, model)',
            '  full — + CLAUDE.md, MCP servers, skills',
            '  isolated — no external settings',
          ].join('\n');
          await adapter.send({ chatId: msg.chatId, text });
        }
        return true;
      }
      case '/help': {
        if (adapter.channelType === 'telegram') {
          const html = [
            '<b>❓ TLive Commands</b>',
            '',
            '<code>/new</code> — New conversation',
            '<code>/sessions</code> — List sessions in current directory',
            '<code>/sessions --all</code> — List all sessions',
            '<code>/session &lt;n&gt;</code> — Switch to session #n',
            '<code>/cd &lt;path&gt;</code> — Change directory',
            '<code>/pwd</code> — Show current directory',
            '<code>/bash &lt;cmd&gt;</code> — Execute shell command',
            '<code>/verbose 0|1</code> — Detail level',
            '  0 = quiet · 1 = terminal card',
            '<code>/perm on|off</code> — Tool permission prompts',
            '<code>/effort low|high|max</code> — Thinking depth',
            '<code>/model &lt;name&gt;</code> — Switch model',
            '<code>/settings user|full|isolated</code> — Claude settings scope',
            '<code>/stop</code> — Interrupt current execution',
            '<code>/hooks pause|resume</code> — Toggle IM approval',
            '<code>/status</code> — Bridge status',
            '<code>/approve &lt;code&gt;</code> — Approve pairing request',
            '<code>/pairings</code> — List pending pairings',
            '<code>/help</code> — This message',
            '',
            '<i>💬 Reply <b>allow</b>/<b>deny</b> to approve permissions</i>',
          ].join('\n');
          await adapter.send({ chatId: msg.chatId, html });
        } else if (adapter.channelType === 'discord') {
          await adapter.send({
            chatId: msg.chatId,
            embed: {
              title: '❓ TLive Commands',
              color: 0x5865F2,
              description: [
                '`/new` — New conversation',
                '`/sessions` — List sessions in current directory',
                '`/sessions --all` — List all sessions',
                '`/session <n>` — Switch to session #n',
                '`/cd <path>` — Change directory',
                '`/pwd` — Show current directory',
                '`/bash <cmd>` — Execute shell command',
                '`/verbose 0|1` — Detail level',
                '> 0 = quiet · 1 = terminal card',
                '`/perm on|off` — Tool permission prompts',
                '`/model <name>` — Switch model',
                '`/settings user|full|isolated` — Claude settings scope',
                '`/hooks pause|resume` — Toggle IM approval',
                '`/status` — Bridge status',
                '`/approve <code>` — Approve pairing request',
                '`/pairings` — List pending pairings',
                '`/help` — This message',
                '',
                '*💬 Reply `allow`/`deny` to approve permissions*',
              ].join('\n'),
            },
          });
        } else {
          const feishuLines = [
            '/new — New conversation',
            '/sessions — List sessions in current directory',
            '/sessions --all — List all sessions',
            '/session <n> — Switch to session #n',
            '/cd <path> — Change directory',
            '/pwd — Show current directory',
            '/bash <cmd> — Execute shell command',
            '/verbose 0|1 — Detail level',
            '  0 = quiet · 1 = terminal card',
            '/perm on|off — Tool permission prompts',
            '/effort low|high|max — Thinking depth',
            '/model <name> — Switch model',
            '/settings user|full|isolated — Claude settings scope',
            '/stop — Interrupt current execution',
            '/hooks pause|resume — Toggle IM approval',
            '/status — Bridge status',
            '/help — This message',
            '',
            '💬 回复 **allow** / **deny** 审批权限',
          ];
          await adapter.send({
            chatId: msg.chatId,
            text: feishuLines.join('\n'),
            feishuHeader: { template: 'indigo', title: '❓ TLive Commands' },
            buttons: [
              { label: '📋 Sessions', callbackData: 'cmd:sessions', style: 'primary' },
              { label: '📂 cd', callbackData: 'cmd:cd', style: 'primary' },
              { label: '🆕 New', callbackData: 'cmd:new', style: 'primary' },
              { label: '📍 PWD', callbackData: 'cmd:pwd', style: 'primary' },
            ],
          });
        }
        return true;
      }
      case '/approve': {
        const code = parts[1];
        if (!code) {
          await adapter.send({ chatId: msg.chatId, text: 'Usage: /approve <pairing_code>' });
          return true;
        }
        const tgAdapter = this.getAdapters().get('telegram');
        if (tgAdapter && 'approvePairing' in tgAdapter) {
          const result = (tgAdapter as any).approvePairing(code);
          if (result) {
            await adapter.send({
              chatId: msg.chatId,
              text: `✅ Approved user ${result.username} (${result.userId})`,
            });
          } else {
            await adapter.send({ chatId: msg.chatId, text: '❌ Code not found or expired' });
          }
        } else {
          await adapter.send({ chatId: msg.chatId, text: '⚠️ Pairing not available' });
        }
        return true;
      }
      case '/pairings': {
        const tgAdapter = this.getAdapters().get('telegram');
        if (tgAdapter && 'listPairings' in tgAdapter) {
          const pairings = (tgAdapter as any).listPairings() as Array<{ code: string; userId: string; username: string }>;
          if (pairings.length === 0) {
            await adapter.send({ chatId: msg.chatId, text: 'No pending pairing requests.' });
          } else {
            const lines = pairings.map(p => `• <code>${p.code}</code> — ${p.username} (${p.userId})`);
            await adapter.send({
              chatId: msg.chatId,
              html: `<b>🔐 Pending Pairings</b>\n\n${lines.join('\n')}\n\nUse /approve <code> to approve.`,
            });
          }
        } else {
          await adapter.send({ chatId: msg.chatId, text: '⚠️ Pairing not available' });
        }
        return true;
      }
      default:
        return false;
    }
  }
}
