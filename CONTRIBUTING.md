# Contributing to YouAgent

Thanks for your interest in contributing!

## Getting started

```bash
git clone https://github.com/brainsparker/youagent.git
cd youagent
npm install
npm test
```

## Before opening a PR

- `npm run typecheck` passes
- `npm test` passes (add tests for new behavior)
- `npm run build` succeeds

## Good first contributions

See the **Known gaps** section of the README — each item there is a scoped,
well-understood piece of work. Open an issue first for anything larger so we
can agree on the approach.

## Code style

TypeScript strict mode, ESM (`type: "module"`, `.js` import specifiers),
JSDoc on exported APIs. Match the style of the module you're editing.
