# Contributing to AUTEUR Frameworks

Contributions are welcome through issues and pull requests. The project accepts new production frameworks, schema improvements, compiler/QC fixes, synthetic fixtures, documentation, and integration examples.

## Before writing code

1. Search existing issues and pull requests.
2. Open a framework proposal or bug report.
3. State the production problem, affected creator workflow, evidence class, scope, and falsification condition.
4. Wait for maintainer direction before a large schema or public-API change.

## Local setup

```bash
git clone https://github.com/shrishmanglik/auteur-frameworks.git
cd auteur-frameworks
npm ci
npm run check
```

Node.js 22.12 or newer is required.

## Evidence classes

- `PROMPT_CORPUS`: repeatedly observed in prompt structures.
- `RENDER_VALIDATED`: supported by observed output behavior.
- `COMBINED`: supported by both.
- `PROPOSED`: a community hypothesis that still requires validation.

An evidence label communicates support type, not universal truth. Provider capabilities and limits require provider-specific evidence and do not belong in the neutral core by assumption.

## Framework proposal contract

A new framework must include:

- the repeatable production problem;
- intended formats and non-goals;
- required input and output blocks;
- evidence class and source ownership statement;
- at least one synthetic passing fixture;
- at least one falsifying or failure fixture;
- deterministic tests;
- one or more actionable QC rules;
- migration notes for schema or API changes.

## Publication boundary

Do not submit:

- private or customer prompts;
- generated image, video, or audio assets;
- per-output extraction records;
- internal record identifiers or prompt-to-output mappings;
- provider session data, credentials, cookies, or API keys;
- private file paths;
- material you do not have the right to license.

Use synthetic fixtures. Maintainers may close a technically correct contribution when evidence ownership or publication safety is unclear.

## Code standards

- TypeScript is strict.
- Structured data remains the source of truth.
- Public functions require deterministic behavior and tests.
- Errors name the problem and a corrective action.
- `UNKNOWN` remains `UNKNOWN`; do not invent provider numbers.
- Keep repairs constrained to one observed defect.
- Avoid adding dependencies unless they remove material complexity.

## Verification

Run:

```bash
npm run check
npm audit --omit=dev --audit-level=high
```

`npm run check` validates schema generation, types, tests, build, docs links, publication boundaries, exact tarball contents, an isolated consumer install, and package dry-run.

## Pull requests

Describe:

- the production problem;
- behavior or contract changed;
- evidence class and falsification condition;
- tests and fixtures added;
- API/schema compatibility;
- publication-boundary review;
- residual risks.

Small, focused pull requests are easier to verify and merge. Maintainers require passing CI and may request an independent review for changes to schemas, compilers, QC, security, or publication boundaries.

## Conduct and security

Follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Report security or private-data issues according to [SECURITY.md](SECURITY.md), not through public issues.
