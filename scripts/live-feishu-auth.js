#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const TLIVE_HOME = process.env.TLIVE_HOME || join(homedir(), '.tlive');
const CONFIG_FILE = join(TLIVE_HOME, 'config.env');
const LIVE_TEST_FILE = join(TLIVE_HOME, 'live-test.env');
const DEFAULT_PORT = 8788;
const CALLBACK_PATH = '/oauth/callback';
const TOKEN_URL = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token';
const AUTHORIZE_URL = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize';
const DEFAULT_SCOPE = 'im:message im:message.send_as_user im:resource:upload offline_access';

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
    env[key] = value;
  }
  return env;
}

function envValue(key, fallback = '') {
  return process.env[key] || configEnv[key] || liveEnv[key] || fallback;
}

function base64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function serializeEnv(env) {
  return `${Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join('\n')}\n`;
}

function mask(value) {
  if (!value) return '';
  if (value.length <= 12) return '***';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function openBrowser(url) {
  if (process.env.TL_FS_AUTH_NO_BROWSER === '1') return false;
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
  return true;
}

function fail(message) {
  console.error(`[live-feishu-auth] ${message}`);
  process.exit(1);
}

const configEnv = loadEnvFile(CONFIG_FILE);
const liveEnv = loadEnvFile(LIVE_TEST_FILE);

const appId = envValue('TL_FS_APP_ID');
const appSecret = envValue('TL_FS_APP_SECRET');
if (!appId) fail(`TL_FS_APP_ID is missing. Add it to ${CONFIG_FILE}`);
if (!appSecret) fail(`TL_FS_APP_SECRET is missing. Add it to ${CONFIG_FILE}`);

const shouldRefresh = process.argv.includes('--refresh');
const port = Number.parseInt(envValue('TL_FS_AUTH_PORT', String(DEFAULT_PORT)), 10);
if (!Number.isInteger(port) || port <= 0) fail('TL_FS_AUTH_PORT must be a valid port');

const redirectUri = envValue('TL_FS_OAUTH_REDIRECT_URI', `http://localhost:${port}${CALLBACK_PATH}`);
const scope = envValue('TL_FS_TEST_OAUTH_SCOPE', DEFAULT_SCOPE);
const state = base64Url(randomBytes(24));
const codeVerifier = base64Url(randomBytes(48));
const codeChallenge = base64Url(createHash('sha256').update(codeVerifier).digest());

const authUrl = new URL(AUTHORIZE_URL);
authUrl.searchParams.set('client_id', appId);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('redirect_uri', redirectUri);
authUrl.searchParams.set('scope', scope);
authUrl.searchParams.set('state', state);
authUrl.searchParams.set('code_challenge', codeChallenge);
authUrl.searchParams.set('code_challenge_method', 'S256');

async function exchangeCode(code) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: appId,
      client_secret: appSecret,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.code !== 0 || !body.access_token) {
    throw new Error(JSON.stringify(body, null, 2));
  }
  return body;
}

async function refreshToken(refreshTokenValue) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: appId,
      client_secret: appSecret,
      refresh_token: refreshTokenValue,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.code !== 0 || !body.access_token) {
    throw new Error(JSON.stringify(body, null, 2));
  }
  return body;
}

function saveToken(token) {
  const merged = { ...liveEnv };
  merged.TL_FS_OAUTH_REDIRECT_URI = redirectUri;
  merged.TL_FS_TEST_OAUTH_SCOPE = token.scope || scope;
  merged.FEISHU_TEST_USER_ACCESS_TOKEN = token.access_token;
  if (token.refresh_token) merged.FEISHU_TEST_USER_REFRESH_TOKEN = token.refresh_token;
  if (token.expires_in) {
    merged.FEISHU_TEST_USER_TOKEN_EXPIRES_AT = new Date(
      Date.now() + Number(token.expires_in) * 1000,
    ).toISOString();
  }
  if (token.refresh_token_expires_in) {
    merged.FEISHU_TEST_USER_REFRESH_EXPIRES_AT = new Date(
      Date.now() + Number(token.refresh_token_expires_in) * 1000,
    ).toISOString();
  }

  mkdirSync(dirname(LIVE_TEST_FILE), { recursive: true });
  writeFileSync(LIVE_TEST_FILE, serializeEnv(merged), { mode: 0o600 });
  try {
    chmodSync(LIVE_TEST_FILE, 0o600);
  } catch {
    // Best effort on platforms without chmod support.
  }
}

if (shouldRefresh) {
  const refreshTokenValue = envValue('FEISHU_TEST_USER_REFRESH_TOKEN');
  if (!refreshTokenValue) fail('FEISHU_TEST_USER_REFRESH_TOKEN is missing. Run auth without --refresh.');
  try {
    const token = await refreshToken(refreshTokenValue);
    saveToken(token);
    console.log(`[live-feishu-auth] refreshed token in ${LIVE_TEST_FILE}`);
    console.log(`[live-feishu-auth] access token ${mask(token.access_token)}`);
    if (token.refresh_token) console.log('[live-feishu-auth] refresh token saved');
    process.exit(0);
  } catch (err) {
    console.error('[live-feishu-auth] refresh failed');
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', redirectUri);
  if (url.pathname !== CALLBACK_PATH) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const returnedState = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code') || '';
  const error = url.searchParams.get('error') || '';

  if (error) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Feishu authorization failed: ${error}`);
    console.error(`[live-feishu-auth] authorization failed: ${error}`);
    server.close();
    return;
  }

  if (returnedState !== state) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Invalid OAuth state.');
    console.error('[live-feishu-auth] invalid OAuth state');
    server.close();
    return;
  }

  if (!code) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Missing authorization code.');
    console.error('[live-feishu-auth] missing authorization code');
    server.close();
    return;
  }

  try {
    const token = await exchangeCode(code);
    saveToken(token);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<p>Feishu test user token saved. You can close this tab.</p>');
    console.log(`[live-feishu-auth] saved token to ${LIVE_TEST_FILE}`);
    console.log(`[live-feishu-auth] access token ${mask(token.access_token)}`);
    if (token.refresh_token) console.log('[live-feishu-auth] refresh token saved');
    server.close();
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Token exchange failed:\n${err instanceof Error ? err.message : String(err)}`);
    console.error('[live-feishu-auth] token exchange failed');
    console.error(err instanceof Error ? err.message : err);
    server.close();
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[live-feishu-auth] callback: ${redirectUri}`);
  console.log(`[live-feishu-auth] scope: ${scope}`);
  console.log('[live-feishu-auth] opening browser for Feishu authorization...');
  if (!openBrowser(authUrl.toString())) {
    console.log(`[live-feishu-auth] open this URL manually:\n${authUrl.toString()}`);
  }
});
