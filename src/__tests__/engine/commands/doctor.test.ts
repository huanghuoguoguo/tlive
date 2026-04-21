import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DoctorCommand } from '../../../engine/commands/doctor.js';
import type { CommandContext } from '../../../engine/commands/types.js';
import type { BaseChannelAdapter } from '../../../channels/base.js';

function createMockContext(overrides?: Partial<CommandContext>): CommandContext {
  const adapter: BaseChannelAdapter = {
    channelType: 'telegram',
    send: vi.fn().mockResolvedValue({ messageId: '1', success: true }),
    sendFormatted: vi.fn().mockResolvedValue({ messageId: '1', success: true }),
    format: vi.fn().mockReturnValue({ chatId: 'c1', text: 'test' }),
    getLocale: vi.fn().mockReturnValue('zh'),
  } as any;

  return {
    adapter,
    msg: {
      channelType: 'telegram',
      chatId: 'c1',
      userId: 'u1',
      text: '/doctor',
      messageId: 'm1',
    },
    parts: ['/doctor'],
    services: {
      getAdapters: vi.fn().mockReturnValue(new Map([
        ['telegram', adapter],
      ])),
      llm: {} as any,
      store: {} as any,
      router: {} as any,
      state: {} as any,
      permissions: {} as any,
      sdkEngine: {} as any,
      activeControls: new Map(),
      defaultWorkdir: '/tmp',
      recentProjects: {} as any,
    },
    helpers: {} as any,
    locale: 'zh',
    ...overrides,
  } as CommandContext;
}

describe('DoctorCommand', () => {
  let command: DoctorCommand;

  beforeEach(() => {
    command = new DoctorCommand();
  });

  it('has correct name and properties', () => {
    expect(command.name).toBe('/doctor');
    expect(command.quick).toBe(true);
    expect(command.description).toBe('系统诊断');
  });

  it('collects OS information', async () => {
    const ctx = createMockContext();
    await command.execute(ctx);

    const send = ctx.adapter.send as ReturnType<typeof vi.fn>;
    expect(send).toHaveBeenCalled();

    const sentMsg = send.mock.calls[0][0];
    expect(sentMsg.text).toContain('操作系统');
    // OS name is capitalized (e.g., 'Linux' not 'linux')
    expect(sentMsg.text.toLowerCase()).toContain(process.platform);
  });

  it('includes Node.js version', async () => {
    const ctx = createMockContext();
    await command.execute(ctx);

    const send = ctx.adapter.send as ReturnType<typeof vi.fn>;
    const sentMsg = send.mock.calls[0][0];
    expect(sentMsg.text).toContain('Node.js');
    expect(sentMsg.text).toContain(process.version);
  });

  it('includes tlive version', async () => {
    const ctx = createMockContext();
    await command.execute(ctx);

    const send = ctx.adapter.send as ReturnType<typeof vi.fn>;
    const sentMsg = send.mock.calls[0][0];
    expect(sentMsg.text).toContain('TLive');
  });

  it('includes uptime', async () => {
    const ctx = createMockContext();
    await command.execute(ctx);

    const send = ctx.adapter.send as ReturnType<typeof vi.fn>;
    const sentMsg = send.mock.calls[0][0];
    expect(sentMsg.text).toContain('运行时间');
  });

  it('includes config status', async () => {
    const ctx = createMockContext();
    await command.execute(ctx);

    const send = ctx.adapter.send as ReturnType<typeof vi.fn>;
    const sentMsg = send.mock.calls[0][0];
    expect(sentMsg.text).toContain('配置文件');
  });

  it('includes channel status', async () => {
    const ctx = createMockContext();
    await command.execute(ctx);

    const send = ctx.adapter.send as ReturnType<typeof vi.fn>;
    const sentMsg = send.mock.calls[0][0];
    expect(sentMsg.text).toContain('通道状态');
    expect(sentMsg.text).toContain('telegram');
  });

  it('returns true after execution', async () => {
    const ctx = createMockContext();
    const result = await command.execute(ctx);
    expect(result).toBe(true);
  });

  it('formats uptime correctly', () => {
    const formatUptime = (command as any).formatUptime.bind(command);

    expect(formatUptime(30)).toBe('30s');
    expect(formatUptime(90)).toBe('1m 30s');
    expect(formatUptime(3661)).toBe('1h 1m');
  });

  it('checks Claude CLI version', async () => {
    const ctx = createMockContext();
    await command.execute(ctx);

    const send = ctx.adapter.send as ReturnType<typeof vi.fn>;
    const sentMsg = send.mock.calls[0][0];
    // Claude CLI check result should be present (either version or not found)
    expect(sentMsg.text).toContain('Claude CLI');
  });
});