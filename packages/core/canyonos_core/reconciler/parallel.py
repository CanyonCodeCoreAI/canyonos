# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Run independent jobs at once, so a slow one holds up no other."""

import os
from concurrent.futures import ThreadPoolExecutor, as_completed


def run_in_parallel(jobs):
    """Run every job at once and wait for all of them; used by the reconciler and both
    provisioners. jobs maps a key to a function that takes no arguments. Returns
    (key, result, error) for each job as it finished, error being None when it succeeded,
    so one that raises never stops the others."""
    if not jobs:
        return []
    done = []
    with ThreadPoolExecutor(
        max_workers=min(len(jobs), (os.cpu_count() or 1) * 100)
    ) as executor:
        futures = {executor.submit(job): key for key, job in jobs.items()}
        for future in as_completed(futures):
            error = future.exception()
            done.append((futures[future], None if error else future.result(), error))
    return done
