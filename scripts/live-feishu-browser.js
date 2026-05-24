#!/usr/bin/env node
import WebSocket from 'ws';

const DEFAULT_CDP_URL = 'http://127.0.0.1:9222';
const cdpUrl = process.env.TL_FEISHU_CDP_URL || DEFAULT_CDP_URL;

function usage() {
  console.error(`Usage:
  npm run live:feishu:browser -- list [text]
  npm run live:feishu:browser -- click <text> [--first|--last|--index N]
  npm run live:feishu:browser -- click-text <text> [--first|--last|--index N]
  npm run live:feishu:browser -- scroll-bottom
  npm run live:feishu:browser -- send <message>
  npm run live:feishu:browser -- text [tailChars]

Environment:
  TL_FEISHU_CDP_URL  Chrome DevTools HTTP endpoint. Default: ${DEFAULT_CDP_URL}
`);
}

function fail(message) {
  console.error(`[live-feishu-browser] ${message}`);
  process.exit(1);
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = { pick: 'first', index: null };
  const values = [];

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--first') {
      flags.pick = 'first';
    } else if (arg === '--last') {
      flags.pick = 'last';
    } else if (arg === '--index') {
      const value = rest[i + 1];
      if (!value) fail('--index requires a value');
      const index = Number.parseInt(value, 10);
      if (!Number.isInteger(index) || index < 0) fail('--index must be a non-negative integer');
      flags.pick = 'index';
      flags.index = index;
      i += 1;
    } else {
      values.push(arg);
    }
  }

  return { command, query: values.join(' '), flags };
}

class CdpClient {
  constructor(socketUrl) {
    this.socketUrl = socketUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.ws = null;
  }

