'use client';

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { LuCircleAlert, LuCircleCheck } from 'react-icons/lu';

type Toast = { id: number; tone: 'ok' | 'error'; text: string };
const Ctx = createContext<(tone: Toast['tone'], text: string) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast['tone'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 3500);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} role="status" className="gw-pop pointer-events-auto flex items-start gap-2 rounded-lg border border-neutral-100 bg-white px-4 py-3 text-sm text-neutral-800 shadow-s4">
            {t.tone === 'ok' ? <LuCircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-gw-green-700" /> : <LuCircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-gw-red-700" />}
            <span className="break-words">{t.text}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
