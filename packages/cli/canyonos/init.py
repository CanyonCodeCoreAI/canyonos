# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos init`, does the following:
1. Pull the Global Controller image
2. Create a container from it, which the CanyonOS API starts once the workflow group's
   files are uploaded
3. Record the container so later commands find it.
"""

import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import time

# Formatting
from pyfiglet import figlet_format

from canyonos import deployment, env, internal_ca, ports, ui
from canyonos.constants import (
    DEFAULT_API_PORT,
    DEFAULT_REDIS_PORT,
    dashboard_port,
    deployment_config_path,
    endpoint_api_port,
    existing_config_path,
    local_redis_port,
    port_in_use,
    private_ip,
    public_ip,
    read_config,
)
from canyonos.docker_cmd import (
    DOCKER_PULL_TIMEOUT,
    DOCKER_QUICK_TIMEOUT,
    DOCKER_RUN_TIMEOUT,
    DOCKER_SOCKET,
    active_docker_socket,
    cleanup_docker,
    mounted_docker_socket,
    run_docker,
)
from canyonos.port_utils import RESERVED_PORTS_ENV


# Production is `env.PROD_CORE_IMAGE`; a developer can point this at the image
# built from their checkout instead.
GC_IMAGE = env.core_image
# Handed to the container in its environment, never on the command line, so a later
# Global Controller of the workflow group still opens a Redis that outlived the last.
REDIS_PASSWORD_ENV = "CANYONOS_REDIS_PASSWORD"
REDIS_HOST_ENV = "CANYONOS_REDIS_HOST"
REDIS_PORT_ENV = "CANYONOS_REDIS_PORT"

# The workflow group's workspace volume (`deployment.workspace_volume()`) is mounted here.
# Files are uploaded through the CanyonOS API, not mounted live, so host-side
# edits don't reach a running build. `canyonos stop` removes the volume.
GC_WORKSPACE_PATH = "/workspace"

# How to start the daemon behind each docker context, as (CLI command, macOS
# app). Keyed off the *active context* rather than which app is installed: with
# both Docker Desktop and OrbStack present, guessing by app bundle starts the
# wrong daemon and then waits out the timeout against a socket nothing is
# listening on.
DOCKER_RUNTIMES = {
    "orbstack": (["orb", "start"], "OrbStack"),
    "colima": (["colima", "start"], None),
    "desktop-linux": (None, "Docker"),
    "default": (None, "Docker"),
}
DOCKER_START_TIMEOUT = 60


def docker_running():
    """Return True if the Docker daemon answers `docker info`."""
    try:
        return (
            run_docker(
                ["docker", "info"],
                timeout=DOCKER_QUICK_TIMEOUT,
                action="docker info",
            ).returncode
            == 0
        )
    except RuntimeError:
        return False


def docker_start_command():
    """The command that starts the daemon for the active context, or None."""
    try:
        result = run_docker(
            ["docker", "context", "show"],
            timeout=DOCKER_QUICK_TIMEOUT,
            action="docker context show",
        )
    except RuntimeError:
        return None

    context = result.stdout.strip() if result.returncode == 0 else "default"
    command, app = DOCKER_RUNTIMES.get(context, (None, "Docker"))
    if command and shutil.which(command[0]):
        return command
    # Docker Desktop's own CLI starts it wherever it was installed, on any OS;
    # --detach returns once the start is requested, and the caller waits on the daemon.
    if app == "Docker" and _docker_desktop_cli():
        return ["docker", "desktop", "start", "--detach"]
    # A Docker Desktop too old for that CLI, or another macOS app.
    if app and sys.platform == "darwin" and os.path.isdir(f"/Applications/{app}.app"):
        return ["open", "-a", app]
    return None


def _docker_desktop_cli():
    """True when `docker desktop` (Docker Desktop 4.37 and later) is installed."""
    try:
        result = run_docker(
            ["docker", "desktop", "version"],
            timeout=DOCKER_QUICK_TIMEOUT,
            action="docker desktop version",
        )
    except RuntimeError:
        return False
    return result.returncode == 0


def _ensure_docker_running(timeout=DOCKER_START_TIMEOUT):
    if docker_running():
        return
    if shutil.which("docker") is None:
        raise RuntimeError(
            "Docker isn't installed. Install Docker Desktop or OrbStack, then rerun."
        )

    command = docker_start_command()
    if command is None:
        info = run_docker(
            ["docker", "info"], timeout=DOCKER_QUICK_TIMEOUT, action="docker info"
        )
        if "permission denied" in info.stderr.lower():
            raise RuntimeError(
                "Docker is running, but this user isn't allowed to use it. Add yourself "
                "to the docker group (`sudo usermod -aG docker $USER`, then log in "
                "again) and rerun."
            )
        # Linux/systemd wants root here; escalating on the user's behalf is not
        # this CLI's call to make.
        raise RuntimeError(
            "Docker isn't running, and there's no way to start it for the current "
            "docker context. Start it (on Linux: `sudo systemctl start docker`) and re-run."
        )

    ui.say(f"Docker isn't running -- starting it with `{' '.join(command)}`...")
    run_docker(
        command,
        timeout=DOCKER_START_TIMEOUT,
        action="Starting the Docker runtime",
        check=True,
    )

    deadline = time.time() + timeout
    with ui.status("Waiting for the Docker daemon..."):
        while time.time() < deadline:
            if docker_running():
                ui.ok("Docker is running.")
                return
            time.sleep(1)

    raise RuntimeError(
        f"Docker did not become ready within {timeout}s. Start it manually and re-run."
    )


def docker_env(state):
    """Env for a host-side `docker` call that should target the exact engine
    a deploy's container was created on, rather than whatever context happens
    to be active now. None (inherit the caller's environment) for a state.json
    from before this was tracked, or a deploy whose DOCKER_HOST wasn't a plain
    unix socket.
    """
    socket = state.get("docker_socket")
    if not socket:
        return None
    return {**os.environ, "DOCKER_HOST": f"unix://{socket}"}


def _image_present(image):
    return (
        subprocess.run(
            ["docker", "image", "inspect", image], capture_output=True
        ).returncode
        == 0
    )


def _pull_image(image=GC_IMAGE):
    # The production image always comes from the registry. A dev image is
    # usually built locally and may not be in any registry at all, so use
    # whatever the daemon already holds before trying to pull it.
    if image != env.PROD_CORE_IMAGE and _image_present(image):
        return
    result = run_docker(
        ["docker", "pull", image],
        timeout=DOCKER_PULL_TIMEOUT,
        action=f"docker pull {image}",
    )
    if result.returncode != 0:
        if image == env.LOCAL_CORE_IMAGE:
            raise RuntimeError(
                f"No {image} image on this machine, and it is not in a registry. "
                "Build it from the repo root with `bun run canyonos:dev`."
            )
        raise RuntimeError(
            f"docker pull {image} failed: {result.stderr.strip() or result.stdout.strip()}"
        )


def _named_container(name=None):
    """(id, running) for the container holding exactly this name, or (None, False).
    The name defaults to this workflow group's Global Controller container."""
    name = name or deployment.gc_container_name()
    try:
        result = run_docker(
            ["docker", "inspect", "--format", "{{.Id}} {{.State.Running}}", name],
            timeout=DOCKER_QUICK_TIMEOUT,
            action=f"Inspecting Docker container {name}",
        )
    except RuntimeError:
        return None, False
    if result.returncode != 0:
        return None, False
    fields = result.stdout.split()
    if not fields:
        return None, False
    return fields[0], fields[1:2] == ["true"]


def _free_container_name():
    """Remove a leftover container squatting on the workflow group's Global Controller name.

    A fixed --name only works if nothing else holds it, and a crashed run whose state
    file is gone leaves a dead holder behind. A *running* holder is something else entirely -- a live controller this CLI
    lost track of, e.g. another HOME sharing the daemon or a run whose state
    file never got written. Tearing it down would orphan the Redis and agent
    containers it spawned, so refuse the way the raw name conflict used to.
    """
    container_id, running = _named_container()
    if container_id is None:
        return
    if running:
        raise RuntimeError(
            f"The container name {deployment.gc_container_name()} is held by a running "
            f"Global Controller ({container_id[:12]}). Run "
            f"`canyonos stop {deployment.deployment_name()}` to tear it down first."
        )
    failure = cleanup_docker(
        ["docker", "rm", "-f", container_id],
        action=f"Removing stale Docker container {container_id[:12]}",
        missing_text="No such container",
    )
    if failure:
        raise RuntimeError(failure)


def _create_workspace_volume():
    """Create the workflow group's workspace volume up front, so it carries the
    workflow group's label and shows in its Docker group; a volume that already exists is
    reused."""
    volume = deployment.workspace_volume()
    run_docker(
        ["docker", "volume", "create", *deployment.deployment_label_args(), volume],
        timeout=DOCKER_QUICK_TIMEOUT,
        action=f"Creating Docker volume {volume}",
        check=True,
    )


def _redis_password():
    """The password this workflow group's Redis container was started with, so a new
    Global Controller still opens a Redis that outlived the last one, else a new random
    one when there is no such container."""
    name = deployment.redis_container_name()
    try:
        inspect = run_docker(
            [
                "docker",
                "inspect",
                "-f",
                "{{range .Config.Env}}{{println .}}{{end}}",
                name,
            ],
            timeout=DOCKER_QUICK_TIMEOUT,
            action=f"Inspecting Docker container {name}",
        )
    except RuntimeError:
        inspect = None
    if inspect is not None and inspect.returncode == 0:
        for line in inspect.stdout.splitlines():
            key, _, value = line.partition("=")
            if key == REDIS_PASSWORD_ENV and value:
                return value
    return secrets.token_hex(32)


def _create_container(
    image=GC_IMAGE,
    redis_port=DEFAULT_REDIS_PORT,
    api_port=None,
    reserved=frozenset(),
    auth_env=(),
):
    """Create this workflow group's Global Controller container, which the CanyonOS API
    starts once the workflow group's files are uploaded, and tell it Redis's port, the
    `reserved` ports and, for an endpoint whose port isn't set, the port it had last
    deploy. `auth_env` are the `docker create` options that hand it the API key hash.
    Returns its ID and the socket it was handed, when that is a real one on this
    machine."""
    active_socket = active_docker_socket()
    # Idempotent: succeeds silently if the network already exists (created by a
    # prior deploy).
    network_name = deployment.deployment_group()
    network = run_docker(
        ["docker", "network", "create", *deployment.network_label_args(), network_name],
        timeout=DOCKER_QUICK_TIMEOUT,
        action=f"Creating Docker network {network_name}",
    )
    if (
        network.returncode != 0
        and "already exists" not in (network.stderr or "").lower()
    ):
        raise RuntimeError(
            f"Could not create Docker network {network_name}: "
            f"{network.stderr.strip() or network.stdout.strip()}"
        )
    host_private_ip = private_ip()
    host_public_ip = public_ip()
    ca_env = internal_ca.gc_env()
    # Secrets travel in the environment of `docker create`, named bare below, so they
    # never show on its command line.
    gc_env = {**os.environ, **ca_env, REDIS_PASSWORD_ENV: _redis_password()}
    workflow_group_id = read_config(deployment_config_path())["workflow_group_id"]
    _create_workspace_volume()
    _free_container_name()
    cmd = [
        "docker",
        "create",
        # PID 1 ignores a SIGTERM it has no handler for; the init forwards it to the
        # deploy, which then removes its replicas before the container exits.
        "--init",
        *deployment.deployment_label_args(),
        *deployment.gc_role_label_args(),
        *deployment.workflow_group_label_args(workflow_group_id),
        "--name",
        deployment.gc_container_name(),
        "--network",
        network_name,
        # Docker-outside-of-Docker: GC shells out to `docker` to launch
        # Redis/agent containers, so it needs the host's real daemon --
        # specifically the same one this command itself just used, not
        # whatever the DOCKER_SOCKET alias happens to point to.
        "-v",
        f"{mounted_docker_socket()}:{DOCKER_SOCKET}",
        "-v",
        f"{deployment.workspace_volume()}:{GC_WORKSPACE_PATH}",
        "--add-host=host.docker.internal:host-gateway",
        "-e",
        f"{REDIS_HOST_ENV}={deployment.redis_container_name()}",
        "-e",
        f"{REDIS_PORT_ENV}={redis_port}",
        *(["-e", f"CANYONOS_LAST_API_PORT={api_port}"] if api_port else []),
        "-e",
        f"{RESERVED_PORTS_ENV}={','.join(map(str, sorted(reserved)))}",
        # So the GC's own docker-outside-of-docker calls resolve the
        # socket unambiguously too, instead of falling back to whatever
        # a bare `docker` invocation inside the container would default to.
        "-e",
        f"DOCKER_HOST=unix://{DOCKER_SOCKET}",
        # The GC launches sibling containers (the machine metrics collector) from
        # its own image; it cannot read that from inside, so pass it in.
        "-e",
        f"CANYONOS_CONTROLLER_IMAGE={image}",
        # Machines other than this one run their collector from the official
        # release image instead, since a dev image here is in no registry.
        "-e",
        f"CANYONOS_COLLECTOR_IMAGE={env.PROD_CORE_IMAGE}",
        # A bare name copies the host's value when set, so agent images match its CPU.
        "-e",
        "CANYONOS_DOCKER_PLATFORM",
        # Names and labels every container the GC launches with this workflow group.
        "-e",
        f"{deployment.DOCKER_PROJECT_ENV}={deployment.deployment_name()}",
        "-e",
        f"CANYONOS_WORKFLOW_GROUP_ID={workflow_group_id}",
        *auth_env,
        "-e",
        REDIS_PASSWORD_ENV,
        *(arg for name in ca_env for arg in ("-e", name)),
    ]
    if host_private_ip:
        cmd.extend(["-e", f"CANYONOS_PRIVATE_IP={host_private_ip}"])
    if host_public_ip:
        cmd.extend(["-e", f"CANYONOS_PUBLIC_IP={host_public_ip}"])
    cmd.append(image)  # image must come after all flags
    result = run_docker(
        cmd,
        timeout=DOCKER_RUN_TIMEOUT,
        action="Creating the Global Controller container",
        env=gc_env,
    )
    if result.returncode != 0:
        raise RuntimeError(
            "Could not create the CanyonOS controller container: "
            f"{result.stderr.strip()}"
        )
    container_id = result.stdout.strip()
    if not container_id:
        raise RuntimeError(
            "Docker created the Global Controller but returned no container ID."
        )
    # Only a real socket on this machine is recorded: later host-side `docker` calls
    # are pointed at it, and the alias names no socket here.
    return container_id, active_socket


def _save_state(
    container_id,
    docker_socket=None,
    redis_port=None,
    api_port=None,
    auth_disabled=False,
):
    """Atomically write GC state so interruption cannot truncate the old record;
    `auth_disabled` records a deploy with no API key, for `canyonos list`."""
    state_dir = deployment.state_dir()
    os.makedirs(state_dir, exist_ok=True)
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=state_dir,
            prefix="state.",
            suffix=".tmp",
            delete=False,
        ) as f:
            temporary_path = f.name
            json.dump(
                {
                    "container_id": container_id,
                    "docker_socket": docker_socket,
                    "redis_port": redis_port,
                    "api_port": api_port,
                    "workflow_group_id": read_config(deployment_config_path()).get(
                        "workflow_group_id"
                    ),
                    "workflow_group_dir": os.getcwd(),
                    "auth_disabled": auth_disabled,
                },
                f,
            )
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary_path, deployment.state_path())
    except Exception:
        if temporary_path is not None:
            try:
                os.remove(temporary_path)
            except FileNotFoundError:
                pass
        raise


