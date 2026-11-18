"use client";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { Kind } from "@/lib/crm";
import { propertyColorHex, type PropertyColorSetting } from "@/lib/property-colors";

const Context = createContext({ settings: [] as PropertyColorSetting[], loading: true, error: "",
  reload: async (): Promise<PropertyColorSetting[]> => [], save: async (_setting: PropertyColorSetting): Promise<void> => {} });
export function PropertyColorsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<PropertyColorSetting[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/property-colors", { cache: "no-store" });
      const data = await response.json() as { settings: PropertyColorSetting[]; error?: string };
      if (!response.ok) throw Error(data.error || "Could not load property colors.");
      setSettings(data.settings); setError(""); return data.settings;
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load property colors."); throw e; }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void reload().catch(() => {}); }, [reload]);
  async function save(input: PropertyColorSetting) {
    const response = await fetch("/api/property-colors", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const data = await response.json() as { setting: PropertyColorSetting; error?: string };
    if (!response.ok) throw Error(data.error || "Could not save property colors.");
    setSettings(current => [...current.filter(s => s.kind !== input.kind || s.field !== input.field), data.setting]);
  }
  return <Context.Provider value={{ settings, loading, error, reload, save }}>{children}
    {error && <aside className="property-colors-notice" role="alert">{error} <button disabled={loading} onClick={() => void reload().catch(() => {})}>Retry colors</button></aside>}
  </Context.Provider>;
}
export function usePropertyColors() { return useContext(Context); }
export function PropertyColorValue({ kind, field, value, children, fallback }: { kind: Kind; field: string; value: unknown; children: ReactNode; fallback?: ReactNode }) {
  const { settings } = usePropertyColors(), hex = propertyColorHex(settings, kind, field, value);
  return hex ? <span className="property-color-value" style={{ backgroundColor: hex + "28", borderColor: hex }}>{children}</span> : <>{fallback ?? children}</>;
}
