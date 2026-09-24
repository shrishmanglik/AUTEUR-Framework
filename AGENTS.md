# AUTEUR Frameworks — Agent Guide

Canonical guide for any coding agent (Codex, Claude Code, Cursor, opencode, Gemini,
Copilot) working **on the AUTEUR Frameworks codebase itself**.

`CLAUDE.md` points here. Update this file, not a per-tool copy.

For using the toolkit as a consumer rather than modifying it, read
[`llms.txt`](llms.txt) — it carries the agent-facing CLI flow and usage rules.

AUTEUR Frameworks is a provider-neutral TypeScript toolkit that turns production intent
into a validated **Universal Packet**, then deterministically projects it into a
production kit, storyboards, prompt packages, pre-flight reports, routing advice, and
constrained repairs.

## Before you change anything

```bash
npm ci
npm run check
```

`npm run check` is the full gate and is what CI runs:
`schema → typecheck → test → build → docs:check → audit:public → audit:package →
test:consumer → npm pack --dry-run`. It takes ~15 seconds. Do not commit without it.

Individual steps when iterating: `npm test` (vitest), `npm run typecheck`,
`npm run docs:check`.

## Architecture rule that governs everything

**Structured data is the source; prompts, storyboards, and kits are projections.**

The Universal Packet (`src/schemas.ts`, zod) is the single source of truth. Compilers,
storyboards, QC, routing, and repair are pure deterministic functions over that packet.
Do not introduce a path where a projection becomes an input, and do not let prompt text
carry state that the packet does not hold.

| Path | Contains |
|---|---|
| `src/schemas.ts` | Universal Packet schema — the contract |
| `src/frameworks.ts` | The framework registry |
| `src/compiler.ts`, `src/storyboard.ts`, `src/production-kit.ts` | Deterministic projections |
| `src/qc.ts`, `src/route-advisor.ts`, `src/repair.ts` | Pre-flight, routing, constrained repair |
| `src/cli.ts` | CLI surface |
| `schemas/`, `examples/`, `test/`, `docs/`, `skills/` | Generated schema, fixtures, tests, docs, skill packs |

## Hard rules

- **No LLM or provider calls in this toolkit.** It builds contracts and reads results.
  Credentials, spend, and provider routing stay in the host application. Do not add an
  SDK, an API key path, or a network call to the core.
- **Determinism.** The same packet must always project the same kit. No clocks, no
  randomness, no ambient environment reads in projection code.
- **No invented provider facts.** Never state provider limits, pricing, audio support,
  model behavior, or API capability that is not evidenced. Under-claim by default.
- **Publication boundary.** This is a public repository and the private research corpus
  is not published. Read [`docs/research-boundary.md`](docs/research-boundary.md) before
  adding fixtures, examples, or evidence. `npm run audit:public` enforces part of this —
  it is a backstop, not a substitute for judgment.
- **Adding or removing a framework** means updating `src/frameworks.ts`, the README
  framework table, and the README count badge together. `npm run docs:check` fails when
  those three disagree.

## Testing expectations

- Every behavior change ships with a vitest test in `test/`.
- Fixtures must be synthetic. Do not commit real client briefs, raw provider prompts,
  media, account identities, or provider asset IDs.
- When you add a guard, prove it **fails** on bad input, not only that it passes on good
  input.

## Conventions

- Conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).
- TypeScript, ES modules, Node >= 22.12. One runtime dependency (`zod`) — adding a second
  needs maintainer approval.
- Contribution process, framework-proposal requirements, and review expectations are in
  [`CONTRIBUTING.md`](CONTRIBUTING.md); project roles are in [`GOVERNANCE.md`](GOVERNANCE.md).
- Report security issues per [`SECURITY.md`](SECURITY.md). Do not open a public issue for
  a vulnerability.

## Release posture

npm-registry publication is intentionally deferred while the public API stabilizes.
Consumers install from a git tag or `main`. Do not publish, tag a release, or announce
without explicit maintainer approval.
