import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, apiForSession } from "../../api";
import type { PlatformSession } from "../../types";

/** One browser identity for both the administration and personal portal. */
export function usePlatformSession() {
  const [session, setSession] = useState<PlatformSession | null | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setChecking(true);
    setError(null);
    try {
      const current = await api.mySession();
      if (request === generation.current) setSession(current);
    } catch (failure) {
      if (request !== generation.current) return;
      if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) setSession(null);
      else setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (request === generation.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const revalidate = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", revalidate);
    return () => {
      generation.current++;
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", revalidate);
    };
  }, [refresh]);

  const signedIn = (current: PlatformSession) => {
    generation.current++;
    setError(null);
    setChecking(false);
    setSession(current);
    // Both roles share the same default login and home address.
    window.history.replaceState(null, "", `/${window.location.search}`);
  };

  const logout = async () => {
    try {
      await apiForSession(session ?? undefined).myLogout();
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === "session_changed") await refresh();
      throw failure;
    }
    generation.current++;
    setSession(null);
    setError(null);
    setChecking(false);
    window.history.replaceState(null, "", "/");
  };

  return { session, error, checking, refresh, signedIn, logout };
}