def load_state(state_path=None):
    """Read this workflow group's Global Controller container and ports from its state
    file in its record under `~/.canyonos/workflows`, or from the state file at `state_path`. On
    Kubernetes, return this folder's state from `kubernetes_state` instead."""
    if state_path is None and deployment.configured_target() == "kubernetes":
        # Imported here: kubernetes_target imports api, which imports this module.
        from canyonos.kubernetes_target import kubernetes_state

        return kubernetes_state()
    state_path = state_path or deployment.state_path()
    try:
        with open(state_path, encoding="utf-8") as f:
            state = json.load(f)
    except FileNotFoundError:
        raise
    except (OSError, json.JSONDecodeError) as e:
        raise RuntimeError(
            f"Could not read CanyonOS state at {state_path}: {e}. "
            "Move or remove that file, then run `canyonos deploy` again."
        ) from None

    if (
        not isinstance(state, dict)
        or not isinstance(state.get("container_id"), str)
        or not state["container_id"]
    ):
        raise RuntimeError(
            f"CanyonOS state at {state_path} is invalid. "
            "Move or remove that file, then run `canyonos deploy` again."
        )
    return state


def stop_existing():
    """Tear down a previously created Global Controller, if state records one.

    Without this each run creates another container and orphans the last one, which
    then can't be reached through state.json.
    """
    # Deferred: stop.py imports from this module, so a top-level import cycles.
    from canyonos.stop import stop_if_safe

    if os.path.isfile(deployment.state_path()) and stop_if_safe(load_state()):
        ui.warn(
            "Starting a new Global Controller anyway; the leftovers above need cleaning up by hand."
        )


