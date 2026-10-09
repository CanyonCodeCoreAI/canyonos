"""Request context the controllers set before running agent code, so futures and the
LLM gateway can tag their work, and the hooks that carry it into threads and worker
processes the agent code starts."""

import _thread
import functools
import multiprocessing.pool
import sys
import threading
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from contextvars import ContextVar

_request_id = ContextVar("canyonos_request_id", default="")
_current_future_id = ContextVar("canyonos_current_future_id", default="")
_current_function = ContextVar("canyonos_current_function", default="")
_current_metrics_key = ContextVar("canyonos_current_metrics_key", default="")
# Threads and worker processes receive exactly these, so a new request variable goes here too.
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


def _run_with_request_context(values, func, /, *args, **kwargs):
    tokens = [var.set(value) for var, value in zip(REQUEST_CONTEXT, values)]
    try:
        return func(*args, **kwargs)
    finally:
        for var, token in zip(REQUEST_CONTEXT, tokens):
            var.reset(token)


def bind(func):
    """Return ``func`` bound to the current request context, picklable when ``func`` is."""
    values = tuple(var.get() for var in REQUEST_CONTEXT)
    return functools.partial(_run_with_request_context, values, func)


def _start_new_thread_in_request_context(function, args, kwargs=None):
    return _original_start_new_thread(bind(function), args, kwargs or {})


def _binding_func(method):
    @functools.wraps(method)
    def bound_method(self, *args, **kwargs):
        if args:
            args = (bind(args[0]), *args[1:])
        else:
            kwargs["func"] = bind(kwargs["func"])
        return method(self, *args, **kwargs)

    return bound_method


_original_start_new_thread = _thread.start_new_thread
_POOL_SUBMITTERS = (
    (ThreadPoolExecutor, "submit"),
    (ProcessPoolExecutor, "submit"),
    (multiprocessing.pool.Pool, "apply_async"),
    (multiprocessing.pool.Pool, "_map_async"),
    (multiprocessing.pool.Pool, "imap"),
    (multiprocessing.pool.Pool, "imap_unordered"),
)


def install():
    """Carry the request context into every thread, executor task and pool task this
    process starts from now on. Only the CanyonOS values travel: other context
    variables, such as decimal's context, keep their per-thread behaviour."""
    if getattr(_thread.start_new_thread, "_canyonos_hook", False):
        return
    missing = [
        f"{owner.__name__}.{name}"
        for owner, name in _POOL_SUBMITTERS
        if not hasattr(owner, name)
    ]
    if "_start_new_thread" not in threading.Thread.start.__code__.co_names:
        missing.append("threading.Thread.start through _start_new_thread")
    if missing:
        raise RuntimeError(
            "CanyonOS cannot carry request context into threads and worker processes "
            f"on Python {sys.version.split()[0]}: missing {', '.join(missing)}"
        )
    setattr(_start_new_thread_in_request_context, "_canyonos_hook", True)
    setattr(_thread, "start_new_thread", _start_new_thread_in_request_context)
    setattr(_thread, "start_new", _start_new_thread_in_request_context)
    setattr(threading, "_start_new_thread", _start_new_thread_in_request_context)
    for owner, name in _POOL_SUBMITTERS:
        setattr(owner, name, _binding_func(getattr(owner, name)))
