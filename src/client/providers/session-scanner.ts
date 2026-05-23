import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { homedir } from 'node:os';
import { truncate } from '../../shared/core/string.js';
import type { AgentProviderKind } from '../../shared/providers/kinds.js';

export interface ScannedSession {
  provider: AgentProviderKind;
  providerDisplayName: string;
  sdkSessionId: string; // provider session/thread id
  projectDir: string; // provider-specific grouping path
  filePath: string; // absolute path to session jsonl
  cwd: string; // working directory from the provider metadata
  mtime: number; // file mtime (ms)
  size: number; // file size in bytes
  preview: string; // last user message content, truncated to 40 chars
  transcript?: SessionTranscriptMessage[]; // last few messages for expanded preview
}

export interface SessionTranscriptMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp?: string;
}

type SessionCandidate = {
  filePath: string;
  projectDir: string;
  sessionId: string;
  mtime: number;
  size: number;
};

// Cache for session scans (5 second TTL)
let cachedClaudeSessions: ScannedSession[] | null = null;
let cachedCodexSessions: ScannedSession[] | null = null;
let claudeCacheTime = 0;
let codexCacheTime = 0;
const CACHE_TTL = 5000;
const CODEX_META_READ_SIZE = 64 * 1024;
const CODEX_PREVIEW_HEAD_READ_SIZE = 256 * 1024;
const SESSION_TAIL_READ_SIZE = 96 * 1024;
const CLAUDE_PREVIEW_READ_SIZE = 32 * 1024;

/**
 * Invalidate session cache — call after query completes to refresh recent tasks.
 */
export function invalidateSessionCache(): void {
  cachedClaudeSessions = null;
  cachedCodexSessions = null;
  claudeCacheTime = 0;
  codexCacheTime = 0;
}

/**
 * Scan all requested provider histories and return a unified, mtime-sorted list.
 */
export function scanAgentSessions(
  limit = 10,
  filterByCwd?: string,
  providers: AgentProviderKind[] = ['claude', 'codex'],
): ScannedSession[] {
  const sessions = providers.flatMap((provider) =>
    provider === 'codex' ? getCodexSessions() : getClaudeSessions(),
  );
  sessions.sort((a, b) => b.mtime - a.mtime);
  return filterAndLimit(sessions, limit, filterByCwd);
}

/**
 * Scan ~/.claude/projects/ for Claude Code session .jsonl files.
 * Returns sessions sorted by mtime descending (most recent first).
 * Results are cached for 5 seconds to avoid repeated file I/O.
 * @param limit max number of sessions to return
 * @param filterByCwd optional cwd filter — only return sessions in this directory
 */
export function scanClaudeSessions(limit = 10, filterByCwd?: string): ScannedSession[] {
  return filterAndLimit(getClaudeSessions(), limit, filterByCwd);
}

/**
 * Scan Codex thread history from ~/.codex/sessions.
 */
export function scanCodexSessions(limit = 10, filterByCwd?: string): ScannedSession[] {
  return filterAndLimit(getCodexSessions(), limit, filterByCwd);
}

function getClaudeSessions(): ScannedSession[] {
  const now = Date.now();

  // Use cache if valid
  if (cachedClaudeSessions && now - claudeCacheTime < CACHE_TTL) {
    return cachedClaudeSessions;
  }

  // Scan fresh
  cachedClaudeSessions = doScanClaude();
  claudeCacheTime = now;
  return cachedClaudeSessions;
}

function getCodexSessions(): ScannedSession[] {
  const now = Date.now();

  if (cachedCodexSessions && now - codexCacheTime < CACHE_TTL) {
    return cachedCodexSessions;
  }

  cachedCodexSessions = doScanCodex();
  codexCacheTime = now;
  return cachedCodexSessions;
}

function filterAndLimit(
  sessions: ScannedSession[],
  limit: number,
  filterByCwd?: string,
): ScannedSession[] {
  let filtered = sessions;
  if (filterByCwd) {
    const normalizedFilter = filterByCwd.replace(/\/+$/, '');
    // Match current directory AND all subdirectories (prefix match)
    filtered = filtered.filter((s) => {
      const normalizedCwd = s.cwd.replace(/\/+$/, '');
      // Exact match or subdirectory (cwd starts with filter + /)
      return normalizedCwd === normalizedFilter || normalizedCwd.startsWith(normalizedFilter + '/');
    });
  }
  return filtered.slice(0, limit);
}

