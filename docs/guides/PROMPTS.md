# Prompt management

CanyonOS can keep each agent function's system prompt outside your code, with every
version of it, and switch versions while the workflow runs, without a redeploy. The LLM
Gateway sends the live version with each model call the function makes.

## Define prompts in a file

Create `prompts.yaml` in the workflow's `config` folder. Each prompt is named after the
agent function it belongs to and holds a list of versions:

```yaml
prompts:
  IntentAgent.parse:
    - version: IntentAgent-parse-1a2b3c4d-v1
      updated_at: '2026-09-20T00:00:00Z'
      content: |
        You extract the user's intent from their message.
        Answer with one word.
```

| Setting      | Default         | What it does                                                                               |
| ------------ | --------------- | ------------------------------------------------------------------------------------------ |
| Prompt name  | required        | `<Agent>.<function>`: the agent's `name` in the workflow config and one of its `functions` |
| `version`    | required        | A name unique within the prompt, ending in `-v<n>`. A higher `n` is a newer version        |
| `content`    | required        | The prompt text                                                                            |
| `updated_at` | none            | The version's date on the dashboard                                                        |
| `live`       | the highest `n` | Set `true` on the one version agents are sent                                              |

Versions the dashboard saves are named `<Agent>-<function>-<hash>-v<n>`, where `<hash>`
is the first 8 hex digits of the text's SHA-256. You can follow the same pattern.

Then remove that system prompt from the agent's code. While `IntentAgent.parse` runs,
every model call it makes, including from helpers it calls, is sent the live version as
its system prompt. That replaces any system prompt the agent set, so the agent only
needs to send its own messages.

The prompts take effect on the next `canyonos deploy`. Later changes to the file are
covered in [Limits](#limits).

## Change a prompt while the workflow runs

Open the workflow on the [dashboard](DASHBOARD.md) and go to **Prompts**. Each prompt is
a card named `<Agent>.<function>`, showing the live version and the first line of its
text. The page works only while the workflow is running; otherwise it says so.

1. Open the card. The live version is at the top, and **Versions** below lists every
   version, newest first.
2. Select **Edit prompt**. The editor starts from the live text. **Save as**, or
   Ctrl+Enter (Cmd+Enter on a Mac), stores your text as the next version, such as
   `v2`. Agents keep the live version while you review it.
3. Open that version in **Versions** and select **Make live** (the button names the
   version, such as **Make v2 live**). Running agents switch to it within about 10
   seconds.
4. To roll back, make an earlier version live the same way.

## See which version a request used

Every model call that was sent a prompt records it on its agent call's span, as
`prompt_name` (`<Agent>.<function>`) and `prompt_version` (for example
`IntentAgent-parse-7f24ec2e-v1`). On **Traces**, open a request to see the version under
each agent call. When one agent call makes several model calls, the last one's version
is kept.

## Where prompts are kept

The dashboard keeps every version in its Postgres database, by `project_id`. When a
deploy registers the workflow with the dashboard, and each time you open the Prompts
page, the dashboard copies in every prompt from `prompts.yaml` it doesn't have yet, with
all its versions. From then on, the dashboard's copy is what agents are sent. Without
the dashboard, agents are sent the live versions in `prompts.yaml` as of the last
deploy.

Because prompts are kept by `project_id`, they carry over to the next deploy only when
the workflow keeps its `project_id`, and deleting the workflow on the dashboard deletes
its prompts. How the gateway gets the live versions is in
[LLM Gateway internals](../architecture/LLM_GATEWAY.md#prompts).

## Limits

- Dashboard edits are not written back to `prompts.yaml`. Copy a version you want to
  keep into the file.
- Once the dashboard has a prompt, later changes to it in `prompts.yaml`, including new
  versions, are ignored. Save a new version on the dashboard instead.
- The dashboard cannot add or delete a prompt. To add one, put it in `prompts.yaml` and
  run `canyonos sync` (Docker only) or `canyonos deploy`; it reaches agents once the dashboard has
  stored it, at the latest when you next open the Prompts page.
- Prompts are set on OpenAI chat completions and responses, Anthropic messages, and AWS
  Bedrock calls. A call with no place for a system prompt, such as an embeddings call,
  is sent unchanged.
- A call is matched to its function only when it is sent with httpx, which the OpenAI
  and Anthropic SDKs use, or with boto3's default session (`boto3.client(...)`). A call
  made with another HTTP client, or a client from your own `boto3.Session()`, gets no
  prompt. Calls from threads and executor tasks the function starts are matched.
