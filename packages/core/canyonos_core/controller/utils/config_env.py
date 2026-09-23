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

# Internal controls a user's .env must never be able to set.
RESERVED_ENV_KEYS = frozenset({"CANYONOS_LLM_STUB_TEXT"})

ENV_REF = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


def load_dotenv(path):
    """Load simple KEY=VALUE entries without overriding existing environment values."""
    if not os.path.isfile(path):
        return
    with open(path, "r") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
                value = value[1:-1]
            if key in RESERVED_ENV_KEYS:
                # Reserved internal control -- never honor it from user .env.
                continue
            if key and key not in os.environ:
                os.environ[key] = value


def expand_env_value(value):
    """Substitute `${VAR}` refs throughout a parsed config, leaving unset ones alone."""
    if isinstance(value, str):
        return ENV_REF.sub(lambda m: os.environ.get(m.group(1), m.group(0)), value)
    if isinstance(value, dict):
        return {key: expand_env_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [expand_env_value(item) for item in value]
    return value


def project_root_for_config(config_path):
    """The project root a config file belongs to -- where its `.env` lives."""
    project_root = os.path.abspath(os.path.join(os.path.dirname(config_path), ".."))
    # Under the .car layout, config lives at <project>/.car/config, so the
    # naive parent-of-parent lands on .car itself -- go up one more level
    # to reach the actual project root where .env lives.
    if os.path.basename(project_root) == ".car":
        project_root = os.path.dirname(project_root)
    return project_root


def load_root_dotenv(config_path):
    """Import the project `.env` that sits next to a config file's project root."""
    load_dotenv(os.path.join(project_root_for_config(config_path), ".env"))


def load_config(config_path):
    """The config as every reader acts on it: root `.env` imported, `${VAR}` expanded."""
    import yaml

    load_root_dotenv(config_path)
    with open(config_path, "r") as f:
        return expand_env_value(yaml.safe_load(f))