  async connect() {
    this.ws = new WebSocket(this.socketUrl);
    this.ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${message.error.message}: ${message.error.data || ''}`));
      } else {
        pending.resolve(message.result);
      }
    });
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
  }

  call(method, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('CDP socket is not connected');
    }
    const id = this.nextId;
    this.nextId += 1;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  close() {
    this.ws?.close();
  }
}

async function getFeishuPage() {
  const response = await fetch(new URL('/json/list', cdpUrl));
  if (!response.ok) fail(`cannot list Chrome targets from ${cdpUrl}: HTTP ${response.status}`);
  const pages = await response.json();
  const page = pages.find(
    (candidate) =>
      candidate.type === 'page' &&
      candidate.webSocketDebuggerUrl &&
      String(candidate.url || '').includes('feishu.cn/next/messenger'),
  );
  if (!page) {
    fail(`no Feishu messenger page found in ${cdpUrl}/json/list`);
  }
  return page;
}

async function evaluate(client, expression) {
  const result = await client.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.text || 'Runtime.evaluate failed';
    throw new Error(text);
  }
  return result.result?.value;
}

function visibleCandidatesExpression(query) {
  return `(() => {
    const query = ${JSON.stringify(normalizeText(query))};
    const selectors = [
      'button',
      '[role="button"]',
      '.ud__button',
      '[class*="button"]',
      '[class*="Button"]'
    ].join(',');
    const seen = new Set();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

    function textOf(el) {
      return (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    }

    function isVisible(el, rect) {
      const style = window.getComputedStyle(el);
      return rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < viewportHeight &&
        rect.left < viewportWidth &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number(style.opacity || '1') > 0;
    }

    const matched = Array.from(document.querySelectorAll(selectors))
      .filter((el) => {
        if (seen.has(el)) return false;
        seen.add(el);
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
        const text = textOf(el);
        if (query && !text.includes(query)) return false;
        return isVisible(el, el.getBoundingClientRect());
      })
      .filter((el, _index, nodes) => {
        return !nodes.some((other) => other !== el && el.contains(other) && textOf(other) === textOf(el));
      });

    return matched
      .map((el, index) => {
        const rect = el.getBoundingClientRect();
        return {
          index,
          text: textOf(el),
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || '',
          className: String(el.className || ''),
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      });
  })()`;
}

function clickCandidateExpression(query, flags) {
  return `(() => {
    const query = ${JSON.stringify(normalizeText(query))};
    const pick = ${JSON.stringify(flags.pick)};
    const wantedIndex = ${flags.index === null ? 'null' : String(flags.index)};
    const selectors = [
      'button',
      '[role="button"]',
      '.ud__button',
      '[class*="button"]',
      '[class*="Button"]'
    ].join(',');

    function textOf(el) {
      return (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    }

    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < (window.innerHeight || document.documentElement.clientHeight) &&
        rect.left < (window.innerWidth || document.documentElement.clientWidth) &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number(style.opacity || '1') > 0;
    }

    const matched = Array.from(document.querySelectorAll(selectors))
      .filter((el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true')
      .filter((el) => textOf(el).includes(query))
      .filter((el) => isVisible(el));
    const candidates = matched.filter((el) => {
      return !matched.some((other) => other !== el && el.contains(other) && textOf(other) === textOf(el));
    });

    if (!candidates.length) {
      return { ok: false, error: 'no visible button matched', count: 0 };
    }

    let selected;
    if (pick === 'last') selected = candidates[candidates.length - 1];
    else if (pick === 'index') selected = candidates[wantedIndex];
    else selected = candidates[0];

    if (!selected) {
      return { ok: false, error: 'selected index is out of range', count: candidates.length };
    }

    selected.scrollIntoView({ block: 'center', inline: 'center' });
    selected.click();
    const rect = selected.getBoundingClientRect();
    return {
      ok: true,
      count: candidates.length,
      text: textOf(selected),
      tag: selected.tagName.toLowerCase(),
      role: selected.getAttribute('role') || '',
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
    };
  })()`;
}

function clickTextExpression(query, flags) {
  return `(() => {
    const query = ${JSON.stringify(normalizeText(query))};
    const pick = ${JSON.stringify(flags.pick)};
    const wantedIndex = ${flags.index === null ? 'null' : String(flags.index)};
    const maxTextLength = Math.max(query.length + 160, 200);
    const selectors = [
      'button',
      '[role="button"]',
      'a',
      '[tabindex]',
      '[class*="reply"]',
      '[class*="Reply"]',
      'div',
      'span'
    ].join(',');

    function textOf(el) {
      return (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    }

    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < (window.innerHeight || document.documentElement.clientHeight) &&
        rect.left < (window.innerWidth || document.documentElement.clientWidth) &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number(style.opacity || '1') > 0;
    }

    const matched = Array.from(document.querySelectorAll(selectors))
      .filter((el) => !['HTML', 'BODY', 'MAIN'].includes(el.tagName))
      .filter((el) => textOf(el).includes(query))
      .filter((el) => textOf(el).length <= maxTextLength)
      .filter((el) => isVisible(el));
    const candidates = matched.filter((el) => {
      return !matched.some((other) => other !== el && el.contains(other) && textOf(other) === textOf(el));
    }).sort((a, b) => {
      const aExact = textOf(a) === query ? 0 : 1;
      const bExact = textOf(b) === query ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      const textDelta = textOf(a).length - textOf(b).length;
      if (textDelta !== 0) return textDelta;
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      return (aRect.width * aRect.height) - (bRect.width * bRect.height);
    });

    if (!candidates.length) {
      return { ok: false, error: 'no visible text matched', count: 0 };
    }

    let selected;
    if (pick === 'last') selected = candidates[candidates.length - 1];
    else if (pick === 'index') selected = candidates[wantedIndex];
    else selected = candidates[0];

    if (!selected) {
      return { ok: false, error: 'selected index is out of range', count: candidates.length };
    }

    selected.scrollIntoView({ block: 'center', inline: 'center' });
    selected.click();
    const rect = selected.getBoundingClientRect();
    return {
      ok: true,
      count: candidates.length,
      text: textOf(selected),
      tag: selected.tagName.toLowerCase(),
      role: selected.getAttribute('role') || '',
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
    };
  })()`;
}

function scrollBottomExpression() {
  return `(() => {
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const scrollables = Array.from(document.querySelectorAll('*'))
      .filter((el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return /(auto|scroll)/.test(style.overflowY) &&
          el.scrollHeight > el.clientHeight + 20 &&
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.top < viewportHeight;
      })
      .sort((a, b) => b.clientHeight - a.clientHeight);

    const targets = scrollables.slice(0, 5);
    for (const el of targets) {
      el.scrollTop = el.scrollHeight;
    }
    window.scrollTo(0, document.documentElement.scrollHeight);
    return {
      ok: true,
      scrolled: targets.length,
      bodyBottom: document.documentElement.scrollHeight,
    };
  })()`;
}

function focusEditorExpression() {
  return `(() => {
    const selectors = [
      '[contenteditable="true"]',
      'textarea',
      '[role="textbox"]'
    ].join(',');
    const candidates = Array.from(document.querySelectorAll(selectors))
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < (window.innerHeight || document.documentElement.clientHeight) &&
          rect.left < (window.innerWidth || document.documentElement.clientWidth) &&
          style.visibility !== 'hidden' &&
          style.display !== 'none';
      })
      .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
    const editor = candidates[0];
    if (!editor) return { ok: false, error: 'no visible editor found' };
    editor.focus();
    const rect = editor.getBoundingClientRect();
    return {
      ok: true,
      tag: editor.tagName.toLowerCase(),
      role: editor.getAttribute('role') || '',
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
    };
  })()`;
}

async function pressEnter(client) {
  const base = {
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    key: 'Enter',
    code: 'Enter',
    unmodifiedText: '\r',
    text: '\r',
  };
  await client.call('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
  await client.call('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

async function main() {
  const { command, query, flags } = parseArgs(process.argv.slice(2));
  if (!command || command === '-h' || command === '--help') {
    usage();
    process.exit(command ? 0 : 1);
  }

  const page = await getFeishuPage();
  const client = new CdpClient(page.webSocketDebuggerUrl);
  await client.connect();
  await client.call('Runtime.enable');

  try {
    if (command === 'list') {
      const candidates = await evaluate(client, visibleCandidatesExpression(query));
      console.log(`[live-feishu-browser] ${candidates.length} visible button(s) matched`);
      candidates.forEach((candidate, index) => {
        const text = candidate.text.length > 120 ? `${candidate.text.slice(0, 117)}...` : candidate.text;
        console.log(
          `${index}: (${candidate.x},${candidate.y}) ${candidate.tag} ${candidate.role} ${JSON.stringify(text)}`,
        );
      });
    } else if (command === 'click') {
      if (!query) fail('click requires button text');
      const result = await evaluate(client, clickCandidateExpression(query, flags));
      if (!result.ok) fail(`${result.error}; matched=${result.count}`);
      console.log(
        `[live-feishu-browser] clicked ${JSON.stringify(result.text)} at (${result.x},${result.y}); matched=${result.count}`,
      );
    } else if (command === 'click-text') {
      if (!query) fail('click-text requires visible text');
      const result = await evaluate(client, clickTextExpression(query, flags));
      if (!result.ok) fail(`${result.error}; matched=${result.count}`);
      console.log(
        `[live-feishu-browser] clicked text ${JSON.stringify(result.text)} at (${result.x},${result.y}); matched=${result.count}`,
      );
    } else if (command === 'scroll-bottom') {
      const result = await evaluate(client, scrollBottomExpression());
      console.log(`[live-feishu-browser] scrolled ${result.scrolled} container(s) to bottom`);
    } else if (command === 'send') {
      if (!query) fail('send requires message text');
      const focus = await evaluate(client, focusEditorExpression());
      if (!focus.ok) fail(focus.error);
      await client.call('Input.insertText', { text: query });
      await pressEnter(client);
      console.log(`[live-feishu-browser] sent ${JSON.stringify(query)} via focused editor`);
    } else if (command === 'text') {
      const limit = Number.parseInt(query || '4000', 10);
      const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 4000;
      const text = await evaluate(
        client,
        `(() => (document.body.innerText || '').slice(-${safeLimit}))()`,
      );
      console.log(text);
    } else {
      usage();
      fail(`unknown command: ${command}`);
    }
  } finally {
    client.close();
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
