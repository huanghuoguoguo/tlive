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

# 5. 重复代码检测
echo "## 5. 重复代码检测 (jscpd)"
echo "   源代码重复:"
npx jscpd src --min-lines 10 --reporters console 2>&1 | grep -E "Clone found" | grep -v "__tests__" | wc -l
echo "   测试代码重复:"
npx jscpd src --min-lines 10 --reporters console 2>&1 | grep -E "Clone found" | grep "__tests__" | wc -l
echo "   详细: npx jscpd src --min-lines 10"
echo ""

# 6. 测试覆盖率
echo "## 6. 测试覆盖率"
npm run test:coverage 2>&1 | grep -E "^Statements|^Branches|^Functions|^Lines" || echo "   运行 npm run test:coverage 查看"
echo ""

# 7. 未使用依赖检测
echo "## 7. 未使用依赖检测 (depcheck)"
npx depcheck --json 2>/dev/null | jq -r '.dependencies // empty, .devDependencies // empty' 2>/dev/null || echo "✅ 无未使用依赖"
echo ""

echo "=== 检测完成 ==="
echo ""
echo "下一步:"
echo "  1. 对重复代码进行重构提取"
echo "  2. 消除 any 类型，提高类型覆盖率"
echo "  3. 提高测试覆盖率（目标 80%）"
echo "  4. 定期运行此脚本，监控熵增趋势"