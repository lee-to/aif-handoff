import * as React from "react";
import { useState, useRef, useCallback, useEffect } from "react";
import { ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { useOutsideClick } from "@/hooks/useOutsideClick";

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

const Select = React.forwardRef<HTMLDivElement, SelectProps>(
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
    const searchInputRef = useRef<HTMLInputElement>(null);

    const close = useCallback(() => {
      setOpen(false);
      setSearchValue("");
    }, []);
    useOutsideClick(containerRef, close, open);

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
      <div ref={containerRef} className={cn("relative", className)}>
        <button
          ref={ref as React.Ref<HTMLButtonElement>}
          type="button"
          disabled={disabled}
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

        {open && (
          <div className="absolute z-50 mt-1 w-full border border-border bg-popover py-1">
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
          </div>
        )}
      </div>
    );
  },
);
Select.displayName = "Select";

export { Select };
export type { SelectProps };
