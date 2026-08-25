import { CreditCard, Loader2, Lock, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";
import { cn, formatCurrency } from "@/lib/utils";

async function readPreviewErrorMessage(
  res: Response,
  notFoundLabel: string,
  fallback: string,
): Promise<string> {
  if (res.status === 404) return notFoundLabel;
  try {
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const j = (await res.json()) as { error?: string };
      if (typeof j?.error === "string" && j.error.length > 0) return j.error;
    }
  } catch {
    /* ignore */
  }
  return fallback;
}

export default function PublicInvoice() {
  const { t } = useTranslation();
  const { shareToken } = useParams();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [html, setHtml] = useState("");
  const [invoiceData, setInvoiceData] = useState<any>(null);
  const [paymentMethods, setPaymentMethods] = useState<Array<{ id: string; label: string }>>([]);
  const [paying, setPaying] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const previewRes = await fetch(`/api/v1/public/invoices/${shareToken}/preview`);
        if (!previewRes.ok) {
          const msg = await readPreviewErrorMessage(
            previewRes,
            t("public.invoice_not_found"),
            t("public.document_unavailable"),
          );
          if (!cancelled) {
            setError(msg);
            setLoading(false);
          }
          return;
        }
        const previewText = await previewRes.text();
        const jsonRes = await fetch(`/api/v1/public/invoices/${shareToken}`);
        const jsonData = await jsonRes.json().catch(() => null);
        if (!cancelled) {
          setHtml(previewText);
          if (jsonData?.data) {
            setInvoiceData(jsonData.data.invoice);
            // Prefer the multi-gateway list; fall back to the legacy flag.
            const methods: Array<{ id: string; label: string }> = jsonData.data.payment_methods
              ?.length
              ? jsonData.data.payment_methods
              : jsonData.data.stripe_enabled
                ? [{ id: "stripe", label: "Stripe" }]
                : [];
            setPaymentMethods(methods);
          }
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setError(t("public.document_unavailable"));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shareToken, t]);

  if (error) {
    return (
      <div className="text-center py-20">
        <h2 className="text-xl text-muted-foreground">{error}</h2>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex justify-center py-20" role="status">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
        <span className="sr-only">{t("common.loading")}</span>
      </div>
    );
  }

  const balanceDue = invoiceData ? invoiceData.total - (invoiceData.amount_paid || 0) : 0;

  const handlePay = async (gateway: string) => {
    setPaying(gateway);
    try {
      const res = await fetch(`/api/v1/public/invoices/${shareToken}/pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gateway }),
      });
      const data = await res.json();
      if (data.success && data.data?.url) {
        window.location.href = data.data.url;
      } else {
        toast.error(typeof data.error === "string" ? data.error : t("public.payment_failed"));
      }
    } catch {
      toast.error(t("public.payment_failed"));
    } finally {
      setPaying(null);
    }
  };

  return (
    <div>
      <iframe
        sandbox="allow-same-origin"
        srcDoc={html}
        className="w-full border-0"
        style={{ minHeight: "900px" }}
        title={t("public.invoice")}
      />
      {paymentMethods.length > 0 && balanceDue > 0 && invoiceData?.status !== "paid" && (
        <div className="py-8 print:hidden">
          <div className="mx-auto max-w-sm rounded-xl border bg-card p-6 shadow-sm">
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-sm text-muted-foreground">{t("public.amount_due")}</span>
              <span className="text-2xl font-semibold tabular-nums">
                {formatCurrency(balanceDue, invoiceData.currency)}
              </span>
            </div>
            <div className="mt-5 grid gap-2">
              {paymentMethods.map((m, i) => {
                const Icon = m.id === "paypal" ? Wallet : CreditCard;
                return (
                  <Button
                    key={m.id}
                    size="lg"
                    // The first gateway carries the primary call to action, the
                    // rest read as alternatives instead of competing with it.
                    variant={i === 0 ? "default" : "outline"}
                    onClick={() => handlePay(m.id)}
                    disabled={paying !== null}
                    className={cn(
                      "h-11 w-full cursor-pointer gap-2 text-sm",
                      i === 0 && "hover:bg-primary/90",
                    )}
                  >
                    {paying === m.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Icon className="size-4" />
                    )}
                    {paying === m.id
                      ? t("public.redirecting")
                      : t("public.pay_with", { method: m.label })}
                  </Button>
                );
              })}
            </div>
            <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
              <Lock className="size-3" />
              {t("public.secure_payment")}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
