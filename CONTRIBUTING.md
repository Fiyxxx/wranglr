# Contributing to Wranglr

## Setup

```
bun install
```

Requires [Bun](https://bun.sh) and [Herdr](https://github.com/) running locally for the daemon to control terminal panes.

## Running tests

```
bun run --filter '*' test
```

Each workspace (`daemon`, `packages/protocol`, `pwa`) also runs its own tests with `bun test` from that directory.

## Running the app

```
bun run start
```

## Before opening a PR

- `bun run --filter '*' test` passes.
- `bun run --cwd pwa build` passes (catches type errors and static-export issues).
- New behavior has a test. Bug fixes should add a regression test that fails without the fix.
- Keep changes scoped — small, focused PRs are easier to review.

## Reporting security issues

Please don't open a public issue for a security vulnerability. See [SECURITY.md](SECURITY.md).
