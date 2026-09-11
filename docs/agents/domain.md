# Domain Docs

How engineering skills should consume this repository's domain documentation.

## Before exploring, read these

- `CONTEXT.md` at the repository root
- `CONTEXT-MAP.md`, if present, to locate context-specific glossaries
- Relevant ADRs under `docs/adr/`

If these files do not exist, proceed silently. Domain-modeling flows create them lazily when terminology or durable decisions are resolved.

## File structure

This repository uses a single-context layout:

```text
/
├── CONTEXT.md
├── docs/
│   └── adr/
└── src/
```

## Use the glossary's vocabulary

Use domain terms as defined in `CONTEXT.md`. Do not silently replace canonical terms with synonyms.

If a required concept is absent, reconsider whether new terminology is necessary or record the gap for domain modeling.

## Flag ADR conflicts

If proposed work contradicts an existing ADR, surface the conflict explicitly instead of silently overriding the decision.
