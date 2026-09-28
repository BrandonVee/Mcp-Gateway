"""Use the project Gateway to list and call tools on every Python service."""

import argparse
import asyncio
import base64
import getpass
import hashlib
import os
import re
import secrets
from urllib.parse import urlparse, parse_qs

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

from server import SERVICES


def access_token(auth_url: str, username: str, password: str) -> str:
    verifier = secrets.token_urlsafe(32)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    redirect_uri = "http://localhost:8080/callback"
    with httpx.Client(base_url=auth_url, timeout=10, follow_redirects=False) as client:
        page = client.get("/authorize", params={
            "response_type": "code", "client_id": "demo-client", "redirect_uri": redirect_uri,
            "scope": "mcp", "state": secrets.token_hex(8),
            "code_challenge": challenge, "code_challenge_method": "S256",
        })
        page.raise_for_status()
        hidden = dict(re.findall(r'name="([^"]+)" value="([^"]*)"', page.text))
        submitted = client.post("/authorize/submit", data={
            **hidden, "username": username, "password": password,
        })
        if submitted.status_code != 302:
            raise RuntimeError(f"OAuth login failed (HTTP {submitted.status_code})")
        code = parse_qs(urlparse(submitted.headers["location"]).query).get("code", [None])[0]
        if not code:
            raise RuntimeError("OAuth authorization did not return a code")
        token = client.post("/token", data={
            "grant_type": "authorization_code", "code": code, "code_verifier": verifier,
            "client_id": "demo-client", "redirect_uri": redirect_uri,
        })
        token.raise_for_status()
        return token.json()["access_token"]


async def verify(gateway_url: str, token: str) -> None:
    checks = {
        "math": ("add", {"a": 2, "b": 5}, "7"),
        "text": ("reverse", {"text": "abc"}, "cba"),
        "utility": ("echo", {"message": "hello"}, "hello"),
    }
    for service, (name, _port) in SERVICES.items():
        tool, arguments, expected = checks[service]
        url = f"{gateway_url.rstrip('/')}/mcp/{name}"
        async with streamablehttp_client(url, headers={"Authorization": f"Bearer {token}"}) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                listed = await session.list_tools()
                if tool not in {item.name for item in listed.tools}:
                    raise RuntimeError(f"{name}: {tool} missing from tools/list")
                result = await session.call_tool(tool, arguments)
                values = [item.text for item in result.content if item.type == "text"]
                if result.isError or expected not in values:
                    raise RuntimeError(f"{name}: unexpected {tool} result: {values}")
                print(f"{name}: tools/list OK; {tool} -> {expected}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--auth-url", default="http://127.0.0.1:9001")
    parser.add_argument("--gateway-url", default="http://127.0.0.1:8000")
    parser.add_argument("--username", default=os.environ.get("MCP_ADMIN_USERNAME", "admin"))
    args = parser.parse_args()
    password = os.environ.get("MCP_ADMIN_PASSWORD") or getpass.getpass("Admin password: ")
    asyncio.run(verify(args.gateway_url, access_token(args.auth_url, args.username, password)))


if __name__ == "__main__":
    main()
