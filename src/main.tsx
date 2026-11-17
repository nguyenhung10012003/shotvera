import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { currentRoute } from "./lib/platform";
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Root />
    </Suspense>
  </StrictMode>,
);
