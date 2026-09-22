import pytest

from canyonos import deploy as deploy_cmd
from canyonos.deploy import PhaseTracker


GC = "canyonos_core.controller.global_controller"
LC = "canyonos_core.controller.local_controller"

# What a container that could not import its adapter leaves in its own log, as
# the global controller quotes it back: the deploy's error markers all appear
# inside it, and none of them is this deploy speaking.
AGENT_IMPORT_FAILURE = [
    f"ERROR:{LC}:Failed to load agent B from /app/b.py: No module named 'llama_index'",
    "Traceback (most recent call last):",
    '  File "/app/local_controller.py", line 336, in _load_agent',
    "    loader.exec_module(module)",
    "ModuleNotFoundError: No module named 'llama_index'",
]

READINESS_FAILED = (
    f"CRITICAL:{GC}:Controller readiness failed: B (127.0.0.1:8001)=failed\n"
)


def container_log_dump(agent, endpoint, body):
    """The block the global controller logs for one container that never came up."""
    return [
        f"WARNING:{GC}:--- begin container log: {agent} ({endpoint}) status=failed ---\n",
        *(f"WARNING:{GC}:  {line}\n" for line in body),
        f"WARNING:{GC}:--- end container log: {agent} ---\n",
    ]


def drive(lines):
    """Feed lines to a tracker, returning (spinners, completions, errored)."""
    tracker = PhaseTracker()
    spinners, done = [], []
    errored = False
    for line in lines:
        message, completed, is_error = tracker.feed(line)
        if is_error:
            errored = True
        if message:
            spinners.append(message)
        if completed:
            done.append(completed)
    return tracker, spinners, done, errored


def first_error_line(lines):
    """The first line a fresh tracker calls fatal, or None."""
    tracker = PhaseTracker()
    for line in lines:
        if tracker.feed(line)[2]:
            return line
    return None


def tail_verbose(lines):
    """Run the `-v` tail over `lines` the way the deploy does, returning its summary."""
    return deploy_cmd._tail_verbose(
        deploy_cmd._queued_lines(iter(lines)),
        {"port": 1},
        None,
        "config.yaml",
        serve=False,
        on_ready=lambda _ready: None,
    )


def test_a_full_run_reports_each_phase_once():
    _, spinners, done, errored = drive(
        [
            "INFO:canyonos_core:Generating stub: a.yaml -> a_stub.py\n",
            "INFO:canyonos_core:Compiling gRPC proto: a.proto\n",
            "INFO:canyonos_core:Building 3 Docker image(s) via `docker buildx bake`.\n",
            "#5 [4/7] RUN pip install -r requirements.txt\n",
            "INFO:canyonos_core:Build complete.\n",
            "INFO:canyonos_core:Deploying from config: config.yaml\n",
            "INFO:canyonos_core.controller.global_controller:Redis launched on 1 node(s).\n",
            "INFO:canyonos_core.controller.global_controller:Waiting for 2 replica(s) to become healthy (timeout=300s)...\n",
            "INFO:canyonos_core.controller.global_controller:Controller Intent (127.0.0.1:50051) is ready.\n",
            "INFO:canyonos_core.controller.global_controller:Controller Metrics (127.0.0.1:50052) is ready.\n",
        ]
    )
    assert not errored
    assert done == ["Build complete", "Redis ready"]
    assert "Building 3 images..." in spinners
    assert spinners[-1] == "Starting agents (2/2 ready)..."


def test_phases_are_matched_in_the_order_the_container_emits_them():
    """Redis and stale-container cleanup are logged by GlobalController.__init__,
    which runs before `Deploying from config:` -- so the matcher must not assume
    the config line comes first.
    """
    _, spinners, done, _ = drive(
        [
            "INFO:canyonos_core.controller.global_controller:Checking for stale containers from previous runs...\n",
            "INFO:canyonos_core.controller.global_controller:Redis launched on 1 node(s).\n",
            "INFO:canyonos_core:Deploying from config: config.yaml\n",
        ]
    )
    assert done == ["Redis ready"]
    assert spinners == ["Cleaning up stale containers...", "Starting deploy..."]


def test_repeated_build_lines_collapse_to_one_spinner_update():
    _, spinners, _, _ = drive(
        [
            "INFO:canyonos_core:Generating stub: a.yaml -> a_stub.py\n",
            "INFO:canyonos_core:Generating stub: b.yaml -> b_stub.py\n",
            "INFO:canyonos_core:Generating Docker context for 'b'\n",
        ]
    )
    assert spinners == ["Generating stubs and Docker contexts..."]


