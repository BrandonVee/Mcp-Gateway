import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "../api";
import type { AdminUser, GatewayHealth, McpServer } from "../types";

export function useControlPlane() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [health, setHealth] = useState<GatewayHealth | null>(null);
  const [busy, setBusy] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [userData, serverData, gatewayHealth] = await Promise.all([
        api.users(),
        api.servers(),
        api.gatewayHealth().catch(
          (error): GatewayHealth => ({
            ok: false,
            redis: false,
            registry: {
              lastError:
                error instanceof Error ? error.message : "Gateway 状态读取失败",
            },
          }),
        ),
      ]);
      setUsers(userData.users);
      setServers(serverData.servers);
      setHealth(gatewayHealth);
      setLastUpdatedAt(Date.now());
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "控制平面数据加载失败",
      );
      throw error;
    }
  }, []);

  useEffect(() => {
    api
      .session()
      .then(() => setAuthenticated(true))
      .catch(() => setAuthenticated(false));
  }, []);

  useEffect(() => {
    if (!authenticated) {
      setInitializing(false);
      return;
    }

    setInitializing(true);
    load()
      .catch((error) => {
        if (
          error instanceof ApiError &&
          (error.status === 401 || error.status === 403)
        ) {
          setAuthenticated(false);
        }
      })
      .finally(() => setInitializing(false));
  }, [authenticated, load]);

  const execute = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await operation();
      await load();
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.status === 401 || error.status === 403)
      ) {
        setAuthenticated(false);
      }
      throw error;
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    setBusy(true);
    try {
      await load();
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.status === 401 || error.status === 403)
      ) {
        setAuthenticated(false);
      }
      throw error;
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
      setLoadError(null);
      setLastUpdatedAt(null);
    }
  };

  return {
    api,
    authenticated,
    users,
    servers,
    health,
    busy,
    initializing,
    loadError,
    lastUpdatedAt,
    execute,
    refresh,
    logout,
    markAuthenticated: () => {
      setInitializing(true);
      setAuthenticated(true);
    },
  };
}
