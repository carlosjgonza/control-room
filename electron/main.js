// Desktop shell: starts the same server the browser version uses, opens one
// window on it, and remembers where you left that window.
import { app, BrowserWindow, shell } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BOUNDS = { width: 760, height: 760 };

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let server = null;

const boundsFile = () => join(app.getPath("userData"), "window.json");

async function loadBounds() {
  try {
    return { ...DEFAULT_BOUNDS, ...JSON.parse(await readFile(boundsFile(), "utf8")) };
  } catch {
    return DEFAULT_BOUNDS;
  }
}

let saveTimer = null;
function saveBoundsSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (!win || win.isDestroyed()) return;
    await mkdir(dirname(boundsFile()), { recursive: true });
    await writeFile(boundsFile(), JSON.stringify(win.getBounds()));
  }, 400);
}

async function createWindow() {
  win = new BrowserWindow({
    ...(await loadBounds()),
    minWidth: 420,
    minHeight: 480,
    title: "Control room",
    backgroundColor: "#06090d",
    titleBarStyle: "hiddenInset",
    icon: join(here, "..", "build", "icon.png"),
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  // Rows open on GitHub in the default browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.on("resize", saveBoundsSoon);
  win.on("move", saveBoundsSoon);
  win.on("closed", () => (win = null));
  await win.loadURL(server.url);
}

app.whenReady().then(async () => {
  // Same folder the server picks on its own; passed explicitly so the config
  // always sits next to window.json, whatever Electron names the app.
  server = await startServer({ dir: app.getPath("userData") });
  await createWindow();
  // Dock click with no window open (macOS keeps the app running after close).
  app.on("activate", () => {
    if (!win) createWindow();
  });
});

app.on("second-instance", () => (win ? win.focus() : createWindow()));
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("will-quit", () => server?.close());
