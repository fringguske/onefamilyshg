"use client";
import { useCallback, useEffect, useState } from "react";

/** fetch() wrapper: JSON in, JSON out, readable errors, redirect to login on 401. */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (res.status === 401 && !path.startsWith("/api/auth/login")) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
  }
  if (!res.ok) {
    const err = new Error((data as { error?: string } | null)?.error ?? `Request failed (${res.status}).`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  return data as T;
}

// ---- browser storage (drafts survive switching apps, closing the tab, or losing signal) ----

export function readStore<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeStore(key: string, value: unknown) {
  try {
    if (value === null || value === undefined) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: the form still works, it just isn't remembered */
  }
}

/** useState that is also saved in the browser under `key`. */
export function useDraft<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void, () => void] {
  const [value, setValue] = useState<T>(initial);
  // the key whose stored value has been loaded into state (storage is only readable after mount)
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  useEffect(() => {
    setValue(readStore(key, initial));
    setLoadedKey(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    if (loadedKey === key) writeStore(key, value);
  }, [key, loadedKey, value]);
  const clear = useCallback(() => {
    writeStore(key, null);
    setValue(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return [value, setValue, clear];
}

/** Warn before leaving the page while something is unsaved. */
export function useUnsavedWarning(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [active]);
}