def _saved_state():
    """The last deploy's state, empty without a readable state file."""
    if not os.path.isfile(deployment.state_path()):
        return {}
    try:
        return load_state()
    except (OSError, RuntimeError):
        return {}


def remember_api_port(api_port):
    """Record the port the endpoint got, so the next deploy starts from it. Without a
    readable state file nothing is recorded, and the next deploy starts from 8080."""
    try:
        state = load_state()
    except (OSError, RuntimeError):
        return
    _save_state(
        state["container_id"],
        state.get("docker_socket"),
        state.get("redis_port"),
        api_port,
        state.get("auth_disabled", False),
    )


def _inspect_container(state):
    """Docker's record of the container `state` records, on the engine it was created
    on, or None when it is gone or Docker can't say."""
    try:
        result = run_docker(
            ["docker", "container", "inspect", state["container_id"]],
            timeout=DOCKER_QUICK_TIMEOUT,
            action=f"Inspecting Docker container {state['container_id'][:12]}",
            env=docker_env(state),
        )
    except RuntimeError:
        return None
    if result.returncode != 0:
        return None
    try:
        return json.loads(result.stdout)[0]
    except (ValueError, IndexError, KeyError):
        return None


def controller_redis(state):
    """The Redis the Global Controller container `state` records was created for: the
    workflow group's Redis container, its port and its password, as `docker create`
    handed them to it, which the dashboard registers. Raises RuntimeError when Docker
    can't say."""
    container = _inspect_container(state) or {}
    variables = dict(
        line.partition("=")[::2]
        for line in (container.get("Config") or {}).get("Env") or []
    )
    try:
        return {
            "redis_host": variables[REDIS_HOST_ENV],
            "redis_port": int(variables[REDIS_PORT_ENV]),
            "redis_password": variables[REDIS_PASSWORD_ENV],
        }
    except (KeyError, ValueError):
        raise RuntimeError(
            "Could not read the Redis settings of the Global Controller container "
            f"{state['container_id'][:12]}."
        ) from None


