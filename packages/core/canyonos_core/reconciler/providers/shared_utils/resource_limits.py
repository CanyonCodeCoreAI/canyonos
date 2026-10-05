"""Default CPU/memory/GPU bounds applied to every container the controller launches."""

# Matches the per-agent resources GlobalController already publishes to Redis,
# so an agent that configures nothing is bounded to what it advertises.
DEFAULT_CPU = 1
DEFAULT_MEMORY_MB = 512
DEFAULT_GPU = 0


def resource_limit_args(resources=None, apply_defaults=True):
    """Turn an agent's `resources:` -- {"cpu": cores, "memory": MB, "gpu": count}, any key absent or None -- into `docker run` --cpus/--memory/--gpus flags; apply_defaults=False (databases) emits only the configured keys."""
    resources = resources or {}
    cpu = resources.get("cpu") or (DEFAULT_CPU if apply_defaults else None)
    memory = resources.get("memory") or (DEFAULT_MEMORY_MB if apply_defaults else None)
    gpu = resources.get("gpu") or DEFAULT_GPU
    args = []
    if cpu:
        args.extend(["--cpus", str(cpu)])
    if memory:
        args.extend(["--memory", f"{memory}m"])
    # `--gpus 0` is not a no-op: on a host without the NVIDIA runtime Docker
    # refuses the request, so zero GPUs means omitting the flag entirely.
    if gpu:
        args.extend(["--gpus", str(gpu)])
    return args
