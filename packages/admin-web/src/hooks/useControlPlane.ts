import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { AdminUser, GatewayHealth, McpServer } from "../types";

export function useControlPlane() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [health, setHealth] = useState<GatewayHealth | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [userData, serverData, gatewayHealth] = await Promise.all([
      api.users(),
      api.servers(),
      api.gatewayHealth(),
    ]);
    setUsers(userData.users);
    setServers(serverData.servers);
    setHealth(gatewayHealth);
  }, []);

  useEffect(() => {
    api
      .session()
      .then(() => setAuthenticated(true))
      .catch(() => setAuthenticated(false));
  }, []);

  useEffect(() => {
    if (!authenticated) return;

    load().catch(() => {
      setAuthenticated(false);
    });
  }, [authenticated, load]);

  const execute = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await operation();
      await load();
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    setBusy(true);
    try {
      await load();
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    try {
      await api.logout();
    } finally {
      setAuthenticated(false);
      setUsers([]);
      setServers([]);
      setHealth(null);
    }
  };

  return {
    api,
    authenticated,
    users,
    servers,
    health,
    busy,
    execute,
    refresh,
    logout,
    markAuthenticated: () => setAuthenticated(true),
  };
}
