import { describe, expect, it } from 'vitest';
import {
  commandRejectionForSurface,
  conversationSurface,
  helpButtonsForSurface,
  helpEntriesForSurface,
  isCommandAllowedOnSurface,
  progressButtonsForSurface,
  taskSummaryButtonsForSurface,
} from '../../server/engine/conversations/surface-policy.js';
import { chatScopeId } from '../../shared/core/key.js';

describe('conversation surface policy', () => {
  it('classifies workbench and topic scopes', () => {
    expect(conversationSurface({ scopeId: 'chat-1' })).toBe('workbench');
    expect(conversationSurface({ scopeId: chatScopeId('chat-1', 'thread-1') })).toBe('topic');
    expect(conversationSurface({ threadId: 'thread-1', scopeId: 'chat-1' })).toBe('topic');
  });

  it('keeps workbench-only commands out of topic surfaces', () => {
    expect(isCommandAllowedOnSurface('/home', 'topic')).toBe(false);
    expect(isCommandAllowedOnSurface('/home-view nodes', 'topic')).toBe(false);
    expect(isCommandAllowedOnSurface('/home-refresh nodes', 'topic')).toBe(false);
    expect(isCommandAllowedOnSurface('/continue sdk-1', 'topic')).toBe(false);
    expect(isCommandAllowedOnSurface('/help', 'topic')).toBe(true);
    expect(isCommandAllowedOnSurface('/home', 'workbench')).toBe(true);
  });

  it('filters topic help through the same command policy', () => {
    const entries = [
      { cmd: 'home' },
      { cmd: 'help' },
      { cmd: 'stop' },
    ];

    expect(helpEntriesForSurface(entries, 'topic')).toEqual([
      { cmd: 'help' },
      { cmd: 'stop' },
    ]);
    expect(helpButtonsForSurface('topic')).toEqual([]);
  });

  it('centralizes topic completion buttons', () => {
    expect(progressButtonsForSurface('topic', 'completed', 'zh')?.map(b => b.callbackData))
      .toEqual([]);
    expect(taskSummaryButtonsForSurface('topic', 'zh')?.map(b => b.callbackData))
      .toEqual([]);
    expect(progressButtonsForSurface('workbench', 'completed', 'zh')).toBeUndefined();
  });

  it('uses explicit rejection messages for blocked topic commands', () => {
    expect(commandRejectionForSurface('/home', 'topic')).toContain('/home 是工作台命令');
    expect(commandRejectionForSurface('/home-view nodes', 'topic')).toContain(
      '/home 是工作台命令',
    );
    expect(commandRejectionForSurface('/continue sdk-1', 'topic')).toContain('不支持切换');
    expect(commandRejectionForSurface('/help', 'topic')).toBeUndefined();
  });
});
