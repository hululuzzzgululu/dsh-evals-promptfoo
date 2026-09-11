> 历史设计草案：其中的目录、配置名和代码示例不代表当前实现。请以根目录 README、
> `config/` 和当前源码为准。

基于刚才重新核对 Promptfoo 和 DSH 当前代码后，我建议把方案正式收敛到下面这一版。最重要的变化是：**不再围绕 Session API 自己实现 Agent 生命周期，而是直接把 DSH 官方 SDK 的 `RunResult` 适配成 Promptfoo 的 `ProviderResponse`。**

# dsh-evals-promptfoo

## 1. 背景

DeepSeek Harness（DSH）提供了完整的 Agent Runtime，包括：

- Agent Loop
- Session
- Plugin
- Skill
- MCP
- Tool
- Model
- Context
- Subagent

当基于 DSH 构建实际 Agent 产品后，需要能够系统性评测：

- 用户任务是否完成
- Agent 是否选择了正确的 Tool
- Tool 参数是否合理
- Tool 调用路径是否合理
- 是否出现无效或重复 Tool 调用
- Subagent 是否正确完成工作
- 最终回答是否正确
- Agent 执行过程中是否发生异常
- Token、Step、Tool Call 等执行成本是否合理

传统 LLM Eval 更接近：

```text
Prompt
  ↓
Model
  ↓
Answer
```

而 DSH Agent 实际执行更接近：

```text
User Request
      │
      ▼
DSH Agent
      │
      ├── Profile / Persona
      ├── Plugin
      ├── Skill
      ├── MCP
      ├── Tool
      ├── Subagent
      └── Model
      │
      ▼
Agent Loop
      │
      ├── Model
      ├── Tool Call
      ├── Tool Result
      ├── Subagent
      ├── Continue
      └── Final Response
      │
      ▼
Result
```

因此需要评测的是：

> **完整 DSH Agent，而不是单独的 LLM。**

本项目使用 Promptfoo 作为 Eval Framework，并通过 DSH 官方 SDK 完成两者之间的适配。

项目名称：

```text
dsh-evals-promptfoo
```

---

# 2. 项目定位

`dsh-evals-promptfoo` 的定位是：

> **将 DeepSeek Harness 的一次完整 Agent Run 适配成 Promptfoo 可以直接评测的 Provider。**

整体关系：

```text
Promptfoo
    │
    ▼
dsh-evals-promptfoo
    │
    ▼
@deepseek-ai/dsh-sdk-client
    │
    ▼
DeepSeek Harness Runtime
```

本项目不建设新的：

```text
Eval Runner
Eval UI
Trace Platform
LLM Judge Framework
Session Framework
Agent Runtime
```

这些分别由：

```text
Promptfoo
+
DeepSeek Harness
```

负责。

`dsh-evals-promptfoo` 只负责两者之间缺失的一层：

```text
DSH RunResult
       ↕
Promptfoo ProviderResponse
```

---

# 3. 核心设计原则

## 3.1 使用 DSH 官方 SDK，而不是重新实现 Session 控制

DSH 当前提供官方 TypeScript SDK：

```text
@deepseek-ai/dsh-sdk-client
```

其中高层：

```text
DeepSeekHarness.run()
```

已经完成完整 Agent Run 生命周期。

其语义是：

```text
发送 Prompt
    ↓
等待 Prompt 进入 durable inbox
    ↓
Agent 执行
    ↓
Tool / Subagent / Model
    ↓
等待整个 Agent 再次进入 idle
    ↓
返回 RunResult
```

返回：

```text
RunResult
├── sessionId
├── finalResponse
├── events
└── notifications
```

其中 `events` 为 root session 的事件；`notifications` 还可以包含通过 `subagent.started` 发现的后代 Session 通知。

因此不需要自己实现：

```text
createSession()

prompt()

waitUntilCompleted()

history()

follow()

history pagination
```

这些都不应该成为第一版 Adapter 的职责。

---

## 3.2 Adapter 应该非常薄

核心关系应该是：