def test_a_run_with_nothing_to_build_still_reports_the_phase():
    _, _, done, _ = drive(
        [
            "INFO:canyonos_core:No Docker images to build.\n",
            "INFO:canyonos_core:Build complete.\n",
        ]
    )
    assert done == ["No images to build", "Build complete"]


def test_agent_progress_counts_up_against_the_announced_total():
    tracker, spinners, _, _ = drive(
        [
            "INFO:canyonos_core.controller.global_controller:Waiting for 3 replica(s) to become healthy (timeout=300s)...\n",
            "INFO:canyonos_core.controller.global_controller:Controller A (127.0.0.1:1) is ready.\n",
            "INFO:canyonos_core.controller.global_controller:Controller B (127.0.0.1:2) is ready.\n",
        ]
    )
    assert spinners[-1] == "Starting agents (2/3 ready)..."
    assert tracker.replicas_total == 3


def test_replicas_of_one_agent_are_counted_separately():
    """`Controller %s is ready.` logs the agent name, which repeats across that
    agent's replicas -- the endpoint is what distinguishes them.
    """
    tracker, spinners, _, _ = drive(
        [
            "INFO:canyonos_core.controller.global_controller:Waiting for 2 replica(s) to become healthy (timeout=300s)...\n",
            "INFO:canyonos_core.controller.global_controller:Controller Echo (127.0.0.1:50051) is ready.\n",
            "INFO:canyonos_core.controller.global_controller:Controller Echo (127.0.0.1:50052) is ready.\n",
        ]
    )
    assert spinners[-1] == "Starting agents (2/2 ready)..."
    assert tracker.agents_ready_message() == ("2 agent(s) ready", True)


def test_a_re_read_ready_line_does_not_double_count():
    tracker, _, _, _ = drive(
        [
            "INFO:canyonos_core.controller.global_controller:Waiting for 2 replica(s) to become healthy (timeout=300s)...\n",
            "INFO:canyonos_core.controller.global_controller:Controller Echo (127.0.0.1:50051) is ready.\n",
            "INFO:canyonos_core.controller.global_controller:Controller Echo (127.0.0.1:50051) is ready.\n",
        ]
    )
    assert tracker.agents_ready_message() == (
        "Workflow up, but only 1/2 agents reported healthy",
        False,
    )


def test_coming_up_short_of_the_announced_replicas_fails_the_deploy(monkeypatch):
    """Runtimes that only warn when the readiness wait runs out can still log
    the up-marker with agents unhealthy; that is a failed deploy, not a short one.
    """
    monkeypatch.setattr(
        deploy_cmd, "_deploy_summary", lambda *a: pytest.fail("no summary")
    )
    lines = deploy_cmd._queued_lines(
        iter(
            [
                "INFO:canyonos_core.controller.global_controller:Waiting for 3 replica(s) to become healthy (timeout=300s)...\n",
                "INFO:canyonos_core.controller.global_controller:Controller A (127.0.0.1:1) is ready.\n",
                "Agent B never reached readiness.\n",
                "INFO:canyonos_core.controller.global_controller:Global controller started, polling every 5s...\n",
            ]
        )
    )

    with pytest.raises(RuntimeError, match="only 1/3 agents reported healthy"):
        deploy_cmd._tail_quiet(
            lines,
            {"port": 1},
            8080,
            "config/global_controller.yaml",
            serve=False,
            on_ready=lambda _ready: None,
        )


def test_incomplete_readiness_replays_the_buffered_diagnostics(monkeypatch, capsys):
    monkeypatch.setattr(
        deploy_cmd, "_deploy_summary", lambda *a: pytest.fail("no summary")
    )
    lines = deploy_cmd._queued_lines(
        iter(
            [
                "Waiting for 2 replica(s) to become healthy (timeout=300s)...\n",
                "Agent B import failed.\n",
                "Global controller started, polling every 5s...\n",
            ]
        )
    )

    with pytest.raises(RuntimeError, match="only 0/2 agents reported healthy"):
        deploy_cmd._tail_quiet(
            lines,
            {"port": 1},
            8080,
            "config/global_controller.yaml",
            serve=False,
            on_ready=lambda _ready: None,
        )

    assert "Agent B import failed." in capsys.readouterr().out


