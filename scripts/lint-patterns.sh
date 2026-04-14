#!/bin/bash
# 语义级重复检测 — 检测 knip/jscpd 无法覆盖的模式
# 包括：重复 key 构建、未使用共享工具函数、硬编码路径等
#
# 用法: bash scripts/lint-patterns.sh [--fix]
# --fix 模式只打印建议，不自动修复

set -euo pipefail

RED='\033[0;31m'
YELLOW='\033[0;33m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

ISSUES=0
WARNINGS=0

issue() {
  echo -e "${RED}ERROR${NC} $1"
  ISSUES=$((ISSUES + 1))
}

warn() {
  echo -e "${YELLOW}WARN${NC}  $1"
  WARNINGS=$((WARNINGS + 1))
}

ok() {
  echo -e "${GREEN}OK${NC}    $1"
}

echo -e "${BOLD}=== 语义级重复检测 ===${NC}"
echo ""

# ─────────────────────────────────────────────
# 1. Duplicate chatKey builders
# ─────────────────────────────────────────────
echo -e "${BOLD}## 1. chatKey 构建模式重复${NC}"

# Pattern: any function/method that returns `${x}:${y}` with channelType/chatId semantics
CHATKEY_DEFS=$(grep -rn 'return `\${.*}:\${.*}`' src/ --include="*.ts" \
  | grep -v '__tests__' \
  | grep -v 'node_modules' \
  | grep -iE 'channel|chat|state|binding|attachment' || true)

CHATKEY_INLINE=$(grep -rn '`\${.*channelType}:\${.*chatId}`' src/ --include="*.ts" \
  | grep -v '__tests__' \
  | grep -v 'node_modules' \
  | grep -v 'stateKey\|chatKey\|bindingKey\|permKey\|attachmentKey' || true)

CHATKEY_COUNT=$(echo "$CHATKEY_DEFS" | grep -c . || true)
CHATKEY_INLINE_COUNT=$(echo "$CHATKEY_INLINE" | grep -c . || true)

if [ "$CHATKEY_COUNT" -gt 2 ]; then
  issue "chatKey 构建函数有 ${CHATKEY_COUNT} 个独立实现（应统一为 1 个共享函数）"
  echo "$CHATKEY_DEFS" | sed 's/^/       /'
else
  ok "chatKey 构建函数数量合理 (${CHATKEY_COUNT})"
fi

if [ "$CHATKEY_INLINE_COUNT" -gt 0 ]; then
  warn "有 ${CHATKEY_INLINE_COUNT} 处内联 chatKey 构建（应使用共享函数）"
  echo "$CHATKEY_INLINE" | sed 's/^/       /'
fi
echo ""

# ─────────────────────────────────────────────
# 2. Duplicate formatSize implementations
# ─────────────────────────────────────────────
echo -e "${BOLD}## 2. formatSize 重复实现${NC}"

FORMATSIZE_COUNT=$(grep -rn 'function formatSize' src/ --include="*.ts" | grep -v '__tests__' | grep -c . || true)
if [ "$FORMATSIZE_COUNT" -gt 1 ]; then
  issue "formatSize 有 ${FORMATSIZE_COUNT} 份实现（应只有 1 份在 session-format.ts）"
  grep -rn 'function formatSize' src/ --include="*.ts" | grep -v '__tests__' | sed 's/^/       /'
else
  ok "formatSize 只有 1 份实现"
fi
echo ""

# ─────────────────────────────────────────────
# 3. Hardcoded ~/.tlive path instead of getTliveHome()
# ─────────────────────────────────────────────
echo -e "${BOLD}## 3. 硬编码 ~/.tlive 路径${NC}"

# Pattern: join(homedir(), '.tlive') or similar, excluding the getTliveHome definition itself
HARDCODED_TLIVE=$(grep -rn "homedir().*['\"]\.tlive['\"]" src/ --include="*.ts" \
  | grep -v '__tests__' \
  | grep -v 'getTliveHome' || true)

HARDCODED_COUNT=$(echo "$HARDCODED_TLIVE" | grep -c . || true)
if [ "$HARDCODED_COUNT" -gt 0 ]; then
  warn "有 ${HARDCODED_COUNT} 处硬编码 ~/.tlive 路径（应使用 getTliveHome()）"
  echo "$HARDCODED_TLIVE" | sed 's/^/       /'
else
  ok "无硬编码 ~/.tlive 路径"
fi
echo ""

# ─────────────────────────────────────────────
# 4. Inline tilde expansion instead of shared utility
# ─────────────────────────────────────────────
echo -e "${BOLD}## 4. 内联 ~ 展开${NC}"

TILDE_EXPAND=$(grep -rn "startsWith.*['\"]~['\"]" src/ --include="*.ts" \
  | grep -v '__tests__' \
  | grep -v 'expandTilde' || true)

TILDE_COUNT=$(echo "$TILDE_EXPAND" | grep -c . || true)
if [ "$TILDE_COUNT" -gt 1 ]; then
  warn "有 ${TILDE_COUNT} 处内联 ~ 展开（应提取 expandTilde() 工具函数）"
  echo "$TILDE_EXPAND" | sed 's/^/       /'
else
  ok "~ 展开逻辑无重复"
fi
echo ""

# ─────────────────────────────────────────────
# 5. Inline truncation instead of truncate()
# ─────────────────────────────────────────────
echo -e "${BOLD}## 5. 内联截断而非使用 truncate()${NC}"