def _can_reuse_container(state, image, auth_env):
    """True when the Global Controller container `state` records runs, or was created
    and not started yet, from `image` with this workflow group's id, the label the
    CanyonOS API finds it by, the Redis port the config asks for and the API key hash
    `auth_env` hands it, so a deploy can upload to it instead of replacing it. One that
    stopped is replaced, so a deploy that failed starts clean."""
    workflow_group_id = read_config(deployment_config_path())["workflow_group_id"]
    if (
        not state
        or state.get("workflow_group_id") != workflow_group_id
        or local_redis_port(existing_config_path())
        not in (None, state.get("redis_port"))
    ):
        return False
    container = _inspect_container(state)
    if container is None:
        return False
    wanted = run_docker(
        ["docker", "image", "inspect", "--format", "{{.Id}}", image],
        timeout=DOCKER_QUICK_TIMEOUT,
        action=f"Inspecting image {image}",
    )
    config = container.get("Config") or {}
    labels = config.get("Labels") or {}
    # The hash reaches the Global Controller only at create, so a new key replaces it.
    return (
        (container.get("State") or {}).get("Status") in ("running", "created")
        and container.get("Image") == wanted.stdout.strip()
        and labels.get(deployment.WORKFLOW_GROUP_LABEL) == workflow_group_id
        and set(auth_env[1::2]) <= set(config.get("Env") or [])
    )


