"""Run all three example MCP servers until interrupted."""

import signal
import subprocess
import sys
import time
import os
from pathlib import Path

from server import SERVICES


def main() -> None:
    directory = Path(__file__).resolve().parent
    pid_file = directory / ".run.pid"
    if pid_file.exists():
        previous = int(pid_file.read_text())
        try:
            os.kill(previous, 0)
        except ProcessLookupError:
            pid_file.unlink()
        else:
            raise RuntimeError(f"Python MCP examples are already running (PID {previous})")
    fd = os.open(pid_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write(str(os.getpid()))
    children = []

    def stop() -> None:
        for child in children:
            if child.poll() is None:
                child.terminate()
        for child in children:
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()

    signal.signal(signal.SIGINT, lambda *_: sys.exit(0))
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    for service in SERVICES:
        children.append(subprocess.Popen([sys.executable, "-u", str(directory / "server.py"), service]))
    print("Python MCP examples started; press Ctrl+C to stop.", flush=True)
    try:
        while True:
            if any(child.poll() is not None for child in children):
                raise RuntimeError("One of the MCP servers exited unexpectedly")
            time.sleep(0.5)
    finally:
        stop()
        pid_file.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
