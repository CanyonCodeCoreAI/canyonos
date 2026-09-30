# Prompt Management

We allow basic prompt management. In our UI, you are able to view all prompts that you use with agents.

You are able to run your existing code without explicit prompt management, but to get support for prompts, follow the steps below to set up prompt management (You don't change anything, you merely move the prompts around)

## Defining prompts

Create a `prompts.yaml` file in the project's config folder. Each prompt has a name and a list of versions:

```yaml
prompts:
  intent.parse:
    - version: intent-parse-1a2b3c4d-1
      updated_at: "2026-09-20T00:00:00Z"
      system: You extract the user's intent from their message.
      user: "{query}"
```

- **Name**: `<agent>.<function>`, the agent and the function that uses the prompt.
- **version**: `<agent>-<function>-<hash>-<n>`
  -  `hash` is a short hash of the prompt
  -  `n` is the version number of the prompt.
- **system** and **user**: the prompt text. Both are required.
- **updated_at**: optional. It shows as the date on the dashboard.

The current version of a prompt is newest one (the one with the highest `n`).

You will also need to have our OTel Database configured for prompt storage. This is automatically done by us though.

## Viewing and editing

When you are on the dashboard, you have the ability to edit any of your current prompts, and have that change propagate out to all agents.

Open the project's **Prompts** page. It lists every prompt at its current version,
with its agent, function, date, version number, and hash. Expand a prompt to read or
edit its system and user text.

Saving an edit adds a new version with the next `n` and a new hash. Older versions are
kept. The page only works while the project is running; otherwise it shows an error.

## How edits reach the agents

1. When the Global Controller starts or reloads, it publishes every YAML file in the
   config folder to each machine's Redis. `prompts.yaml` becomes the `prompts:config`
   key.
2. A dashboard edit is saved to the `prompts:config` key in the Global Controller's
   Redis.
3. Every poll interval, the Global Controller copies that key to every machine's Redis.

CanyonOS does not put prompts into agents for you. An agent sees an edit only if its
code reads `prompts:config` from its own machine's Redis.

## Limits

- Edits are not written back to `prompts.yaml`. When the Global Controller reloads, it
  publishes the file again and dashboard edits are lost. Copy any edit you want to keep
  into `prompts.yaml`.
- You can only edit prompts that are already in `prompts.yaml`. The dashboard cannot
  add or delete a prompt.
