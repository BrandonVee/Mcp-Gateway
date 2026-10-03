import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, apiForSession } from '../api';
import { getCurrentLanguage, getTranslation } from '../i18n';
import type {
  PlatformSession,
  SystemSettings,
  AdminConnection,
  AdminUser,
  GatewayHealth,
  McpServer,
  SystemUpdateStatus,
  SystemSettingsInput,
  AuthHealth,
} from '../types';
import { mutateAndRefresh } from '../utils/operations';

export function useControlPlane(
  session: PlatformSession,
  onLogout: () => Promise<void>,
  onSessionExpired: () => Promise<void>,
) {
  const api = useMemo(() => apiForSession(session), [session.user_id, session.auth_version]);
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [connections, setConnections] = useState<AdminConnection[]>([]);
  const [health, setHealth] = useState<GatewayHealth | null>(null);
  const [authHealth, setAuthHealth] = useState<AuthHealth | null>(null);
  const [update, setUpdate] = useState<SystemUpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [userData, serverData, connectionData, gatewayHealth, settingsData, updateData, authHealthData] =
        await Promise.all([
          api.users(),
          api.servers(),
          api.adminConnections(),
          api.gatewayHealth().catch((error): GatewayHealth => ({
            ok: false,
            redis: false,
            registry: {
              lastError:
                error instanceof Error
                  ? error.message
                  : getTranslation('errors.couldNotReadGatewayStatus', getCurrentLanguage()),
            },
          })),
          api.systemSettings(),
          // Deployments that disable web updates answer 503 for this endpoint.
          api.systemUpdate().catch(() => null),
          api.authHealth().catch(() => null),
        ]);
      setSettings(settingsData);
      setUsers(userData.users);
      setServers(serverData.servers);
      setConnections(connectionData.connections);
      setHealth(gatewayHealth);
      setAuthHealth(authHealthData);
      setUpdate(updateData);
    } catch (error) {
      setLoadError(
        error instanceof Error
          ? error.message
          : getTranslation('errors.controlPlaneDataLoadFailed', getCurrentLanguage()),
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
          (error.status === 401 || error.status === 403 || error.code === 'session_changed')
        ) {
          void onSessionExpired();
        }
      })
      .finally(() => setInitializing(false));
  }, [load, onSessionExpired]);

  const execute = async (operation: () => Promise<unknown>) => {
    if (inFlight.current) throw new Error(getTranslation('common.operationInProgress', getCurrentLanguage()));
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await mutateAndRefresh(operation, load);
      if (
        result.refreshError instanceof ApiError &&
        (result.refreshError.status === 401 ||
          result.refreshError.status === 403 ||
          result.refreshError.code === 'session_changed')
      )
        void onSessionExpired();
      return result;
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.status === 401 || error.status === 403 || error.code === 'session_changed')
      ) {
        void onSessionExpired();
      }
      throw error;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const saveSystemSettings = async (body: SystemSettingsInput) => {
    const saved = await api.saveSystemSettings(body);
    setSettings(saved);
    return saved;
  };
  const addUpstreamHost = async (host: string) => {
    const saved = await api.addUpstreamHost(host);
    setSettings(saved);
    return saved;
  };

  const refresh = async () => {
    if (inFlight.current) throw new Error(getTranslation('common.operationInProgress', getCurrentLanguage()));
    inFlight.current = true;
    setBusy(true);
    try {
      await load();
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.status === 401 || error.status === 403 || error.code === 'session_changed')
      ) {
        void onSessionExpired();
      }
      throw error;
    } finally {
      inFlight.current = false;
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
      setAuthHealth(null);
      setUpdate(null);
      setLoadError(null);
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
    authHealth,
    update,
    busy,
    loggingOut,
    initializing,
    loadError,
    saveSystemSettings,
    addUpstreamHost,
    execute,
    refreshUpdate: async () => setUpdate(await api.systemUpdate(true)),
    refresh,
    logout,
  };
}
