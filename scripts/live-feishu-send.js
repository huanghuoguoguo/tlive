#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TLIVE_HOME = process.env.TLIVE_HOME || join(homedir(), '.tlive');
const CONFIG_FILE = join(TLIVE_HOME, 'config.env');
const LIVE_TEST_FILE = join(TLIVE_HOME, 'live-test.env');
const MESSAGE_URL = 'https://open.feishu.cn/open-apis/im/v1/messages';

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
  npm run live:feishu:send -- <message>

Examples:
  npm run live:feishu:send -- "/home"
  npm run live:feishu:send -- "/new claude yhh-client-..."
`);
}

function fail(message) {
  console.error(`[live-feishu-send] ${message}`);
  process.exit(1);
}

const configEnv = loadEnvFile(CONFIG_FILE);
const liveEnv = loadEnvFile(LIVE_TEST_FILE);
const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
  usage();
  process.exit(0);
}

const token = envValue('FEISHU_TEST_USER_ACCESS_TOKEN');
const chatId = envValue('TL_FS_TEST_CHAT_ID');
const receiveIdType = envValue('TL_FS_TEST_RECEIVE_ID_TYPE', 'chat_id');
const text = argv.join(' ') || '/home';

if (!token) fail(`FEISHU_TEST_USER_ACCESS_TOKEN is missing. Run npm run live:feishu:auth first.`);
if (!chatId) fail(`TL_FS_TEST_CHAT_ID is missing. Add it to ${LIVE_TEST_FILE}`);

const url = new URL(MESSAGE_URL);
url.searchParams.set('receive_id_type', receiveIdType);

const response = await fetch(url, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json; charset=utf-8',
  },
  body: JSON.stringify({
    receive_id: chatId,
    msg_type: 'text',
    content: JSON.stringify({ text }),
  }),
});

const body = await response.json().catch(() => ({}));
if (!response.ok || body.code !== 0) {
  console.error('[live-feishu-send] request failed');
  console.error(JSON.stringify(body, null, 2));
  process.exit(1);
}

console.log(
  `[live-feishu-send] sent "${text}" to ${receiveIdType}:${chatId}; message_id=${body.data?.message_id ?? ''}`,
);
