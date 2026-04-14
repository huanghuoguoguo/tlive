#!/bin/bash
# 熵控检测脚本 - 综合静态分析
# 运行所有熵控工具，生成汇总报告

set -e

echo "=== tlive 熵控检测报告 ==="
echo "运行时间: $(date)"
echo ""

# 1. TypeScript 类型检查
echo "## 1. TypeScript 类型检查"
npm run typecheck 2>&1 | tail -3
echo ""

# 2. Biome Lint
echo "## 2. Biome Lint"
npm run lint 2>&1 | tail -3
echo ""

# 3. Knip 死代码检测
echo "## 3. Knip 死代码检测"
npm run lint:dead 2>&1 | grep -E "^(Unused|Unlisted|Configuration)" || echo "✅ 无死代码"
echo ""

# 4. 类型覆盖率
echo "## 4. 类型覆盖率"
npx type-coverage 2>&1 | tail -1
echo "   详细: npx type-coverage --detail"
echo ""

# 5. 重复代码检测 (jscpd)
echo "## 5. 文本级重复代码 (jscpd)"
echo "   源代码重复:"
npx jscpd src --min-lines 5 --min-tokens 40 --ignore "**/__tests__/**" --reporters console 2>&1 | grep -E "Clone found" | wc -l
echo "   详细: npm run lint:duplicate"
echo ""

# 6. 语义级重复检测 (自定义脚本)
echo "## 6. 语义级重复检测 (lint:patterns)"
bash scripts/lint-patterns.sh 2>&1 | grep -E "^ERROR|^WARN|^OK|^##" || echo "✅ 无语义级重复"
echo "   详细: npm run lint:patterns"
echo ""

# 7. 测试覆盖率
echo "## 7. 测试覆盖率"
npm run test:coverage 2>&1 | grep -E "^Statements|^Branches|^Functions|^Lines" || echo "   运行 npm run test:coverage 查看"
echo ""

# 8. 未使用依赖检测
echo "## 8. 未使用依赖检测 (depcheck)"
npx depcheck --json 2>/dev/null | jq -r '.dependencies // empty, .devDependencies // empty' 2>/dev/null || echo "✅ 无未使用依赖"
echo ""

echo "=== 检测完成 ==="
echo ""
echo "下一步:"
echo "  1. 修复 lint:patterns 报告的错误（chatKey/formatSize 重复）"
echo "  2. 对 jscpd 报告的重复代码进行重构提取"
echo "  3. 消除 any 类型，提高类型覆盖率"
echo "  4. 提高测试覆盖率（目标 80%）"
echo "  5. 定期运行此脚本，监控熵增趋势"