function doScanClaude(): ScannedSession[] {
  const projectsDir = join(homedir(), '.claude', 'projects');

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== 'memory')
      .map((d) => d.name);
  } catch {
    return [];
  }

  // Collect all .jsonl files with mtime
  const candidates: SessionCandidate[] = [];

  for (const dir of projectDirs) {
    const dirPath = join(projectsDir, dir);
    let files: string[];
    try {
      files = readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const file of files) {
      // Skip sub-agent sessions
      if (file.startsWith('agent-')) continue;
      const filePath = join(dirPath, file);
      try {
        const st = statSync(filePath);
        candidates.push({
          filePath,
          projectDir: dir,
          sessionId: file.replace('.jsonl', ''),
          mtime: st.mtimeMs,
          size: st.size,
        });
      } catch {}
    }
  }

  // Sort by mtime descending
  candidates.sort((a, b) => b.mtime - a.mtime);

  // Parse header of each file for metadata
  return candidates.map((c) =>
    parseClaudeSessionHeader(c.filePath, c.projectDir, c.sessionId, c.mtime, c.size),
  );
}

function doScanCodex(): ScannedSession[] {
  const sessionsDir = join(homedir(), '.codex', 'sessions');
  const candidates: SessionCandidate[] = [];
  collectCodexCandidates(sessionsDir, sessionsDir, candidates);
  candidates.sort((a, b) => b.mtime - a.mtime);

  const sessions: ScannedSession[] = [];
  for (const candidate of candidates) {
    const parsed = parseCodexSession(
      candidate.filePath,
      candidate.projectDir,
      candidate.sessionId,
      candidate.mtime,
      candidate.size,
    );
    if (parsed) sessions.push(parsed);
  }
  return sessions;
}

function collectCodexCandidates(
  dirPath: string,
  rootPath: string,
  candidates: SessionCandidate[],
): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collectCodexCandidates(entryPath, rootPath, candidates);
      continue;
    }
    if (!entry.name.endsWith('.jsonl')) continue;
    try {
      const st = statSync(entryPath);
      candidates.push({
        filePath: entryPath,
        projectDir: relative(rootPath, dirname(entryPath)) || '.',
        sessionId: codexSessionIdFromFilename(entry.name),
        mtime: st.mtimeMs,
        size: st.size,
      });
    } catch {
      // Ignore unreadable entries.
    }
  }
}

function parseClaudeSessionHeader(
  filePath: string,
  projectDir: string,
  sessionId: string,
  mtime: number,
  size: number,
): ScannedSession {
  let cwd = decodeDirName(projectDir);
  let preview = '(empty)';

  try {
    // Read last 32KB of file for efficiency (session files can grow large)
    const st = statSync(filePath);
    const fd = openSync(filePath, 'r');
    try {
      const fileSize = st.size;
      const offset = fileSize > CLAUDE_PREVIEW_READ_SIZE ? fileSize - CLAUDE_PREVIEW_READ_SIZE : 0;
      const readLen = fileSize > CLAUDE_PREVIEW_READ_SIZE ? CLAUDE_PREVIEW_READ_SIZE : fileSize;
      const buf = Buffer.alloc(readLen);
      const bytesRead = readSync(fd, buf, 0, readLen, offset);
      const tail = buf.toString('utf-8', 0, bytesRead);
      const lines = tail.split('\n');

      // Parse lines backwards to find last meaningful message
      let lastCwd = '';
      let lastUserMsg = '';
      let fallbackTitle = '';
      let fallbackPrompt = '';

      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const obj = JSON.parse(line);

          // Track cwd from any message (first found going backwards)
          if (!lastCwd && obj.cwd) lastCwd = obj.cwd;
          if (!fallbackTitle && obj.type === 'ai-title' && typeof obj.aiTitle === 'string') {
            fallbackTitle = normalizePlainText(obj.aiTitle, 40);
          }
          if (!fallbackPrompt && obj.type === 'last-prompt' && typeof obj.lastPrompt === 'string') {
            fallbackPrompt = normalizePlainText(obj.lastPrompt, 40);
          }

          // Look for user messages with content
          if (obj.type === 'user' && !lastUserMsg && obj.message?.content) {
            const content = obj.message.content;
            const normalized = normalizeClaudeUserContent(content, 40);
            if (!normalized) continue;
            lastUserMsg = normalized;
            break; // Found last user message, stop
          }
        } catch {}
      }

      if (lastCwd) cwd = lastCwd;
      preview = lastUserMsg || fallbackPrompt || fallbackTitle || preview;
    } finally {
      closeSync(fd);
    }
  } catch {
    // File unreadable — use defaults
  }

  return {
    provider: 'claude',
    providerDisplayName: 'Claude',
    sdkSessionId: sessionId,
    projectDir,
    filePath,
    cwd,
    mtime,
    size,
    preview: preview === '(empty)' ? fallbackSessionPreview('Claude', sessionId) : preview,
  };
}

