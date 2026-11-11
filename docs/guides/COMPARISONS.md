# What CanyonOS offers

Running a multi-agent workflow in production usually takes several tools. CanyonOS
covers them in one install.

| Job                    | What you'd usually add                            | What CanyonOS does                                                                                                                                                       |
| ---------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Run and scale agents   | Compose files or Kubernetes YAML                  | Builds an image per agent, runs its replicas on Docker, EC2 or Kubernetes, and [adds or removes replicas](SCALING.md) with load                                          |
| Run agents in parallel | A task queue or async code                        | A call to another agent returns a `Future` at once, so agents run in parallel without async code                                                                         |
| Serve the workflow     | A web server and a job queue                      | An HTTP endpoint that answers with a `request_id` at once, and the result on `GET /status/<request_id>`                                                                  |
| Human in the loop      | Code to pause a run, save its state and resume it | When an agent asks a question, such as with `input()` or LangGraph's `interrupt()`, the request pauses until the caller [answers](RUNTIME_CONTRACT.md#asking-the-person) |
| Control model calls    | An LLM proxy                                      | A [gateway](LLM_GATEWAY.md) in every replica: which agents may use a model, a cost cap per call, and spend rules that refuse or switch model                             |
| Manage prompts         | A prompt registry                                 | [Prompt versions](PROMPTS.md) on the dashboard; agents switch to the live version within seconds, without a redeploy                                                     |
| Observe                | A tracing tool                                    | A [dashboard](DASHBOARD.md) with each request's traces, model calls, tokens, cost, logs and errors, and OpenTelemetry export                                             |

## Works with

| What                    | With                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent code              | Plain Python, LangGraph and the OpenAI Agents SDK, including their [human-in-the-loop](RUNTIME_CONTRACT.md#asking-the-person) calls                 |
| Model providers         | Any OpenAI-format API, Anthropic and AWS Bedrock, through the [LLM Gateway](LLM_GATEWAY.md)                                                         |
| Where it runs           | Docker on your machine ([Local](LOCAL.md)), [EC2](EC2.md), or a [Kubernetes](KUBERNETES.md) cluster                                                 |
| Observability backends  | The built-in [dashboard](DASHBOARD.md), plus any [OpenTelemetry receiver](WORKFLOW_CONFIG.md#oteldestinations), such as Langfuse or Arize Phoenix |
| Coding agents (convert) | Claude Code, Codex, Gemini CLI, Cursor CLI and ten more, for [`canyonos convert`](CONVERT_WORKFLOW.md)                                              |

To try it, [start from scratch](FROM_SCRATCH.md), or check an existing app against
[What a workflow needs](WORKFLOW_REQUIREMENTS.md).