def test_a_quoted_container_log_does_not_end_the_transcript_before_the_summary():
    """A dumped log carries the agent's own ERROR lines and traceback. Reading
    those as this deploy's failure stops the transcript inside the block, so the
    rest of the evidence and the summary naming the dead replica never print.
    """
    transcript = [
        f"INFO:{GC}:Waiting for 2 replica(s) to become healthy (timeout=120s)...\n",
        f"INFO:{GC}:Controller A (127.0.0.1:8000) is ready.\n",
        *container_log_dump("B", "127.0.0.1:8001", AGENT_IMPORT_FAILURE),
        READINESS_FAILED,
    ]

    assert first_error_line(transcript) == READINESS_FAILED

    tracker, _, done, errored = drive(transcript)
    assert errored
    assert not done
    assert tracker.agents_ready_message() == (
        "Workflow up, but only 1/2 agents reported healthy",
        False,
    )


def test_an_up_marker_quoted_inside_a_container_log_does_not_declare_success(
    monkeypatch, capsys
):
    """A dumped log is whatever the agent printed, including this deploy's own
    phrases if the agent happened to log them. Only the real one counts.
    """
    monkeypatch.setattr(
        deploy_cmd, "_deploy_summary", lambda *_a: pytest.fail("no summary")
    )
    transcript = [
        f"INFO:{GC}:Waiting for 1 replica(s) to become healthy (timeout=120s)...\n",
        *container_log_dump(
            "B",
            "127.0.0.1:8001",
            [
                f"INFO:{GC}:Global controller started, polling every 5s...",
                *AGENT_IMPORT_FAILURE,
            ],
        ),
        READINESS_FAILED,
    ]

    with pytest.raises(RuntimeError, match="before the workflow became ready"):
        tail_verbose(transcript)

    assert "Controller readiness failed" in capsys.readouterr().out


def test_quoted_text_that_mentions_a_sentinel_does_not_end_the_block():
    """The payload is another process's output and can say anything, including
    the end sentinel. Only the controller's own line may close the block, or the
    rest of the quote is read as this deploy speaking.
    """
    transcript = [
        *container_log_dump(
            "B",
            "127.0.0.1:8001",
            ["--- end container log: B ---", *AGENT_IMPORT_FAILURE],
        ),
        READINESS_FAILED,
    ]

    assert first_error_line(transcript) == READINESS_FAILED


def test_error_detection_resumes_after_a_container_log_block():
    """The block is skipped, not the rest of the run: a genuine failure logged
    after the dump still has to end the deploy.
    """
    transcript = [
        *container_log_dump("B", "127.0.0.1:8001", ["all quiet in here"]),
        "ERROR:canyonos_core:Config file not found: missing.yaml\n",
    ]

    assert first_error_line(transcript) == transcript[-1]


def test_a_run_that_never_announced_replicas_still_reports_ready():
    tracker, _, _, _ = drive(["INFO:canyonos_core:Build complete.\n"])
    assert tracker.agents_ready_message() == ("Workflow ready", True)


def test_replicas_ready_without_an_announced_total_still_reports_progress():
    _, spinners, _, _ = drive(
        [
            "INFO:canyonos_core.controller.global_controller:Controller A (127.0.0.1:1) is ready.\n"
        ]
    )
    assert spinners == ["Starting agents..."]


@pytest.mark.parametrize(
    "line",
    [
        "ERROR:canyonos_core:Config file not found: missing.yaml\n",
        "Traceback (most recent call last):\n",
        'ERROR: failed to solve: process "/bin/sh -c pip install" did not complete successfully\n',
        "CRITICAL:canyonos_core.controller.global_controller:Failed to launch Redis on 127.0.0.1: docker: Error response from daemon: driver failed programming external connectivity on endpoint canyonos-redis: Bind for 0.0.0.0:6379 failed: port is already allocated.\n",
    ],
)
def test_fatal_lines_are_flagged(line):
    _, _, _, errored = drive([line])
    assert errored


@pytest.mark.parametrize(
    "line",
    [
        "WARNING:canyonos_core.controller.global_controller:otel.destinations not configured -- no OTel metrics collection will happen.\n",
        "  Warning: no entrypoint mapping for 'agent'\n",
    ],
)
def test_benign_warnings_do_not_trip_the_error_path(line):
    _, _, _, errored = drive([line])
    assert not errored


def test_the_deploy_is_only_declared_dead_after_two_consecutive_checks(monkeypatch):
    """One dropped request shouldn't end a deploy that is merely busy."""
    replies = iter([None, {"running": True}, None, None])
    monkeypatch.setattr(deploy_cmd, "deploy_status", lambda _port: next(replies))
    state = {"port": 1}

    misses = 0
    verdicts = []
    for _ in range(4):
        dead, misses = deploy_cmd._deploy_is_dead(state, misses)
        verdicts.append(dead)

    # a miss, then a recovery that resets the count, then two misses in a row
    assert verdicts == [False, False, False, True]


