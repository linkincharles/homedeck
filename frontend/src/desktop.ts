import type { HomeAssistant } from "./types/home-assistant";

// HomeDeck Desktop (the macOS and Windows tray app) opens this panel at /homedeck?app=1. The app is
// Pro only and checks the license itself: the panel hands it the signed key and the app verifies the
// signature, the installation and the expiry before it shows HomeDeck. Without the app nothing here runs.

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

function invoker(): Invoke | undefined {
  return (window as unknown as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__?.invoke;
}

const SESSION_KEY = "homedeck-desktop";

/** True inside HomeDeck Desktop (remembered for the visit, since Home Assistant may drop the query). */
export function inDesktopApp(): boolean {
  if (!invoker()) return false;
  try {
    if (new URLSearchParams(window.location.search).get("app") === "1") window.sessionStorage.setItem(SESSION_KEY, "1");
    return window.sessionStorage.getItem(SESSION_KEY) === "1";
  } catch {
    return new URLSearchParams(window.location.search).get("app") === "1";
  }
}

/** Sends the signed key (or none, on Free) to the app, which locks itself when it doesn't unlock Pro. */
export async function reportLicenseToDesktop(hass: HomeAssistant): Promise<void> {
  const invoke = invoker();
  if (!invoke || !inDesktopApp()) return;
  try {
    const { key, installation_id } = await hass.connection.sendMessagePromise<{ key: string | null; installation_id: string }>({ type: "homedeck/license/key" });
    await invoke("report_license", { key: key ?? "", installation: installation_id });
  } catch (err) {
    // An integration older than the app has no homedeck/license/key: the app shows "update HomeDeck".
    const code = (err as { code?: string })?.code;
    await invoke("report_license", { key: "", installation: "", error: code === "unknown_command" ? "outdated" : "failed" }).catch(() => undefined);
  }
}

/** /homedeck?pro=1 opens the Pro sheet: the app's "Get Pro" button sends people here in their browser. */
export function wantsProSheet(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("pro") === "1";
  } catch {
    return false;
  }
}