```text
Promptfoo Test Case
        │
        ▼
provider.callApi()
        │
        ▼
DeepSeekHarness.run(prompt)
        │
        ▼
RunResult
        │
        ▼
ProviderResponse
        │
        ▼
Promptfoo Assertions
```

而不是：

```text
DSH
 ↓
Session API
 ↓
Client
 ↓
Event Normalizer
 ↓
DshEvalResult
 ↓
Promptfoo
```

中间不再创建第二套 DSH Runtime Model。

---

## 3.3 DSH Event 是 Agent 行为的事实来源

对于 Agent 行为评测，应直接利用：

```text
RunResult.events
RunResult.notifications
```

不直接读取：

```text
session JSONL
```

也不重新复制成另一套复杂 DTO。

只提供少量查询函数：

```text
getToolCalls()

getTreeToolCalls()

getStepCount()

getTokenUsage()

getFinishReason()
```

这些是：

> **Projection / Query Helper**

而不是新的 Domain Model。

---

## 3.4 Provider 负责执行，Assertion 负责判断

Provider 回答：

> Agent 实际发生了什么？

Assertion 回答：

> 这些行为是不是正确？

例如：

```text
DSH Event
   ↓
tool/call:
  name = table_search
```

Provider 只负责把这个事实暴露出来。

至于：

```text
是否必须调用 table_search
是否应该禁止 web_search
参数是否符合预期
顺序是否合理
```

由 Promptfoo Assertion 判断。

---

## 3.5 Promptfoo 已经具备的能力不重复建设

Promptfoo 本身已经提供：

- Dataset Runner
- deterministic assertions
- JavaScript assertions
- JSON Schema
- Regex
- contains
- latency
- LLM rubric
- metrics
- result viewer
- repeat
- cache
- concurrency
- extensions

Custom JavaScript / TypeScript Provider 只需要实现 `id()` 和 `callApi()`，返回标准 `ProviderResponse`。

所以本项目重点只放在：

```text
DSH execution
+
DSH-specific assertions
```

---

# 4. 总体架构

最终第一版架构：

```text
                    Dataset
                       │
                       ▼
                ┌────────────┐
                │ Promptfoo  │
                │            │
                │ Runner     │
                │ Assertions │
                │ LLM Judge  │
                │ Result UI  │
                └─────┬──────┘
                      │
                      ▼
                dsh-provider.ts
                      │
                      ▼
          @deepseek-ai/dsh-sdk-client
                      │
                      ▼
             DeepSeekHarness.run()
                      │
                      ▼
          ┌──────────────────────┐
          │   DSH Eval Runtime   │
          │                      │
          │ Agent                │
          │ Plugins              │
          │ Skills               │
          │ MCP                  │
          │ Tools                │
          │ Subagents            │
          │ Model                │
          └──────────┬───────────┘
                     │
                     ▼
                  RunResult
             ┌───────┼─────────┐
             ▼       ▼         ▼
        finalResponse events notifications
             │       │         │
             │       └────┬────┘
             │            ▼
             │      DSH Event Helpers
             │            │
             └──────┬─────┘
                    ▼
           ProviderResponse
                    │
                    ▼
               Assertions
                    │
                    ▼
             Promptfoo Result
```

---

# 5. DSH Eval Runtime

这里是整个方案中非常重要的一点。

DSH SDK 驱动的是一套：

```text
SDK-serving DSH Runtime
```

DSH SDK 使用 stdio JSON-RPC 驱动 Runtime，服务端由：

```text
@deepseek-ai/dsh-sdk-jsonrpc-server
```

提供。DSH 官方 SDK 设计明确要求调用方提供 Runtime 和相应的 `cordis.yml`；SDK Server 只是其中一个插件，其他 Agent 能力由外围 Cordis composition 决定。

因此评测不能直接使用一个完全不同的默认 SDK Agent。

必须满足：

```text
Product Agent Composition
           ≈
Evaluation Agent Composition
```

即实际产品里的：

```text
Agent Persona

System Prompt

Plugins

Skills

MCP

Tools

Model Configuration
```

在 Evaluation Runtime 中也应该保持一致。

区别主要只是增加：

```text
@deepseek-ai/dsh-sdk-jsonrpc-server
```

