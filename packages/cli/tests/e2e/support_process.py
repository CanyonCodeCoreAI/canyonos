"""Executable controlled boundaries used to prove the E2E process harness."""

from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import subprocess
import sys
from pathlib import Path


def run_stdio() -> int:
    """Echo stdin and report isolated process state on stderr."""
    sys.stdout.write(sys.stdin.read())
    sys.stderr.write(
        json.dumps(
            {
                "cwd": os.getcwd(),
                "home": os.environ.get("HOME"),
                "path": os.environ.get("PATH"),
                "token": os.environ.get("CASE_TOKEN"),
            }
        )
        + "\n"
    )
    return 7


def run_detached_child(child_file: Path, new_session: bool) -> int:
    """Exit at once, leaving a sleeping child that keeps the leader's output open."""
    child = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(3600)"],
        stdin=subprocess.DEVNULL,
        start_new_session=new_session,
    )
    child_file.write_text(f"{child.pid}\n")
    print("leader done", flush=True)
    return 0


def run_partial_output() -> int:
    """Write to both streams, then wait until the harness stops the process group."""
    print("before-timeout", flush=True)
    print("before-timeout-error", file=sys.stderr, flush=True)
    while True:
        signal.pause()


def run_service(address_file: Path, child_file: Path | None) -> int:
    """Bind port zero, report the address, and serve until its process group stops."""
    child = None
    if child_file is not None:
        child = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(3600)"],
            start_new_session=False,
        )
        child_file.write_text(f"{child.pid}\n")

    stopping = False

    def stop(_signum: int, _frame: object) -> None:
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    server = socket.socket()
    server.settimeout(0.05)
    server.bind(("127.0.0.1", 0))
    server.listen()
    host, port = server.getsockname()
    address_file.write_text(f"tcp://{host}:{port}\n")
    print(f"ready tcp://{host}:{port}", flush=True)

    try:
        while not stopping:
            try:
                connection, _address = server.accept()
            except TimeoutError:
                continue
            connection.close()
    finally:
        server.close()
        if child is not None:
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
    return 0


def main() -> int:
    """Run the requested controlled subprocess behavior."""
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("stdio")
    detached_child = subparsers.add_parser("detached-child")
    detached_child.add_argument("child_file", type=Path)
    detached_child.add_argument("--new-session", action="store_true")
    subparsers.add_parser("partial-output")
    service = subparsers.add_parser("service")
    service.add_argument("address_file", type=Path)
    service.add_argument("--child-file", type=Path)
    subparsers.add_parser("early-exit")
    subparsers.add_parser("idle")
    args = parser.parse_args()

    if args.command == "stdio":
        return run_stdio()
    if args.command == "detached-child":
        return run_detached_child(args.child_file, args.new_session)
    if args.command == "partial-output":
        return run_partial_output()
    if args.command == "service":
        return run_service(args.address_file, args.child_file)
    if args.command == "early-exit":
        print("controlled startup failure", file=sys.stderr)
        return 23
    while True:
        signal.pause()


if __name__ == "__main__":
    raise SystemExit(main())
