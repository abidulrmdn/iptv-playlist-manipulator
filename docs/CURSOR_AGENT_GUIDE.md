# Cursor agent & contributor guide

This repo is **iptv-list-manager**: a Firebase-based IPTV playlist middleware (encrypted sources, rules engine, Storage-backed M3U, optional TMDB, diff / NEW markers, web UI).

## Where persistent AI rules live

| Location | Purpose |
|----------|---------|
| [`.cursor/rules/iptv-core.mdc`](../.cursor/rules/iptv-core.mdc) | Always-on: product context, cost/security, phased milestones |
| [`.cursor/rules/firebase-functions.mdc`](../.cursor/rules/firebase-functions.mdc) | When editing `functions/**/*.ts` |
| [`.cursor/rules/web-spa.mdc`](../.cursor/rules/web-spa.mdc) | When editing `web/**/*.{ts,tsx}` |

Cursor loads **`.mdc`** rules from `.cursor/rules/` (YAML frontmatter + markdown). Edit those files to change agent defaults for this project.

## Project skill (optional invoke)

| Location | When to use |
|----------|-------------|
| [`.cursor/skills/iptv-middleware-mvp/SKILL.md`](../.cursor/skills/iptv-middleware-mvp/SKILL.md) | Refresh jobs, Storage layout, limits, TMDB enrichment, scheduler, or “where does X live?” |

In chat, mention the skill by name or ask the agent to follow **iptv-middleware-mvp** for deep cuts on the pipeline.

## Human docs (source of truth)

- [README.md](../README.md) — features, deploy summary, plan alignment table  
- [docs/LIMITS.md](./LIMITS.md) — hard caps and where they are enforced  
- [docs/PRODUCTION.md](./PRODUCTION.md) — Blaze, budgets, IAM, Cloud Run escape hatch  
- [firestore.rules](../firestore.rules) / [storage.rules](../storage.rules) — isolation and deny client Storage writes  

## Commands to verify changes

```bash
npm run build -w functions
npm run build -w web
npm run lint
npm run serve    # Firebase emulators only
npm run up       # emulators + Vite (needs wait-on)
```

## How we prefer to work

1. **Small, focused diffs** — one concern per PR when possible.  
2. **Limits + docs together** — changing `LIMITS` implies updating `docs/LIMITS.md`.  
3. **Evidence before “done”** — run the relevant build (and lint if touched).  
4. **No plan file edits** — product/requirements plans in `~/.cursor/plans/` or attachments are reference-only unless the user asks to change them.

## Root pointer for agents

See [AGENTS.md](../AGENTS.md) in the repo root for a one-line pointer back to this file.
