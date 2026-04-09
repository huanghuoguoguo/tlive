// Strip ANSI escape sequences (terminal color codes, cursor movement, etc.)
// biome-ignore lint/complexity/useRegexLiterals: literal form triggers a control-character warning here
const ANSI_PATTERN = new RegExp('\\u001B(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~])', 'g');

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

// API key patterns — match common provider key formats
const API_KEY_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // OpenAI
  { pattern: /sk-proj-[A-Za-z0-9_-]{6,}/g, replacement: 'sk-proj-[REDACTED]' },
  { pattern: /sk-[A-Za-z0-9]{20,}/g, replacement: 'sk-[REDACTED]' },
  // Anthropic
  { pattern: /sk-ant-api\d{2}-[A-Za-z0-9_-]{6,}/g, replacement: 'sk-ant-[REDACTED]' },
  // AWS
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: 'AKIA[REDACTED]' },
  // GitHub
  { pattern: /ghp_[A-Za-z0-9]{36,}/g, replacement: 'ghp_[REDACTED]' },
  { pattern: /github_pat_[A-Za-z0-9_]{20,}/g, replacement: 'github_pat_[REDACTED]' },
  { pattern: /gho_[A-Za-z0-9]{36,}/g, replacement: 'gho_[REDACTED]' },
  { pattern: /ghu_[A-Za-z0-9]{36,}/g, replacement: 'ghu_[REDACTED]' },
  { pattern: /ghs_[A-Za-z0-9]{36,}/g, replacement: 'ghs_[REDACTED]' },
  { pattern: /ghr_[A-Za-z0-9]{36,}/g, replacement: 'ghr_[REDACTED]' },
  // Slack
  { pattern: /xox[boaprs]-[0-9A-Za-z-]{10,}/g, replacement: 'xox_[REDACTED]' },
  // Bearer / JWT tokens
  { pattern: /Bearer\s+eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, replacement: 'Bearer [REDACTED]' },
];

// Private key blocks
const PRIVATE_KEY_PATTERN = /-----BEGIN\s+(RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END\s+(RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g;

// Environment variable patterns — only for sensitive-looking variable names
// Matches: SOMETHING_PASSWORD="value", SECRET_KEY=value, API_TOKEN='value'
const SENSITIVE_ENV_PATTERN = /\b([A-Z_]*(?:PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|ACCESS_KEY|AUTH)[A-Z_]*)=["']?([^\s"']{12,})["']?/g;

/**
 * Redact sensitive content (API keys, tokens, passwords, private keys)
 * from text before sending to IM platforms.
 */
export function redactSensitiveContent(text: string): string {
  let result = stripAnsi(text);

  // 1. Private keys (multi-line, must be first)
  PRIVATE_KEY_PATTERN.lastIndex = 0;
  result = result.replace(PRIVATE_KEY_PATTERN, '[PRIVATE KEY REDACTED]');

  // 2. API key patterns
  for (const { pattern, replacement } of API_KEY_PATTERNS) {
    // Reset regex lastIndex for global patterns
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }

  // 3. Sensitive environment variables
  SENSITIVE_ENV_PATTERN.lastIndex = 0;
  result = result.replace(SENSITIVE_ENV_PATTERN, (_match, varName, _value) => {
    return `${varName}=[REDACTED]`;
  });

  return result;
}
