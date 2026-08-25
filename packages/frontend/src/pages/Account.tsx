import { Breadcrumbs } from "@/components/shared/Breadcrumbs";
import { TwoFactorCard } from "@/components/shared/TwoFactorCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTranslation } from "@/i18n";
import { useAuthStore } from "@/stores/auth.store";

/**
 * The signed-in user's own account. Distinct from Settings, which configures
 * the business and the instance — a second factor belongs to a person, not to
 * the company.
 */
export default function Account() {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);

  if (!user) return null;

  const rows: Array<{ label: string; value: string }> = [
    { label: t("account.username"), value: user.username },
    { label: t("account.display_name"), value: user.display_name || "—" },
    { label: t("account.email"), value: user.email || "—" },
    { label: t("account.role"), value: user.role || (user.is_admin ? "Admin" : "User") },
  ];

  return (
    <div className="space-y-4">
      <Breadcrumbs
        items={[{ label: t("nav.dashboard"), href: "/" }, { label: t("account.title") }]}
      />
      <h1 className="text-2xl font-bold">{t("account.title")}</h1>

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>{t("account.profile")}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="divide-y">
            {rows.map((row) => (
              <div key={row.label} className="flex justify-between gap-4 py-2 text-sm">
                <dt className="text-muted-foreground">{row.label}</dt>
                <dd className="text-right">{row.value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      <div className="max-w-3xl">
        <TwoFactorCard />
      </div>
    </div>
  );
}