作为评测进程驱动 Agent 的入口。

可以理解为：

```text
Product Composition
        +
SDK JSON-RPC Server
        ↓
Evaluation Composition
```

DSH 自带 `sdk` profile，也提供了独立 `jsonrpc-agent` Cordis 示例；自定义产品 composition 可以保留自己的插件配置，同时加入 SDK server。

---

# 6. Provider

核心文件：

```text
src/provider.ts
```

Provider 直接使用：

```text
DeepSeekHarness
```

概念代码：

```typescript
class DshProvider {

  id() {
    return 'deepseek-harness';
  }

  async callApi(prompt: string) {

    const harness = getHarness();

    const result =
      await harness.run(prompt);

    const view =
      buildEvalView(result);

    return {
      output:
        result.finalResponse,

      sessionId:
        result.sessionId,

      tokenUsage:
        view.tokenUsage,

      finishReason:
        view.finishReason,

      metadata: {
        dsh: view,
      },
    };
  }
}
```

Promptfoo Provider 原生支持：

```text
output

error

tokenUsage

metadata
```

等 ProviderResponse 字段，因此没有必要再包装一个额外的 Eval Result。

---

# 7. RunResult → ProviderResponse

核心映射：

| DSH | Promptfoo |
|---|---|
| `finalResponse` | `output` |
| `sessionId` | `sessionId` / metadata |
| Session usage | `tokenUsage` |
| `turn/end.reason.kind` | `finishReason` |
| `events` | compact DSH metadata |
| `notifications` | subagent/tree metadata |

基本关系：

```text
RunResult
   │
   ├── finalResponse
   │        ↓
   │      output
   │
   ├── sessionId
   │        ↓
   │     sessionId
   │
   ├── events
   │        ↓
   │    root agent view
   │
   └── notifications
            ↓
       agent tree view
```

---

# 8. 不默认保存完整 Event Log

DSH 的 Event Log 很完整，可能包含：

```text
assistant/chunk

assistant/message

tool/call

tool/result

agent events

plugin events
...
```

如果每个 Test Case 都把完整：

```text
events
+
notifications
```

存入 Promptfoo metadata，Dataset 较大后结果体积会迅速增加。

因此 Provider 默认只生成：

```text
Compact Eval View
```

例如：

```typescript
{
  sessionId,

  finishReason,

  steps,

  modelCalls,

  tools,

  subagents
}
```

并提供配置：

```yaml
includeRawEvents: false
```

调试时可以：

```yaml
includeRawEvents: true
```

再附带完整事件。

原则是：

> DSH Event 是 source of truth，但不意味着必须复制整个 Event Store 到 Promptfoo Result。

---

# 9. Event Helpers

所有 DSH Event 处理集中在一个文件：

```text
src/events.ts
```

不再拆：

```text
answer.ts

steps.ts

usage.ts

tools.ts

errors.ts
```

第一版只提供少量纯函数：

```typescript
getToolCalls(events)

getTreeToolCalls(events, notifications)

getStepCount(events)

getModelCallCount(events)

getTokenUsage(events)

getFinishReason(events)
```

目录和 API 都保持收敛。

---

# 10. Final Response

这里甚至不需要：

```text
getFinalAnswer()
```

因为：

```text
DeepSeekHarness.run()
```

已经直接返回：

```text
finalResponse
```

DSH SDK 自己负责从这次 owned activity interval 中获取 root session 最后一条 committed assistant response。

因此直接：

```typescript
output = result.finalResponse;
```

即可。

---

# 11. Finish Reason

TypeScript SDK 当前的 `RunResult` 主要暴露：

```text
sessionId

finalResponse

events

notifications
```

不像当前 Python SDK 那样直接包含 `finish_reason`；如果 Promptfoo Adapter 需要，可以从 root session 最后一个：

```text
turn/end
```

事件中的：

```text
data.reason.kind
```

派生。Python SDK 当前也是按这一语义暴露 finish reason。

因此：

```typescript
getFinishReason(events)
```

只需要做非常薄的一次 Projection。

---

# 12. Tool Calls

Tool Eval 是本项目最重要的 DSH-specific 能力。

