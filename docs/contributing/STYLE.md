# Style

## Names

- **CanyonOS** in prose. `canyonos` only for the command, package, or image name, in code
  formatting: `canyonos deploy`, `canyonos-core`.
- **Canyon Code** for the company. Never "CanyonCode" or "Canyon OS".
- Components are capitalized: Global Controller, Local Controller, LLM Gateway, Reconciler.

## Files and folders

- Markdown files: `UPPER_SNAKE_CASE.md` (`LLM_GATEWAY.md`, `CONTRIBUTING.md`).
- Folders: lowercase (`docs/guides/`, not `docs/GUIDES/`).
- Architecture docs: `docs/architecture/<COMPONENT>.md`.
- Every folder a reader browses to has a `README.md`.

## Commands, paths, and values

- Commands, flags, file names, config keys, and ports go in code formatting: `canyonos test`,
  `--json`, `global_controller.yaml`, `replicas`, `8080`.
- Commands and requests a reader will run go in fenced blocks with a language tag
  (`bash`, `yaml`, `python`).
- Use the real default ports and paths, the same in every doc.

## Docstrings

Every module, class, and public function gets a docstring. Write it for someone who has never seen the code and has no patience for filler.

- **Add what the name can't say.** Say where it's used (the command or process it serves), what it returns, and what it changes. `"""Table of the configured agents."""` on `_agents_table` says nothing new.
- **Stay high level.** Describe the whole ("each agent's settings"), not its fields, columns, keys, or options. For a command dispatcher, say it runs the given command; don't list what each command does.
- **Say where output ends up.** "shows in the terminal", "writes a file under `~/.canyonos`", "logs". Not "prints". Spell out flows in words ("when you choose View in `canyonos config`"), not shorthand like "config → View".
- **Use the product's words, not the code's.** "one section of the config", not "a flat-ish dict". Don't use internal names like "sync manifest"; say what the thing is, and name files by their real names (`global_controller.yaml`).
- **Write a sentence with a verb.** "Find the config file…; if it doesn't exist, show an error in the terminal and return None." Not "Resolved config path, or None after reporting that it's missing."
- **Entry points say what they do,** not just who runs them. A process's `main` says what the process does while it runs.
- **When something is kept, left, or skipped, say what it is and why.** "leave CanyonOS's own container and files in place for the next deploy", not "keeping the Global Controller container".
- **Format:** one line when it fits, two when needed. Lines stay within 88 columns, and a wrapped docstring shouldn't leave one word or a lone `"""` on its last line.

Examples:

```python
def _require_config(config_path):
    """Find the config file `canyonos config` opens: the given path, or the project's
    default. If it doesn't exist, show an error in the terminal and return None."""

def run_stop():
    """Run `canyonos stop`: shut down the running agents and the dashboard, but leave
    CanyonOS's own container and files in place for the next deploy. `canyonos quit`
    removes those too."""
```
