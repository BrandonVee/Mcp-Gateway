"""Stop the three Python MCP servers started by run_servers.py."""

import os
import signal
from pathlib import Path


def main() -> None:
    pid_file = Path(__file__).resolve().parent / ".run.pid"
    if not pid_file.exists():
        print("Python MCP examples are not running")
        return
    pid = int(pid_file.read_text())
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pid_file.unlink(missing_ok=True)
        print("Removed stale process ID")
        return
    print(f"Stopping Python MCP examples (PID {pid})")


if __name__ == "__main__":
    main()
