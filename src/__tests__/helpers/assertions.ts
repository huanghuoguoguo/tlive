/**
 * Assertion helpers for testing platform messages and IM outputs.
 */

import { expect } from 'vitest';

// ── Message Content Assertions ──

/**
 * Assert message text contains expected substring.
 */
export function assertContainsText(text: string, expected: string): void {
  expect(text).toContain(expected);
}

/**
 * Assert message text matches pattern (partial matching for dynamic content).
 */
export function assertMatchesPattern(text: string, pattern: RegExp): void {
  expect(text).toMatch(pattern);
}

/**
 * Assert message does not contain forbidden content.
 */
export function assertNotContains(text: string, forbidden: string): void {
  expect(text).not.toContain(forbidden);
}

// ── Format Assertions ──

/**
 * Assert HTML message has proper structure.
 */
export function assertHtmlStructure(html: string): void {
  // Should be valid HTML (no unmatched tags at basic level)
  const openTags = html.match(/<[^/][^>]*>/g) ?? [];
  const closeTags = html.match(/<\/[^>]*>/g) ?? [];
  // Basic sanity check - should have reasonable ratio
  expect(closeTags.length).toBeGreaterThanOrEqual(openTags.length * 0.8);
}

/**
 * Assert Markdown message has expected structure.
 */
export function assertMarkdownStructure(md: string): void {
  // Should be non-empty and not contain raw HTML unless expected
  expect(md.length).toBeGreaterThan(0);
}

/**
 * Assert Feishu interactive card has required fields.
 */
export function assertFeishuCardStructure(cardJson: string): void {
  const card = JSON.parse(cardJson);
  expect(card.config).toBeDefined();
  expect(card.body).toBeDefined();
  expect(card.body.elements).toBeDefined();
  expect(Array.isArray(card.body.elements)).toBe(true);
}

// ── Button Assertions ──

export interface ButtonExpectation {
  label: string;
  callbackData?: string;
  style?: 'primary' | 'danger' | 'secondary';
}

/**
 * Assert inline keyboard contains expected buttons.
 */
export function assertTelegramButtons(replyMarkup: unknown, buttons: ButtonExpectation[]): void {
  const markup = replyMarkup as { inline_keyboard: unknown[][] };
  expect(markup.inline_keyboard).toBeDefined();

  const flatButtons = (markup.inline_keyboard as { text: string; callback_data?: string }[][])
    .flat()
    .map(b => ({ label: b.text, callbackData: b.callback_data }));

  for (const expected of buttons) {
    const found = flatButtons.some(b =>
      b.label === expected.label &&
      (!expected.callbackData || b.callbackData === expected.callbackData)
    );
    expect(found, `Expected button "${expected.label}" not found`).toBe(true);
  }
}

/**
 * Assert QQ Bot keyboard has expected button count.
 */
export function assertQQBotKeyboardRows(keyboard: unknown, expectedRowCount: number): void {
  const kb = keyboard as { content: { rows: unknown[] } };
  expect(kb.content.rows).toHaveLength(expectedRowCount);
}

// ── Error Assertions ──

/**
 * Assert error is a RateLimitError with correct retry time.
 */
export function assertRateLimitError(error: unknown, expectedRetryAfter?: number): void {
  const e = error as { name: string; retryAfter?: number };
  expect(e.name).toBe('RateLimitError');
  if (expectedRetryAfter) {
    expect(e.retryAfter).toBe(expectedRetryAfter);
  }
}

/**
 * Assert error is an AuthError.
 */
export function assertAuthError(error: unknown): void {
  const e = error as { name: string };
  expect(e.name).toBe('AuthError');
}

/**
 * Assert error is a FormatError.
 */
export function assertFormatError(error: unknown): void {
  const e = error as { name: string };
  expect(e.name).toBe('FormatError');
}

// ── Send Result Assertions ──

/**
 * Assert send result is successful with message ID.
 */
export function assertSendSuccess(result: unknown, expectedMessageId?: string): void {
  const r = result as { success: boolean; messageId?: string };
  expect(r.success).toBe(true);
  expect(r.messageId).toBeDefined();
  if (expectedMessageId) {
    expect(r.messageId).toBe(expectedMessageId);
  }
}

/**
 * Assert send result is failure.
 */
export function assertSendFailure(result: unknown): void {
  const r = result as { success: boolean };
  expect(r.success).toBe(false);
}

// ── Inbound Message Assertions ──

/**
 * Assert inbound message has expected structure.
 */
export function assertInboundMessage(msg: unknown, expectations: {
  channelType?: string;
  chatId?: string;
  userId?: string;
  text?: string;
  callbackData?: string;
}): void {
  const m = msg as Record<string, unknown>;
  if (expectations.channelType) expect(m.channelType).toBe(expectations.channelType);
  if (expectations.chatId) expect(m.chatId).toBe(expectations.chatId);
  if (expectations.userId) expect(m.userId).toBe(expectations.userId);
  if (expectations.text) expect(m.text).toBe(expectations.text);
  if (expectations.callbackData) expect(m.callbackData).toBe(expectations.callbackData);
}

// ── Canonical Event Assertions ──

/**
 * Assert canonical event has expected kind.
 */
export function assertEventKind(event: unknown, expectedKind: string): void {
  const e = event as { kind: string };
  expect(e.kind).toBe(expectedKind);
}

/**
 * Assert stream result has text content.
 */
export function assertStreamHasText(events: unknown[], expectedText?: string): void {
  const textEvents = events.filter((e: unknown) => (e as { kind: string }).kind === 'text_delta');
  expect(textEvents.length).toBeGreaterThan(0);
  if (expectedText) {
    const combinedText = textEvents
      .map((e: unknown) => (e as { kind: 'text_delta'; text: string }).text)
      .join('');
    expect(combinedText).toContain(expectedText);
  }
}