// Plugin-framework UI strings (the admin Plugins management tab). Merged into
// the OSS dictionaries at import time via the registerTranslations hook.

import { registerTranslations } from "@/i18n";

registerTranslations("en", {
  plugins: {
    tab: "Plugins",
    title: "Plugins",
    description: "Enable or disable optional extensions for your workspace.",
    empty: "No plugins available.",
    enable: "Enable",
    disable: "Disable",
    enabled_toast: "Plugin enabled",
    disabled_toast: "Plugin disabled",
  },
});

registerTranslations("tr", {
  plugins: {
    tab: "Eklentiler",
    title: "Eklentiler",
    description: "Çalışma alanınız için isteğe bağlı eklentileri açın veya kapatın.",
    empty: "Kullanılabilir eklenti yok.",
    enable: "Etkinleştir",
    disable: "Devre dışı bırak",
    enabled_toast: "Eklenti etkinleştirildi",
    disabled_toast: "Eklenti devre dışı bırakıldı",
  },
});

registerTranslations("de", {
  plugins: {
    tab: "Plugins",
    title: "Plugins",
    description: "Optionale Erweiterungen für Ihren Arbeitsbereich aktivieren oder deaktivieren.",
    empty: "Keine Plugins verfügbar.",
    enable: "Aktivieren",
    disable: "Deaktivieren",
    enabled_toast: "Plugin aktiviert",
    disabled_toast: "Plugin deaktiviert",
  },
});

registerTranslations("es", {
  plugins: {
    tab: "Plugins",
    title: "Plugins",
    description: "Active o desactive extensiones opcionales para su espacio de trabajo.",
    empty: "No hay plugins disponibles.",
    enable: "Activar",
    disable: "Desactivar",
    enabled_toast: "Plugin activado",
    disabled_toast: "Plugin desactivado",
  },
});

registerTranslations("fr", {
  plugins: {
    tab: "Plugins",
    title: "Plugins",
    description: "Activez ou désactivez les extensions optionnelles de votre espace de travail.",
    empty: "Aucun plugin disponible.",
    enable: "Activer",
    disable: "Désactiver",
    enabled_toast: "Plugin activé",
    disabled_toast: "Plugin désactivé",
  },
});
