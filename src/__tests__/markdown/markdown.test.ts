import { describe, it, expect } from 'vitest';
import {
  downgradeHeadings,
  sanitizeFeishuMarkdown,
} from '../../channels/feishu/markdown.js';

describe('Feishu rendering', () => {
  it('converts external markdown images to links for Feishu cards', () => {
    const md = '[![CI](https://github.com/org/repo/actions/workflows/ci.yml/badge.svg)](https://github.com/org/repo/actions)';
    const result = sanitizeFeishuMarkdown(md);

    expect(result).not.toContain('![');
    expect(result).toBe('[CI](https://github.com/org/repo/actions)');
  });

  it('keeps markdown image syntax inside fenced code blocks', () => {
    const md = '```md\n![CI](https://example.com/badge.svg)\n```\n![Logo](https://example.com/logo.svg)';

    expect(sanitizeFeishuMarkdown(md)).toBe(
      '```md\n![CI](https://example.com/badge.svg)\n```\n[Logo](https://example.com/logo.svg)',
    );
  });

  it('sanitizes images through card markdown helpers', () => {
    expect(downgradeHeadings('# Title\n![CI](https://example.com/badge.svg)')).toBe(
      '**Title**\n[CI](https://example.com/badge.svg)',
    );
  });
});