function parseCodexSession(
  filePath: string,
  projectDir: string,
  fallbackSessionId: string,
  mtime: number,
  size: number,
): ScannedSession | null {
  let sessionId = fallbackSessionId;
  let cwd = homedir();
  let preview = '(empty)';

  try {
    const head = readWindow(filePath, size, CODEX_META_READ_SIZE, 'head');
    for (const rawLine of head.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj?.type !== 'session_meta' || !obj.payload) continue;
        const payload = obj.payload;
        if (typeof payload.id === 'string' && payload.id) sessionId = payload.id;
        if (typeof payload.cwd === 'string' && payload.cwd) cwd = payload.cwd;
        break;
      } catch {
        // Ignore malformed/incomplete head line.
      }
    }

    const tail = readWindow(filePath, size, SESSION_TAIL_READ_SIZE, 'tail');
    preview = extractCodexUserPreview(tail, 'last') ?? preview;
    if (preview === '(empty)') {
      const previewHead = readWindow(filePath, size, CODEX_PREVIEW_HEAD_READ_SIZE, 'head');
      preview = extractCodexUserPreview(previewHead, 'first') ?? preview;
    }
  } catch {
    return null;
  }

  return {
    provider: 'codex',
    providerDisplayName: 'Codex',
    sdkSessionId: sessionId,
    projectDir,
    filePath,
    cwd,
    mtime,
    size,
    preview: preview === '(empty)' ? fallbackSessionPreview('Codex', sessionId) : preview,
  };
}

export function readSessionTranscriptPreview(
  session: ScannedSession,
  maxMessages = 4,
): SessionTranscriptMessage[] {
  return session.provider === 'codex'
    ? readCodexSessionTranscriptPreview(session, maxMessages)
    : readClaudeSessionTranscriptPreview(session, maxMessages);
}

function readClaudeSessionTranscriptPreview(
  session: ScannedSession,
  maxMessages: number,
): SessionTranscriptMessage[] {
  try {
    const st = statSync(session.filePath);
    const tail = readWindow(session.filePath, st.size, SESSION_TAIL_READ_SIZE, 'tail');
    return readTranscriptMessages(tail, maxMessages, extractClaudeTranscriptMessage);
  } catch {
    return [];
  }
}

function readCodexSessionTranscriptPreview(
  session: ScannedSession,
  maxMessages: number,
): SessionTranscriptMessage[] {
  try {
    const tail = readWindow(session.filePath, session.size, SESSION_TAIL_READ_SIZE, 'tail');
    return readTranscriptMessages(tail, maxMessages, extractCodexTranscriptMessage, true);
  } catch {
    return [];
  }
}

function readTranscriptMessages(
  tail: string,
  maxMessages: number,
  extractMessage: (obj: unknown) => SessionTranscriptMessage | null,
  dedupe = false,
): SessionTranscriptMessage[] {
  const messages: SessionTranscriptMessage[] = [];
  const seen = dedupe ? new Set<string>() : undefined;

  for (const rawLine of tail.split('\n').reverse()) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      const message = extractMessage(obj);
      if (!message) continue;
      const key = `${message.role}:${message.text}`;
      if (seen?.has(key)) continue;
      seen?.add(key);
      messages.push(message);
      if (messages.length >= maxMessages) break;
    } catch {
      // Ignore malformed/incomplete tail line.
    }
  }

  return messages.reverse();
}

function extractCodexUserPreview(text: string, direction: 'first' | 'last'): string | null {
  const lines = direction === 'last' ? text.split('\n').reverse() : text.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      const message = extractCodexTranscriptMessage(obj);
      if (message?.role !== 'user' || !message.text) continue;
      return truncate(message.text.trim().replace(/\s+/g, ' '), 40);
    } catch {
      // Ignore malformed/incomplete window lines.
    }
  }
  return null;
}

function extractClaudeTranscriptMessage(obj: any): SessionTranscriptMessage | null {
  if (obj?.type === 'user') {
    const text = normalizeClaudeUserContent(obj?.message?.content, 160);
    if (!text) return null;
    return { role: 'user', text, timestamp: obj?.timestamp };
  }

  if (obj?.type === 'assistant') {
    const text = normalizeAssistantContent(obj?.message?.content);
    if (!text) return null;
    return { role: 'assistant', text, timestamp: obj?.timestamp };
  }

  return null;
}

