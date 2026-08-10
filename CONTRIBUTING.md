# Contributing to `@supabase/middleware`

Thank you for your interest in contributing to `@supabase/middleware`! This document provides guidelines and instructions for contributing to the project.

## Table of Contents

- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Development Workflow](#development-workflow)
- [Testing](#testing)
- [Code Style](#code-style)
- [Writing a middleware](#writing-a-middleware)
- [Submitting Changes](#submitting-changes)
- [Questions?](#questions)
- [License](#license)

## Getting Started

Check the [open issues](https://github.com/supabase/middleware/issues) for something to work on, or open one to discuss a bug or feature before sending a PR.

## Development Setup

### Prerequisites

- **Node.js**: 22.x or higher
- **pnpm**

### Installation

1. Fork and clone the repository:

   ```bash
   git clone https://github.com/YOUR_USERNAME/middleware.git
   cd middleware
   ```

2. Install dependencies:

   ```bash
   pnpm install
   ```

3. Build the project to verify setup:

   ```bash
   pnpm build
   ```

## Development Workflow

### Building

Build the library for distribution:

```bash
pnpm build
```

Watch mode for development (rebuilds on file changes):

```bash
pnpm dev
```

### Formatting

Format all code using Prettier:

```bash
pnpm format        # write
pnpm format:check  # verify only — this is what CI runs
```

CI fails on unformatted files, so run `pnpm format` before pushing. Generated
files are excluded in [`.prettierignore`](./.prettierignore): the lockfiles and
`CHANGELOG.md`, which release-please owns. Build output (`dist`, `api-docs`) is
already covered because Prettier reads `.gitignore` as well.

## Testing

```bash
pnpm test
```

Watch mode:

```bash
pnpm test:watch
```

## Code Style

```bash
pnpm lint       # check
pnpm lint:fix   # fix
pnpm typecheck  # tsc --noEmit
```

### The TypeScript floor

`pnpm typecheck` runs the repo's own TypeScript. Consumers may be on an older
one, so CI also checks both published artifacts against the **minimum** version
the README claims — currently 5.4, because the types use `NoInfer`:

```bash
pnpm typecheck:min       # src/**/*.ts — what JSR ships
pnpm typecheck:consumer  # dist/*.d.ts — what npm ships (run pnpm build first)
```

Both use the `tsc` pinned in [`test/ts-floor`](./test/ts-floor), which is also
where the consumer fixture lives. Below the floor the interesting failure is not
a different error but a _missing_ one — collision detection goes quiet and a
duplicate key compiles — so the fixture pins its negative cases with
`@ts-expect-error` and fails on the unused directive.

If a change needs a newer TypeScript, raising the floor is deliberate: bump
`typescript` in `test/ts-floor/package.json` and the Requirements section of the
root README in the same commit.

## Writing a middleware

The full authoring guide — `defineMiddleware`, request-side and generator forms, tests, publishing, and composing alongside the built-in entries — is in [`docs/authoring-guide.md`](./docs/authoring-guide.md). The composition primitives (`ctx` shape, conflict & prerequisite enforcement, the response seam) are documented in [`src/core/README.md`](./src/core/README.md), with [`feature-flag`](./src/middleware/feature-flag/README.md) and [`cors`](./src/middleware/cors/README.md) as worked examples.

To add a middleware **to this repository** (rather than publish your own package), see [`src/middleware/README.md`](./src/middleware/README.md) for the directory layout and subpath wiring.

## Submitting Changes

### Commit Messages

This project follows [Conventional Commits](https://www.conventionalcommits.org/). Format:

```text
<type>(<scope>): <description>

[optional body]

[optional footer]
```

**Types:** `feat`, `fix`, `docs`, `test`, `chore`, `refactor`, `perf`, `ci`, `build`

**Breaking changes:** use `feat!:` / `fix!:`, or include `BREAKING CHANGE:` in the commit footer.

**Examples:**

```bash
feat(cors): support wildcard subdomain origins
fix(pipeline): preserve ctx ordering across generator seams
docs: clarify prerequisite enforcement
```

### Pull Request Process

1. **Create a branch** from `main`:

   ```bash
   git checkout -b feat/my-feature
   ```

2. **Make your changes**, following the guidelines above.

3. **Commit** using conventional commit format.

4. **Push** to your fork and **open a Pull Request** with:
   - A clear title following conventional commit format
   - A description of what changed and why
   - A reference to any related issue (e.g., "Fixes #123")

5. **Respond to feedback** — maintainers may request changes.

### PR Guidelines

- Keep PRs focused — one feature or fix per PR.
- Update documentation if you change public APIs.
- Add tests for new functionality.
- Ensure all CI checks pass.

## Questions?

- Open an [issue](https://github.com/supabase/middleware/issues) for bugs or feature requests.
- Check existing issues and PRs before creating new ones.

## License

By contributing to `@supabase/middleware`, you agree that your contributions will be licensed under the MIT License.
