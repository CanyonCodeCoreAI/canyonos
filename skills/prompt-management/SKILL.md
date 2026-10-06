---
name: prompt-management
description: Extract existing LLM prompts from an agent project's source into CanyonOS config/prompts.yaml. Use when setting up prompt management or refreshing its versioned prompts from code.
---

# Extract prompts for CanyonOS

Create or update `prompts.yaml` from the project's actual LLM call paths, following
[Prompt management](https://raw.githubusercontent.com/CanyonCodeCoreAI/canyonos/main/docs/guides/PROMPTS.md).
Preserve prompt content and application behavior; do not invent or improve prompts.

## 1. Locate the source and config

- Find the active `global_controller.yaml`. Write `prompts.yaml` beside it:
  `.car/config/prompts.yaml` for a ported project, or `config/prompts.yaml` for
  the source layout. Respect an explicitly chosen destination.
- Trace the manifest's agent entrypoints and workflow to their LLM calls. For a
  `.car` project, inspect `.car/app`, since that is the deployed source.
- Search for message roles, prompt constants, template constructors, formatting
  functions, and referenced prompt files. Follow imports and builders to the text
  actually sent to the model; a variable named `prompt` alone is not evidence.

## 2. Extract templates without changing meaning

- Name each prompt `<agent>.<function>` using the agent name and the function
  making the LLM call, rather than an internal string builder. Keep existing
  prompt names when refreshing a file.
- A prompt is the call's system prompt: the instructions, without the runtime
  input. The gateway sends the live version as the system prompt of every call
  the function makes, replacing any the code set, so the code keeps sending only
  its own message (the request, the figures, the conversation).
- Preserve wording, whitespace, punctuation, examples, and literal braces.
  Combine adjacent string literals as the source does. When the instructions
  live in the user message, split them out as the system prompt and leave the
  runtime input in the code; report the split.
- Never insert a real request, retrieved content, conversation, or secret into
  the YAML. Runtime values stay in the code's own message, not as placeholders
  in the prompt.
- Do not flatten multiple system messages, assistant/tool messages, multimodal
  content, or framework-specific templates into one string when that changes
  semantics. Report those call paths as unrepresented rather than claiming full
  coverage.

## 3. Write versioned YAML

The top-level `prompts` mapping contains a list of versions for each prompt name.
Every version has `version` and `content`; `updated_at` is an optional, quoted UTC
ISO 8601 timestamp, and `live: true` marks the version agents are sent.

- Compute the hash exactly as the dashboard does: the first eight lowercase hex
  characters of SHA-256 over the UTF-8 `content` text.
- Use `<agent>-<function>-<hash>-v<n>` for `version`, replacing every dot in the
  prompt name with a hyphen. Start `n` at 1; on a changed prompt, append a version
  with one more than the highest trailing `v<n>`. With no `live: true`, the
  highest `n` is live, regardless of list order or timestamps.
- Leave unchanged prompts unchanged. Preserve old versions, unrelated prompts,
  and other configuration fields; do not overwrite the file with a fresh list.
- Use YAML quoting or literal block scalars that preserve the extracted text.
  Check the parsed strings before hashing, including their trailing newlines.
  If no real LLM prompts are found, report that instead of fabricating entries.

## 4. Verify and report

- Parse the resulting YAML and verify version lists, required string fields,
  hashes, and revisions. Check that each new entry maps to an actual LLM call.
- Render representative inputs using the original builder and the extracted
  template, then compare the messages exactly. Cover conditional sections and
  formatting that affect the text. Use isolated string builders or mocks so this
  verification does not call model providers or start the application.
- Report the destination, extracted names, source locations, placeholder
  bindings, unrepresented call paths, and validation results.

Creating the file makes prompts available to the running project's dashboard
after controller startup. The gateway sends each function's live version as the
system prompt of its LLM calls, so the code must stop sending those instructions
itself; remove them from the code only when requested, and keep the runtime
message it sends. Once a prompt is stored by the dashboard, later changes to it
in `prompts.yaml` are ignored; a prompt new to the file is stored the next time
the dashboard reads prompts. Dashboard edits are not written back to the YAML.
