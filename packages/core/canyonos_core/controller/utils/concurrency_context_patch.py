"""Makes agent calls from threads and worker processes belong to the request that started them.

CanyonOS tags each agent call with the current request, future and metrics IDs. Python does not
hand those IDs to new threads or worker processes, so calls made from them would lose their request.

This script edits the image's Python so that:
- every new thread starts with the IDs of the thread that started it
- every ThreadPoolExecutor task runs with the IDs of the code that submitted it
- every ProcessPoolExecutor and multiprocessing.Pool task runs with its submitter's IDs

Run once while the image is built. It fails the build if Python's source has changed and the
edits no longer apply."""

import concurrent.futures.process
import concurrent.futures.thread
import multiprocessing.pool
import multiprocessing.util
import os
import sysconfig

# Reused pool workers would otherwise keep the IDs of the request they were forked in.
_BIND_HELPERS = """from . import process
import functools


def _canyonos_context():
    try:
        import canyonos_core.controller.canyonos_context as context
    except ImportError:
        import canyonos_context as context
    return context


def _run_with_canyonos_ids(ids, func, /, *args, **kwargs):
    for var, value in zip(_canyonos_context().REQUEST_CONTEXT, ids):
        var.set(value)
    return func(*args, **kwargs)


def _canyonos_bind(func):
    ids = tuple(var.get() for var in _canyonos_context().REQUEST_CONTEXT)
    return functools.partial(_run_with_canyonos_ids, ids, func)
"""

# _thread is built in, so it is wrapped at every interpreter start; threading.Thread starts through it.
_SITECUSTOMIZE = """import _contextvars
import _thread

_start_new_thread = _thread.start_new_thread


def _start_in_copied_context(function, args, *kwargs):
    return _start_new_thread(_contextvars.copy_context().run, (function, *args), *kwargs)


_thread.start_new_thread = _thread.start_new = _start_in_copied_context
"""

_POOL_BIND = "        '''\n        func = util._canyonos_bind(func)\n"

_EDITS = {
    concurrent.futures.thread.__file__: [
        ("import threading\n", "import threading\nimport contextvars\n"),
        (
            "w = _WorkItem(f, fn, args, kwargs)",
            "w = _WorkItem(f, contextvars.copy_context().run, (fn, *args), kwargs)",
        ),
    ],
    multiprocessing.util.__file__: [
        ("from . import process\n", _BIND_HELPERS),
    ],
    concurrent.futures.process.__file__: [
        (
            "import multiprocessing.connection\n",
            "import multiprocessing.connection\nimport multiprocessing.util\n",
        ),
        (
            "w = _WorkItem(f, fn, args, kwargs)",
            "w = _WorkItem(f, mp.util._canyonos_bind(fn), args, kwargs)",
        ),
    ],
    multiprocessing.pool.__file__: [
        (
            "MUCH slower than `Pool.map()`.\n        '''\n",
            "MUCH slower than `Pool.map()`.\n" + _POOL_BIND,
        ),
        (
            "ordering of results is arbitrary.\n        '''\n",
            "ordering of results is arbitrary.\n" + _POOL_BIND,
        ),
        (
            "Asynchronous version of `apply()` method.\n        '''\n",
            "Asynchronous version of `apply()` method.\n" + _POOL_BIND,
        ),
        (
            "starmap and their async counterparts.\n        '''\n",
            "starmap and their async counterparts.\n" + _POOL_BIND,
        ),
    ],
}

for path, edits in _EDITS.items():
    with open(path) as f:
        source = f.read()
    for old, new in edits:
        if source.count(old) != 1:
            raise SystemExit(f"{path}: expected exactly one {old!r}")
        source = source.replace(old, new)
    with open(path, "w") as f:
        f.write(source)

with open(os.path.join(sysconfig.get_paths()["purelib"], "sitecustomize.py"), "x") as f:
    f.write(_SITECUSTOMIZE)