需要从：

```text
tool/call
```

读取：

```text
callId

name

arguments
```

然后通过：

```text
callId
```

关联对应：

```text
tool/result
```

得到：

```typescript
interface ToolCallView {
  callId: string;
  name: string;

  argumentsRaw?: string;
  arguments?: unknown;

  result?: unknown;

  error?: unknown;
}
```

这里的 `ToolCallView` 只是：

```text
SessionEvent 查询结果
```

不是新的 Runtime Model。

---

# 13. Root 与 Agent Tree

这是第一版必须考虑的能力。

DSH SDK：

```text
RunResult.events
```

只包含 root session events。

但：

```text
RunResult.notifications
```

还可以包含通过：

```text
subagent.started
```

发现的 descendant session notifications。

例如：

```text
Lead Agent
    │
    ▼
Data Subagent
    │
    ├── table_search
    └── execute_sql
```

如果只看：

```text
result.events
```

会错误得到：

```text
Lead 没有调用 table_search
```

因此 Tool Assertions 应支持：

```text
scope = root
```

和：

```text
scope = tree
```

两种范围。

默认建议：

```text
tree
```

因为通常 Eval 要回答的是：

> **整个 Agent Task 有没有正确使用 Tool。**

只有需要评价主 Agent 自身行为时才指定：

```text
root
```

---

# 14. Promptfoo Dataset

尽量直接使用 Promptfoo 原生 Test Case，不重新发明 DSL。

例如：

```yaml
- description: 查询订单数据

  vars:
    prompt: |
      查询昨天的订单金额

  assert:

    - type: javascript
      metric: tools
      value: file://src/assertions/tools.ts

      config:
        scope: tree

        required:
          - table_search
          - execute_sql

        forbidden:
          - web_search
```

---

# 15. 输入与期望分离

Dataset 中：

```text
vars
```

只用于：

> Test 输入。

例如：

```yaml
vars:
  prompt: |
    查询订单数据
```

评测期望不要塞进 `vars`。

应该放：

```text
assert.config
```

例如：

```yaml
config:

  required:
    - table_search

  forbidden:
    - web_search
```

Promptfoo JavaScript Assertion 的 `config` 就是专门用来给自定义 Assertion 传递结构化配置的。

因此形成清晰边界：

```text
vars
=
输入

assert.config
=
期望
```

---

# 16. Tool Assertion

第一版不建议拆成：

```text
tool-used.ts

tool-not-used.ts

tool-count.ts

tool-args.ts

tool-sequence.ts
```

而提供一个统一：

```text
src/assertions/tools.ts
```

配置：

```yaml
- type: javascript
  metric: tools
  value: file://src/assertions/tools.ts

  config:

    scope: tree

    required:
      - table_search
      - execute_sql

    forbidden:
      - external_http

    sequence:
      - table_search
      - execute_sql

    maxCalls:
      execute_sql: 1

    args:
      - tool: table_search
        contains:
          keyword: order
```

一个 Assertion 完成：

```text
Tool Used

Tool Not Used

Tool Count

Tool Arguments

Tool Sequence
```

---

# 17. Assertion Result

Promptfoo JavaScript Assertion 可以返回：

```text
GradingResult
```

并支持：

```text
componentResults
```

Promptfoo UI 会展示每个 component 的评测结果。

因此统一 Tool Assertion 可以返回：

```text
Tools                             PASS

├─ required: table_search         PASS

├─ required: execute_sql          PASS

├─ forbidden: external_http       PASS

├─ sequence                       PASS

└─ execute_sql <= 1               PASS
```

这样比 Dataset 中放五个独立 Assertion 更清晰。

---

# 18. Answer Evaluation

最终回答不需要本项目实现专门 evaluator。

直接使用 Promptfoo 原生能力：

```text
equals

contains

regex

is-json

json-schema

javascript

llm-rubric
```

例如：

```yaml
- type: llm-rubric
  metric: answer_quality
  value: |
    回答应准确给出查询结果，
    不应只告诉用户如何查询。
```

---

# 19. Token / Step / Tool Count

这些指标第一版主要用于：

```text
observe
+
compare
```

