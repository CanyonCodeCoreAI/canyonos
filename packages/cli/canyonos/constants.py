"""Shared helpers for the canyonos CLI.

Config/data layer. Holds shared values and parsing helpers"""

import os
import urllib.error
import urllib.request

import yaml
from ruamel.yaml import YAML

from canyonos.port_utils import is_port_free

DEFAULT_API_PORT = 8080
DEFAULT_REDIS_PORT = 6379
DEFAULT_DASHBOARD_PORT = 8081

_EC2_TOKEN_URL = "http://169.254.169.254/latest/api/token"
_EC2_PUBLIC_IP_URL = "http://169.254.169.254/latest/meta-data/public-ipv4"
_EC2_PRIVATE_IP_URL = "http://169.254.169.254/latest/meta-data/local-ipv4"

_metadata_cache = {}


def default_config_path():
    """Global controller config for the current directory, preferring the .car artifact layout."""
    car = os.path.join(".car", "config", "global_controller.yaml")
    return (
        car if os.path.isfile(car) else os.path.join("config", "global_controller.yaml")
    )


def read_config(config_path):
    """The config at `config_path` as loaded YAML, or {} when it is missing, empty or
    not valid YAML."""
    try:
        with open(config_path) as f:
            return yaml.safe_load(f) or {}
    except (OSError, yaml.YAMLError):
        return {}


def public_ip(timeout=0.3):
    """This machine's public IP via the EC2 IMDSv2 metadata service, or None.

    Only meaningful on an EC2 instance -- a laptop or any other host simply
    fails to reach the link-local metadata address and gets None back. Kept to
    a short timeout and cached for the life of the process so a non-EC2 host
    doesn't pay a network-timeout tax on every call site that wants a display
    host (deploy summary, `status`, etc).
    """
    return _ec2_metadata(_EC2_PUBLIC_IP_URL, timeout)


def private_ip(timeout=0.3):
    """This machine's private IP via the EC2 IMDSv2 metadata service, or None
    off EC2; cached like `public_ip`."""
    return _ec2_metadata(_EC2_PRIVATE_IP_URL, timeout)


def _ec2_metadata(url, timeout):
    """One EC2 IMDSv2 metadata value, or None; it and the token are fetched once per process."""
    if url in _metadata_cache:
        return _metadata_cache[url]
    _metadata_cache[url] = None
    try:
        if _EC2_TOKEN_URL not in _metadata_cache:
            _metadata_cache[_EC2_TOKEN_URL] = None
            token_req = urllib.request.Request(
                _EC2_TOKEN_URL,
                method="PUT",
                headers={"X-aws-ec2-metadata-token-ttl-seconds": "21600"},
            )
            _metadata_cache[_EC2_TOKEN_URL] = (
                urllib.request.urlopen(token_req, timeout=timeout).read().decode()
            )
        token = _metadata_cache[_EC2_TOKEN_URL]
        if token:
            ip_req = urllib.request.Request(
                url, headers={"X-aws-ec2-metadata-token": token}
            )
            _metadata_cache[url] = (
                urllib.request.urlopen(ip_req, timeout=timeout).read().decode().strip()
                or None
            )
    except (OSError, urllib.error.URLError):
        pass
    return _metadata_cache[url]


def endpoint_api_port(config_path):
    """Return the host port the endpoint answers on, or None when the config has no
    `endpoint:` block or its `api_port` is not a port number, which the deploy's
    schema check then reports."""
    endpoint = read_config(config_path).get("endpoint")
    if not isinstance(endpoint, dict):
        return None
    port = endpoint.get("api_port", DEFAULT_API_PORT)
    return port if isinstance(port, int) and not isinstance(port, bool) else None


def endpoint_answers(api_port):
    """True when the endpoint on this machine gives any HTTP answer; the probe's
    unknown request id 404s, which still proves the server is up and listening."""
    try:
        urllib.request.urlopen(
            f"http://127.0.0.1:{api_port}/status/canyonos-test-probe", timeout=2
        )
    except urllib.error.HTTPError:
        return True
    except OSError:
        return False
    return True


def local_redis_port(config_path):
    """Host port the local node's Redis is published on, or the default."""
    config = read_config(config_path)
    if not isinstance(config, dict):
        return DEFAULT_REDIS_PORT

    agents = config.get("agents")
    for agent in agents if isinstance(agents, list) else []:
        if isinstance(agent, dict) and agent.get("host", "localhost") in (
            "localhost",
            "127.0.0.1",
        ):
            return _port_or_default(agent.get("redis_port", DEFAULT_REDIS_PORT))
    redis = config.get("redis")
    if not isinstance(redis, dict):
        return DEFAULT_REDIS_PORT
    return _port_or_default(redis.get("port", DEFAULT_REDIS_PORT))


def _port_or_default(value):
    """`value` when it is a usable TCP port, else the default the runtime falls back to."""
    if isinstance(value, bool) or not isinstance(value, int):
        return DEFAULT_REDIS_PORT
    return value if 1 <= value <= 65535 else DEFAULT_REDIS_PORT


def port_in_use(port):
    """True if this host port is already taken (cannot be bound).

    Bind-based, matching `port_utils.is_port_free`, so "in use" here means the
    same thing a container launcher will hit when it tries to publish the port --
    not merely "something is actively accepting connections".
    """
    return not is_port_free(port)


def dashboard_port(config_path):
    """Host port the local dashboard prefers to start on, falling back to the default."""
    return read_config(config_path).get("dashboard_port", DEFAULT_DASHBOARD_PORT)


def workspace_relative(config_path):
    """`config_path` relative to the cwd, or None if it falls outside it.

    The container only ever receives a copy of the current directory, and it
    resolves what it's given against /workspace -- so an absolute path silently
    discards that prefix and a `../` one escapes it. Both then 404 naming a
    path that exists on the host, which reads as a bug in the wrong place.
    """
    # realpath on both sides: a symlinked project dir (or macOS's /tmp ->
    # /private/tmp) otherwise makes an in-project absolute path look external.
    relative = os.path.relpath(
        os.path.realpath(config_path), os.path.realpath(os.getcwd())
    )
    if relative == ".." or relative.startswith(f"..{os.sep}"):
        return None
    return relative


def round_trip_yaml():
    """Loader that preserves comments, key order, quoting and ${ENV} refs.

    The indent settings match the project's YAML style, so edits don't reflow
    list indentation: block sequences stay indented under their key.
    """
    yaml_rt = YAML()
    yaml_rt.preserve_quotes = True
    yaml_rt.indent(mapping=2, sequence=4, offset=2)
    return yaml_rt
