# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Decides how many agent calls one replica runs at the same time.

Why there is a limit at all
---------------------------
A replica runs its agent's calls on threads, many at once. Most agent calls spend nearly
all of their time waiting for a language model to answer, and a call that is waiting costs
almost nothing, so running hundreds of them side by side is cheap. That is why the
configured maximum is high: 512 calls, or whatever CANYONOS_MAX_WORKERS says. Calls that
arrive while the limit is reached wait in line in front of the agent, oldest first, and
each one starts as soon as a running call finishes.

Two things can still go wrong when too many calls run at once: the replica can run out of
memory, or out of processor time. This class watches for both and lowers the limit when
either one runs short. The replica's controller calls `update` once per metrics tick (every
5 seconds by default, CANYONOS_POLL_INTERVAL) and applies whatever limit it returns.

Memory: the hard limit
----------------------
Each replica's container has a memory limit (the agent's `resources: memory`, 512 MB by
default). If its calls together use more than that, the operating system kills the whole
container, and every call running on it is lost, not only the one that used too much. So
the limit is lowered to the number of calls that fit:

    calls that fit = (85% of the memory limit - memory in use at startup) / memory per call

"Memory in use at startup" is read right after the agent is loaded and before any call
runs, so the agent's own code and data are never blamed on the calls. The 15% left over is
room for calls that are still growing.

Nothing tells the replica how much memory a call needs, so it learns that while it runs.
Only a new highest memory reading teaches it anything. Below the highest, the memory in use
may simply be what earlier calls left behind, and counting it would make calls look bigger
than they are. At a new high with at least 4 calls running, the memory above startup is
shared out across the running calls, plus 10% for calls that are still growing. A bigger
estimate replaces the old one at once, because guessing too low is what gets a replica
killed. A smaller one only moves the estimate a fifth of the way down, so one quiet moment
does not undo what a busy one taught. Until the replica has seen 4 calls running at a new
high, there is no estimate and memory does not lower the limit.

When the replica has swap
-------------------------
Without swap, a single call that suddenly needs more memory than the replica has gets the
replica killed, and the new replica starts learning from scratch. With swap (compressed
swap kept in memory, on machines set up for it), the replica slows down for a moment
instead of dying, and it carries on with a highest reading set by that one unusual call.
Two rules stop that call from holding the limit down for good:

- When memory in use falls below half of the highest reading, the highest reading is
  forgotten and set to what is in use now, so the next busy spell can teach the estimate
  again.
- When calls have been waiting for 10 ticks in a row while the replica sits at its limit
  and uses less than half of its memory, the estimate is plainly too big. It drops by 10%
  each tick, but never below what the calls running right now actually use.

CPU: the soft limit
-------------------
Running out of processor time does not kill anything. Every call just gets slower, because
the running calls share the processor. Letting more calls start on a full processor does
not finish more work; it only spreads the same work over more calls. Worse, the replica
never looks busy from outside: no call waits in line, so a scaling policy that watches the
line (`queue_length_total`) never adds a replica.

So while the container uses 90% or more of its CPU limit (the agent's `resources: cpu`, 1
CPU by default), the limit is held at the number of calls running right now. The calls
already running carry on, and new ones wait in line until one finishes. Once CPU use falls
below 70%, the hold is let go and only the memory limit applies again. The gap between 90%
and 70% keeps the hold from switching on and off every tick.

What to expect from it: a replica whose processor is full now builds a line of waiting
calls, so `queue_length_total` scaling adds replicas, and the replica still finishes just as
many calls, because its processor stays busy. It does not make one replica faster on its
own. A call that waits in line takes about as long as it would have taken running slowly
next to the others, and a short call can now wait behind long ones. With 2 or more CPUs
the hold rarely starts: Python runs one thread's code at a time, so one replica's agent
keeps about one CPU busy at most.

How the readings are taken
--------------------------
Each tick the controller passes in how many calls are running, how many are waiting, the
memory in use and the CPU use. Memory in use is what the container's memory accounting
reports, plus swap in use, minus file cache the system can take back at any moment, minus
pages counted twice because they sit both in memory and in swap. CPU use is the processor
time the container used since the previous tick, as a percent of its CPU limit.
"""


class WorkerLimit:
    """How many calls a replica runs at once: the configured maximum, lowered to how many
    fit in its memory and held while its CPU is full. Updated once per metrics tick."""

    def __init__(
        self,
        configured_max_workers: int,
        base_memory_bytes: int,
        memory_limit_bytes: int,
        has_swap: bool,
    ):
        self._configured_max_workers = configured_max_workers
        # Memory the replica uses once its agent is loaded, before any call runs.
        self._base_memory = base_memory_bytes
        # The container's memory limit, set from the agent's resources memory; past it the kernel kills the replica.
        self._memory_limit = memory_limit_bytes
        self._has_swap = has_swap
        self._highest_memory = base_memory_bytes
        # 0 until a tick sees 4 or more calls running at a new memory high.
        self._memory_per_call = 0.0
        self._memory_cap = None
        self._ticks_held_back_with_room = 0
        self._cpu_full = False

    def update(
        self,
        running_calls: int,
        queued_calls: int,
        memory_used_bytes: int,
        cpu_used_percent: float,
    ) -> int:
        """Take one tick's running and queued calls, the memory in use now and the CPU use
        as a percent of the limit; return the new limit."""
        # Without swap a giant call restarts the replica and the estimate with it; with swap it survives, albeit slowing down.
        if self._has_swap:
            if memory_used_bytes < 0.5 * self._highest_memory:
                self._highest_memory = memory_used_bytes
            calls_held_back = (
                self._memory_cap is not None
                and queued_calls > 0
                and running_calls >= self._memory_cap - 1
            )
            held_back_with_room = (
                calls_held_back and memory_used_bytes < 0.5 * self._memory_limit
            )
            self._ticks_held_back_with_room = (
                self._ticks_held_back_with_room + 1 if held_back_with_room else 0
            )
            if self._ticks_held_back_with_room > 9:
                measured_per_call = (
                    1.1
                    * (memory_used_bytes - self._base_memory)
                    / max(running_calls, 1)
                )
                self._memory_per_call = max(
                    0.9 * self._memory_per_call, measured_per_call
                )

        # Only a new high says how big calls are; below it, memory may be what earlier calls left behind.
        if memory_used_bytes > self._highest_memory:
            self._highest_memory = memory_used_bytes
            if running_calls >= 4:
                # 1.1 leaves room for running calls that are still growing.
                measured_per_call = (
                    1.1 * (memory_used_bytes - self._base_memory) / running_calls
                )
                if measured_per_call > self._memory_per_call:
                    self._memory_per_call = measured_per_call
                else:
                    self._memory_per_call = (
                        0.8 * self._memory_per_call + 0.2 * measured_per_call
                    )
        max_workers = self._configured_max_workers
        if self._memory_per_call:
            self._memory_cap = max(
                1,
                int(
                    (0.85 * self._memory_limit - self._base_memory)
                    // self._memory_per_call
                ),
            )
            max_workers = min(max_workers, self._memory_cap)

        # A full CPU only spreads the same work over more calls, so new ones wait until it frees up.
        if cpu_used_percent >= 90:
            self._cpu_full = True
        elif cpu_used_percent < 70:
            self._cpu_full = False
        if self._cpu_full:
            max_workers = min(max_workers, max(running_calls, 1))
        return max_workers
