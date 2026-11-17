import { useEffect, useState } from "react";
import type { t as translate } from "../i18n";
import { onUpdateStatus, updateStatus, type UpdateStatus } from "./platform";

const INITIAL: UpdateStatus = {
  state: "idle",
  currentVersion: "",
  version: null,
  notes: null,
  progress: null,
  error: null,
};

/** The updater's state, kept up to date by `update://state` events. */
export function useUpdateStatus(): UpdateStatus {
  const [status, setStatus] = useState<UpdateStatus>(INITIAL);
  useEffect(() => {
    void updateStatus().then(setStatus);
    const unlisten = onUpdateStatus(setStatus);
    return () => void unlisten.then((u) => u());
  }, []);
  return status;
}

/** A one-line description of the update state, in the UI language. */
export function updateLabel(t: typeof translate, s: UpdateStatus): string {
  switch (s.state) {
    case "checking":
      return t("update.checking");
    case "upToDate":
      return t("update.upToDate");
    case "available":
      return t("update.available", { version: s.version ?? "" });
    case "downloading":
      return t("update.downloading", { percent: Math.round((s.progress ?? 0) * 100) });
    case "installing":
      return t("update.installing");
    case "error":
      return t("update.error", { error: s.error ?? "" });
    default:
      return t("settings.version", { version: s.currentVersion });
  }
}
