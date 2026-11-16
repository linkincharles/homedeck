import { pauseCameras } from "./cameraPause";
import { createRoot, type Root } from "react-dom/client";
import { App } from "./App";
import { installFonts } from "./fonts";
import { styles } from "./styles";
import { scaleFonts } from "./cssScale";
import { theme } from "./theme";
import { themeEditing } from "./theme-editing";
import { themeExtras } from "./theme-extras";
import { themePlan } from "./theme-plan";
import { themeLayouts } from "./theme-layouts";
import { themeKids } from "./theme-kids";
import { themePhoto } from "./theme-photo";
import type { HomeAssistant, HomeDeckPanelInfo } from "./types/home-assistant";
import { hideSidebar, hideSidebarPreferred, restoreSidebar } from "./sidebar";
import { hidePageScrollbars } from "./scrollbars";

class HomeDeckPanel extends HTMLElement {
  private _hass?: HomeAssistant;
  private _panel?: HomeDeckPanelInfo;
  private readonly root: Root;
  private showScrollbars?: () => void;

  constructor() {
    super();
    installFonts();
    const shadow = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = scaleFonts(`@layer legacy{${styles}}${theme}${themeEditing}${themeExtras}${themePlan}${themeLayouts}${themeKids}${themePhoto}`);
    const mount = document.createElement("div");
    shadow.append(style, mount);
    this.root = createRoot(mount);
  }

  set hass(value: HomeAssistant) {
    const first = !this._hass;
    this._hass = value;
    this.renderPanel();
    if (first) this.applySidebar();
  }

  set panel(value: HomeDeckPanelInfo) {
    this._panel = value;
    this.renderPanel();
  }

  connectedCallback() {
    pauseCameras("panel-closed", false);
    this.renderPanel();
    window.addEventListener("homedeck-sidebar-pref", this.applySidebar);
    this.applySidebar();
    this.showScrollbars?.();
    this.showScrollbars = hidePageScrollbars(this);
  }

  disconnectedCallback() {
    pauseCameras("panel-closed", true);
    window.removeEventListener("homedeck-sidebar-pref", this.applySidebar);
    this.showScrollbars?.();
    this.showScrollbars = undefined;
    // Leaving HomeDeck brings Home Assistant's sidebar back as it was.
    restoreSidebar(document.querySelector("home-assistant") ?? document.body);
  }

  /** Hides Home Assistant's sidebar while HomeDeck is open on a device that asked for it. */
  private readonly applySidebar = () => {
    if (!this.isConnected) return;
    if (hideSidebarPreferred()) hideSidebar(this, this._hass?.dockedSidebar);
    else restoreSidebar(this);
  };

  private renderPanel() {
    if (!this._hass) return;
    this.root.render(<App hass={this._hass} key={this._panel?.config?.version ?? "homedeck"} version={this._panel?.config?.version} />);
  }
}

if (!customElements.get("homedeck-panel")) {
  customElements.define("homedeck-panel", HomeDeckPanel);
  watchForUpdates();
}

/**
 * Wall tablets and Echo Shows keep HomeDeck open for days. When Home Assistant restarts with a new HomeDeck
 * (or a new build of it), a page that stays open keeps the old code and can hang on Home Assistant's
 * spinner. So when the connection comes back after a drop, HomeDeck checks which panel file Home Assistant
 * now serves and, if it changed, reloads the page once to pick it up.
 */
function watchForUpdates() {
  type Connection = { addEventListener: (event: string, listener: () => void) => void; sendMessagePromise: <T>(message: Record<string, unknown>) => Promise<T> };
  type Panels = Record<string, { config?: { _panel_custom?: { module_url?: string } } | null }>;
  const connection = (window as unknown as { hassConnection?: Promise<{ conn: Connection }> }).hassConnection;
  if (!connection) return;
  const moduleOf = (panels: Panels) => panels?.homedeck?.config?._panel_custom?.module_url;
  void connection.then(({ conn }) => {
    let loaded: string | undefined;
    void conn.sendMessagePromise<Panels>({ type: "get_panels" }).then((panels) => { loaded = moduleOf(panels); }).catch(() => undefined);
    let dropped = false;
    conn.addEventListener("disconnected", () => { dropped = true; });
    conn.addEventListener("ready", () => {
      if (!dropped) return;
      dropped = false;
      // Home Assistant may still be registering its panels right after it comes back: ask a few times.
      let tries = 0;
      const check = () => {
        tries += 1;
        void conn.sendMessagePromise<Panels>({ type: "get_panels" }).then((panels) => {
          const now = moduleOf(panels);
          if (!now) { if (tries < 10) window.setTimeout(check, 3000); else reloadOnce("missing"); return; }
          if (loaded && now !== loaded) reloadOnce(now);
          loaded = now;
        }).catch(() => { if (tries < 10) window.setTimeout(check, 3000); });
      };
      window.setTimeout(check, 1500);
    });
  }).catch(() => undefined);
}

/** Reloads the page for this update, once: a second reload for the same one within a minute is skipped. */
function reloadOnce(target: string) {
  // Only the HomeDeck page reloads: someone on another Home Assistant page is left alone.
  if (!window.location.pathname.startsWith("/homedeck")) return;
  const key = "homedeck-reloaded-for";
  try {
    const last = JSON.parse(window.sessionStorage.getItem(key) ?? "null") as { target: string; at: number } | null;
    if (last && last.target === target && Date.now() - last.at < 60_000) return;
    window.sessionStorage.setItem(key, JSON.stringify({ target, at: Date.now() }));
  } catch { /* reload anyway */ }
  window.location.reload();
}
