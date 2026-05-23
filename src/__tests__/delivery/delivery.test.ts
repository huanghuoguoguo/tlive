import { describe, it, expect } from 'vitest';
import { chunkByParagraph } from '../../shared/formatting/text-chunk.js';

describe('paragraph-aware chunking', () => {
  it('keeps paragraphs together when possible', () => {
    const text = ['first paragraph', 'second paragraph', 'third paragraph'].join('\n\n');
    const chunks = chunkByParagraph(text, 28);
    expect(chunks).toEqual(['first paragraph', 'second paragraph', 'third paragraph']);
  });
});

describe('fence-aware chunking', () => {
  it('preserves code block fences across chunks', () => {
    const text = '# Title\n```js\n' + 'let x = 1;\n'.repeat(100) + '```\nEnd.';
    const chunks = chunkByParagraph(text, 200);
    for (const chunk of chunks) {
      const opens = (chunk.match(/```/g) || []).length;
      expect(opens % 2).toBe(0);
    }
  });

  it('reopens code block in next chunk', () => {
    const text = '```\n' + 'line\n'.repeat(50) + '```';
    const chunks = chunkByParagraph(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].trimEnd().endsWith('```')).toBe(true);
    expect(chunks[1].startsWith('```')).toBe(true);
  });

  it('handles text without code blocks normally', () => {
    const text = 'Hello\nWorld\nFoo\nBar';
    const chunks = chunkByParagraph(text, 12);
    expect(chunks).toEqual(['Hello\nWorld', 'Foo\nBar']);
  });

  it('returns single chunk if within limit', () => {
    expect(chunkByParagraph('short text', 100)).toEqual(['short text']);
  });

  it('splits long line without code block', () => {
    const text = 'A'.repeat(300);
    const chunks = chunkByParagraph('A'.repeat(300), 100);
    expect(chunks.every(chunk => chunk.length <= 100)).toBe(true);
    expect(chunks.join('')).toBe(text);
  });
});
