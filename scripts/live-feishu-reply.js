#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TLIVE_HOME = process.env.TLIVE_HOME || join(homedir(), '.tlive');
const SERVER_CONFIG_FILE = join(TLIVE_HOME, 'server.env');
const LIVE_TEST_FILE = join(TLIVE_HOME, 'live-test.env');
const TOPIC_SESSIONS_FILE = join(TLIVE_HOME, 'runtime', 'topic-sessions.json');

function loadEnvFile(path) {
  const env = {};
  if (!existsSync(path)) return env;
  const content = readFileSync(path, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const raw = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const eq = raw.indexOf('=');
    if (eq === -1) continue;
    const key = raw.slice(0, eq).trim();
    let value = raw.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value.replace(/'\\''/g, "'");
  }
  return env;
}

function envValue(key, fallback = '') {
  return process.env[key] || liveEnv[key] || configEnv[key] || fallback;
}

function usage() {
  console.error(`Usage:
  npm run live:feishu:reply -- --root <rootMessageId> <message>
  npm run live:feishu:reply -- --latest [provider] <message>

Examples:
  npm run live:feishu:reply -- --latest codex "/pwd"
  npm run live:feishu:reply -- --root om_xxx "/bash pwd"
`);
}

function fail(message) {
  console.error(`[live-feishu-reply] ${message}`);
  process.exit(1);
}

function loadTopicSessions() {
  if (!existsSync(TOPIC_SESSIONS_FILE)) return [];
  const data = JSON.parse(readFileSync(TOPIC_SESSIONS_FILE, 'utf-8'));
  return Object.values(data).filter((entry) => entry && entry.rootMessageId);
}

function findLatestTopic(provider) {
  const sessions = loadTopicSessions();
  return sessions
    .filter((entry) => !provider || entry.provider === provider)
    .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))[0];
}

function parseArgs(argv) {
  let rootMessageId = '';
  let provider = '';
  const messageParts = [];

  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(0);
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      rootMessageId = argv[i + 1] || '';
      i += 1;
    } else if (arg === '--latest') {
      const maybeProvider = argv[i + 1] || '';
      if (maybeProvider && !maybeProvider.startsWith('-') && !maybeProvider.startsWith('/')) {
        provider = maybeProvider;
        i += 1;
      }
    } else {
      messageParts.push(arg);
    }
  }

  if (!rootMessageId) {
    const topic = findLatestTopic(provider);
    if (!topic) fail(`No topic session found${provider ? ` for provider ${provider}` : ''}`);
    rootMessageId = topic.rootMessageId;
    console.log(
      `[live-feishu-reply] selected topic root=${rootMessageId} provider=${topic.provider || ''} cwd=${topic.cwd || ''}`,
    );
  }

  return { rootMessageId, text: messageParts.join(' ') };
}

const configEnv = loadEnvFile(SERVER_CONFIG_FILE);
const liveEnv = loadEnvFile(LIVE_TEST_FILE);
const token = envValue('FEISHU_TEST_USER_ACCESS_TOKEN');
const { rootMessageId, text } = parseArgs(process.argv.slice(2));

if (!token) fail('FEISHU_TEST_USER_ACCESS_TOKEN is missing. Run npm run live:feishu:auth first.');
if (!rootMessageId) {
  usage();
  fail('rootMessageId is required.');
}
if (!text) {
  usage();
  fail('message text is required.');
}

const url = new URL(`https://open.feishu.cn/open-apis/im/v1/messages/${rootMessageId}/reply`);
url.searchParams.set('reply_in_thread', 'true');

const response = await fetch(url, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json; charset=utf-8',
  },
  body: JSON.stringify({
    msg_type: 'text',
    content: JSON.stringify({ text }),
  }),
});

const body = await response.json().catch(() => ({}));
if (!response.ok || body.code !== 0) {
  console.error('[live-feishu-reply] request failed');
  console.error(JSON.stringify(body, null, 2));
  process.exit(1);
}

console.log(
  `[live-feishu-reply] replied "${text}" to root:${rootMessageId}; message_id=${body.data?.message_id ?? ''}`,
);
