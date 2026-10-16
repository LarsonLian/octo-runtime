import { createRoot } from "react-dom/client";
import { useEffect } from "react";
import { App } from "./App";
import { initI18n, useT } from "./lib/i18n";
import { configureUiKit } from "./components/config";
import "./styles/webui.scss";
initI18n();
const overlays: Array<{ layer: number; dismiss: () => void }> = [];
configureUiKit({
  useTranslate: useT,
  useOverlayDismiss: ({ active, layer, onDismiss }) => {
    useEffect(() => {
      if (!active) return;
      const item = { layer, dismiss: () => onDismiss("escape") };
      overlays.push(item);
      const listener = (event: KeyboardEvent) => {
        if (event.key === "Escape" && [...overlays].sort((a, b) => b.layer - a.layer)[0] === item) {
          event.preventDefault();
          event.stopPropagation();
          item.dismiss();
        }
      };
      window.addEventListener("keydown", listener);
      return () => {
        overlays.splice(overlays.indexOf(item), 1);
        window.removeEventListener("keydown", listener);
      };
    }, [active, layer, onDismiss]);
  }
});
createRoot(document.getElementById("root")!).render(<App />);