而不是全部做成 Hard Gate。

Provider 从 DSH Events 计算：

```text
tokenUsage

stepCount

modelCalls

toolCalls
```

其中：

```text
tokenUsage
```

直接映射到 Promptfoo 原生：

```text
ProviderResponse.tokenUsage
```

Promptfoo 本身会汇总 Token 和 Latency 等指标。

---

# 20. Runtime 复用

DSH SDK 的 `DeepSeekHarness` 可以复用同一个 Runtime subprocess，而不是每个 Case 都重新启动。官方 SDK 就是按照可复用 Harness Runtime 设计的。

因此：

```text
Promptfoo Eval
     │
     ▼
Start DSH Runtime
     │
     ├── Case A → fresh session
     │
     ├── Case B → fresh session
     │
     ├── Case C → fresh session
     │
     └── Case D → fresh session
     │
     ▼
Close DSH Runtime
```

这样避免每个 Case 重复进行：

```text
Cordis startup

Plugin loading

Model provider loading

SDK server startup
```

---

# 21. Session 隔离

虽然共用 Runtime，但默认：

> **每一个 Test Case 使用一个新的 DSH Session。**

即：

```text
Runtime
   │
   ├── Case A → Session A
   ├── Case B → Session B
   └── Case C → Session C
```

这样既复用了昂贵的 Runtime 初始化，又避免 Conversation Context 相互污染。

---

# 22. Promptfoo 运行配置

Promptfoo 当前：

```text
cache 默认 true

maxConcurrency 默认 4
``` 


对于 DSH Agent Eval，第一版建议显式设置：

```yaml
evaluateOptions:

  cache: false

  maxConcurrency: 1
```

---

## 22.1 cache = false

Agent Eval 需要实际重新执行 Agent。

否则重复执行相同 Dataset 时，有可能直接复用之前 Provider Response。

因此默认：

```yaml
cache: false
```

正式执行需要 fresh run 时保持关闭缓存。

---

## 22.2 maxConcurrency = 1

第一版一个 Eval 复用一套 DSH Runtime。

同时 Agent 可能存在：

```text
Workspace

Filesystem

Plugin State

External System

Shared Resource
```

并发执行可能造成环境相互影响。

因此第一版默认：

```yaml
maxConcurrency: 1
```

后续有明确性能需求时，再考虑：

```text
Runtime Pool
+
Parallel Evaluation
```

而不是在 V1 提前增加复杂度。

---

# 23. Timeout

Promptfoo 原生支持：

```text
evaluateOptions.timeoutMs
``` 


因此不再实现自己的：

```text
max-latency assertion
```

Test Case 超时交给 Promptfoo 控制。

第一版需要注意：

> Provider 超时后不能只放弃 Promise，而让 DSH Agent 继续在后台运行。

因此 Timeout / Abort 发生时，应关闭当前 Harness Runtime；后续 Case 再重新创建 Runtime。

这样可以避免超时 Agent 继续修改：

```text
Workspace

Files

External Resources
```

---

# 24. Error 语义

必须区分两类错误。

## 24.1 Adapter / Infrastructure Error

例如：

```text
DSH Runtime 启动失败

SDK JSON-RPC 失败

Protocol Error

Runtime Crash
```

这类应返回：

```text
ProviderResponse.error
```

在 Promptfoo 中体现为：

```text
ERROR
```

---

## 24.2 Agent Execution Failure

例如：

```text
Tool Error

turn/end = error

max-tokens

Agent 最终没有完成任务
```

这类不应该转换成 Provider Infrastructure Error。

应该正常返回：

```text
output

finishReason

metadata.dsh
```

然后由 Assertion 判断：

```text
FAIL
```

因此：

```text
Infrastructure problem
        ↓
ERROR


Agent behavior problem
        ↓
FAIL
```

这是非常重要的语义区分。

---

# 25. Multi-turn

第一版暂不做 Multi-turn DSL。

V1 统一：

```text
一个 Test Case
=
一个 fresh session
+
一次 harness.run()
```

原因：

- 实现最简单
- Dataset 最清晰
- 已覆盖绝大多数 Agent Regression 场景
- 不需要发明 `turns:` 等新的 Dataset 语法

