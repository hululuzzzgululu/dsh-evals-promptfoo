[English](README.md) | [简体中文](README.zh-CN.md)

# DSH Evals with Promptfoo

一句话：这是一个“AI Agent 自动考试器”——让 AI 真正完成一组任务，再自动检查它的回答是否正确、工具是否用对、运行是否健康，并生成可以查看和比较的报告。

[DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 是负责运行 AI Agent、让模型调用工具完成任务的程序；[Promptfoo](https://www.promptfoo.dev/docs/getting-started/) 是负责组织测试用例、执行断言和展示评测报告的工具。本项目把二者连接起来：通过 DSH 官方 TypeScript SDK 启动真实 Agent，收集最终回答、Tool 调用、Subagent 和执行状态，再交给 Promptfoo 展示和评分。

> `npm run e2e` 会启动真实 DSH 并调用真实模型，会消耗模型额度。项目中没有 mock Runtime，也没有自动回退到 mock。

## 快速开始

### 1. 准备依赖

需要：

- Node.js 22 或更高版本；
- npm；
- 一个可用的 DSH 模型配置，或者 OpenAI-compatible 模型的 URL、API Key 和模型名。

安装项目依赖：

```bash
npm ci
```
可以先运行离线检查：

```bash
npm run smoke
```

该命令只执行构建、类型检查和单元测试，不启动 DSH，也不调用 Candidate 或 Judge 模型。

### 2. 配置 `.env`

复制模板：

```bash
cp .env.example .env
```

编辑 `.env`：

```dotenv
# 被测 DSH Agent 使用的模型
CANDIDATE_BASE_URL=https://candidate.example.com/v1
CANDIDATE_API_KEY=your-candidate-api-key
CANDIDATE_MODEL_NAME=your-candidate-model

# llm-rubric、factuality 等模型裁判使用的模型
JUDGE_BASE_URL=https://judge.example.com/v1
JUDGE_API_KEY=your-judge-api-key
JUDGE_MODEL_NAME=your-judge-model
```

这些值的含义：

| 变量 | 用途 |
| --- | --- |
| `CANDIDATE_*` | 被测 DSH Agent 的模型地址、凭证和模型名 |
| `JUDGE_*` | Promptfoo 直接调用的独立裁判模型 |

如果本机 DSH profile 已经配置好了模型和凭证，可以让三个 `CANDIDATE_*` 保持为空；SDK 会继续使用 profile、DSH credential store 和环境中的默认配置。`JUDGE_*` 不会读取 DSH 的私有凭证，只要所选 Case 包含 `llm-rubric`、`factuality` 等模型评分断言，就需要单独配置它们。Base URL 通常以 `/v1` 结尾。

默认运行结构位于 [`config/candidate.yaml`](config/candidate.yaml)。在这里修改被测 DSH 的 `profile`、`provider`、patch、工作目录或模型环境变量映射；凭证仍应保存在被 Git 忽略的 `.env` 中。

### 3. 查看可运行领域

```bash
npm run domains
```

当前会看到：

```text
Dataset domains:
- helloworld (3 YAML files)
- smoke (1 YAML file)
```

### 4. 运行第一个真实 Eval

运行完整的 Hello World 领域：

```bash
npm run e2e -- helloworld
```

`helloworld` 包含三个真实 DSH Case：读取 `package.json`、读取 `tsconfig.json`，以及读取 README 后由 Judge 评分。因此完整运行它需要 Candidate 配置；其中最后一个 Case 还需要 Judge 配置。

如果暂时只配置了 Candidate，先运行不需要 Judge 的最小检查：

```bash
npm run e2e -- smoke
```

不传领域名会运行所有自动发现的领域：

```bash
npm run e2e
```

### 5. 查看报告

```bash
npm run report
```

该命令启动 Promptfoo 本地报告 UI，默认地址通常是 `http://localhost:15500`，并读取之前持久化的 Eval 结果。报告中可以查看最终回答、断言结果、命名指标，并通过 `domain=helloworld` 等标签识别运行领域。

## 添加自己的 Dataset

Dataset 放在仓库根目录的 `datasets/` 下。领域来自文件或一级目录名称，无需修改
`config/evals/`。

### 最简单：一个领域一个 YAML

创建 `datasets/my-domain.yaml`：

```yaml
- description: returns the expected readiness marker
  metadata:
    caseId: my-domain-ready
    category: smoke
  vars:
    prompt: Reply with exactly READY
  assert:
    - type: equals
      value: READY
```

然后运行：

```bash
npm run domains
npm run e2e -- my-domain
```

每个 Case 都会自动获得全局 `executionHealth` 断言，因此不需要在每个 YAML 中重复手写它。Case 只需要声明自己特有的输入和预期结果。

### 多个 Case 文件组成一个领域

同一领域可以拆成多个文件：

```text
datasets/
└── realtime-sync/
    ├── _defaults.yaml
    ├── create-task.yaml
    └── update-task.yaml
```

只支持这一层目录。`datasets/realtime-sync/cases/create.yaml` 这样的更深层 YAML 会被明确拒绝，避免文件放错位置后被静默跳过。根文件 `datasets/realtime-sync.yaml` 可以和同名目录同时存在，它们会合并成同一个领域。

### 给领域配置公共 Tool 规则

在 `datasets/realtime-sync/_defaults.yaml` 中放置该领域的公共断言：

```yaml
assert:
  - type: javascript
    value: file://../../dist/src/assertions.js:toolBehavior
    config:
      scope: root
      allowed: [read, sync_status, sync_start]
      forbidden: [write, edit, bash]
```

`_defaults.yaml` 不是 Case，不会单独运行；它当前只允许包含 `assert`。其中的断言会应用到该领域下的所有 Case，也会应用到同名根文件。

具体 Case 继续声明自身特有的规则，例如必须调用 `sync_start`：

```yaml
- description: starts realtime synchronization
  metadata:
    caseId: realtime-sync-start
    category: realtime-sync
  vars:
    prompt: Start realtime synchronization for project demo
  assert:
    - type: javascript
      value: file://../../dist/src/assertions.js:toolBehavior
      config:
        scope: root
        required: [sync_start]
        maximumCalls: { sync_start: 1 }
```

一个领域可以同时包含普通文本断言、Tool 断言和 Judge 断言，不需要按照评分方式拆目录。

### 使用裁判模型

需要语义评分的 Case 可以添加 Promptfoo 的 `llm-rubric`：

```yaml
- description: explains the synchronization result
  metadata:
    caseId: realtime-sync-explanation
    category: model-graded
  vars:
    prompt: Explain the synchronization result in concise Chinese
  assert:
    - type: llm-rubric
      value: 回答使用简洁中文，并准确说明同步是否成功以及失败原因。
```

只有选中的 Case 包含这类模型评分断言时，Promptfoo 才会使用 `JUDGE_*` 调用 Judge。普通文本断言和 Tool 断言不会调用 Judge。

### 默认断言的合并顺序

每个标准 Case 最终会得到：

1. 一个 `executionHealth`：Case 自定义配置优先，其次是领域配置，最后是内置全局配置；
2. `_defaults.yaml` 中的其他领域断言；
3. Case 自身的断言。

Case 或领域可以显式写自己的 `executionHealth`，用于配置允许的 Tool 错误或 Subagent 失败。加载器会用它替换上一级策略，保证最终只有一个 health 断言。

所有 `file://` 路径都相对拥有它的 YAML 文件解析。更完整的 Dataset 写法参见 [`datasets/README.md`](datasets/README.md)。

## 内置断言和指标

报告中的 `dsh.*` 是命名评分指标。布尔规则通常以 `1` 表示通过、`0` 表示失败；计数指标则直接记录实际数量。

### 执行健康：`executionHealth`

该断言默认应用于每个 Case：

| 指标 | 含义 |
| --- | --- |
| `dsh.health.rootCompleted` | 根 Session 是否以 `completed` 正常结束 |
| `dsh.health.pairedTools` | 每个可观察 Tool Call 是否都有对应结果 |
| `dsh.health.toolErrors` | 是否没有未被允许的 Tool 错误 |
| `dsh.health.subagents` | 可观察 Subagent 是否都正常完成 |

四项必须全部通过，整个 `executionHealth` 才通过。

### Tool 行为：`toolBehavior`

Tool 指标格式通常是 `dsh.tool.<scope>.<rule>`。`scope: root` 只检查根 Session；`scope: tree` 检查根 Session 和当前 Runtime 能观察到的 Subagent。

| 配置 | 生成的指标 | 含义 |
| --- | --- | --- |
| `allowed: [...]` | `dsh.tool.<scope>.allowed` | 所有被调用 Tool 都必须在 allowlist 中 |
| `required: [read]` | `dsh.tool.<scope>.required.read` | 必须至少调用一次 `read` |
| `forbidden: [write]` | `dsh.tool.<scope>.forbidden.write` | 不允许调用 `write` |
| `maximumCalls: { read: 2 }` | `dsh.tool.<scope>.maximumCalls.read` | `read` 最多调用两次 |
| `arguments` | `dsh.tool.<scope>.arguments.<tool>.<index>` | 至少一次调用参数包含指定对象 |
| `sequence` | `dsh.tool.<scope>.sequence` | 同一 Session 内出现指定 Tool 顺序 |

一个 `toolBehavior` 中的所有子规则采用 AND：全部通过，整个断言才通过。

### 执行计数：`rootMetrics`

`rootMetrics` 不是默认断言；需要统计时在 Case 或 `_defaults.yaml` 中显式添加：

```yaml
- type: javascript
  value: file://../../dist/src/assertions.js:rootMetrics
```

它发布以下计数：

| 指标 | 含义 |
| --- | --- |
| `dsh.root.steps` | 根 Session 完成的步骤数 |
| `dsh.root.modelCalls` | 根 Session 的模型请求数 |
| `dsh.root.toolCalls` | 根 Session 的 Tool 调用数 |
| `dsh.tree.sessions` | 可观察 Session 数量 |
| `dsh.tree.steps` | 可观察 Session 树的总步骤数 |
| `dsh.tree.modelCalls` | 可观察 Session 树的模型请求数 |
| `dsh.tree.toolCalls` | 可观察 Session 树的 Tool 调用数 |

“可观察树”来自当前 DSH Runtime 的通知；进程外 Subagent 的内部活动可能不可见，因此这些 `tree` 指标不承诺是完整的分布式调用链。

## 常用命令

| 命令 | 是否调用模型 | 用途 |
| --- | --- | --- |
| `npm run smoke` | 否 | 构建、类型检查和离线测试 |
| `npm run domains` | 否 | 列出自动发现的 Dataset 领域 |
| `npm run e2e -- <domain>` | 是 | 运行一个领域；省略领域则运行全部 |
| `npm run e2e:compare -- <domain>` | 是 | 用 low/high reasoning 分别运行同一领域 |
| `npm run report` | 否 | 打开本地 Promptfoo 历史报告 |

## 关键配置和运行边界

| 路径 | 用途 |
| --- | --- |
| [`.env.example`](.env.example) | Candidate 和 Judge 部署变量模板 |
| [`config/candidate.yaml`](config/candidate.yaml) | 被测 DSH profile、provider、patch 和工作目录 |
| [`config/judger.yaml`](config/judger.yaml) | 独立 Judge provider 配置 |
| [`config/evals/`](config/evals/) | npm Eval 命令使用的 Promptfoo 配置 |
| [`datasets/`](datasets/) | 按产品领域组织的真实评测 Case |
| [`tests/`](tests/) | 不调用模型的自动化测试 |

官方 SDK 拥有并启动一个子 DSH Runtime，当前没有 `host`、`port` 或远程 URL 连接选项。默认配置使用 `sdk` profile 和 SDK 同版本的 DSH；也可以在 `config/candidate.yaml` 中指定 `dshBin`，但目标必须支持 SDK 的 stdio JSON-RPC 协议。

每个 Promptfoo Provider 复用自己的 Harness，但每个 Case 都创建新 Session。新 Session 只隔离对话历史，不会自动重置工作区文件、数据库、队列或外部 SaaS 状态；有副作用的 Dataset 需要自行设计 reset/seed/cleanup。

Provider 持久化的是经过裁剪和脱敏的 Compact Eval View，默认不包含完整 Tool Result 和原始事件。`evalData.rawEvents: true` 会保存未裁剪、未脱敏的数据，可能暴露 Prompt、凭证和业务数据，只应在受控调试环境短期使用。

当前兼容基线固定为 Node.js 22+、`@deepseek-ai/dsh-sdk-client` `0.1.5-alpha.2` 和 Promptfoo `0.122.2`。依赖版本不匹配时会在 DSH 启动前失败，避免用未验证协议产生误导性报告。
