# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""POST a JSON body to a deployed workflow and wait for the request to finish.

Unlike tests/e2e/query.py, the body is sent as given, so an argument can be an
object, and a failed request still prints its status.

Usage: request.py <url> <body-json> [timeout-seconds]
Prints the final /status record as JSON, with the request id added; exits 1
when the request does not finish in time.
"""

import json
import sys
import time
import urllib.parse
import urllib.request

POLL_INTERVAL = 2
DEFAULT_TIMEOUT = 300


def main():
    url, body = sys.argv[1:3]
    timeout = int(sys.argv[3]) if len(sys.argv) > 3 else DEFAULT_TIMEOUT
    request = urllib.request.Request(
        url,
        data=body.encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        request_id = json.loads(response.read())["request_id"]
    print(f"POST {url} -> request {request_id}", file=sys.stderr)

    base = urllib.parse.urlsplit(url)
    status_url = f"{base.scheme}://{base.netloc}/status/{request_id}"
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with urllib.request.urlopen(status_url, timeout=10) as response:
            status = json.loads(response.read())
        if status["status"] in ("done", "error"):
            print(json.dumps({"request_id": request_id, **status}))
            return
        time.sleep(POLL_INTERVAL)
    sys.exit(f"request {request_id} did not finish within {timeout}s")


if __name__ == "__main__":
    main()
