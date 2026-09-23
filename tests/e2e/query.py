"""POST a query to a deployed workflow, poll its status and print the result.

Talks to the workflow's REST API directly, the way a user of `canyonos deploy`
would, instead of going through `canyonos test`.

Usage: query.py <base-url> <query> [timeout-seconds]
Prints the workflow's return value as JSON; exits 1 on error or timeout.
"""

import json
import sys
import time
import urllib.request

ROUTE = "main"
POLL_INTERVAL = 2
DEFAULT_TIMEOUT = 300


def post(url, body):
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read())


def get(url):
    with urllib.request.urlopen(url, timeout=10) as response:
        return json.loads(response.read())


def main():
    base_url, query = sys.argv[1].rstrip("/"), sys.argv[2]
    timeout = int(sys.argv[3]) if len(sys.argv) > 3 else DEFAULT_TIMEOUT

    request_id = post(f"{base_url}/{ROUTE}", {"query": query})["request_id"]
    print(f"POST {base_url}/{ROUTE} -> request {request_id}", file=sys.stderr)

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status = get(f"{base_url}/status/{request_id}")
        if status["status"] == "done":
            print(json.dumps(status["result"], indent=2))
            return
        if status["status"] == "error":
            sys.exit(f"workflow error: {status.get('error')}")
        time.sleep(POLL_INTERVAL)

    sys.exit(f"request {request_id} did not finish within {timeout}s")


if __name__ == "__main__":
    main()
