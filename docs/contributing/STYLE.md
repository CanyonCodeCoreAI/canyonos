# Style

Rules for code and docs that reviewers check. CI enforces the formatting and lint
rules; see [Testing](TESTING.md#checks).

## Names

- **CanyonOS** in prose. `canyonos` only for the command, package, or image name, in
  code formatting: `canyonos deploy`, `canyonos-core`.
- **Canyon Code** for the company. Never "CanyonCode" or "Canyon OS".
- Components are capitalized: Global Controller, Local Controller, LLM Gateway,
  Reconciler.
- One word per thing, in code, comments, logs and docs: _machine_ (never "instance" or
  "node"), _agent_ (never "service"), _replica_ (never "instance"), _container_ and
  _orchestrator_. What each one means, and the older names that stay, are in
  [AGENTS.md](https://github.com/CanyonCodeCoreAI/canyonos/blob/main/AGENTS.md#rules).

## Files and folders

- Markdown files: `UPPER_SNAKE_CASE.md` (`LLM_GATEWAY.md`, `CONTRIBUTING.md`), except
  where a tool fixes the name: `docs/index.md`, `.github/pull_request_template.md`.
- Folders: lowercase (`docs/guides/`, not `docs/GUIDES/`).
- Architecture docs: `docs/architecture/<COMPONENT>.md`.
- Every folder a reader browses to has a `README.md`.

## Docstrings

Every module, class, and public function gets a docstring. Write it for someone who has
never seen the code and has no patience for filler.

- **Add what the name can't say.** Say where it's used (the command or process it
  serves), what it returns, and what it changes. `"""Table of the configured agents."""`
  on `_agents_table` says nothing new.
- **Stay high level.** Describe the whole ("each agent's settings"), not its fields,
  columns, keys, or options. For a command dispatcher, say it runs the given command;
  don't list what each command does.
- **Say where output ends up.** "shows in the terminal", "writes a file under
  `~/.canyonos`", "logs". Not "prints". Spell out flows in words ("when you choose View
  in `canyonos config`"), not shorthand like "config → View".
- **Use the product's words, not the code's.** "one section of the config", not "a
  flat-ish dict". Don't use internal names like "sync manifest"; say what the thing is,
  and name files by their real names (`workflow_config.yaml`).
- **Write a sentence with a verb.** "Find the config file…; if it doesn't exist, show an
  error in the terminal and return None." Not "Resolved config path, or None after
  reporting that it's missing."
- **Entry points say what they do,** not just who runs them. A process's `main` says
  what the process does while it runs.
- **When something is kept, left, or skipped, say what it is and why.** "leave
  CanyonOS's own container and files in place for the next deploy", not "keeping the
  Global Controller container".
- **Format:** one line when it fits, two when needed. Lines stay within 88 columns, and
  a wrapped docstring shouldn't leave one word or a lone `"""` on its last line.

Examples from the CLI:

```python
def _agents_table(agent_specs):
    """Build a read-only table of agent settings, shown in the terminal when you choose
    View in `canyonos config`."""

def _redis_outlived_its_password():
    """True when this project's Redis container still runs on the active Docker engine
    but its password file under `~/.canyonos/projects/` is gone, so a new password
    would not open it."""
```

## License header

Every new source file starts with this two-line SPDX header, in the file's comment style
(shown with `#`; use `//` in TypeScript and Protobuf, `--` in SQL):

```text
# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only
```

Markdown, JSON and the other files listed in `REUSE.toml` get their license from there
instead.

## Docs

- Describe what the code does now. A feature that is not merged yet is documented in
  its own pull request.
- Say each fact once, on the page that owns it, and link to it from the others.
- Commands, flags, file names, config keys, and ports go in code formatting:
  `canyonos test`, `--json`, `workflow_config.yaml`, `replicas`, `8080`.
- Commands and requests a reader will run go in fenced blocks with a language tag
  (`bash`, `yaml`, `python`).
- Keep fenced blocks out of lists. The docs site renders a block inside a list item
  outside the list and breaks its numbering, so end the list, or write the steps as
  paragraphs with the blocks between them.
- Use the real default ports and paths, the same in every doc.
- Use a table for content with the same fields per row, and pad its columns.
- Wrap prose at 88 characters.
- Write the docs in `docs/` by hand; see the [AI policy](README.md#ai-policy).
- Build them with `mkdocs build --strict` before a pull request; see
  [Testing](TESTING.md#docs).
