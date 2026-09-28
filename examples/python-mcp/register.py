"""Register the local Python services through the platform admin API."""

import argparse
import getpass
import os

import httpx

from server import SERVICES


def register(auth_url: str, username: str, password: str) -> None:
    with httpx.Client(base_url=auth_url, timeout=10) as client:
        login = client.post("/admin/session", json={"username": username, "password": password})
        if login.status_code != 200:
            raise RuntimeError(f"Admin login failed (HTTP {login.status_code})")

        listed = client.get("/admin/servers")
        listed.raise_for_status()
        existing = {item["name"]: item for item in listed.json()["servers"]}

        for service, (name, port) in SERVICES.items():
            instance = {"id": f"{name}-a", "url": f"http://127.0.0.1:{port}/mcp"}
            if name in existing:
                current = existing[name]
                if current["auth_mode"] != "none" or current["instances"] != [{**instance, "enabled": True}]:
                    raise RuntimeError(f"{name} already exists with different settings; inspect it in the admin UI")
                print(f"{name}: already registered")
                continue
            response = client.post("/admin/servers", json={
                "name": name,
                "display_name": f"Python {service.title()} Example",
                "instances": [instance],
                "auth_mode": "none",
            })
            if response.status_code != 201:
                raise RuntimeError(f"Could not register {name} (HTTP {response.status_code}): {response.text}")
            print(f"{name}: registered -> {instance['url']}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--auth-url", default="http://127.0.0.1:9001")
    parser.add_argument("--username", default=os.environ.get("MCP_ADMIN_USERNAME", "admin"))
    args = parser.parse_args()
    password = os.environ.get("MCP_ADMIN_PASSWORD") or getpass.getpass("Admin password: ")
    register(args.auth_url, args.username, password)


if __name__ == "__main__":
    main()
