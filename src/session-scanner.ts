import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { truncate } from './utils/string.js';

export interface ScannedSession {
  sdkSessionId: string;   // .jsonl filename (UUID)
  projectDir: string;     // encoded dir name, e.g. "-home-yhh-myproject"
  filePath: string;       // absolute path to session jsonl
  cwd: string;            // from last user message's cwd field
  mtime: number;          // file mtime (ms)
  size: number;           // file size in bytes
  preview: string;        // last user message content, truncated to 40 chars
  transcript?: SessionTranscriptMessage[]; // last few messages for expanded preview
}

export interface SessionTranscriptMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp?: string;
}

// Cache for session scans (5 second TTL)
let cachedSessions: ScannedSession[] | null = null;
let cacheTime = 0;
const CACHE_TTL = 5000;

/**
 * Invalidate session cache — call after query completes to refresh recent tasks.
 */
export function invalidateSessionCache(): void {
  cachedSessions = null;
  cacheTime = 0;
}

/**
 * Scan ~/.claude/projects/ for Claude Code session .jsonl files.
 * Returns sessions sorted by mtime descending (most recent first).
 * Results are cached for 5 seconds to avoid repeated file I/O.
 * @param limit max number of sessions to return
 * @param filterByCwd optional cwd filter — only return sessions in this directory
 */
export function scanClaudeSessions(limit = 10, filterByCwd?: string): ScannedSession[] {
  const now = Date.now();

  // Use cache if valid
  if (cachedSessions && (now - cacheTime) < CACHE_TTL) {
    return filterAndLimit(cachedSessions, limit, filterByCwd);
  }

  // Scan fresh
  cachedSessions = doScan();
  cacheTime = now;
  return filterAndLimit(cachedSessions, limit, filterByCwd);
}

function filterAndLimit(sessions: ScannedSession[], limit: number, filterByCwd?: string): ScannedSession[] {
  let filtered = sessions.filter(s => s.preview !== '(empty)');
  if (filterByCwd) {
    const normalizedFilter = filterByCwd.replace(/\/+$/, '');
    // Match current directory AND all subdirectories (prefix match)
    filtered = filtered.filter(s => {
      const normalizedCwd = s.cwd.replace(/\/+$/, '');
      // Exact match or subdirectory (cwd starts with filter + /)
      return normalizedCwd === normalizedFilter || normalizedCwd.startsWith(normalizedFilter + '/');
    });
  }
  return filtered.slice(0, limit);
}

function doScan(): ScannedSession[] {
  const projectsDir = join(homedir(), '.claude', 'projects');

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== 'memory')
      .map(d => d.name);
  } catch {
    return [];
  }

  // Collect all .jsonl files with mtime
  const candidates: Array<{ path: string; filePath: string; projectDir: string; sessionId: string; mtime: number; size: number }> = [];

  for (const dir of projectDirs) {
    const dirPath = join(projectsDir, dir);
    let files: string[];
    try {
      files = readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
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
          path: filePath,
          projectDir: dir,
          sessionId: file.replace('.jsonl', ''),
          mtime: st.mtimeMs,
          size: st.size,
        });
      } catch {
      }
    }
  }

  // Sort by mtime descending
  candidates.sort((a, b) => b.mtime - a.mtime);

  // Parse header of each file for metadata
  return candidates.map(c => parseSessionHeader(c.path, c.projectDir, c.sessionId, c.mtime, c.size));
}

function parseSessionHeader(
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
    const READ_SIZE = 32 * 1024;
    const st = statSync(filePath);
    const fd = openSync(filePath, 'r');
    try {
      const fileSize = st.size;
      const offset = fileSize > READ_SIZE ? fileSize - READ_SIZE : 0;
      const readLen = fileSize > READ_SIZE ? READ_SIZE : fileSize;
      const buf = Buffer.alloc(readLen);
      const bytesRead = readSync(fd, buf, 0, readLen, offset);
      const tail = buf.toString('utf-8', 0, bytesRead);
      const lines = tail.split('\n');

    // Parse lines backwards to find last meaningful message
    let lastCwd = '';
    let lastUserMsg = '';

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);

        // Track cwd from any message (first found going backwards)
        if (!lastCwd && obj.cwd) lastCwd = obj.cwd;

        // Look for user messages with content
        if (obj.type === 'user' && !lastUserMsg && obj.message?.content) {
          const content = obj.message.content;
          // Skip meta/command messages
          if (content.startsWith('<local-command') || content.startsWith('<command-name') || content.startsWith('<command-message')) continue;
          lastUserMsg = content;
          break; // Found last user message, stop
        }
      } catch {
      }
    }

    if (lastCwd) cwd = lastCwd;
    if (lastUserMsg) {
      // Clean up and truncate preview
      preview = truncate(lastUserMsg.trim().replace(/\s+/g, ' '), 40);
    }
    } finally {
      closeSync(fd);
    }
  } catch {
    // File unreadable — use defaults
  }

  return { sdkSessionId: sessionId, projectDir, filePath, cwd, mtime, size, preview };
}

export function readSessionTranscriptPreview(
  session: ScannedSession,
  maxMessages = 4,
): SessionTranscriptMessage[] {
  try {
    const READ_SIZE = 96 * 1024;
    const st = statSync(session.filePath);
    const fd = openSync(session.filePath, 'r');
    try {
      const fileSize = st.size;
      const offset = fileSize > READ_SIZE ? fileSize - READ_SIZE : 0;
      const readLen = fileSize > READ_SIZE ? READ_SIZE : fileSize;
      const buf = Buffer.alloc(readLen);
      const bytesRead = readSync(fd, buf, 0, readLen, offset);
      const tail = buf.toString('utf-8', 0, bytesRead);
      const messages: SessionTranscriptMessage[] = [];

      for (const rawLine of tail.split('\n').reverse()) {
        const line = rawLine.trim();
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          const message = extractTranscriptMessage(obj);
          if (!message) continue;
          messages.push(message);
          if (messages.length >= maxMessages) break;
        } catch {}
      }

      return messages.reverse();
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
}

function extractTranscriptMessage(obj: any): SessionTranscriptMessage | null {
  if (obj?.type === 'user') {
    const text = normalizeUserContent(obj?.message?.content);
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

function normalizeUserContent(content: unknown): string {
  if (typeof content === 'string') {
    if (content.startsWith('<local-command') || content.startsWith('<command-name') || content.startsWith('<command-message')) {
      return '';
    }
    return truncate(content.trim().replace(/\s+/g, ' '), 160);
  }

  return '';
}

function normalizeAssistantContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const textBlocks = content
    .filter(block => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
  if (!textBlocks.length) return '';
  return truncate(textBlocks.join('\n'), 180);
}

/** Decode project directory name back to path: "-home-yhh-myproject" → "/home/yhh/myproject" */
function decodeDirName(name: string): string {
  // The encoding replaces / with -, so the dir name starts with -
  // e.g. /home/yhh/project → -home-yhh-project
  if (!name.startsWith('-')) return name;
  return name.replace(/-/g, '/');
}
