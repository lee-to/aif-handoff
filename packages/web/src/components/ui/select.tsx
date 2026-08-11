import * as React from "react";
import { useState, useRef, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  createOverlayLayerId,
  isTopOverlayLayer,
  pushOverlayLayer,
} from "@/components/ui/overlayStack";

const sizeClasses = {
  default: "h-9 text-sm px-3",
  sm: "h-7 text-xs px-2",
};

interface SelectProps {
  value?: string;
  options: { value: string; label: string }[];
  onChange?: (e: { target: { value: string } }) => void;
  className?: string;
  disabled?: boolean;
  placeholder?: string;
  selectSize?: "default" | "sm";
  searchable?: boolean;
  searchPlaceholder?: string;
  searchAutoFocus?: boolean;
  searchEmptyMessage?: string;
}

const Select = React.forwardRef<HTMLButtonElement, SelectProps>(
  (
    {
      className,
      options,
      value,
      onChange,
      disabled,
      placeholder,
      selectSize = "default",
      searchable = false,
      searchPlaceholder = "Filter options",
      searchAutoFocus = true,
      searchEmptyMessage = "No matching options",
    },
    ref,
  ) => {
    const [open, setOpen] = useState(false);
    const [searchValue, setSearchValue] = useState("");
    const containerRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const overlayLayerId = useRef(createOverlayLayerId("select"));
    const [position, setPosition] = useState({ top: 0, left: 0, width: 0 });

    const close = useCallback(() => {
      setOpen(false);
      setSearchValue("");
    }, []);
    const setTriggerRef = useCallback(
      (node: HTMLButtonElement | null) => {
        triggerRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      },
      [ref],
    );

    const updatePosition = useCallback(() => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    }, []);

    useEffect(() => {
      if (!open) return;
      updatePosition();
      window.addEventListener("resize", updatePosition);
      window.addEventListener("scroll", updatePosition, true);
      return () => {
        window.removeEventListener("resize", updatePosition);
        window.removeEventListener("scroll", updatePosition, true);
      };
    }, [open, updatePosition]);

    useEffect(() => {
      if (!open) return;
      return pushOverlayLayer(overlayLayerId.current);
    }, [open]);

    useEffect(() => {
      if (!open) return;
      const onPointerDown = (event: PointerEvent) => {
        const target = event.target as Node | null;
        if (!target) return;
        if (containerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
        close();
      };
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape" && isTopOverlayLayer(overlayLayerId.current)) close();
      };
      document.addEventListener("pointerdown", onPointerDown);
      document.addEventListener("keydown", onKeyDown);
      return () => {
        document.removeEventListener("pointerdown", onPointerDown);
        document.removeEventListener("keydown", onKeyDown);
      };
    }, [close, open]);

    const selected = options.find((o) => o.value === value);
    const normalizedSearch = searchValue.trim().toLowerCase();
    const filteredOptions =
      searchable && normalizedSearch.length > 0
        ? options.filter((option) =>
            `${option.label} ${option.value}`.toLowerCase().includes(normalizedSearch),
          )
        : options;

    useEffect(() => {
      if (!open || !searchable || !searchAutoFocus) return;
      const frame = requestAnimationFrame(() => searchInputRef.current?.focus());
      return () => cancelAnimationFrame(frame);
    }, [open, searchable, searchAutoFocus]);

    const handleSelect = (optValue: string) => {
      onChange?.({ target: { value: optValue } });
      setOpen(false);
      setSearchValue("");
    };

    return (
      <>
        <div ref={containerRef} className={cn("relative", className)}>
          <button
            ref={setTriggerRef}
            type="button"
            disabled={disabled}
            aria-haspopup="listbox"
            aria-expanded={open}
            onClick={() =>
              !disabled &&
              setOpen((prev) => {
                const next = !prev;
                if (!next) setSearchValue("");
                return next;
              })
            }
            className={cn(
              "flex w-full items-center justify-between border border-input bg-card py-1 transition-colors",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              "disabled:cursor-not-allowed disabled:opacity-50",
              sizeClasses[selectSize],
              open && "ring-1 ring-ring",
            )}
          >
            <span className={cn("truncate text-left", !selected && "text-muted-foreground")}>
              {selected?.label ?? placeholder ?? "Select…"}
            </span>
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                open && "rotate-180",
              )}
            />
          </button>
        </div>

        {open &&
          typeof document !== "undefined" &&
          createPortal(
            <div
              ref={menuRef}
              role="listbox"
              className="border border-border bg-popover py-1"
              style={{
                position: "fixed",
                top: position.top,
                left: position.left,
                width: position.width,
                zIndex: "calc(var(--z-modal) + 1)",
              }}
            >
              {searchable && (
                <div className="px-2 pb-1">
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={searchValue}
                    onChange={(event) => setSearchValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.preventDefault();
                    }}
                    placeholder={searchPlaceholder}
                    className={cn(
                      "h-8 w-full border border-input bg-card px-2 text-sm text-foreground",
                      "placeholder:text-muted-foreground",
                      "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    )}
                  />
                </div>
              )}
              {filteredOptions.length === 0 ? (
                <p className="px-3 py-1.5 text-sm text-muted-foreground">{searchEmptyMessage}</p>
              ) : (
                filteredOptions.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    role="option"
                    aria-selected={opt.value === value}
                    onClick={() => handleSelect(opt.value)}
                    className={cn(
                      "flex w-full items-start gap-2 px-3 py-1.5 text-left text-sm transition-colors",
                      "hover:bg-accent/50",
                      opt.value === value ? "text-primary font-medium" : "text-foreground",
                    )}
                  >
                    <Check
                      className={cn(
                        "h-3 w-3 shrink-0",
                        opt.value === value ? "opacity-100" : "opacity-0",
                      )}
                    />
                    {opt.label}
                  </button>
                ))
              )}
            </div>,
            document.body,
          )}
      </>
    );
  },
);
Select.displayName = "Select";

export { Select };
export type { SelectProps };
