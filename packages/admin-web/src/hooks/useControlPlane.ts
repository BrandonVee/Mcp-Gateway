import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, apiForSession } from "../api";
import { getCurrentLanguage, getTranslation } from "../i18n";
import type { PlatformSession, SystemSettings, AdminConnection, AdminUser, GatewayHealth, McpServer } from "../types";

export function useControlPlane(session: PlatformSession, onLogout: () => Promise<void>, onSessionExpired: () => Promise<void>) {
  const api = useMemo(() => apiForSession(session), [session.user_id, session.auth_version]);
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [connections, setConnections] = useState<AdminConnection[]>([]);
  const [health, setHealth] = useState<GatewayHealth | null>(null);
  const [busy, setBusy] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
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
  }, [api]);

  useEffect(() => {
    setInitializing(true);
    load()
      .catch((error) => {
        if (
          error instanceof ApiError &&
          (error.status === 401 || error.status === 403 || error.code === "session_changed")
        ) {
          void onSessionExpired();
        }
      })
      .finally(() => setInitializing(false));
  }, [load, onSessionExpired]);

  const execute = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await operation();
      await load();
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.status === 401 || error.status === 403 || error.code === "session_changed")
      ) {
        void onSessionExpired();
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
        (error.status === 401 || error.status === 403 || error.code === "session_changed")
      ) {
        void onSessionExpired();
      }
      throw error;
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    setLoggingOut(true);
    try {
      await onLogout();
      setSettings(null);
      setUsers([]);
      setServers([]);
      setConnections([]);
      setHealth(null);
      setLoadError(null);
      setLastUpdatedAt(null);
    } finally {
      setLoggingOut(false);
    }
  };

  return {
    api,
    settings,
    users,
    servers,
    connections,
    health,
    busy,
    loggingOut,
    initializing,
    loadError,
    lastUpdatedAt,
    execute,
    refresh,
    logout,
  };
}
