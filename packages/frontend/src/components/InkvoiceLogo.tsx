import { cn } from "@/lib/utils";

interface LogoProps {
  className?: string;
}

const ACCENT = "#f3522e";

/** Icon-only mark (the five-bar "ink level" mark) */
export function InkvoiceIcon({ className }: LogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 100 100"
      className={cn("shrink-0", className)}
      aria-hidden="true"
    >
      <rect x="9" y="33" width="10" height="34" rx="5" fill="var(--foreground)" />
      <rect x="27" y="21" width="10" height="58" rx="5" fill="var(--foreground)" />
      <rect x="45" y="8" width="10" height="84" rx="5" fill={ACCENT} />
      <rect x="63" y="26" width="10" height="48" rx="5" fill="var(--foreground)" />
      <rect x="81" y="37" width="10" height="26" rx="5" fill="var(--foreground)" />
    </svg>
  );
}

/** Full logo with mark + "inkvoice" wordmark */
export function InkvoiceLogo({ className }: LogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 254 80"
      className={cn("shrink-0", className)}
      aria-label="Inkvoice"
    >
      <g transform="translate(15 15) scale(0.5)">
        <rect x="9" y="33" width="10" height="34" rx="5" fill="var(--foreground)" />
        <rect x="27" y="21" width="10" height="58" rx="5" fill="var(--foreground)" />
        <rect x="45" y="8" width="10" height="84" rx="5" fill={ACCENT} />
        <rect x="63" y="26" width="10" height="48" rx="5" fill="var(--foreground)" />
        <rect x="81" y="37" width="10" height="26" rx="5" fill="var(--foreground)" />
      </g>
      <text
        x="78"
        y="55.12"
        fontFamily="'Geist Variable', system-ui, -apple-system, sans-serif"
        fontSize="43"
        fontWeight="700"
        letterSpacing="-1.8"
        fill="var(--foreground)"
      >
        <tspan>ink</tspan>
        <tspan fill="var(--muted-foreground)">voice</tspan>
      </text>
    </svg>
  );
}
