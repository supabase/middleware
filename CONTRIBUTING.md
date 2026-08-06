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

- **Node.js**: 20.x or higher
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
pnpm format
```

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

## Writing a middleware

The composition primitives (`ctx` shape, conflict & prerequisite enforcement, the response seam) are documented in [`src/core/README.md`](./src/core/README.md). The authoring guide for `defineMiddleware` — request-side and generator forms — is in [`src/middleware/README.md`](./src/middleware/README.md), with [`feature-flag`](./src/middleware/feature-flag/README.md) and [`cors`](./src/middleware/cors/README.md) as worked examples.

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
