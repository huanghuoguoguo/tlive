# 飞书卡片文档获取方法

飞书开放平台文档是 SPA（单页应用），直接用 WebFetch 无法获取内容。但飞书官方为 AI 提供了 `.md` 版本的文档。

## 获取方法

### 1. 发现 markdown 版本链接

飞书文档页面 HTML 中有 `<link rel="alternate" type="text/markdown">` 标签：

```html
<link rel="alternate" type="text/markdown" 
  href="https://open.feishu.cn/document/.../xxx.md" 
  tip="pure markdown version, better for ai" />
```

### 2. 用 curl 获取 markdown 版本

```bash
# 卡片 JSON 2.0 结构
curl -sL "https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-structure.md"

# 表单容器
curl -sL "https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/containers/form-container.md"

# 输入框组件
curl -sL "https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/interactive-components/input.md"

# 下拉选择-单选组件
curl -sL "https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/interactive-components/single-select-dropdown-menu.md"

# 组件概述
curl -sL "https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/component-json-v2-overview.md"

# 消息内容结构
curl -sL "https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json.md"
```

### 3. 关键文档 URL 模板

文档 URL 模式：
```
https://open.feishu.cn/document/{path}.md
```

常用路径：

| 文档 | 路径 |
|------|------|
| 卡片 JSON 2.0 结构 | `uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-structure` |
| 组件概述 | `uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/component-json-v2-overview` |
| 表单容器 | `uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/containers/form-container` |
| 输入框 | `uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/interactive-components/input` |
| 下拉选择-单选 | `uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/interactive-components/single-select-dropdown-menu` |
| 下拉选择-多选 | `uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/interactive-components/multi-select-dropdown-menu` |
| 按钮 | `uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/interactive-components/button` |
| 卡片回传交互 | `uAjLw4CM/ukzMukzMukzM/feishu-cards/card-callback-communication` |
| 发送消息内容结构 | `server-docs/im-v1/message-content-description/create_json` |

### 4. 注意事项

- 某些路径的 `.md` 版本可能不存在（返回 "This document is not found")
- 中英文路径不同，中文路径用 `ukTMukTMukTM`，英文路径用 `ukzMukzMukzM`
- 如果 `.md` 版本不存在，可以尝试：
  1. 用 Playwright/Puppeteer 获取动态页面内容
  2. 使用飞书卡片搭建工具可视化编辑后复制 JSON

## 关键知识点总结

### Card 2.0 表单结构

```json
{
  "schema": "2.0",
  "body": {
    "elements": [
      {
        "tag": "form",
        "name": "form_id",
        "elements": [
          { "tag": "input", "name": "field_name", ... },
          { "tag": "select_static", "name": "select_name", ... },
          {
            "tag": "column_set",
            "columns": [{
              "elements": [{
                "tag": "button",
                "form_action_type": "submit",  // 关键！
                "name": "submit_btn"
              }]
            }]
          }
        ]
      }
    ]
  }
}
```

### 回调数据结构

```json
{
  "event": {
    "action": {
      "tag": "button",
      "form_value": {
        "field_name": "用户输入值",
        "select_name": "选项值"
      }
    }
  }
}
```

### 按钮类型

- `form_action_type: "submit"` — 提交表单
- `form_action_type: "reset"` — 重置表单
- `behaviors: [{ type: "callback", value: {...} }]` — 普通回调按钮

---

*文档更新：2026-04-10*