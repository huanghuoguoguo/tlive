import { describe, expect, it } from 'vitest';
import { presentHelp, presentHelpCli, presentNewSession, presentSessions, presentStatus } from '../engine/command-presenter.js';

describe('command presenter', () => {
  it('renders /status for telegram as HTML', () => {
    const msg = presentStatus('chat-1', 'telegram', '🟢 connected', 'telegram, discord');
    expect(msg.chatId).toBe('chat-1');
    expect(msg.html).toContain('TLive Status');
    expect(msg.html).toContain('telegram, discord');
  });

  it('renders /new for discord as embed', () => {
    const msg = presentNewSession('chat-1', 'discord', ' in ~/workspace');
    expect(msg.embed).toEqual(
      expect.objectContaining({
        title: expect.stringContaining('New Session'),
        description: expect.stringContaining('~/workspace'),
      })
    );
  });

  it('renders /sessions for feishu with header', () => {
    const msg = presentSessions('chat-1', 'feishu', ' (project)', ['1. session'], '\nUse /session <n> to switch', [
      { label: '▶️ 继续 #1', callbackData: 'cmd:session 1', style: 'primary' },
    ]);
    expect(msg.text).toContain('1. session');
    expect(msg.feishuHeader).toEqual({ template: 'blue', title: '📋 Sessions (project)' });
    expect(msg.buttons).toHaveLength(1);
  });

  it('renders /help for feishu with layered quick action buttons', () => {
    const msg = presentHelp('chat-1', 'feishu');
    expect(msg.feishuHeader).toEqual({ template: 'indigo', title: '❓ 常用帮助' });
    expect(msg.buttons).toHaveLength(4);
    expect(msg.text).toContain('/sessions');
    expect(msg.text).not.toContain('/model');
  });

  it('renders /help-cli for feishu with full command list', () => {
    const msg = presentHelpCli('chat-1', 'feishu');
    expect(msg.feishuHeader).toEqual({ template: 'blue', title: '📚 完整命令' });
    expect(msg.text).toContain('/model');
    expect(msg.text).toContain('/sessioninfo <n>');
  });
});