DSH SDK 本身支持复用指定 Session，因此未来增加 Multi-turn 并不存在架构障碍。

---

# 26. 第一版工程结构

目录尽量收敛：

```text
dsh-evals-promptfoo/
│
├── package.json
├── tsconfig.json
├── promptfooconfig.yaml
│
├── src/
│   ├── provider.ts
│   ├── runtime.ts
│   ├── events.ts
│   ├── extension.ts
│   │
│   └── assertions/
│       └── tools.ts
│
├── datasets/
│   └── examples.yaml
│
├── examples/
│   └── cordis.yml
│
└── README.md
```

不再建立：

```text
client/

session/

core/

models/

graders/

lifecycle/

verifiers/
```

这些第一版都没有必要。

---

# 27. 各文件职责

## provider.ts

唯一职责：

```text
Promptfoo Provider
        ↓
DeepSeekHarness.run()
        ↓
RunResult
        ↓
ProviderResponse
```

---

## runtime.ts

负责 Harness 生命周期：

```text
getHarness()

closeHarness()
```

以及读取 Provider 配置：

```text
cordis

cwd

sessionRoot

provider

model

maxTokens

env
```

---

## events.ts

集中实现 DSH Event Query：

```text
getToolCalls()

getTreeToolCalls()

getStepCount()

getModelCallCount()

getTokenUsage()

getFinishReason()

buildEvalView()
```

全部是纯函数。

---

## assertions/tools.ts

统一处理：

```text
required tools

forbidden tools

tool args

tool count

tool sequence

root / tree scope
```

---

## extension.ts

第一版主要：

```text
afterAll
   ↓
closeHarness()
```

Promptfoo 支持 `beforeAll` / `afterAll` / `beforeEach` / `afterEach` extensions。

---

## datasets/examples.yaml

提供最小可运行示例。

使用方真正需要持续维护的主要也是：

```text
Dataset
```

---

## examples/cordis.yml

只作为：

```text
SDK Evaluation Composition Example
```

说明：

> 自定义 DSH Agent 如何加入 `dsh-sdk-jsonrpc-server` 后被 Promptfoo 驱动。

不是要求使用方必须复制这份 Cordis。

---

# 28. Provider 配置

例如：

```yaml
providers:

  - id: file://src/provider.ts

    config:

      cordis: ./my-agent/cordis.yml

      cwd: ./workspace

      provider: deepseek-official

      model: deepseek-v4-flash

      includeRawEvents: false
```

实际 Secret 等仍通过：

```text
Environment Variables
```

注入。

不写进 Dataset。

---

# 29. Promptfoo 配置示例

```yaml
description: DeepSeek Harness Eval

prompts:

  - "{{prompt}}"

providers:

  - id: file://src/provider.ts

    config:

      cordis: ./examples/cordis.yml

      includeRawEvents: false

tests:

  - file://datasets/*.yaml

extensions:

  - file://src/extension.ts

evaluateOptions:

  cache: false

  maxConcurrency: 1
```

---

# 30. Dataset 示例

一个典型 Test Case：

```yaml
- description: 查询订单金额

  vars:

    prompt: |
      查询昨天的订单金额

  assert:

    - type: javascript

      metric: tools

      value: file://src/assertions/tools.ts

      config:

        scope: tree

        required:
          - table_search
          - execute_sql

        forbidden:
          - web_search

        sequence:
          - table_search
          - execute_sql

        maxCalls:
          execute_sql: 1


    - type: llm-rubric

      metric: answer_quality

      value: |
        回答应直接给出查询结果。
        不应只告诉用户应该如何查询。
```

可以看到使用方主要关心：

```text
输入什么

应该发生什么
```

而不用理解：

```text
DSH SDK

Session Events

Subagent Events

Promptfoo Provider Contract
```

---

# 31. 第一版支持的评测能力

V1 只支持真正通用、价值高的能力。

### Final Answer

```text
finalResponse
→
Promptfoo output
```

然后使用 Promptfoo 原生 Assertions。

---

### Tool Selection

```text
required
forbidden
```