def test_a_running_deploy_is_never_declared_dead(monkeypatch):
    monkeypatch.setattr(deploy_cmd, "deploy_status", lambda _port: {"running": True})
    dead, misses = deploy_cmd._deploy_is_dead({"port": 1}, 1)
    assert not dead and misses == 0


def test_the_clis_own_status_requests_are_not_shown_or_buffered(monkeypatch):
    """The container logs every request the CLI makes to it, so its own polling
    lands in the stream it is reading.
    """
    shown = []
    monkeypatch.setattr(deploy_cmd.ui, "ok", lambda m: shown.append(m))
    monkeypatch.setattr(deploy_cmd.ui, "warn", lambda m: shown.append(m))
    monkeypatch.setattr(deploy_cmd, "_deploy_summary", lambda *a: ("url", []))

    lines = deploy_cmd._queued_lines(
        iter(
            [
                '172.17.0.1 - - [04/Sep/2026 21:00:00] "GET /status HTTP/1.1" 200 -\n',
                "INFO:canyonos_core:Build complete.\n",
                "INFO:canyonos_core.controller.global_controller:Global controller started, polling every 5s...\n",
            ]
        )
    )
    summary = deploy_cmd._tail_quiet(
        lines,
        {"port": 1},
        8080,
        "config/global_controller.yaml",
        serve=False,
        on_ready=lambda _ready: None,
    )

    assert summary == ("url", [])
    assert shown == ["Build complete", "Workflow ready"]


def test_a_build_that_dies_silently_does_not_hang(monkeypatch, capsys):
    """A failed build leaves `docker logs -f` open with nothing more to say, so
    the wait has to end on /status rather than on the stream closing.
    """
    monkeypatch.setattr(deploy_cmd, "_STATUS_POLL_SECONDS", 0.01)
    monkeypatch.setattr(deploy_cmd, "_REVEAL_GRACE_SECONDS", 0.5)
    monkeypatch.setattr(deploy_cmd, "deploy_status", lambda _p: {"running": False})

    lines = deploy_cmd._queued_lines(
        iter(["INFO:canyonos_core:Building 2 Docker image(s) via `x`.\n"])
    )
    # The queue never yields None: the stream stays open, as it does in reality.
    lines.put = lambda *a, **k: None

    with pytest.raises(RuntimeError, match="stopped or timed out"):
        deploy_cmd._tail_quiet(
            lines,
            {"port": 1},
            8080,
            "config/global_controller.yaml",
            serve=False,
            on_ready=lambda _ready: None,
        )
    assert "Building 2 Docker image(s)" in capsys.readouterr().out


def test_a_live_child_that_never_becomes_ready_times_out(monkeypatch):
    monkeypatch.setattr(deploy_cmd, "_STATUS_POLL_SECONDS", 0.001)
    monkeypatch.setattr(deploy_cmd, "_STARTUP_TIMEOUT_SECONDS", 0.01)
    monkeypatch.setattr(deploy_cmd, "_REVEAL_GRACE_SECONDS", 0)
    monkeypatch.setattr(deploy_cmd, "deploy_status", lambda _p: {"running": True})

    lines = deploy_cmd._queued_lines(iter(()))

    with pytest.raises(RuntimeError, match="stopped or timed out"):
        deploy_cmd._tail_quiet(
            lines,
            {"port": 1},
            8080,
            "config/global_controller.yaml",
            serve=False,
            on_ready=lambda _ready: None,
        )


def test_a_log_reader_error_fails_promptly(monkeypatch):
    class BrokenStream:
        def __iter__(self):
            raise OSError("pipe closed")

    monkeypatch.setattr(deploy_cmd, "_STARTUP_TIMEOUT_SECONDS", 10)
    lines = deploy_cmd._queued_lines(BrokenStream())

    with pytest.raises(RuntimeError, match="Could not read.*pipe closed"):
        list(deploy_cmd._drain(lines, {"port": 1}))


def test_verbose_stops_tailing_once_the_workflow_is_up(monkeypatch):
    """`-v` prints every line until the workflow is up and then returns --
    `canyonos logs` re-attaches on demand. Tailing past the summary is what
    left the old startup deadline silently governing the whole session."""
    monkeypatch.setattr(
        deploy_cmd, "_deploy_summary", lambda *_a: ("url", [], "config.yaml")
    )
    after_ready = "this line arrives after the workflow is up\n"
    lines = deploy_cmd._queued_lines(
        iter(
            [
                "INFO:canyonos_core:Build complete.\n",
                "INFO:canyonos_core.controller.global_controller:Global controller started, polling every 5s...\n",
                after_ready,
            ]
        )
    )

    summary = deploy_cmd._tail_verbose(
        lines,
        {"port": 1},
        8080,
        "config/global_controller.yaml",
        serve=False,
        on_ready=lambda _ready: None,
    )

    assert summary == ("url", [], "config.yaml")
    assert lines.get(timeout=1) == after_ready


