# `future:{future_id}` Redis hash schema

Both directions (origin -> executor request, executor -> origin completion
callback) send the future's full hash. Whichever machine last wrote a field
wins for most fields (e.g. `args` as re-serialized by the executor) -- the
one exception is `created_at`, which only the origin ever writes, so it
always reflects the future's true submission time.

Fields currently written into `future:{future_id}`, and where:

| Field                      | Written by |
|----------------------------|------------|
| `id`                       | `future.py` (`Future.__init__`), `local_controller.py` (`_execute_locally`) |
| `request_id`                | `future.py`, `local_controller.py` |
| `parent`                    | `future.py`, `local_controller.py` |
| `service`                   | `future.py`, `local_controller.py` |
| `method`                    | `future.py`, `local_controller.py` |
| `args`                      | `future.py`, `local_controller.py` (json-encoded) |
| `created_at`                | `future.py` only (origin submission time) |
| `result`                    | `local_controller.py` (`_execute_locally`), `local_controller_frontend.py` (`WriteResult`) -- absent until the call succeeds, so `""` is a real empty result |
| `failed`                    | `future.py`, `local_controller.py` |
| `error`                     | `future.py` (`_submit_request`), `local_controller.py` (`_mark_future_failed`) -- the sole failure-message field, one readable line such as `IntentAgent.parse failed: ValueError: no valid holdings`; a failure passed on from a called agent keeps that agent's line; the LLM gateway deliberately never writes it |
| `finished_at`               | `local_controller.py` (`_execute_locally` finally block) |
| `cpu_resource`              | `local_controller.py` |
| `gpu_resource`              | `local_controller.py` |
| `agent`                     | `local_controller.py` (ID of the replica that ran this step) |
| `queue_time`                | `local_controller.py` (only when `submitted_at` is known) |
| `model`                     | `llm_gateway/hooks.py` (on_response) |
| `prompt_name`               | `llm_gateway/hooks.py` (on_response) |
| `prompt_version`            | `llm_gateway/hooks.py` (on_response) |
| `input_token_count`         | `llm_gateway/hooks.py` |
| `output_token_count`        | `llm_gateway/hooks.py` |
| `token_count`               | `llm_gateway/hooks.py` |
| `errors`                    | `llm_gateway/hooks.py` (Bedrock call error flag) |
| `input_cache_tokens`        | `llm_gateway/hooks.py` |
| `input_cache_write_tokens`  | `llm_gateway/hooks.py` |
| `logs`                      | `future.py`, `local_controller.py` (`_mark_future_failed`), `log_handler.py` (`LogHandler`) -- JSON-encoded array of OTel Log Data Model entries; see below |

## The `logs` field

`logs` holds a JSON-encoded array of OTel Log Data Model dicts (`Timestamp`, `SeverityNumber`,
`SeverityText`, `Body`, `Attributes`, `Resource`), appended to (never overwritten) via
`append_log_entry` in `controller/utils/log_entry.py`. Two writers feed it, split strictly by
severity, and neither is optional for the range it covers:

- **WARNING and above** (failures): written by `_mark_future_failed` and
  `Future._submit_request`'s gRPC-failure handler, via `build_failure_entry`, at the same call
  site that sets the `error`/`failed` fields, wakes up any consumers waiting on the future, and
  relays the failure to `origin` across replicas. A call whose argument failed or timed out
  before its method started gets no entry, since the failure is not its agent's; its `error`
  still says why.
- **DEBUG/INFO only** (ambient context): captured by `LogHandler`, a `logging.Handler` attached
  to the root logger in `LocalController.__init__`, but only when `logs_enabled` is true (the
  `logs:` key in `global_controller.yaml`, on by default -- set `logs: false` to opt out).
  `LogHandler` explicitly refuses to handle WARNING and above so it can never duplicate what the
  failure path already wrote, and skips the Local Controller's own lines, which go only to the
  container's stdout.

When `logs_enabled` is false, only the WARNING-and-above writer ever runs, so a failed future
still gets `error`/`failed` set and consumers/origin still get notified -- it just has no `logs`
entry with the extra detail (traceback, agent identity).