---

### Tool Arguments

```text
contains
```

第一版不需要实现复杂 JSONPath / Schema matcher。

---

### Tool Count

```text
maxCalls
```

---

### Tool Sequence

```text
sequence
```

---

### Agent Tree

```text
scope: root

scope: tree
```

---

### Execution Metrics

```text
Token

Step Count

Model Calls

Tool Calls

Finish Reason
```

---

# 32. 第一版明确不做

V1 不做：

```text
Realtime Streaming

Session API Client

History Pagination

Custom Session Model

Custom EvalResult Model

OpenTelemetry

Artifact Framework

Filesystem Verifier

Database Verifier

SQL Eval Framework

Multi-turn DSL

Fixture Framework

Custom Eval UI

复杂 Metric Framework
```

不是这些能力没有价值，而是：

> 它们都不是完成第一版 DSH ↔ Promptfoo Adapter 所必需的。

---

# 33. 第一版最小实现链路

最终代码执行链可以缩减成：

```text
Dataset
   │
   ▼
Promptfoo
   │
   ▼
provider.callApi(prompt)
   │
   ▼
getHarness()
   │
   ▼
harness.run(prompt)
   │
   ▼
RunResult
   │
   ├── finalResponse
   │
   ├── events
   │
   └── notifications
   │
   ▼
buildEvalView()
   │
   ▼
ProviderResponse
   │
   ▼
Promptfoo Assertion
```

核心 Adapter 实际只需要解决：

```text
RunResult
    ↓
ProviderResponse
```

这一件事。

---

# 34. 第一版核心模块关系

```text
                         provider.ts
                             │
                  ┌──────────┴──────────┐
                  ▼                     ▼
              runtime.ts            events.ts
                  │                     │
                  ▼                     ▼
         DeepSeekHarness          RunResult Query
                  │                     │
                  └──────────┬──────────┘
                             ▼
                      ProviderResponse
                             │
                             ▼
                  assertions/tools.ts
```

结构足够简单，也没有明显重复抽象。

---

# 35. 核心结论

整个设计最终可以归纳成六点。

### 1. 使用官方 SDK

```text
@deepseek-ai/dsh-sdk-client
```

负责完整 DSH Agent Run。

不自行实现 Session 控制。

---

### 2. Adapter 保持极薄

```text
DeepSeekHarness.run()
        ↓
RunResult
        ↓
Promptfoo ProviderResponse
```

是整个项目最核心的数据流。

---

### 3. 不建立第二套 Runtime Model

直接使用：

```text
DSH Events
```

并只提供少量 Query / Projection。

---

### 4. 充分复用 Promptfoo

Promptfoo 已经负责：

```text
Dataset

Runner

Assertions

LLM Judge

Metrics

Result UI
```

本项目不重复实现。

---

### 5. Tool / Agent Tree 是主要增强点

真正需要 DSH-specific 代码的地方主要是：

```text
Tool Call

Tool Arguments

Tool Sequence

Subagent Tree
```

因此统一由：

```text
events.ts
+
assertions/tools.ts
```

解决。

---

### 6. Dataset 是主要使用界面

理想状态下，新的 DSH 使用方只需要：

```text
提供自己的 DSH evaluation composition
+
编写自己的 datasets
```

大部分 Eval Adapter 逻辑都可以直接复用。

---

# 36. 未来规划

后续根据实际需求逐步增加 **Multi-turn、实时事件、OpenTelemetry、Artifact/State Verification，并进一步接入自动化回归和安全评测能力**。

这版里我认为最值得定下来的三个决策是：**直接用 `DeepSeekHarness.run()`、默认支持 `root/tree` 两种 Tool Scope、以及把所有 Tool 判断收敛成一个 `tools.ts` Assertion。** 这三个决定会让仓库明显更小，同时没有牺牲后续扩展空间。
> **Historical research input:** this document contains earlier API sketches and is not the
> implementation contract. Use [the current specification](../.scratch/dsh-evals-promptfoo/spec.md)
> and the runnable examples instead; in particular, `cordis` and `sessionRoot` are not direct
> constructor options in the locked TypeScript SDK.
