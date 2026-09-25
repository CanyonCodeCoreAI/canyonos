from contextvars import ContextVar

# Unlike thread-locals, these reach workers started with a copy of the caller's context.
_request_id = ContextVar("canyonos_request_id", default="")
_current_future_id = ContextVar("canyonos_current_future_id", default="")
_current_metrics_key = ContextVar("canyonos_current_metrics_key", default="")


def set_request_id(request_id: str):
    """Set the current request ID."""
    _request_id.set(request_id)


def get_request_id() -> str:
    """Get the current request ID, or an empty string if not set."""
    return _request_id.get()


def set_current_future_id(future_id: str):
    """Set the future_id currently executing."""
    _current_future_id.set(future_id)


def get_current_future_id() -> str:
    """Get the future_id currently executing, or an empty string if not set."""
    return _current_future_id.get()


def set_current_metrics_key(metrics_key: str):
    """Set the Redis metrics-hash key of the controller instance currently executing."""
    _current_metrics_key.set(metrics_key)


def get_current_metrics_key() -> str:
    """Get the current metrics-hash key, or an empty string if not set."""
    return _current_metrics_key.get()