function extractCodexTranscriptMessage(obj: any): SessionTranscriptMessage | null {
  if (obj?.type === 'response_item') {
    const payload = obj.payload;
    if (payload?.type !== 'message') return null;
    if (payload.role !== 'user' && payload.role !== 'assistant') return null;
    const text = normalizeCodexContent(payload.content, payload.role);
    if (!text) return null;
    return { role: payload.role, text, timestamp: obj?.timestamp };
  }

  if (obj?.type === 'event_msg') {
    const payload = obj.payload;
    if (payload?.type === 'user_message' && typeof payload.message === 'string') {
      const text = normalizePlainText(payload.message, 160);
      return text ? { role: 'user', text, timestamp: obj?.timestamp } : null;
    }
    if (payload?.type === 'agent_message' && typeof payload.message === 'string') {
      const text = normalizePlainText(payload.message, 180);
      return text ? { role: 'assistant', text, timestamp: obj?.timestamp } : null;
    }
  }

  return null;
}

function normalizeClaudeUserContent(content: unknown, limit: number): string {
  if (typeof content === 'string') {
    if (
      content.startsWith('<local-command') ||
      content.startsWith('<command-name') ||
      content.startsWith('<command-message')
    ) {
      return '';
    }
    return normalizePlainText(content, limit);
  }

  if (Array.isArray(content)) {
    const textBlocks = content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (!block || typeof block !== 'object' || !('type' in block)) return '';
        const typed = block as { type?: unknown; text?: unknown };
        if (typed.type === 'text' && typeof typed.text === 'string') return typed.text;
        return '';
      })
      .map((text) => text.trim().replace(/\s+/g, ' '))
      .filter(Boolean);
    if (!textBlocks.length) return '';
    return truncate(textBlocks.join('\n'), limit);
  }

  return '';
}

function normalizeAssistantContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const textBlocks = content
    .filter(
      (block) =>
        block &&
        typeof block === 'object' &&
        'type' in block &&
        block.type === 'text' &&
        'text' in block &&
        typeof block.text === 'string',
    )
    .map((block) => block.text.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
  if (!textBlocks.length) return '';
  return truncate(textBlocks.join('\n'), 180);
}

function normalizeCodexContent(content: unknown, role: 'user' | 'assistant'): string {
  if (typeof content === 'string') return normalizePlainText(content, role === 'user' ? 160 : 180);
  if (!Array.isArray(content)) return '';
  const textBlocks = content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (!block || typeof block !== 'object' || !('type' in block)) return '';
      const typed = block as { type?: unknown; text?: unknown };
      if (
        (typed.type === 'input_text' || typed.type === 'output_text' || typed.type === 'text') &&
        typeof typed.text === 'string'
      ) {
        return typed.text;
      }
      return '';
    })
    .map((text) => text.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
  if (!textBlocks.length) return '';
  return truncate(textBlocks.join('\n'), role === 'user' ? 160 : 180);
}

function normalizePlainText(text: string, limit: number): string {
  return truncate(text.trim().replace(/\s+/g, ' '), limit);
}

function fallbackSessionPreview(providerDisplayName: string, sessionId: string): string {
  return `${providerDisplayName} session ${sessionId.slice(0, 8)}`;
}

function readWindow(
  filePath: string,
  fileSize: number,
  readSize: number,
  position: 'head' | 'tail',
): string {
  const fd = openSync(filePath, 'r');
  try {
    const readLen = Math.min(fileSize, readSize);
    const offset = position === 'tail' && fileSize > readSize ? fileSize - readSize : 0;
    const buf = Buffer.alloc(readLen);
    const bytesRead = readSync(fd, buf, 0, readLen, offset);
    return buf.toString('utf-8', 0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function codexSessionIdFromFilename(filename: string): string {
  const match = filename.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
  );
  return match?.[1] ?? filename.replace(/\.jsonl$/, '');
}

/** Decode project directory name back to path: "-home-yhh-myproject" → "/home/yhh/myproject" */
function decodeDirName(name: string): string {
  // The encoding replaces / with -, so the dir name starts with -
  // e.g. /home/yhh/project → -home-yhh-project
  if (!name.startsWith('-')) return name;
  return name.replace(/-/g, '/');
}