# Pattern: .slice(0, N) + '...' or similar, excluding the truncate utility itself
INLINE_TRUNC=$(grep -rn "\.slice(0,.*\.\.\." src/ --include="*.ts" \
  | grep -v '__tests__' \
  | grep -v 'utils/string' || true)

INLINE_TRUNC2=$(grep -rn "\.length > [0-9].*\.slice(0," src/ --include="*.ts" \
  | grep -v '__tests__' \
  | grep -v 'utils/string' || true)

TRUNC_COUNT=$(echo -e "${INLINE_TRUNC}\n${INLINE_TRUNC2}" | sort -u | grep -c . || true)
if [ "$TRUNC_COUNT" -gt 0 ]; then
  warn "有 ${TRUNC_COUNT} 处内联截断（应使用 truncate()）"
  echo -e "${INLINE_TRUNC}\n${INLINE_TRUNC2}" | sort -u | grep . | sed 's/^/       /'
else
  ok "无内联截断"
fi
echo ""

# ─────────────────────────────────────────────
# 6. Duplicate notification emoji/template maps
# ─────────────────────────────────────────────
echo -e "${BOLD}## 6. 通知 emoji map 重复${NC}"

EMOJI_MAP_COUNT=$(grep -rn "idle_prompt.*['\"]⏰\|stop.*['\"]🛑\|generic.*['\"]ℹ️" src/ --include="*.ts" \
  | grep -v '__tests__' \
  | grep -c . || true)

if [ "$EMOJI_MAP_COUNT" -gt 2 ]; then
  warn "通知 emoji map 在 ${EMOJI_MAP_COUNT} 处定义（应提取为共享常量）"
  grep -rn "idle_prompt.*['\"]⏰\|stop.*['\"]🛑\|generic.*['\"]ℹ️" src/ --include="*.ts" \
    | grep -v '__tests__' | sed 's/^/       /'
else
  ok "通知 emoji map 无明显重复"
fi
echo ""

# ─────────────────────────────────────────────
# 7. Inconsistent session ID shortening
# ─────────────────────────────────────────────
echo -e "${BOLD}## 7. session ID 截短不一致${NC}"

# Look for .slice(-N) or .slice(0, N) on session/sdk IDs
SID_SHORTEN=$(grep -rn '\.slice(-[0-9]\+)\|\.slice(0, [0-9]\+)' src/ --include="*.ts" \
  | grep -v '__tests__' \
  | grep -iE 'session|sdk|binding' || true)

SID_COUNT=$(echo "$SID_SHORTEN" | grep -c . || true)
if [ "$SID_COUNT" -gt 3 ]; then
  warn "session ID 截短出现 ${SID_COUNT} 次，长度/方向可能不一致（建议统一为 shortId()）"
  echo "$SID_SHORTEN" | sed 's/^/       /'
else
  ok "session ID 截短数量合理 (${SID_COUNT})"
fi
echo ""

# ─────────────────────────────────────────────
# 8. Duplicate debounced-save pattern
# ─────────────────────────────────────────────
echo -e "${BOLD}## 8. debounced-save 模式重复${NC}"

DEBOUNCE_COUNT=$(grep -rn 'SAVE_DEBOUNCE_MS\|debouncedSave\|savePersisted' src/ --include="*.ts" \
  | grep -v '__tests__' \
  | grep -v 'import' \
  | grep -oP '[^/]+\.ts' | sort -u | grep -c . || true)

if [ "$DEBOUNCE_COUNT" -gt 1 ]; then
  warn "debounced-save 模式在 ${DEBOUNCE_COUNT} 个文件中实现（可提取为共享基类）"
  grep -rn 'SAVE_DEBOUNCE_MS' src/ --include="*.ts" | grep -v '__tests__' | sed 's/^/       /'
else
  ok "debounced-save 模式无重复"
fi
echo ""

# ─────────────────────────────────────────────
# 9. Duplicate atomic write pattern
# ─────────────────────────────────────────────
echo -e "${BOLD}## 9. atomic write 模式重复${NC}"

ATOMIC_COUNT=$(grep -rn 'renameSync\|\.tmp.*writeFileSync\|writeFileSync.*\.tmp' src/ --include="*.ts" \
  | grep -v '__tests__' \
  | grep -oP '[^/]+\.ts' | sort -u | grep -c . || true)

if [ "$ATOMIC_COUNT" -gt 1 ]; then
  warn "atomic write 模式在 ${ATOMIC_COUNT} 个文件中实现（可提取为共享工具函数）"
  grep -rn 'renameSync' src/ --include="*.ts" | grep -v '__tests__' | sed 's/^/       /'
else
  ok "atomic write 模式无重复"
fi
echo ""

# ─────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────
echo -e "${BOLD}=== 汇总 ===${NC}"
echo -e "  错误: ${RED}${ISSUES}${NC}"
echo -e "  警告: ${YELLOW}${WARNINGS}${NC}"
echo ""

if [ "$ISSUES" -gt 0 ]; then
  echo -e "${RED}发现 ${ISSUES} 个需要修复的问题${NC}"
  exit 1
elif [ "$WARNINGS" -gt 0 ]; then
  echo -e "${YELLOW}发现 ${WARNINGS} 个建议改进项${NC}"
  exit 0
else
  echo -e "${GREEN}全部通过${NC}"
  exit 0
fi
