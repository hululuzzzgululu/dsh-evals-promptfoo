[English](README.md) | [简体中文](README.zh-CN.md)

# DSH Evals with Promptfoo

In one sentence: this is an "AI Agent auto-grader" — it lets an AI actually complete a set of tasks, then automatically checks whether its answers are correct, whether it used the right tools, and whether the run stayed healthy, and generates a report you can browse and compare.

[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) is the program that runs AI Agents and lets models call tools to complete tasks; [Promptfoo](https://www.promptfoo.dev/docs/getting-started/) is the tool that organizes test cases, runs assertions, and renders evaluation reports. This project connects the two: it launches a real Agent through the official DSH TypeScript SDK, collects the final answers, tool calls, subagents, and execution state, and hands everything to Promptfoo for display and scoring.

> `npm run e2e` launches a real DSH and calls real models, which consumes model quota. There is no mock Runtime in this project, and no automatic fallback to mock.

## Quick Start

### 1. Prepare dependencies

You need:

- Node.js 22 or later;
- npm;
- a working DSH model configuration, or the URL, API key, and model name of an OpenAI-compatible model.

Install the project dependencies:

```bash
npm ci
```

You can run the offline checks first:

```bash
npm run smoke
```

That command only runs the build, type checking, and unit tests — it does not launch DSH and does not call the Candidate or Judge models.

### 2. Configure `.env`

Copy the template:

```bash
cp .env.example .env
```

Edit `.env`:

```dotenv
# Model used by the DSH Agent under test
CANDIDATE_BASE_URL=https://candidate.example.com/v1
CANDIDATE_API_KEY=your-candidate-api-key
CANDIDATE_MODEL_NAME=your-candidate-model

# Model used by model-graded assertions such as llm-rubric and factuality
JUDGE_BASE_URL=https://judge.example.com/v1
JUDGE_API_KEY=your-judge-api-key
JUDGE_MODEL_NAME=your-judge-model
```

What these values mean:

| Variable | Purpose |
| --- | --- |
| `CANDIDATE_*` | Endpoint, credentials, and model name for the DSH Agent under test |
| `JUDGE_*` | A separate judge model that Promptfoo calls directly |

If your local DSH profile already has the model and credentials configured, you can leave the three `CANDIDATE_*` values empty; the SDK will keep using the profile, the DSH credential store, and defaults from the environment. `JUDGE_*` never reads DSH's private credentials — as soon as any selected case contains a model-graded assertion such as `llm-rubric` or `factuality`, you must configure them separately. The base URL usually ends with `/v1`.

The default run structure lives in [`config/candidate.yaml`](config/candidate.yaml). Change the DSH under test there — its `profile`, `provider`, patches, working directory, or model environment variable mappings; credentials should still be kept in `.env`, which is ignored by Git.

### 3. List runnable domains

```bash
npm run domains
```

You will currently see:

```text
Dataset domains:
- helloworld (3 YAML files)
- smoke (1 YAML file)
```

### 4. Run your first real eval

Run the full Hello World domain:

```bash
npm run e2e -- helloworld
```

`helloworld` contains three real DSH cases: read `package.json`, read `tsconfig.json`, and read the README then get graded by the Judge. Running it in full therefore requires the Candidate configuration; the last case also requires the Judge configuration.

If you have only configured the Candidate so far, start with the minimal check that needs no Judge:

```bash
npm run e2e -- smoke
```

Passing no domain name runs every auto-discovered domain:

```bash
npm run e2e
```

### 5. View the report

```bash
npm run report
```

This starts the local Promptfoo report UI — the default address is usually `http://localhost:15500` — and reads previously persisted eval results. In the report you can inspect final answers, assertion results, and named metrics, and identify the domain of each run by labels such as `domain=helloworld`.

## Adding your own dataset

Datasets live under `datasets/` at the repository root. Domains come from file or first-level directory names — no changes to `config/evals/` are needed.

### Simplest: one domain, one YAML

Create `datasets/my-domain.yaml`:

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

Then run:

```bash
npm run domains
npm run e2e -- my-domain
```

Every case automatically gets the global `executionHealth` assertion, so you don't need to hand-write it in every YAML. A case only declares its own inputs and expected outcomes.

### Multiple case files forming one domain

A single domain can be split across files:

```text
datasets/
└── realtime-sync/
    ├── _defaults.yaml
    ├── create-task.yaml
    └── update-task.yaml
```

Only this one level of directories is supported. Deeper YAML files such as `datasets/realtime-sync/cases/create.yaml` are explicitly rejected, so misplaced files are never silently skipped. A root file `datasets/realtime-sync.yaml` can coexist with the same-named directory; they merge into one domain.

### Configure shared tool rules for a domain

Put the domain's shared assertions in `datasets/realtime-sync/_defaults.yaml`:

```yaml
assert:
  - type: javascript
    value: file://../../dist/src/assertions.js:toolBehavior
    config:
      scope: root
      allowed: [read, sync_status, sync_start]
      forbidden: [write, edit, bash]
```

`_defaults.yaml` is not a case and never runs on its own; currently it may only contain `assert`. Its assertions apply to every case in the domain, and to the same-named root file as well.

Individual cases keep declaring their own specific rules — for example, that `sync_start` must be called:

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

A domain can mix plain-text assertions, tool assertions, and judge assertions — there is no need to split directories by scoring method.

### Using a judge model

Cases that need semantic scoring can add Promptfoo's `llm-rubric`:

```yaml
- description: explains the synchronization result
  metadata:
    caseId: realtime-sync-explanation
    category: model-graded
  vars:
    prompt: Explain the synchronization result in concise Chinese
  assert:
    - type: llm-rubric
      value: The answer is in concise Chinese and accurately states whether synchronization succeeded, and why it failed if it did.
```

Promptfoo only calls the Judge via `JUDGE_*` when a selected case contains a model-graded assertion like this. Plain-text assertions and tool assertions never call the Judge.

### Merge order of default assertions

Every standard case ends up with:

1. one `executionHealth`: the case's own configuration first, then the domain configuration, then the built-in global configuration;
2. the other domain assertions from `_defaults.yaml`;
3. the case's own assertions.

A case or a domain may write its own `executionHealth` explicitly, to configure allowed tool errors or subagent failures. The loader uses it to replace the policy from the level above, guaranteeing exactly one health assertion in the end.

All `file://` paths are resolved relative to the YAML file that owns them. See [`datasets/README.md`](datasets/README.md) for the full dataset authoring guide.

## Built-in assertions and metrics

The `dsh.*` values in the report are named scoring metrics. Boolean rules usually use `1` for pass and `0` for fail; counter metrics record the actual count.

### Execution health: `executionHealth`

This assertion is applied to every case by default:

| Metric | Meaning |
| --- | --- |
| `dsh.health.rootCompleted` | Whether the root session ended normally with `completed` |
| `dsh.health.pairedTools` | Whether every observable tool call has a matching result |
| `dsh.health.toolErrors` | Whether there are no tool errors outside the allowed set |
| `dsh.health.subagents` | Whether all observable subagents completed normally |

All four must pass for `executionHealth` to pass.

### Tool behavior: `toolBehavior`

Tool metrics generally take the form `dsh.tool.<scope>.<rule>`. `scope: root` inspects only the root session; `scope: tree` inspects the root session plus every subagent the current Runtime can observe.

| Config | Generated metric | Meaning |
| --- | --- | --- |
| `allowed: [...]` | `dsh.tool.<scope>.allowed` | Every tool called must be in the allowlist |
| `required: [read]` | `dsh.tool.<scope>.required.read` | `read` must be called at least once |
| `forbidden: [write]` | `dsh.tool.<scope>.forbidden.write` | `write` must not be called |
| `maximumCalls: { read: 2 }` | `dsh.tool.<scope>.maximumCalls.read` | `read` may be called at most twice |
| `arguments` | `dsh.tool.<scope>.arguments.<tool>.<index>` | At least one call's arguments contain the given object |
| `sequence` | `dsh.tool.<scope>.sequence` | The given tool order occurs within one session |

All sub-rules inside one `toolBehavior` are ANDed: every one of them must pass for the assertion to pass.

### Execution counts: `rootMetrics`

`rootMetrics` is not a default assertion; add it explicitly to a case or `_defaults.yaml` when you need the counts:

```yaml
- type: javascript
  value: file://../../dist/src/assertions.js:rootMetrics
```

It publishes the following counters:

| Metric | Meaning |
| --- | --- |
| `dsh.root.steps` | Steps completed by the root session |
| `dsh.root.modelCalls` | Model requests made by the root session |
| `dsh.root.toolCalls` | Tool calls made by the root session |
| `dsh.tree.sessions` | Number of observable sessions |
| `dsh.tree.steps` | Total steps across the observable session tree |
| `dsh.tree.modelCalls` | Model requests across the observable session tree |
| `dsh.tree.toolCalls` | Tool calls across the observable session tree |

The "observable tree" comes from notifications of the current DSH Runtime; the internal activity of out-of-process subagents may not be visible, so these `tree` metrics do not promise a complete distributed call graph.

## Common commands

| Command | Calls models? | Purpose |
| --- | --- | --- |
| `npm run smoke` | No | Build, type checking, and offline tests |
| `npm run domains` | No | List auto-discovered dataset domains |
| `npm run e2e -- <domain>` | Yes | Run one domain; omit the domain to run all |
| `npm run e2e:compare -- <domain>` | Yes | Run the same domain with low/high reasoning |
| `npm run report` | No | Open the local Promptfoo history report |

## Key configuration and runtime boundaries

| Path | Purpose |
| --- | --- |
| [`.env.example`](.env.example) | Template for Candidate and Judge deployment variables |
| [`config/candidate.yaml`](config/candidate.yaml) | DSH profile, provider, patches, and working directory under test |
| [`config/judger.yaml`](config/judger.yaml) | Configuration for the standalone Judge provider |
| [`config/evals/`](config/evals/) | Promptfoo configuration used by the npm eval commands |
| [`datasets/`](datasets/) | Real eval cases organized by product domain |
| [`tests/`](tests/) | Automated tests that do not call models |

The official SDK owns and starts a child DSH Runtime; there are currently no `host`, `port`, or remote URL connection options. The default configuration uses the `sdk` profile and the DSH version matching the SDK; you can point `dshBin` at a different binary in `config/candidate.yaml`, but the target must support the SDK's stdio JSON-RPC protocol.

Each Promptfoo provider reuses its harness, but every case creates a fresh session. A new session only isolates the conversation history — it does not automatically reset workspace files, databases, queues, or external SaaS state; datasets with side effects must design their own reset/seed/cleanup.

What the provider persists is a trimmed and redacted Compact Eval View that by default excludes full tool results and raw events. `evalData.rawEvents: true` persists untrimmed, unredacted data, which may expose prompts, credentials, and business data — use it only short-term in a controlled debugging environment.

The current compatibility baseline is pinned to Node.js 22+, `@deepseek-ai/dsh-sdk-client` `0.1.5-alpha.2`, and Promptfoo `0.122.2`. Mismatched dependency versions fail before DSH starts, rather than producing misleading reports over an unverified protocol.
