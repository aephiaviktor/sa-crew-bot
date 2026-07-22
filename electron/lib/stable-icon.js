// electron/lib/stable-icon.js
// SLYA-grade Windows taskbar icon handler.
// Owns: AppUserModelId, stable .ico path in %LOCALAPPDATA%\aephia\icons\,
//       setIcon after window creation, focus re-apply, self-healing copy.
//
// Why this exists:
//   The shared `node_modules\electron\dist\electron.exe` carries the
//   default atom icon as its embedded resource. On Windows the live
//   taskbar icon for a running window is set by the BrowserWindow icon
//   option, and Windows can drop that handle on sleep/wake or focus
//   changes — at which point it falls back to the .exe's atom. To stay
//   robust we (1) reference a real multi-resolution .ico at a stable
//   path that nothing in the project touches, (2) re-assert it via
//   setIcon on the live HWND, and (3) re-apply on every focus event.

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const STABLE_ICON_DIR = process.platform === 'win32'
  ? path.join(
      process.env.LOCALAPPDATA
        || path.join(process.env.USERPROFILE || process.env.HOME, 'AppData', 'Local'),
      'aephia',
      'icons'
    )
  : null;

function getStableIconPath(appKey) {
  if (process.platform !== 'win32' || !appKey) return null;
  return path.join(STABLE_ICON_DIR, `${appKey}.ico`);
}

function ensureStableIconDir() {
  if (!STABLE_ICON_DIR) return null;
  try {
    if (!fs.existsSync(STABLE_ICON_DIR)) {
      fs.mkdirSync(STABLE_ICON_DIR, { recursive: true });
    }
  } catch (e) {
    // Best-effort; fall back to source path on any failure.
  }
  return STABLE_ICON_DIR;
}

/**
 * Initialize the stable icon for an app.
 * - Sets AppUserModelId on Windows (per-app, per-profile for multi-profile apps).
 * - Ensures the stable icon directory exists.
 * - On first run (or if the stable copy is missing), copies the source .ico
 *   from the project into the stable store. Self-healing.
 * Returns the icon path to use for BrowserWindow, or null off-Windows.
 */
function init({ appKey, appUserModelId, sourceIconPath } = {}) {
  if (process.platform !== 'win32') {
    return sourceIconPath || null;
  }
  if (appUserModelId && app && typeof app.setAppUserModelId === 'function') {
    try {
      app.setAppUserModelId(appUserModelId);
    } catch (e) {
      // No-op; setting AUMID can fail in some contexts.
    }
  }
  ensureStableIconDir();
  const stablePath = getStableIconPath(appKey);
  if (stablePath) {
    try {
      if (!fs.existsSync(stablePath) && sourceIconPath && fs.existsSync(sourceIconPath)) {
        fs.copyFileSync(sourceIconPath, stablePath);
      }
      if (fs.existsSync(stablePath)) {
        return stablePath;
      }
    } catch (e) {
      // Fall through to source path.
    }
  }
  return sourceIconPath || null;
}

/**
 * Apply the icon to a live BrowserWindow.
 * - Calls setIcon (re-asserts the icon on the HWND).
 * - Registers a focus listener that re-applies on every browser-window-focus
 *   event. Windows can drop the icon handle on sleep/wake, app focus
 *   changes, or after a process restart; re-applying on focus is cheap
 *   and keeps the taskbar icon consistent.
 */
function applyToWindow(win, iconPath) {
  if (!win || !iconPath) return;
  try {
    if (typeof win.setIcon === 'function') {
      win.setIcon(iconPath);
    }
  } catch (e) {
    // No-op.
  }
  if (app && typeof app.on === 'function') {
    const handler = () => {
      try {
        if (!win.isDestroyed() && typeof win.setIcon === 'function') {
          win.setIcon(iconPath);
        }
      } catch (e) {
        // No-op.
      }
    };
    app.on('browser-window-focus', handler);
    if (typeof win.once === 'function') {
      win.once('closed', () => app.removeListener('browser-window-focus', handler));
    }
  }
}

module.exports = {
  init,
  applyToWindow,
  getStableIconPath,
  STABLE_ICON_DIR,
};
