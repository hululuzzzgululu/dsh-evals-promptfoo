# Evaluation datasets

Promptfoo evaluation cases live here, separate from the adapter's automated tests in `tests/`.
The runner discovers domains automatically from either supported shape:

```text
datasets/<domain>.yaml
datasets/<domain>/*.yaml
datasets/<domain>/_defaults.yaml
```

The root file and same-named directory may coexist; their Cases form one domain. Use a root file for
a small domain and the directory form when splitting it by scenario. YAML nested more deeply is an
error. Both `.yaml` and `.yml` are accepted. `npm run domains` prints the discovered catalog;
`npm run e2e -- <domain>` runs one domain, while omitting the name runs all of them. The resulting
evaluation receives a `domain=<name>` Promptfoo tag for report filtering.

Every Case automatically inherits the global `executionHealth` assertion. It verifies that the
root turn completed and rejects unpaired Tool calls, Tool errors, and failed visible Subagents. Do
not copy that assertion into every Case. If one Case needs health allowances, define its own
`executionHealth` assertion; it replaces the global policy for that Case.

A domain directory may define `_defaults.yaml` with an `assert` array. Those assertions apply to
all Cases in the directory and to a same-named root file, if one exists. The defaults file is not a
Case and currently accepts only `assert`:

```yaml
assert:
  - type: javascript
    value: file://../../dist/src/assertions.js:toolBehavior
    config:
      scope: root
      allowed: [read, write, edit, bash]
      forbidden: [write, edit, bash]
```

`allowed` is an allowlist: observing any Tool outside it fails the assertion. `forbidden` is an
explicit denylist. `required` remains Case-specific when only some workflows must call a Tool.
Assertions are evaluated in this order: one health policy (Case, then domain, then global), domain
assertions, and finally Case assertions.

A domain names product behavior such as `realtime-sync`, `offline-sync`, `offline-development`, or
`image-management`. It does not name an assertion mechanism. One domain may contain Cases that use
Tools, Cases graded by the Judge, and Cases that use both. Model-graded assertions such as
`llm-rubric` and `factuality` cause Judge calls; merely loading a domain does not.

Use one YAML list item per stable case. Each case should have:

- a unique `metadata.caseId` that remains stable when wording changes;
- a `metadata.category` suitable for filtering and reporting;
- `vars` containing only input data;
- only the stable native or DSH-specific assertions unique to that Case;
- a description of the expected behavior, not an implementation detail.

The checked-in Cases run against real DSH. `smoke.yaml` is the cheapest model/runtime check. The
`helloworld/` domain contains read-only Tool Cases plus `explanation.yaml`, which combines Tool
behavior checks with the Judge selected by `config/judger.yaml`.

All `file://` references resolve relative to the YAML file that owns them. A root Dataset reaches
assertions through `file://../dist/...`; a nested Case or `_defaults.yaml` uses
`file://../../dist/...`.
