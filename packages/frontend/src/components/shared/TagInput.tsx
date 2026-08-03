import { X } from "lucide-react";
import { useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useTranslation } from "@/i18n";
import { cn } from "@/lib/utils";

interface TagInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  /** Existing tags to suggest (autocomplete) while typing. */
  suggestions?: string[];
  placeholder?: string;
  disabled?: boolean;
  max?: number;
  className?: string;
  ariaLabel?: string;
}

/**
 * Chip-based tag input: Enter or comma commits the typed tag, Backspace with
 * an empty input removes the last chip, and a small dropdown offers existing
 * tags as suggestions. Used in forms (full editor) and list filter bars.
 */
export function TagInput({
  value,
  onChange,
  suggestions = [],
  placeholder,
  disabled,
  max = 30,
  className,
  ariaLabel,
}: TagInputProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const add = (raw: string) => {
    const name = raw.trim().replace(/\s+/g, " ");
    if (!name) return;
    const lower = name.toLowerCase();
    if (value.some((v) => v.toLowerCase() === lower)) return;
    if (value.length >= max) return;
    onChange([...value, name]);
  };

  const commit = () => {
    add(draft);
    setDraft("");
  };

  const match = draft.trim().toLowerCase();
  const seen = new Set(value.map((v) => v.toLowerCase()));
  const filtered = match
    ? suggestions.filter((s) => s.toLowerCase().includes(match) && !seen.has(s.toLowerCase()))
    : [];

  return (
    <div className={cn("w-full", className)}>
      <div
        className={cn(
          "flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent px-2 py-1.5 transition-colors",
          focused && "ring-2 ring-ring ring-offset-1",
          disabled && "opacity-50 cursor-not-allowed",
        )}
      >
        {value.map((tag) => (
          <Badge key={tag.toLowerCase()} variant="secondary" className="gap-1 pr-1">
            {tag}
            {!disabled && (
              <button
                type="button"
                aria-label={t("tags.remove", { tag })}
                className="rounded-full hover:text-foreground text-muted-foreground focus:outline-none"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(value.filter((v) => v.toLowerCase() !== tag.toLowerCase()));
                  inputRef.current?.focus();
                }}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </Badge>
        ))}
        <Input
          ref={inputRef}
          value={draft}
          disabled={disabled}
          aria-label={ariaLabel}
          placeholder={value.length === 0 ? placeholder : ""}
          className="h-7 min-w-[8rem] flex-1 border-0 bg-transparent p-0 shadow-none focus-visible:ring-0"
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            // Commit the trailing draft when focus leaves the editor.
            if (draft.trim()) commit();
            setDraft("");
          }}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              commit();
            } else if (e.key === "Backspace" && !draft && value.length > 0) {
              onChange(value.slice(0, -1));
            }
          }}
        />
      </div>
      {focused && match && filtered.length > 0 && (
        <div className="relative">
          <div className="absolute left-0 right-0 top-1 z-20 rounded-md border bg-popover text-popover-foreground shadow-md">
            {filtered.slice(0, 8).map((s) => (
              <button
                key={s.toLowerCase()}
                type="button"
                className="block w-full px-3 py-1.5 text-left text-sm hover:bg-accent"
                onMouseDown={(e) => {
                  e.preventDefault();
                  add(s);
                  setDraft("");
                }}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