def test_verbose_tail_stops_on_a_fatal_line(monkeypatch, capsys):
    """`-v` echoed the CRITICAL line, ran on to the up-marker and reported the
    deploy up, so whether a broken deploy exited 1 depended on the verbosity flag.
    """
    monkeypatch.setattr(
        deploy_cmd, "_deploy_summary", lambda *_a: pytest.fail("no summary")
    )

    with pytest.raises(RuntimeError, match="before the workflow became ready"):
        tail_verbose(
            [
                "INFO:canyonos_core:Deploying from config: config.yaml\n",
                READINESS_FAILED,
                f"INFO:{GC}:Global controller started, polling every 5s...\n",
            ]
        )

    assert "Controller readiness failed" in capsys.readouterr().out


def test_every_failed_replicas_log_survives_to_the_replay(monkeypatch, capsys):
    """Five replicas dumping 40 lines each outrun a 200-line buffer, and a long
    build sits in front of them. The verdict is worth nothing without the logs
    that explain it, so the replay has to reach back past all of it.
    """
    monkeypatch.setattr(deploy_cmd, "_STATUS_POLL_SECONDS", 0.01)
    monkeypatch.setattr(deploy_cmd, "_REVEAL_GRACE_SECONDS", 0.1)
    monkeypatch.setattr(deploy_cmd, "deploy_status", lambda _p: {"running": False})

    transcript = [
        f"#5 [{step}/250] RUN pip install -r reqs.txt\n" for step in range(250)
    ]
    transcript.append(
        f"INFO:{GC}:Waiting for 5 replica(s) to become healthy (timeout=120s)...\n"
    )
    for index in range(5):
        transcript += container_log_dump(
            f"Agent{index}",
            f"127.0.0.1:800{index}",
            [f"agent{index} log line {n}" for n in range(35)] + AGENT_IMPORT_FAILURE,
        )
    transcript.append(READINESS_FAILED)

    lines = deploy_cmd._queued_lines(iter(transcript))
    with pytest.raises(RuntimeError, match="before the workflow became ready"):
        deploy_cmd._tail_quiet(
            lines,
            {"port": 1},
            8080,
            "config/global_controller.yaml",
            serve=False,
            on_ready=lambda _ready: None,
        )

    out = capsys.readouterr().out
    # The earliest dumped line, ~210 lines above the cause that revealed it.
    assert "agent0 log line 0" in out
    assert "ModuleNotFoundError: No module named 'llama_index'" in out
    assert out.rindex("Cause:") > out.rindex("agent0 log line 0")
    # And the cause pinned at the end is the verdict, not a line one of the
    # dumps was quoting. Matched on one word: rich wraps the reprint.
    assert "readiness" in out.rsplit("Cause:", 1)[1]


def test_reveal_failure_reprints_the_cause_after_unrelated_noise(capsys):
    """An unrelated process (e.g. a background poller) can keep logging after the
    real failure is detected, during the grace-drain -- the triggering line must
    still be the last thing on screen, not buried under that noise.
    """
    noise = "ERROR:__main__:Failed to read otel:destinations from Redis; keeping the current 1 destination(s)\n"
    cause = "CRITICAL:canyonos_core:Failed to launch configured runtimes: Unable to locate credentials\n"
    lines = deploy_cmd._queued_lines(iter([noise, noise, noise]))

    deploy_cmd._reveal_failure(lines, [cause], {"port": 1}, cause)

    out = capsys.readouterr().out
    # "Cause:" only prefixes the pinned reprint -- rich's own line-wrapping can
    # otherwise split a long line, so matching on the full cause text is fragile.
    assert out.rindex("Cause:") > out.rindex("Failed to read otel:destinations")


def test_reveal_failure_prints_no_cause_line_when_nothing_tripped_it(capsys):
    """A build that dies silently (no line ever matched `_ERROR_MARKERS`) has no
    single line to point back to -- the "Cause:" reprint should stay absent
    rather than print a hollow one.
    """
    lines = deploy_cmd._queued_lines(iter([]))

    deploy_cmd._reveal_failure(lines, [], {"port": 1})

    assert "Cause:" not in capsys.readouterr().out
