"""Request context the controllers set before running agent code, so futures and the
LLM gateway can tag their work."""

from contextvars import ContextVar

# Unlike thread-locals, these reach workers started with a copy of the caller's context.
_request_id = ContextVar("canyonos_request_id", default="")
_current_future_id = ContextVar("canyonos_current_future_id", default="")
_current_function = ContextVar("canyonos_current_function", default="")
_current_metrics_key = ContextVar("canyonos_current_metrics_key", default="")
# Process pools copy exactly these into their workers, so a new request variable goes here too.
REQUEST_CONTEXT = (
    _request_id,
    _current_future_id,
    _current_function,
    _current_metrics_key,
)


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


def set_current_function(function: str):
    """Set the agent function currently executing."""
    _current_function.set(function)


def get_current_function() -> str:
    """Get the agent function currently executing, or an empty string if not set."""
    return _current_function.get()


def set_current_metrics_key(metrics_key: str):
    """Set the Redis metrics-hash key of the controller instance currently executing."""
    _current_metrics_key.set(metrics_key)


def get_current_metrics_key() -> str:
    """Get the current metrics-hash key, or an empty string if not set."""
    return _current_metrics_key.get()
