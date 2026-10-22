# AUTEUR Frameworks: Agent Guide

**Read [`AGENTS.md`](AGENTS.md).** It is the canonical guide for agents working on this
codebase and is kept current; this file exists so Claude Code finds the guide by its own
convention. Do not duplicate guidance here: a second copy drifts.

If you are *using* the toolkit rather than modifying it, read [`llms.txt`](llms.txt), or
attach the MCP server (below) and call the tools directly.

The rules that must not be missed, repeated inline:

- **No LLM or provider calls belong in this toolkit.** It builds and validates contracts;
  credentials, spend, and provider routing stay in the host application.
- **Structured data is the source; prompts, storyboards, and kits are projections.** The
  Universal Packet is the single source of truth.
- **Determinism.** The same packet must always project the same kit: no clocks, no
  randomness, no ambient environment reads in projection code.
- **Never invent provider limits, pricing, audio support, or API behavior.**
- **`npm run check` must pass before any commit.**

## MCP server

```jsonc
// .mcp.json in the consuming project
{
  "mcpServers": {
    "auteur": {
      "command": "npx",
      "args": ["auteur-frameworks", "mcp"]
    }
  }
}
```

Speaks MCP protocol `2024-11-05` and exposes `auteur_frameworks`, `auteur_develop`,
`auteur_draft`, `auteur_validate`, `auteur_preflight`, `auteur_storyboard`,
`auteur_compile`, `auteur_kit`, `auteur_continue`, `auteur_score_render`, and
`auteur_compare_renders`.
Tool failures come back as `isError: true` results with readable validation messages.

Everything else is in [`AGENTS.md`](AGENTS.md).
