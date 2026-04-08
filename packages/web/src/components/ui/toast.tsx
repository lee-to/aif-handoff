import * as React from "react";
import { useState, useEffect, useCallback, createContext, useContext } from "react";
import { X, CheckCircle, AlertTriangle, Info, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

type ToastVariant = "success" | "error" | "warning" | "info";

interface ToastItem {
  id: string;
  message: string;
  variant: ToastVariant;
  duration?: number;
}

const VARIANT_STYLES: Record<ToastVariant, string> = {
  success: "border-success/40 bg-success/10 text-success-foreground",
  error: "border-destructive/40 bg-destructive/10 text-destructive",
  warning: "border-warning/40 bg-warning/10 text-warning-foreground",
  info: "border-info/40 bg-info/10 text-info-foreground",
};

const VARIANT_ICONS: Record<ToastVariant, React.ElementType> = {
  success: CheckCircle,
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
};

interface ToastContextValue {
  toast: (message: string, variant?: ToastVariant, duration?: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}

let idCounter = 0;

function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const toast = useCallback((message: string, variant: ToastVariant = "info", duration = 4000) => {
    const id = `toast-${++idCounter}`;
    setToasts((prev) => [...prev, { id, message, variant, duration }]);
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div
        className="fixed bottom-4 right-4 flex flex-col gap-2"
        style={{ zIndex: "var(--z-toast)" }}
        aria-live="polite"
        role="status"
      >
        {toasts.map((t) => (
          <ToastMessage key={t.id} item={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastMessage({ item, onDismiss }: { item: ToastItem; onDismiss: (id: string) => void }) {
  useEffect(() => {
    if (!item.duration) return;
    const timer = setTimeout(() => onDismiss(item.id), item.duration);
    return () => clearTimeout(timer);
  }, [item.id, item.duration, onDismiss]);

  const Icon = VARIANT_ICONS[item.variant];

  return (
    <div
      className={cn(
        "flex items-center gap-2 border px-3 py-2 text-xs shadow-lg",
        VARIANT_STYLES[item.variant],
      )}
      role="alert"
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1">{item.message}</span>
      <button
        type="button"
        onClick={() => onDismiss(item.id)}
        className="shrink-0 text-muted-foreground hover:text-foreground"
        aria-label="Dismiss"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

export { ToastProvider, useToast, ToastMessage };
export type { ToastVariant, ToastItem };
