import * as React from "react"
import { useEffect, useRef, useState } from "react"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

interface NumberInputProps
  extends Omit<React.ComponentProps<"input">, "type" | "value" | "onChange" | "min" | "max" | "step"> {
  value: number | string | undefined | null
  onValueChange: (value: number) => void
  min?: number
  max?: number
  decimals?: number
  allowNegative?: boolean
  integer?: boolean
}

/**
 * Keeps what someone can legitimately be part-way through typing: digits, a
 * leading minus, and both decimal separators. Grouping separators are allowed
 * through as well so a pasted "1.234,56" survives to be parsed properly.
 */
function sanitize(input: string, opts: { allowNegative: boolean; integer: boolean }): string {
  let result = ""
  let hasNegative = false

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === "-" && opts.allowNegative && i === 0 && !hasNegative) {
      hasNegative = true
      result += ch
    } else if ((ch === "." || ch === ",") && !opts.integer) {
      result += ch
    } else if (ch >= "0" && ch <= "9") {
      result += ch
    }
  }
  return result
}

/**
 * Parses a typed amount, accepting either decimal separator. A German keyboard
 * produces "71,48"; the comma used to be dropped outright, turning that into
 * 7148 — a hundredfold error with nothing on screen to suggest it.
 *
 * The last separator is the decimal one and anything before it is grouping, so
 * "1.234,56" and "1,234.56" both come out as 1234.56.
 *
 * One input is genuinely ambiguous: a single separator followed by exactly
 * three digits, where "1.234" means 1234 to a German reader and 1.234 to an
 * English one. It is read as grouping when the field allows fewer than three
 * decimals, since three decimal places cannot be what was meant there.
 */
export function parseDecimalInput(input: string, decimals?: number): number {
  const trimmed = input.trim()
  if (!trimmed) return Number.NaN

  const negative = trimmed.startsWith("-")
  const body = trimmed.replace(/[^\d.,]/g, "")

  const lastSeparator = Math.max(body.lastIndexOf("."), body.lastIndexOf(","))

  let intPart = lastSeparator === -1 ? body : body.slice(0, lastSeparator)
  let fracPart = lastSeparator === -1 ? "" : body.slice(lastSeparator + 1)

  if (lastSeparator !== -1) {
    const separatorCount = (body.match(/[.,]/g) ?? []).length
    const looksLikeGrouping =
      separatorCount === 1 && fracPart.length === 3 && decimals !== undefined && decimals < 3
    if (looksLikeGrouping) {
      intPart += fracPart
      fracPart = ""
    }
  }

  intPart = intPart.replace(/[.,]/g, "")
  if (!intPart && !fracPart) return Number.NaN

  const value = Number.parseFloat(`${intPart || "0"}${fracPart ? `.${fracPart}` : ""}`)
  if (Number.isNaN(value)) return Number.NaN
  return negative ? -value : value
}

function formatForDisplay(value: number | string | undefined | null, decimals?: number): string {
  if (value === undefined || value === null || value === "") return ""
  const num = typeof value === "string" ? parseFloat(value) : value
  if (Number.isNaN(num)) return ""
  if (decimals !== undefined) return num.toFixed(decimals)
  return String(num)
}

function NumberInput({
  value,
  onValueChange,
  min = 0,
  max,
  decimals,
  allowNegative = false,
  integer = false,
  className,
  onFocus: onFocusProp,
  onBlur: onBlurProp,
  ...props
}: NumberInputProps) {
  const isFocused = useRef(false)
  const [displayValue, setDisplayValue] = useState(() => formatForDisplay(value, decimals))

  useEffect(() => {
    if (!isFocused.current) {
      setDisplayValue(formatForDisplay(value, decimals))
    }
  }, [value, decimals])

  const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    isFocused.current = true
    requestAnimationFrame(() => e.target.select())
    onFocusProp?.(e)
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = sanitize(e.target.value, { allowNegative, integer })
    setDisplayValue(raw)
  }

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    isFocused.current = false
    const parsed = parseDecimalInput(displayValue, integer ? 0 : decimals)
    let final = Number.isNaN(parsed) ? min : parsed
    if (min !== undefined && final < min) final = min
    if (max !== undefined && final > max) final = max
    if (decimals !== undefined) final = parseFloat(final.toFixed(decimals))
    setDisplayValue(formatForDisplay(final, decimals))
    onValueChange(final)
    onBlurProp?.(e)
  }

  return (
    <Input
      {...props}
      type="text"
      inputMode={integer ? "numeric" : "decimal"}
      className={cn("tabular-nums", className)}
      value={displayValue}
      onFocus={handleFocus}
      onChange={handleChange}
      onBlur={handleBlur}
    />
  )
}

export { NumberInput }
