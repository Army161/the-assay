"use client";
import { createContext, useCallback, useContext, useState } from "react";

interface Toast { id: number; kind: "ok" | "err" | "info"; title: string; body?: string; href?: string }
const Ctx = createContext<{ push: (t: Omit<Toast, "id">) => void }>({ push: () => {} });
export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setList((l) => [...l, { ...t, id }]);
    setTimeout(() => setList((l) => l.filter((x) => x.id !== id)), t.kind === "err" ? 9000 : 6000);
  }, []);
  return (
    <Ctx.Provider value={{ push }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-[min(380px,calc(100vw-2rem))]" role="status" aria-live="polite">
        {list.map((t) => (
          <div key={t.id} className={`card p-3 text-sm border-l-2 ${t.kind === "ok" ? "border-l-up" : t.kind === "err" ? "border-l-down" : "border-l-amber"}`}>
            <div className="font-semibold">{t.title}</div>
            {t.body && <div className="text-text-2 mt-0.5 break-words">{t.body}</div>}
            {t.href && <a className="text-amber-2 text-xs mt-1 inline-block hover:underline" href={t.href} target="_blank" rel="noreferrer">View on Solscan ↗</a>}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
