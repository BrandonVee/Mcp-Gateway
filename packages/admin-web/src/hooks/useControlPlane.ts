import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "../api";
import { getCurrentLanguage, getTranslation } from "../i18n";
import type { SystemSettings, AdminConnection, AdminUser, GatewayHealth, McpServer } from "../types";

export function useControlPlane() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [connections, setConnections] = useState<AdminConnection[]>([]);
  const [health, setHealth] = useState<GatewayHealth | null>(null);
  const [busy, setBusy] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [userData, serverData, connectionData, gatewayHealth, settingsData] = await Promise.all([
        api.users(),
        api.servers(),
        api.adminConnections(),
        api.gatewayHealth().catch(
          (error): GatewayHealth => ({
            ok: false,
            redis: false,
            registry: {
              lastError:
                error instanceof Error ? error.message : getTranslation("errors.couldNotReadGatewayStatus", getCurrentLanguage()),
            },
          }),
        ),
        api.systemSettings(),
      ]);
      setSettings(settingsData);
      setUsers(userData.users);
      setServers(serverData.servers);
      setConnections(connectionData.connections);
      setHealth(gatewayHealth);
      setLastUpdatedAt(Date.now());
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : getTranslation("errors.controlPlaneDataLoadFailed", getCurrentLanguage()),
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
      setConnections([]);
      setHealth(null);
      setLoadError(null);
      setLastUpdatedAt(null);
    }
  };

  return {
    api,
    authenticated,
    settings,
    users,
    servers,
    connections,
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
