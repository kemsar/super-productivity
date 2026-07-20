import { BrowserWindow, BrowserWindowConstructorOptions, screen } from 'electron';
import { join } from 'node:path';
import { info } from 'electron-log/main';
import { IS_MAC } from './common.const';
import { assertSecureWebPreferences } from './web-preferences-guard';

/**
 * Global-hotkey quick-add overlay (issue #25). Opens a small borderless
 * always-on-top BrowserWindow over whatever app currently has focus, so the
 * user can capture a thought into SP without context-switching.
 *
 * Design: the overlay loads a self-contained HTML file (not the Angular
 * app) and talks to SP via the local REST API on `127.0.0.1:3876`. This
 * matches the task-widget pattern and dodges two problems that come with
 * loading the full Angular app in a second BrowserWindow:
 *   1. Two Angular renderers = two op-log store instances fighting for
 *      the same sp_op_log lock during sync.
 *   2. Cold-boot latency — a full store hydration would make the overlay
 *      appear a second or two after the hotkey fires.
 *
 * Trade-off for MVP: the plain-HTML page can't reuse SP's Angular
 * autocomplete components. Rich autocomplete (branch E) will either
 * ship as a dedicated Angular sub-bundle (like task-widget's own
 * renderer) or migrate the overlay HTML to consume more from REST.
 *
 * Unlike `globalAddTask` (raises the main SP window and opens its
 * add-task bar), this window stays foreign — no dock icon (macOS), no
 * taskbar entry, no focus-steal beyond the input field. Hides on blur,
 * on Esc, or after a successful submit; focus returns to the
 * previously-active app.
 */

let quickAddWin: BrowserWindow | null = null;

const OVERLAY_WIDTH = 620;
const OVERLAY_HEIGHT = 220;

/**
 * Positions the overlay near the top-center of the display containing the
 * cursor. Feels like Alfred/Raycast — same monitor as the user's attention,
 * predictable location, avoids clipping when the main window occupies most
 * of a smaller screen.
 */
const _computeBounds = (): {
  x: number;
  y: number;
  width: number;
  height: number;
} => {
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  const { x: dx, y: dy, width: dw } = display.workArea;
  const horizontalOffset = (dw - OVERLAY_WIDTH) / 2;
  const verticalOffset = dw * 0.05;
  return {
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    x: Math.round(dx + horizontalOffset),
    y: Math.round(dy + verticalOffset),
  };
};

const _createWindow = (): BrowserWindow => {
  const bounds = _computeBounds();

  const webPreferences: BrowserWindowConstructorOptions['webPreferences'] = {
    // No preload for now — the overlay only talks to the main-window app via
    // its local REST API (localhost:3876). If future phases need IPC (e.g.
    // for direct store dispatch), add a dedicated preload here.
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    disableDialogs: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
  };
  assertSecureWebPreferences(webPreferences, 'quick-add-overlay');

  const win = new BrowserWindow({
    ...bounds,
    title: 'Super Productivity — Quick Add',
    frame: false,
    // Transparent frameless windows have platform quirks (see task-widget.ts
    // comments) — the overlay is short-lived enough to opt for a solid
    // background and rely on the Angular route to draw its own chrome.
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    closable: true,
    show: false,
    autoHideMenuBar: true,
    roundedCorners: IS_MAC,
    hasShadow: true,
    webPreferences,
  });

  // Visible on all workspaces so the hotkey lands you here from any Space
  // (macOS) or virtual desktop (Win/Linux).
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.on('closed', () => {
    quickAddWin = null;
  });

  // Auto-hide on blur — matches Alfred/Raycast semantics. The window is a
  // capture surface, not a persistent panel; if the user tabs away or clicks
  // out, we assume they abandoned the entry.
  win.on('blur', () => {
    if (quickAddWin && !quickAddWin.isDestroyed()) {
      quickAddWin.hide();
    }
  });

  // Load the self-contained overlay HTML. Sits next to this file at the
  // electron/ root so electron-builder's `electron/**/*` glob picks it up
  // for the packaged app (same shape task-widget.html uses).
  win.loadFile(join(__dirname, 'quick-add.html')).catch((err) => {
    info('[quick-add-window] loadFile failed', err);
  });

  win.once('ready-to-show', () => {
    if (!quickAddWin || quickAddWin.isDestroyed()) return;
    quickAddWin.show();
    quickAddWin.focus();
  });

  return win;
};

/**
 * Show the overlay (creating it if needed). Bound to the `globalQuickAdd`
 * shortcut in ipc-handlers/global-shortcuts.ts.
 */
export const showQuickAddWindow = (): void => {
  if (quickAddWin && !quickAddWin.isDestroyed()) {
    // Cheap open path: window already exists, just re-position (cursor may
    // have moved to a different monitor) and show.
    const bounds = _computeBounds();
    quickAddWin.setBounds(bounds);
    quickAddWin.show();
    quickAddWin.focus();
    return;
  }
  quickAddWin = _createWindow();
};

/**
 * Hide the overlay if it's open. Currently unused externally — the Angular
 * route hides itself via `window.close()` on submit/Esc, which triggers our
 * `closed` handler. Exported for future callers (e.g. app-quit cleanup).
 */
export const hideQuickAddWindow = (): void => {
  if (quickAddWin && !quickAddWin.isDestroyed()) {
    quickAddWin.hide();
  }
};

/**
 * Convenience toggle for the global shortcut: hide if visible, show
 * otherwise. Matches the ergonomics of Alfred (same key opens and closes).
 */
export const toggleQuickAddWindow = (): void => {
  if (quickAddWin && !quickAddWin.isDestroyed() && quickAddWin.isVisible()) {
    quickAddWin.hide();
    return;
  }
  showQuickAddWindow();
};
