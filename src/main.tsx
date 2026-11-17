import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_LOCALE, isLocale, setLocale } from "./i18n";
import { currentRoute, loadSettings, onLanguageChange } from "./lib/platform";
import "./styles.css";

const OverlayApp = lazy(() => import("./overlay/OverlayApp").then((m) => ({ default: m.OverlayApp })));
const PinApp = lazy(() => import("./pin/PinApp").then((m) => ({ default: m.PinApp })));
const SettingsApp = lazy(() => import("./settings/SettingsApp").then((m) => ({ default: m.SettingsApp })));
const HomeApp = lazy(() => import("./home/HomeApp").then((m) => ({ default: m.HomeApp })));

function Root() {
  const { view, params } = currentRoute();
  document.documentElement.dataset.view = view;
  switch (view) {
    case "overlay":
      return <OverlayApp monitor={Number(params.get("monitor") ?? 0)} />;
    case "pin":
      return <PinApp id={params.get("id") ?? ""} />;
    case "settings":
      return <SettingsApp />;
    default:
      return <HomeApp />;
  }
}

window.addEventListener("hashchange", () => window.location.reload());

/** Applies the saved UI language before the first render and follows later changes. */
async function initLanguage(): Promise<void> {
  const language = await loadSettings()
    .then((s) => s.language)
    .catch(() => DEFAULT_LOCALE);
  setLocale(isLocale(language) ? language : DEFAULT_LOCALE);
  void onLanguageChange((l) => {
    if (isLocale(l)) setLocale(l);
  });
}

void initLanguage().finally(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Suspense fallback={null}>
        <Root />
      </Suspense>
    </StrictMode>,
  );
});
