# Quickstart

## Requirements

- Node.js 20 or newer for the `v0.11.0` install below
- Node.js 22.12 or newer for the `main` branch and the next release
- npm 10 or newer

## Install from GitHub

```bash
mkdir auteur-quickstart
cd auteur-quickstart
npm init -y
npm install github:shrishmanglik/auteur-frameworks#v0.11.0
npx auteur-frameworks help
```

The Git dependency builds itself during installation. No global package install is required.

## Compile a known-good production

```bash
npx auteur-frameworks kit \
  node_modules/auteur-frameworks/examples/product-film.json \
  --out production-kit.json
```

Open `production-kit.json`. It contains the full story-to-repair handoff. Prompt surfaces live under `shotList[n].prompts`:

- `videoPrompt`
- `compactVideoPrompt`
- `compactPromptReport`
- `openingFramePrompt` (`framePrompt` is its backwards-compatible alias)
- `terminalFramePrompt`
- `audioPrompt`
- `negativePrompt`
- `qcIssues`

## Develop a new production

Copy one request from `node_modules/auteur-frameworks/examples/requests/` and edit the idea, format, duration, aspect ratio, audience, tone, constraints, creative mandate, must-include details, and clichés to avoid.

```bash
npx auteur-frameworks develop request.json --out development-contract.json
```

Send the contract's `systemInstruction`, `userBrief`, and `responseSchema` to a structured-output model. Save its JSON response as `production.json`.

```bash
npx auteur-frameworks validate production.json
npx auteur-frameworks kit production.json --out production-kit.json
```

Do not skip pre-flight. A successful schema parse proves shape; pre-flight checks relationships, timing, production duration, continuity, audio, and known generation risks.

## Use from TypeScript

```ts
import { buildProductionKit, parseUniversalPacket } from "auteur-frameworks";

const packet = parseUniversalPacket(input);
const kit = buildProductionKit(packet);
if (!kit.preflight.passed) throw new Error(JSON.stringify(kit.preflight.issues));
```

## Next

- [LLM integration](llm-integration.md)
- [Provider handoff](provider-handoff.md)
- [Evaluation methodology](evaluation.md)
