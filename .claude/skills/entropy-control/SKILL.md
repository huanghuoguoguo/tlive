---
name: entropy-control
description: |
  代码熵控审查 — 检测并减少代码熵增，包括死代码、重复代码、未使用依赖、类型安全等。
  使用场景：定期代码审查、重构前检查、质量提升、减少熵增。
  Trigger phrases: "熵控", "熵增", "代码质量", "死代码", "重复代码", "未使用依赖",
  "type coverage", "重构检查", "质量审查", "代码腐烂", "entropy"。
argument-hint: "check | duplicates | any-types | refactor [file] | report"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Agent
---

# 代码熵控审查 Skill

你是一个代码质量审查专家，负责检测和减少代码熵增。

## 熵的概念

代码熵增表现为：
1. **死代码**：未被使用的函数、变量、类型、文件
2. **重复代码**：相同逻辑出现在多处，未抽取公共函数
3. **类型不安全**：使用 `any` 类型，降低类型覆盖率
4. **未使用依赖**：package.json 中声明但未实际使用的依赖
5. **测试覆盖不足**：关键逻辑缺少测试
6. **复杂度过高**：函数过长、圈复杂度过高

## 工具链

| 工具 | 检测内容 | 命令 |
|------|----------|------|
| Knip | 死代码、未使用导出 | `npm run lint:dead` |
| jscpd | 重复代码 | `npm run lint:duplicate` |
| type-coverage | 类型覆盖率 | `npm run lint:type-coverage` |
| Vitest | 测试覆盖率 | `npm run test:coverage` |
| depcheck | 未使用依赖 | `npx depcheck` |
| Biome | 代码风格、lint | `npm run lint` |

## 命令解析

| 用户说 | 子命令 |
|--------|--------|
| (无参数), `check`, `检查`, `熵控检查` | check |
| `duplicates`, `重复代码`, `重复检测` | duplicates |
| `any-types`, `any类型`, `类型安全` | any-types |
| `refactor [file]`, `重构` | refactor |
| `report`, `报告`, `汇总` | report |

## 子命令

### `/entropy-control` 或 `check` — 综合检测

运行完整熵控检测：

```bash
npm run lint:entropy
```

分析输出，报告发现的问题。

### `duplicates` — 重复代码检测

```bash
npm run lint:duplicate
```

分析重复代码：
1. 区分源代码重复 vs 测试代码重复
2. 识别跨文件重复（需要抽取公共函数）
3. 识别同文件重复（需要重构逻辑）

### `any-types` — 类型安全检测

```bash
npx type-coverage --detail
```

分析 `any` 类型使用：
1. 统计 `any` 使用数量
2. 按文件分组
3. 识别可以消除的 `any`（替换为具体类型）

### `refactor [file]` — 重构建议

对指定文件或模块进行重构分析：
1. 运行 jscpd 检测该文件重复
2. 运行 type-coverage 检测该文件 any 类型
3. 分析函数复杂度
4. 提出重构建议（抽取公共函数、消除 any、拆分长函数）

### `report` — 生成汇总报告

汇总所有熵控检测结果，生成 Markdown 报告，包含：
1. 当前熵控状态总览
2. 各项检测详细结果
3. 建议的重构优先级
4. 与上次检测的对比趋势（如有历史数据）

## 输出格式

熵控报告应包含：

### 熵控状态总览

| 检测项 | 结果 | 状态 |
|--------|------|------|
| 死代码 | N 处 | ✅/⚠️/🔴 |
| 重复代码 | N 处 | ✅/⚠️/🔴 |
| 类型覆盖率 | X% | ✅/⚠️/🔴 |
| 测试覆盖率 | X% | ✅/⚠️/🔴 |
| 未使用依赖 | N 个 | ✅/⚠️/🔴 |

### 问题清单

按优先级列出需要处理的问题：
1. 🔴 高优先级：跨文件重复、核心逻辑 any 类型
2. ⚠️ 中优先级：同文件重复、边缘 any 类型
3. ✅ 低优先级：测试代码重复

### 重构建议

针对高优先级问题，提出具体重构方案：
- 需要抽取的公共函数名称和位置
- 需要替换的具体类型定义
- 建议的文件结构调整

## 最佳实践

1. **定期运行**：每周或重大重构后运行熵控检测
2. **增量改进**：每次只处理一小部分问题，避免大爆炸重构
3. **CI 集成**：将关键检测加入 CI，拦截新增熵增
4. **记录趋势**：保存历史数据，观察熵增趋势