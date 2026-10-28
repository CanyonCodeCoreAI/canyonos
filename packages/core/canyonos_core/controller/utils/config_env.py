# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The `.env` import and `${VAR}` expansion the config goes through before it is read.

Shared so the manifest schema checks exactly the values the Global Controller
will act on. Expansion is textual: `${API_PORT}` becomes the variable's text
and stays a string, whatever it holds. That is why the schema supports
references in string-typed fields only -- a reference in a numeric one would
pass here and be misread at runtime, where `replicas` of `"3"` starts a single
replica rather than three.
"""

import os
import re

ENV_REF = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


def read_dotenv(path):
    """Return the simple KEY=VALUE entries of a `.env` file, the first of a repeated key
    winning, or {} when there is no file."""
    values = {}
    if not os.path.isfile(path):
        return values
    # utf-8-sig drops the byte-order mark some Windows editors (Notepad) save in front
    # of the first key, which would otherwise become part of its name; a file without
    # one reads exactly as with utf-8.
    with open(path, encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
                value = value[1:-1]
            if key:
                values.setdefault(key, value)
    return values


def load_dotenv(path):
    """Load simple KEY=VALUE entries without overriding existing environment values."""
    for key, value in read_dotenv(path).items():
        os.environ.setdefault(key, value)


def expand_env_value(value, env=os.environ):
    """Substitute `${VAR}` refs from `env` throughout a parsed config, leaving unset ones
    alone."""
    if isinstance(value, str):
        return ENV_REF.sub(lambda m: env.get(m.group(1), m.group(0)), value)
    if isinstance(value, dict):
        return {
            expand_env_value(key, env): expand_env_value(item, env)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [expand_env_value(item, env) for item in value]
    return value


def resolve_env_file(config_path):
    """
    Return the absolute path of the project's `.env`, the one in the folder above
    `config_path`'s, or None when there is none.

    Raises:
        ValueError: the file exists but is unreadable. Deploy should fail here
            rather than start a fleet of agents with no API keys.
    """
    path = os.path.abspath(os.path.join(os.path.dirname(config_path), "..", ".env"))
    if not os.path.isfile(path):
        return None
    if not os.access(path, os.R_OK):
        raise ValueError(f".env is not readable: {path}")
    return path


def read_root_dotenv(config_path):
    """Return the entries of the project's `.env`, or {} when there is none, without
    importing them."""
    env_path = resolve_env_file(config_path)
    return read_dotenv(env_path) if env_path else {}


def load_root_dotenv(config_path):
    """Import the project's `.env`, if there is one."""
    env_path = resolve_env_file(config_path)
    if env_path:
        load_dotenv(env_path)


def load_config(config_path):
    """The config as every reader acts on it: root `.env` imported, `${VAR}` expanded."""
    import yaml

    load_root_dotenv(config_path)
    with open(config_path, "r") as f:
        return expand_env_value(yaml.safe_load(f))
