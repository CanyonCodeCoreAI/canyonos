# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

# Calls HelloAgent from threads, asyncio, reused thread and process pools, and fork and spawn
# processes, and reports the request context each call saw and the Python each agent runs on.
# tests/e2e/workflows/context-propagation lays it over helloworld.

import _thread
import asyncio
import multiprocessing
import platform
import threading
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from multiprocessing.pool import ThreadPool

try:
    import canyonos_core.controller.canyonos_context as canyonos_context
except ImportError:
    import canyonos_context

from agents.hello_agent import HelloAgent

# Created before any request so their workers are reused, which is when stale IDs would show.
THREAD_POOL = ThreadPoolExecutor(max_workers=1)
PROCESS_POOL = ProcessPoolExecutor(max_workers=1)
SPAWN_PROCESS_POOL = ProcessPoolExecutor(
    max_workers=1, mp_context=multiprocessing.get_context("spawn")
)
MP_THREAD_POOL = ThreadPool(1)


def _observe(where):
    future = HelloAgent().hello(name=where)
    return {
        "request_id": canyonos_context.get_request_id(),
        "future_id": canyonos_context.get_current_future_id(),
        "function": canyonos_context.get_current_function(),
        "greeting": future.value(),
        "agent_request_id": future.redis.hget(f"future:{future.id}", "request_id"),
        "agent_parent": future.redis.hget(f"future:{future.id}", "parent"),
    }


def _observe_into(queue, where):
    queue.put(_observe(where))


def _observe_in_new_thread(where):
    result = []
    thread = threading.Thread(target=lambda: result.append(_observe(where)))
    thread.start()
    thread.join()
    return result[0]


def _queued_result(process, queue):
    process.start()
    result = queue.get(timeout=60)
    process.join()
    return result


class _ObservingThread(threading.Thread):
    def run(self):
        self.result = _observe("thread_subclass")


class _ObservingProcess(multiprocessing.Process):
    def __init__(self, queue):
        super().__init__()
        self.queue = queue

    def run(self):
        self.queue.put(_observe("process_subclass"))


async def _observe_async():
    loop = asyncio.get_running_loop()
    task = asyncio.create_task(asyncio.to_thread(_observe, "async_task"))
    executor = loop.run_in_executor(None, _observe, "async_executor")
    return await asyncio.gather(task, executor)


# Python 3.14+ starts workers with forkserver, and they import this module again; only the controller makes the pool.
MP_POOL = (
    multiprocessing.Pool(1)
    if multiprocessing.current_process().name == "MainProcess"
    else None
)


class Workflow:
    def main(self, query: str = "World"):
        results = {
            "main": _observe("main"),
            "python": {
                "Workflow": platform.python_version(),
                "HelloAgent": HelloAgent().python_version().value(),
            },
        }

        thread_result = []
        thread = threading.Thread(
            target=lambda: thread_result.append(_observe("thread"))
        )
        thread.start()
        thread.join()
        results["thread"] = thread_result[0]

        subclass_thread = _ObservingThread()
        subclass_thread.start()
        subclass_thread.join()
        results["thread_subclass"] = subclass_thread.result

        raw_thread_done = threading.Event()
        raw_thread_result = []
        _thread.start_new_thread(
            lambda: (
                raw_thread_result.append(_observe("raw_thread")),
                raw_thread_done.set(),
            ),
            (),
        )
        raw_thread_done.wait(60)
        results["raw_thread"] = raw_thread_result[0]

        results["thread_pool"] = THREAD_POOL.submit(_observe, "thread_pool").result()
        results["nested_thread"] = THREAD_POOL.submit(
            _observe_in_new_thread, "nested_thread"
        ).result()
        results["async_task"], results["async_executor"] = asyncio.run(_observe_async())
        results["process_pool"] = PROCESS_POOL.submit(_observe, "process_pool").result(
            timeout=60
        )
        results["spawn_process_pool"] = SPAWN_PROCESS_POOL.submit(
            _observe, "spawn_process_pool"
        ).result(timeout=60)

        results["mp_apply"] = MP_POOL.apply(_observe, ("mp_apply",))
        results["mp_map"] = MP_POOL.map(_observe, ["mp_map"])[0]
        results["mp_imap"] = next(MP_POOL.imap(_observe, ["mp_imap"]))
        results["mp_imap_unordered"] = next(
            MP_POOL.imap_unordered(_observe, ["mp_imap_unordered"])
        )
        results["mp_thread_pool"] = MP_THREAD_POOL.apply(_observe, ("mp_thread_pool",))

        queue = multiprocessing.Queue()
        results["mp_process"] = _queued_result(
            multiprocessing.Process(target=_observe_into, args=(queue, "mp_process")),
            queue,
        )
        results["process_subclass"] = _queued_result(_ObservingProcess(queue), queue)

        spawn = multiprocessing.get_context("spawn")
        spawn_queue = spawn.Queue()
        results["spawn_process"] = _queued_result(
            spawn.Process(target=_observe_into, args=(spawn_queue, "spawn_process")),
            spawn_queue,
        )
        return results
