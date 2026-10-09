# Calls HelloAgent from threads, asyncio and reused thread and process pools, and reports the
# request context each call saw. Swapped in for helloworld's workflow by run_tests.sh.

import _thread
import asyncio
import multiprocessing
import os
import sys
import threading
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "stubs"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "grpc_stubs"))

try:
    import canyonos_core.controller.canyonos_context as canyonos_context
except ImportError:
    import canyonos_context

from deploy import deploy
from agents.hello_agent import HelloAgent

# Created before any request so their workers are reused, which is when stale IDs would show.
THREAD_POOL = ThreadPoolExecutor(max_workers=1)
PROCESS_POOL = ProcessPoolExecutor(max_workers=1)


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


async def _observe_async():
    loop = asyncio.get_running_loop()
    task = asyncio.create_task(asyncio.to_thread(_observe, "async_task"))
    executor = loop.run_in_executor(None, _observe, "async_executor")
    return await asyncio.gather(task, executor)


MP_POOL = multiprocessing.Pool(1)


def main(query: str = "World"):
    results = {"main": _observe("main")}

    thread_result = []
    thread = threading.Thread(target=lambda: thread_result.append(_observe("thread")))
    thread.start()
    thread.join()
    results["thread"] = thread_result[0]

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
    results["async_task"], results["async_executor"] = asyncio.run(_observe_async())
    results["process_pool"] = PROCESS_POOL.submit(_observe, "process_pool").result(
        timeout=60
    )

    results["mp_apply"] = MP_POOL.apply(_observe, ("mp_apply",))
    results["mp_map"] = MP_POOL.map(_observe, ["mp_map"])[0]
    results["mp_imap"] = next(MP_POOL.imap(_observe, ["mp_imap"]))
    results["mp_imap_unordered"] = next(
        MP_POOL.imap_unordered(_observe, ["mp_imap_unordered"])
    )

    process_queue = multiprocessing.Queue()
    process = multiprocessing.Process(
        target=_observe_into, args=(process_queue, "mp_process")
    )
    process.start()
    results["mp_process"] = process_queue.get(timeout=60)
    process.join()
    return results


deploy(main, port=8080)
