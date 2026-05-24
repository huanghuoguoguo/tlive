#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const TLIVE_HOME = process.env.TLIVE_HOME || join(homedir(), '.tlive');
const CONFIG_FILE = join(TLIVE_HOME, 'config.env');
const LIVE_TEST_FILE = join(TLIVE_HOME, 'live-test.env');
const TOPIC_SESSIONS_FILE = join(TLIVE_HOME, 'runtime', 'topic-sessions.json');
const FILE_UPLOAD_URL = 'https://open.feishu.cn/open-apis/im/v1/files';

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
  npm run live:feishu:upload-file -- --root <rootMessageId> <filePath>
  npm run live:feishu:upload-file -- --latest [provider] <filePath>

Examples:
  npm run live:feishu:upload-file -- --latest claude /tmp/smoke.txt
  npm run live:feishu:upload-file -- --root om_xxx /tmp/smoke.txt
`);
}

function fail(message) {
  console.error(`[live-feishu-upload-file] ${message}`);
  process.exit(1);
}

function loadTopicSessions() {
  if (!existsSync(TOPIC_SESSIONS_FILE)) return [];
  const data = JSON.parse(readFileSync(TOPIC_SESSIONS_FILE, 'utf-8'));
  return Object.values(data).filter((entry) => entry && entry.rootMessageId);
}

function findLatestTopic(provider) {
  return loadTopicSessions()
    .filter((entry) => !provider || entry.provider === provider)
    .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))[0];
}

function parseArgs(argv) {
  let rootMessageId = '';
  let provider = '';
  const fileParts = [];

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
      if (maybeProvider && !maybeProvider.startsWith('-') && !maybeProvider.includes('/')) {
        provider = maybeProvider;
        i += 1;
      }
    } else {
      fileParts.push(arg);
    }
  }

  if (!rootMessageId) {
    const topic = findLatestTopic(provider);
    if (!topic) fail(`No topic session found${provider ? ` for provider ${provider}` : ''}`);
    rootMessageId = topic.rootMessageId;
    console.log(
      `[live-feishu-upload-file] selected topic root=${rootMessageId} provider=${topic.provider || ''} cwd=${topic.cwd || ''}`,
    );
  }

  return { rootMessageId, filePath: fileParts.join(' ') };
}

async function uploadFile(token, filePath) {
  const fileName = basename(filePath);
  const bytes = readFileSync(filePath);
  if (bytes.length === 0) fail('file must not be empty');

  const form = new FormData();
  form.set('file_type', 'stream');
  form.set('file_name', fileName);
  form.set('file', new Blob([bytes], { type: 'application/octet-stream' }), fileName);

  const response = await fetch(FILE_UPLOAD_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.code !== 0) {
    if (body.code === 99991679) {
      fail(
        'upload requires user scope im:resource:upload or im:resource; add the scope, publish the app, then re-run live:feishu:auth',
      );
    }
    fail(`upload failed code=${body.code ?? response.status} msg=${body.msg ?? response.statusText}`);
  }

  const fileKey = body.data?.file_key;
  if (!fileKey) fail('upload returned no file_key');
  return fileKey;
}

async function replyWithFile(token, rootMessageId, fileKey) {
  const url = new URL(`https://open.feishu.cn/open-apis/im/v1/messages/${rootMessageId}/reply`);
  url.searchParams.set('reply_in_thread', 'true');
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      msg_type: 'file',
      content: JSON.stringify({ file_key: fileKey }),
    }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.code !== 0) {
    fail(`reply failed code=${body.code ?? response.status} msg=${body.msg ?? response.statusText}`);
  }
  return body.data?.message_id ?? '';
}

const configEnv = loadEnvFile(CONFIG_FILE);
const liveEnv = loadEnvFile(LIVE_TEST_FILE);
const token = envValue('FEISHU_TEST_USER_ACCESS_TOKEN');
const { rootMessageId, filePath } = parseArgs(process.argv.slice(2));

if (!token) fail('FEISHU_TEST_USER_ACCESS_TOKEN is missing. Run npm run live:feishu:auth first.');
if (!rootMessageId) {
  usage();
  fail('rootMessageId is required.');
}
if (!filePath || !existsSync(filePath)) {
  usage();
  fail('filePath is required and must exist.');
}

const fileKey = await uploadFile(token, filePath);
const messageId = await replyWithFile(token, rootMessageId, fileKey);
console.log(
  `[live-feishu-upload-file] uploaded ${JSON.stringify(filePath)} to root:${rootMessageId}; message_id=${messageId}`,
);
