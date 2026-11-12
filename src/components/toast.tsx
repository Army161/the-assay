"use client";
import { createContext, useCallback, useContext, useState } from "react";
import { EXPLORER } from "@/lib/chain";
import { TxUnknown } from "@/lib/send";

/** `sticky` stays up until dismissed, for what the user has to act on. */
interface Toast { id: number; kind: "ok" | "err" | "info"; title: string; body?: string; href?: string; sticky?: boolean }
const Ctx = createContext<{ push: (t: Omit<Toast, "id">) => void }>({ push: () => {} });
export const useToast = () => useContext(Ctx);

/**
 * The toast for a send that threw. TxUnknown was sent and may still land, so it is not called a failure: it links the
 * transaction and stays up until dismissed, so the user can check it before trying again and paying twice.
 */
export function sendErrorToast(e: unknown, failedTitle: string, max = 240): Omit<Toast, "id"> {
  if (e instanceof TxUnknown) return { kind: "info", title: "Not confirmed yet", body: "It was sent and may still go through. Check it on Solscan before trying again.", href: EXPLORER(e.signature), sticky: true };
  const msg = (e as Error)?.message || String(e);
  return { kind: "err", title: failedTitle, body: /User rejected/i.test(msg) ? "You cancelled in the wallet." : msg.slice(0, max) };
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setList((l) => l.filter((x) => x.id !== id)), []);
  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setList((l) => [...l, { ...t, id }]);
    if (!t.sticky) setTimeout(() => dismiss(id), t.kind === "err" ? 9000 : 6000);
  }, [dismiss]);
  return (
    <Ctx.Provider value={{ push }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-[min(380px,calc(100vw-2rem))]" role="status" aria-live="polite">
        {list.map((t) => (
          <div key={t.id} className={`card p-3 text-sm border-l-2 relative ${t.sticky ? "pr-8" : ""} ${t.kind === "ok" ? "border-l-up" : t.kind === "err" ? "border-l-down" : "border-l-amber"}`}>
            {t.sticky && <button className="absolute top-2 right-2 px-1 text-text-2 hover:text-text" aria-label="Dismiss" onClick={() => dismiss(t.id)}>×</button>}
            <div className="font-semibold">{t.title}</div>
            {t.body && <div className="text-text-2 mt-0.5 break-words">{t.body}</div>}
            {t.href && <a className="text-amber-2 text-xs mt-1 inline-block hover:underline" href={t.href} target="_blank" rel="noreferrer">View on Solscan ↗</a>}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
