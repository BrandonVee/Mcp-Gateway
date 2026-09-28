"""Three small Streamable HTTP MCP servers for local gateway testing."""

import argparse

from mcp.server.fastmcp import FastMCP


SERVICES = {
    "math": ("python-math", 3101),
    "text": ("python-text", 3102),
    "utility": ("python-utility", 3103),
}


def build_server(service: str, port: int) -> FastMCP:
    name, _ = SERVICES[service]
    mcp = FastMCP(name, host="127.0.0.1", port=port, json_response=True)

    if service == "math":

        @mcp.tool()
        def add(a: int, b: int) -> int:
            """Add two integers."""
            return a + b

        @mcp.tool()
        def multiply(a: int, b: int) -> int:
            """Multiply two integers."""
            return a * b

    elif service == "text":

        @mcp.tool()
        def reverse(text: str) -> str:
            """Reverse a string."""
            return text[::-1]

        @mcp.tool()
        def word_count(text: str) -> int:
            """Count whitespace-separated words."""
            return len(text.split())

    else:

        @mcp.tool()
        def echo(message: str) -> str:
            """Return the message unchanged."""
            return message

        @mcp.tool()
        def server_info() -> str:
            """Identify this example MCP service."""
            return name

    return mcp


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("service", choices=SERVICES)
    args = parser.parse_args()
    name, port = SERVICES[args.service]
    print(f"[{name}] http://127.0.0.1:{port}/mcp", flush=True)
    build_server(args.service, port).run(transport="streamable-http")


if __name__ == "__main__":
    main()
