# Prompt Management

A prompt is the system prompt of one agent function. CanyonOS keeps every version of it and sends
the one marked **live** to the model on every call that function makes, so you can change what an
agent is told without touching its code or redeploying.

The loop is:

1. Write the first version of each prompt in `config/prompts.yaml` and take it out of the agent code.
2. On the dashboard's **Prompts** page, read what is live, edit it, and save the edit as a new version.
3. Make that version live. Running agents switch to it within about 10 seconds.
4. Check the request trace: every LLM call records the prompt version it used.
5. If the new version is worse, make the previous one live again.

## Defining prompts

Create a `prompts.yaml` file in the project's config folder. Each prompt has a name and a list of versions:

```yaml
prompts:
  IntentAgent.parse:
    - version: IntentAgent-parse-1a2b3c4d-v1
      updated_at: '2026-09-20T00:00:00Z'
      content: You extract the user's intent from their message.
```

- **Name**: `<Agent>.<function>`, the agent class and the function that calls the model. The
  gateway matches calls to prompts by this name, so it has to be the real function name.
- **version**: `<Agent>-<function>-<hash>-v<n>`
  - `hash` is a short hash of the prompt
  - `n` is the version number of the prompt.
- **content**: the prompt text. Required.
- **updated_at**: optional. It shows as the version's date on the dashboard.
- **live**: optional, `true` on the one version agents are sent.

The live version is the one marked `live: true`. If none is marked, it is the newest one
(the one with the highest `n`).

Take the instructions out of your agent code. Each time the agent's `<function>` calls the
model, CanyonOS sends the live version as the system prompt, replacing any the agent set,
and the agent only sends its own message.

## The Prompts page

Open the project's **Prompts** page. Each prompt is a card named after its function. The card
header shows which version is live and the first line of its text.

Open a card to read the live version, with the version history on the left. Pick any version to
read it. A version that is not live has a **Make live** button, which switches agents to it: that
is how you roll forward and how you roll back.

**Edit** opens the version you are reading in an editor. Saving adds it as the next version,
`v<n+1>`, and shows it. It is not live until you make it live, so agents keep what they have while
you review the text. Older versions are kept.

The page only works while the project is running; otherwise it says so.

## Saved prompts

Prompts are stored in the dashboard's Postgres, and agents are sent what is stored there.
`prompts.yaml` only supplies a prompt's first versions: a prompt in `prompts.yaml` that Postgres
does not have yet is stored when the dashboard API starts, and when the Prompts page is read.

Without the dashboard, agents are sent the live versions in `prompts.yaml`.

Prompts are stored per project id, so they carry over only when the project keeps its
`project_id`.

## Prompt versions in traces

Each agent call that used a prompt records which one on its span: `prompt_name`
(`<Agent>.<function>`) and `prompt_version` (for example `IntentAgent-parse-7f24ec2e-v1`).
The request view shows the version under each block. When one call makes several
LLM calls, the last one's version is kept.

## Limits

- Edits are not written back to `prompts.yaml`. Once a prompt is stored in Postgres,
  later changes to it in `prompts.yaml` are ignored.
- Prompts are sent on OpenAI, Anthropic and AWS Bedrock calls. A call with no place for a
  system prompt, such as an embeddings call, is sent unchanged.
- A model call made from a thread or event loop your agent starts itself gets no prompt.
- You can only edit prompts that are already in `prompts.yaml`. The dashboard cannot
  add or delete a prompt.