def run_init(banner=True, image=GC_IMAGE, auth_env=(), auth_disabled=False):
    """Keep this workflow group's Global Controller container when it runs, or waits to
    be started, from `image` with the config's Redis port and `auth_env`; otherwise
    replace it with a fresh one created from `image`, which the CanyonOS API starts
    once the files are uploaded, and save its ID for later commands. Run at the start
    of `canyonos deploy`. A new container gets `auth_env`, the options that hand it the
    API key hash; the state records `auth_disabled`, a deploy with no key."""
    if banner:
        ui.gradient(figlet_format("CANYON OS", font="ansi_shadow", width=200))

    # Read before stop_existing() removes the state, so a redeploy keeps its ports.
    saved = _saved_state()
    with ui.status("Pulling Global Controller image..."):
        _pull_image(image)
    if _can_reuse_container(saved, image, auth_env):
        container = _inspect_container(saved) or {}
        running = (container.get("State") or {}).get("Running")
        kept = "already running" if running else "kept"
        ui.ok(f"Global Controller {kept} in container {saved['container_id'][:12]}")
        return
    stop_existing()

    # After stop_existing(), so the last deploy's ports read as free. Picked and saved
    # under the ports lock: a deploy at the same moment then sees them as claimed.
    config_path = existing_config_path()
    with ports.held():
        claims = ports.claimed(dashboard_port(config_path))
        # Without `api_port`, the reconciler picks the endpoint's port when Docker
        # binds it, starting from the one picked here.
        api_port = endpoint_api_port(config_path)
        if api_port is not None and (port_in_use(api_port) or api_port in claims):
            raise RuntimeError(
                f"Port {api_port} is already in use, and the endpoint needs it. Free "
                f"it, or change `endpoint.api_port` in {config_path} or delete it so "
                "CanyonOS picks a free port."
            )
        # A taken `redis.port` is left to the Global Controller, which reuses this
        # workflow group's own Redis when a crashed deploy left it running there.
        redis_port = local_redis_port(config_path)
        if redis_port is None:
            preferred_redis = saved.get("redis_port") or DEFAULT_REDIS_PORT
            redis_port = ports.pick(preferred_redis, "Redis", claims)
        claims[redis_port] = "Redis"
        last_api_port = None
        if api_port is None:
            preferred_api = saved.get("api_port") or DEFAULT_API_PORT
            last_api_port = ports.pick(preferred_api, "the endpoint", claims)
            claims[last_api_port] = "the endpoint"
        with ui.status("Creating Global Controller container..."):
            container_id, docker_socket = _create_container(
                image=image,
                redis_port=redis_port,
                api_port=last_api_port,
                reserved=frozenset(claims),
                auth_env=auth_env,
            )
        try:
            _save_state(
                container_id,
                docker_socket,
                redis_port,
                last_api_port,
                auth_disabled,
            )
        except OSError as e:
            cleanup_failure = cleanup_docker(
                ["docker", "rm", "-f", container_id],
                action=f"Removing Global Controller {container_id[:12]}",
                missing_text="No such container",
            )
            detail = (
                f" Automatic cleanup also failed: {cleanup_failure}"
                if cleanup_failure
                else ""
            )
            raise RuntimeError(
                f"Could not save Global Controller state at {deployment.state_path()}: "
                f"{e}. Removed container {container_id[:12]}.{detail}"
            ) from None
    ui.ok(f"Global Controller created in container {container_id[:12]}")
