const { app, BrowserWindow, ipcMain, Tray, Menu, session, shell, Notification, safeStorage, nativeImage } = require('electron');
const path = require('path');
const https = require('https');
const Store = require('electron-store');
const { fetchViaWindow } = require('./src/fetch-via-window');
const { isNewerVersion } = require('./src/version');

// Update checks target THIS fork's own GitHub Releases, not the upstream
// project — otherwise the upstream's higher version always reports as an
// "update" and sends users back to the original app.
const GITHUB_OWNER = 'conradcullen-maker';
const GITHUB_REPO = 'claude-usage-widget';

// Migration: Handle old encrypted config files from v1.7.0 and earlier
// Must happen BEFORE creating Store instance to prevent parse errors
const fs = require('fs');
const os = require('os');

// electron-store uses different paths per platform
let configPath;
if (process.platform === 'darwin') {
  configPath = path.join(os.homedir(), 'Library', 'Application Support', 'claude-usage-widget', 'config.json');
} else if (process.platform === 'win32') {
  configPath = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'claude-usage-widget', 'config.json');
} else {
  // Linux
  configPath = path.join(os.homedir(), '.config', 'claude-usage-widget', 'config.json');
}

try {
  if (fs.existsSync(configPath)) {
    const rawData = fs.readFileSync(configPath, 'utf-8');
    // Check if file looks encrypted (contains non-JSON garbage or doesn't start with {)
    if (rawData.includes('\u0000') || !rawData.trim().startsWith('{')) {
      console.log('[Migration] Detected old encrypted config from v1.7.0, deleting for fresh start');
      fs.unlinkSync(configPath);
    }
  }
} catch (err) {
  console.error('[Migration] Error checking config file:', err.message);
  // If we can't read it, try to delete it
  try {
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
  } catch {}
}

// Non-sensitive settings storage (no encryption needed)
const store = new Store();

// Debug mode: set DEBUG_LOG=1 env var or pass --debug flag to see verbose logs.
// Regular users will only see critical errors in the console.
const DEBUG = process.env.DEBUG_LOG === '1' || process.argv.includes('--debug');
function debugLog(...args) {
  if (DEBUG) console.log('[Debug]', ...args);
}

const CHROME_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let mainWindow = null;
let sessionTray = null;  // Tray icon for Session usage
let weeklyTray = null;   // Tray icon for Weekly usage

const WIDGET_WIDTH = process.platform === 'darwin' ? 590 : 560;
const WIDGET_HEIGHT = 155;
const HISTORY_RETENTION_DAYS = 30;
const CHART_DAYS = 7;
const MAX_HISTORY_SAMPLES = 10000; // Cap total samples to prevent unbounded growth

function storeUsageHistory(data) {
  const timestamp = Date.now();
  let history = store.get('usageHistory', []);

  // resets_at fields are recorded with each snapshot so the chart can
  // reconstruct timer rollovers (drop-to-zero) that happen while the app
  // is closed, with no fresh snapshot to mark the moment.
  const toMs = (iso) => {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    return Number.isFinite(t) ? t : null;
  };

  history.push({
    timestamp,
    session: data.five_hour?.utilization || 0,
    weekly: data.seven_day?.utilization || 0,
    sonnet: data.seven_day_sonnet?.utilization || 0,
    extraUsage: data.extra_usage?.utilization || 0,
    sessionResetsAt: toMs(data.five_hour?.resets_at),
    weeklyResetsAt: toMs(data.seven_day?.resets_at),
    sonnetResetsAt: toMs(data.seven_day_sonnet?.resets_at),
    extraResetsAt: toMs(data.extra_usage?.resets_at)
  });

  // Rotation: apply both time-based and count-based limits
  const cutoff = timestamp - (HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  history = history.filter((entry) => entry.timestamp > cutoff);

  // If still over limit, drop oldest samples
  if (history.length > MAX_HISTORY_SAMPLES) {
    history = history.slice(history.length - MAX_HISTORY_SAMPLES);
  }

  store.set('usageHistory', history);
}

// Set session-level User-Agent to avoid Electron detection
app.on('ready', () => {
  session.defaultSession.setUserAgent(CHROME_USER_AGENT);
});

// Set sessionKey as a cookie in Electron's session
async function setSessionCookie(sessionKey) {
  await session.defaultSession.cookies.set({
    url: 'https://claude.ai',
    name: 'sessionKey',
    value: sessionKey,
    domain: '.claude.ai',
    path: '/',
    secure: true,
    httpOnly: true
  });
  debugLog('sessionKey cookie set in Electron session');
}

function createMainWindow() {
  const savedPosition = store.get('windowPosition');
  const windowOptions = {
    width: WIDGET_WIDTH,
    height: WIDGET_HEIGHT,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: false,
    icon: path.join(__dirname, process.platform === 'darwin' ? 'assets/icon.icns' : process.platform === 'linux' ? 'assets/logo.png' : 'assets/icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  };

  if (savedPosition) {
    windowOptions.x = savedPosition.x;
    windowOptions.y = savedPosition.y;
  }

  mainWindow = new BrowserWindow(windowOptions);
  mainWindow.loadFile('src/renderer/index.html');

  let positionSaveTimer = null;
  mainWindow.on('move', () => {
    if (positionSaveTimer) clearTimeout(positionSaveTimer);
    positionSaveTimer = setTimeout(() => {
      const position = mainWindow.getBounds();
      store.set('windowPosition', { x: position.x, y: position.y });
    }, 300);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

/**
 * Convert a "#rrggbb" hex string to an {r,g,b} object.
 * Falls back to the supplied default if the input can't be parsed.
 */
function hexToRgb(hex, fallback) {
  if (typeof hex === 'string') {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (m) {
      const n = parseInt(m[1], 16);
      return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
    }
  }
  return fallback;
}

/**
 * Determine background color based on thresholds.
 * `defaultColor` is the {r,g,b} used when neither the warn nor danger threshold
 * is hit — callers pass the user's picked colour for the bar so the tray badge
 * matches the compact widget.
 */
function getBackgroundColor(percent, defaultColor, warnThreshold, dangerThreshold) {
  if (percent >= dangerThreshold) {
    // Red #ef4444
    return { r: 239, g: 68, b: 68 };
  } else if (percent >= warnThreshold) {
    // Amber/Orange #f59e0b
    return { r: 245, g: 158, b: 11 };
  }
  return defaultColor;
}

/**
 * Bold 8x11 bitmap font for numbers 0-9 (2-pixel strokes for bold look)
 * Each number is represented as an array of 11 rows, each row is 8 bits
 */
const BITMAP_FONT = {
  '0': [
    0b00111100,
    0b01111110,
    0b11100111,
    0b11000011,
    0b11000011,
    0b11000011,
    0b11000011,
    0b11000011,
    0b11100111,
    0b01111110,
    0b00111100
  ],
  '1': [
    0b00011000,
    0b00111000,
    0b01111000,
    0b00011000,
    0b00011000,
    0b00011000,
    0b00011000,
    0b00011000,
    0b00011000,
    0b01111110,
    0b01111110
  ],
  '2': [
    0b00111100,
    0b01111110,
    0b11100111,
    0b00000011,
    0b00000110,
    0b00011100,
    0b00111000,
    0b01110000,
    0b11100000,
    0b11111111,
    0b11111111
  ],
  '3': [
    0b00111100,
    0b01111110,
    0b11100111,
    0b00000011,
    0b00000110,
    0b00111100,
    0b00000110,
    0b00000011,
    0b11100111,
    0b01111110,
    0b00111100
  ],
  '4': [
    0b00000110,
    0b00001110,
    0b00011110,
    0b00110110,
    0b01100110,
    0b11111111,
    0b11111111,
    0b00000110,
    0b00000110,
    0b00000110,
    0b00000110
  ],
  '5': [
    0b11111111,
    0b11111111,
    0b11000000,
    0b11000000,
    0b11111100,
    0b00000110,
    0b00000011,
    0b00000011,
    0b11100111,
    0b01111110,
    0b00111100
  ],
  '6': [
    0b00111100,
    0b01111110,
    0b11100000,
    0b11000000,
    0b11111100,
    0b11100110,
    0b11000011,
    0b11000011,
    0b11100111,
    0b01111110,
    0b00111100
  ],
  '7': [
    0b11111111,
    0b11111111,
    0b00000011,
    0b00000110,
    0b00001100,
    0b00011000,
    0b00110000,
    0b00110000,
    0b01100000,
    0b01100000,
    0b01100000
  ],
  '8': [
    0b00111100,
    0b01111110,
    0b11100111,
    0b11000011,
    0b01111110,
    0b00111100,
    0b01111110,
    0b11000011,
    0b11100111,
    0b01111110,
    0b00111100
  ],
  '9': [
    0b00111100,
    0b01111110,
    0b11100111,
    0b11000011,
    0b11000011,
    0b01111111,
    0b00111111,
    0b00000011,
    0b00000111,
    0b01111110,
    0b00111100
  ]
};

/**
 * Narrow 6x11 bitmap font for 3-digit numbers (100%)
 * Bold version to match
 */
const BITMAP_FONT_NARROW = {
  '0': [
    0b011110,
    0b111111,
    0b110011,
    0b110011,
    0b110011,
    0b110011,
    0b110011,
    0b110011,
    0b110011,
    0b111111,
    0b011110
  ],
  '1': [
    0b001100,
    0b011100,
    0b111100,
    0b001100,
    0b001100,
    0b001100,
    0b001100,
    0b001100,
    0b001100,
    0b111111,
    0b111111
  ]
};

/**
 * Draw a crisp bitmap character at position (x, y) in the buffer
 */
function drawChar(buffer, width, height, char, x, y, color, useNarrow = false) {
  const bitmap = useNarrow ? BITMAP_FONT_NARROW[char] : BITMAP_FONT[char];
  if (!bitmap) return useNarrow ? 6 : 8;
  
  const charWidth = useNarrow ? 6 : 8;
  const charHeight = 11;
  const maxCol = useNarrow ? 5 : 7;
  
  for (let row = 0; row < charHeight; row++) {
    for (let col = 0; col < charWidth; col++) {
      if (bitmap[row] & (1 << (maxCol - col))) {
        const px = x + col;
        const py = y + row;
        if (px >= 0 && px < width && py >= 0 && py < height) {
          const offset = (py * width + px) * 4;
          buffer[offset] = color.b;
          buffer[offset + 1] = color.g;
          buffer[offset + 2] = color.r;
          buffer[offset + 3] = color.a;
        }
      }
    }
  }
  return charWidth;
}

/**
 * Generate a single percentage badge icon with colored background and bitmap text
 * @param {number} percent - Usage percentage (0-100)
 * @param {object} bgColor - Background color {r, g, b}
 * @returns {NativeImage} Generated tray icon
 */
function generatePercentageIcon(percent, bgColor) {
  const width = 20;  // Back to 20x20
  const height = 20;
  const buffer = Buffer.alloc(width * height * 4);
  
  // Draw filled square background
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      buffer[offset] = bgColor.b;
      buffer[offset + 1] = bgColor.g;
      buffer[offset + 2] = bgColor.r;
      buffer[offset + 3] = 255;
    }
  }
  
  // Draw white text
  const percentText = Math.round(percent).toString();
  const textColor = { r: 255, g: 255, b: 255, a: 255 };
  
  // Use narrow font for 3-digit numbers (100%)
  const useNarrow = percentText.length >= 3;
  const charWidth = useNarrow ? 6 : 8;
  const charHeight = 11;
  const gap = percentText.length >= 3 ? 0 : 1; // 1px gap for 1-2 digits, no gap for 100
  const totalWidth = percentText.length * charWidth + (percentText.length - 1) * gap;
  let startX = Math.floor((width - totalWidth) / 2);
  const startY = Math.floor((height - charHeight) / 2);
  
  // Draw each digit
  for (let i = 0; i < percentText.length; i++) {
    drawChar(buffer, width, height, percentText[i], startX, startY, textColor, useNarrow);
    startX += charWidth + gap;
  }
  
  return nativeImage.createFromBuffer(buffer, { width, height });
}

/**
 * Generate a Red X icon for 99-100% usage (maxed out)
 * @returns {NativeImage} Generated red X tray icon
 */
function generateRedXIcon() {
  const width = 20;
  const height = 20;
  const buffer = Buffer.alloc(width * height * 4);
  
  // Red background
  const red = { r: 220, g: 53, b: 69 }; // #dc3545
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      buffer[offset] = red.b;
      buffer[offset + 1] = red.g;
      buffer[offset + 2] = red.r;
      buffer[offset + 3] = 255;
    }
  }
  
  // Draw white X (2 pixel thick lines)
  const white = { r: 255, g: 255, b: 255, a: 255 };
  
  // Diagonal line from top-left to bottom-right
  for (let i = 0; i < 11; i++) {
    const x1 = 5 + i;
    const y1 = 5 + i;
    // Draw 2x2 pixel for thickness
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const px = x1 + dx;
        const py = y1 + dy;
        if (px < width && py < height) {
          const offset = (py * width + px) * 4;
          buffer[offset] = white.b;
          buffer[offset + 1] = white.g;
          buffer[offset + 2] = white.r;
          buffer[offset + 3] = white.a;
        }
      }
    }
  }
  
  // Diagonal line from top-right to bottom-left
  for (let i = 0; i < 11; i++) {
    const x1 = 15 - i;
    const y1 = 5 + i;
    // Draw 2x2 pixel for thickness
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const px = x1 + dx;
        const py = y1 + dy;
        if (px < width && py < height) {
          const offset = (py * width + px) * 4;
          buffer[offset] = white.b;
          buffer[offset + 1] = white.g;
          buffer[offset + 2] = white.r;
          buffer[offset + 3] = white.a;
        }
      }
    }
  }
  
  return nativeImage.createFromBuffer(buffer, { width, height });
}



/**
 * Show the main window without the double-blink artifact on Windows.
 *
 * On Windows, transparent + alwaysOnTop + frameless windows re-enter the DWM
 * compositing pipeline in two steps when shown after hide(): an initial layered
 * window render (blink 1) followed by the alwaysOnTop z-order re-assertion
 * (blink 2). Setting opacity to 0 before show() masks those intermediate states;
 * the window is made opaque again after the DWM has had time to settle (~3 frames).
 * macOS and Linux do not have this issue so they just call show() directly.
 */
function showMainWindowClean() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  // Respect the tray stats setting even when createTray is called from generic refresh paths.
  if (!store.get('settings.showTrayStats', false)) {
    destroyTrayIcons();
    return;
  }

  // Rebuild from a clean state if only one of the two stats tray icons survived.
  const hasSessionTray = sessionTray && !sessionTray.isDestroyed();
  const hasWeeklyTray = weeklyTray && !weeklyTray.isDestroyed();
  if (hasSessionTray && hasWeeklyTray) return;
  if (hasSessionTray || hasWeeklyTray) destroyTrayIcons();

  try {
    const staticIconPath = path.join(__dirname, process.platform === 'darwin' ? 'assets/tray-icon-mac.png' : process.platform === 'linux' ? 'assets/tray-icon-linux.png' : 'assets/tray-icon.png');
    
    // Create Weekly tray icon FIRST (left position, blue)
    weeklyTray = new Tray(staticIconPath);
    weeklyTray.setToolTip('Weekly Usage');
    
    // Create Session tray icon SECOND (right position, purple)
    sessionTray = new Tray(staticIconPath);
    sessionTray.setToolTip('Session Usage');

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show Widget',
        click: () => {
          if (mainWindow) {
            showMainWindowClean();
          } else {
            createMainWindow();
          }
        }
      },
      {
        label: 'Refresh',
        click: () => {
          if (mainWindow) {
            mainWindow.webContents.send('refresh-usage');
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Log Out',
        click: async () => {
          store.delete('sessionKey');
          store.delete('organizationId');
          // Clear all Claude.ai cookies and session storage
          const cookies = await session.defaultSession.cookies.get({ url: 'https://claude.ai' });
          for (const cookie of cookies) {
            await session.defaultSession.cookies.remove('https://claude.ai', cookie.name);
          }
          await session.defaultSession.clearStorageData({
            storages: ['localstorage', 'sessionstorage', 'cachestorage'],
            origin: 'https://claude.ai'
          });
          if (mainWindow) {
            mainWindow.webContents.send('session-expired');
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Exit',
        click: () => {
          app.quit();
        }
      }
    ]);

    sessionTray.setContextMenu(contextMenu);
    weeklyTray.setContextMenu(contextMenu);

    // Click handlers - swapped order
        weeklyTray.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
          mainWindow.hide();
        } else {
          showMainWindowClean();
        }
      }
    });
    
        sessionTray.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
          mainWindow.hide();
        } else {
          showMainWindowClean();
        }
      }
    });
  } catch (error) {
    console.error('Failed to create tray:', error);
  }
}

function destroyTrayIcons() {
  // Centralized tray cleanup keeps Linux appindicator hosts from showing stale icons.
  const trays = [sessionTray, weeklyTray];
  sessionTray = null;
  weeklyTray = null;

  for (const tray of trays) {
    if (!tray || tray.isDestroyed()) continue;

    try {
      tray.removeAllListeners();
      tray.setContextMenu(null);
      tray.setToolTip('');

      // On Linux, some appindicator hosts repaint stale tray entries lazily.
      // Clearing the image before destroy gives the host an explicit update.
      if (process.platform === 'linux') {
        tray.setImage(nativeImage.createEmpty());
      }
    } catch (error) {
      console.error('Failed to clear tray icon:', error);
    }

    try {
      tray.destroy();
    } catch (error) {
      console.error('Failed to destroy tray icon:', error);
    }
  }
}

/**
 * Format reset time for tray tooltip
 * @param {string} resetsAt - ISO timestamp string
 * @param {string} timeFormat - '12h' or '24h'
 * @param {boolean} includeDate - Whether to include the date (for weekly resets)
 * @returns {string} Formatted time string
 */
function formatResetTime(resetsAt, timeFormat, includeDate = false) {
  if (!resetsAt) return null;
  const date = new Date(resetsAt);
  
  const formatTime = () => {
    if (timeFormat === '24h') {
      return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
    } else {
      let hours = date.getHours();
      const minutes = date.getMinutes().toString().padStart(2, '0');
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12 || 12;
      return `${hours}:${minutes} ${ampm}`;
    }
  };
  
  if (includeDate) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthStr = months[date.getMonth()];
    const dayNum = date.getDate();
    return `${monthStr} ${dayNum}, ${formatTime()}`;
  } else {
    return formatTime();
  }
}

/**
 * Update tray icons with current usage data
 * @param {Object} usageData - Usage data object containing session and weekly percentages
 */
function updateTrayIcon(usageData) {
  const showTrayStats = store.get('settings.showTrayStats', false);
  
  if (!showTrayStats) {
    // Destroy only weeklyTray, keeping sessionTray alive as a persistent restore
    // icon. Without it, hide() on Windows leaves no way to restore the window.
    // Apply the same Linux appindicator cleanup that destroyTrayIcons() uses.
    if (weeklyTray && !weeklyTray.isDestroyed()) {
      try {
        weeklyTray.removeAllListeners();
        weeklyTray.setContextMenu(null);
        weeklyTray.setToolTip('');
        if (process.platform === 'linux') weeklyTray.setImage(nativeImage.createEmpty());
        weeklyTray.destroy();
      } catch (_) {}
      weeklyTray = null;
    }
    return;
  }

  // Recreate tray icons if they were destroyed
  if (!sessionTray || sessionTray.isDestroyed() || !weeklyTray || weeklyTray.isDestroyed()) {
    createTray();
  }

  if ((!sessionTray || sessionTray.isDestroyed()) && (!weeklyTray || weeklyTray.isDestroyed())) return;

  // Get threshold settings and time format
  const warnThreshold = store.get('settings.warnThreshold', 75);
  const dangerThreshold = store.get('settings.dangerThreshold', 90);
  const timeFormat = store.get('settings.timeFormat', '12h');

  // Tray badges reuse the user's compact-mode colour pickers (session = purple
  // default #8b5cf6, weekly = blue default #3b82f6). Threshold overrides still win.
  const sessionDefault = hexToRgb(
    store.get('settings.compactSessionColor', '#8b5cf6'),
    { r: 139, g: 92, b: 246 }
  );
  const weeklyDefault = hexToRgb(
    store.get('settings.compactWeeklyColor', '#3b82f6'),
    { r: 59, g: 130, b: 246 }
  );

  // Extract percentages and reset times from usage data
  const sessionPercent = usageData?.five_hour?.utilization || 0;
  const sessionResetsAt = usageData?.five_hour?.resets_at;
  const weeklyPercent = usageData?.seven_day?.utilization || 0;
  const weeklyResetsAt = usageData?.seven_day?.resets_at;

  try {
    // Generate Weekly icon (blue background) - LEFT position
    let weeklyIcon;
    if (weeklyPercent >= 99) {
      weeklyIcon = generateRedXIcon();
    } else {
      const weeklyColor = getBackgroundColor(weeklyPercent, weeklyDefault, warnThreshold, dangerThreshold);
      weeklyIcon = generatePercentageIcon(weeklyPercent, weeklyColor);
    }
    if (weeklyTray && !weeklyTray.isDestroyed()) {
      weeklyTray.setImage(weeklyIcon);
      let weeklyTooltip = `Weekly: ${Math.round(weeklyPercent)}%`;
      const weeklyResetTime = formatResetTime(weeklyResetsAt, timeFormat, true);
      if (weeklyResetTime) {
        weeklyTooltip += `\nResets: ${weeklyResetTime}`;
      }
      weeklyTray.setToolTip(weeklyTooltip);
    }
    
    // Generate Session icon (purple background) - RIGHT position
    let sessionIcon;
    if (sessionPercent >= 99) {
      sessionIcon = generateRedXIcon();
    } else {
      const sessionColor = getBackgroundColor(sessionPercent, sessionDefault, warnThreshold, dangerThreshold);
      sessionIcon = generatePercentageIcon(sessionPercent, sessionColor);
    }
    if (sessionTray && !sessionTray.isDestroyed()) {
      sessionTray.setImage(sessionIcon);
      let sessionTooltip = `Session: ${Math.round(sessionPercent)}%`;
      const sessionResetTime = formatResetTime(sessionResetsAt, timeFormat, false);
      if (sessionResetTime) {
        sessionTooltip += `\nResets: ${sessionResetTime}`;
      }
      sessionTray.setToolTip(sessionTooltip);
    }
  } catch (error) {
    console.error('Failed to update tray icons:', error);
  }
}


// IPC Handlers
ipcMain.handle('get-credentials', () => {
  let sessionKey = null;
  // Try safeStorage first (OS keychain)
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = store.get('sessionKey_encrypted');
    if (encrypted) {
      try {
        sessionKey = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      } catch (err) {
        console.error('[Keychain] Failed to decrypt session key:', err.message);
      }
    }
  } else {
    // Fallback: plain storage (legacy or safeStorage unavailable)
    sessionKey = store.get('sessionKey');
  }
  return {
    sessionKey,
    organizationId: store.get('organizationId')
  };
});

ipcMain.handle('save-credentials', async (event, { sessionKey, organizationId }) => {
  // Store session key in OS keychain if available
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(sessionKey);
    store.set('sessionKey_encrypted', encrypted.toString('base64'));
    store.delete('sessionKey'); // Remove legacy plain storage
  } else {
    // Fallback: plain storage
    store.set('sessionKey', sessionKey);
  }
  if (organizationId) {
    store.set('organizationId', organizationId);
  }
  // Also set cookie in Electron session for window-based fetching
  await setSessionCookie(sessionKey);
  return true;
});

ipcMain.handle('delete-credentials', async () => {
  store.delete('sessionKey');
  store.delete('sessionKey_encrypted');
  store.delete('organizationId');
  // Remove all Claude.ai cookies
  const cookies = await session.defaultSession.cookies.get({ url: 'https://claude.ai' });
  for (const cookie of cookies) {
    await session.defaultSession.cookies.remove('https://claude.ai', cookie.name);
  }
  // Clear any cached data from the Electron session (storage, cache)
  // so nothing lingers on shared machines
  await session.defaultSession.clearStorageData({
    storages: ['localstorage', 'sessionstorage', 'cachestorage'],
    origin: 'https://claude.ai'
  });
  return true;
});

// Validate a sessionKey by fetching org ID via hidden BrowserWindow
ipcMain.handle('validate-session-key', async (event, sessionKey) => {
  debugLog('Validating session key:', sessionKey.substring(0, 20) + '...');
  try {
    // Set the cookie in Electron's session first
    await setSessionCookie(sessionKey);

    // Fetch organizations using hidden BrowserWindow (bypasses Cloudflare)
    const data = await fetchViaWindow('https://claude.ai/api/organizations');

    if (data && Array.isArray(data) && data.length > 0) {
      // Filter to orgs with 'chat' capability (excludes API-only orgs)
      const chatOrgs = data.filter(org => 
        org.capabilities && org.capabilities.includes('chat')
      );

      if (chatOrgs.length === 0) {
        return { success: false, error: 'No chat-enabled organizations found' };
      }

      // Prioritize Teams org if present, otherwise use first chat org
      const defaultOrg = chatOrgs.find(org => org.raven_type === 'team') || chatOrgs[0];
      const orgId = defaultOrg.uuid || defaultOrg.id;
      
      debugLog(`Session key validated, found ${chatOrgs.length} chat org(s), default org ID:`, orgId);
      
      return { 
        success: true, 
        organizationId: orgId,
        organizations: chatOrgs.map(org => ({
          id: org.uuid || org.id,
          name: org.name,
          isTeam: org.raven_type === 'team'
        }))
      };
    }

    // Check if it's an error response
    if (data && data.error) {
      return { success: false, error: data.error.message || data.error };
    }

    return { success: false, error: 'No organization found' };
  } catch (error) {
    console.error('Session key validation failed:', error.message);
    // Clean up the invalid cookie
    await session.defaultSession.cookies.remove('https://claude.ai', 'sessionKey');
    return { success: false, error: error.message };
  }
});

ipcMain.on('minimize-window', () => {
  if (mainWindow) {
    if (process.platform === 'darwin') {
      mainWindow.minimize();
    } else {
      const minimizeToTray = store.get('settings.minimizeToTray', false);
      if (minimizeToTray) {
        mainWindow.hide();
      } else {
        mainWindow.minimize();
      }
    }
  }
});

ipcMain.on('close-window', () => {
  app.quit();
});

// Tracks the in-progress resize animation so a new resize request can
// cancel it cleanly and start a fresh interpolation from the current size.
let resizeAnimTimer = null;

ipcMain.on('resize-window', (event, height, animate) => {
  if (!mainWindow) return;

  // Cancel any in-flight animation so we always interpolate from the
  // window's current actual height (not the previous target).
  if (resizeAnimTimer) {
    clearInterval(resizeAnimTimer);
    resizeAnimTimer = null;
  }

  if (!animate) {
    mainWindow.setContentSize(WIDGET_WIDTH, height);
    return;
  }

  const [, startHeight] = mainWindow.getContentSize();
  const targetHeight = height;
  if (startHeight === targetHeight) return;

  const duration = 220; // ms — matches the graph-section fade-in
  const startTime = Date.now();
  // Cubic ease-out — fast start, gentle finish; feels like macOS panel reveal.
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);

  resizeAnimTimer = setInterval(() => {
    if (!mainWindow) {
      clearInterval(resizeAnimTimer);
      resizeAnimTimer = null;
      return;
    }
    const elapsed = Date.now() - startTime;
    const t = Math.min(elapsed / duration, 1);
    const h = Math.round(startHeight + (targetHeight - startHeight) * easeOut(t));
    mainWindow.setContentSize(WIDGET_WIDTH, h);
    if (t >= 1) {
      clearInterval(resizeAnimTimer);
      resizeAnimTimer = null;
    }
  }, 16);
});

ipcMain.handle('get-window-position', () => {
  if (mainWindow) {
    return mainWindow.getBounds();
  }
  return null;
});

ipcMain.handle('set-window-position', (event, { x, y }) => {
  if (mainWindow) {
    mainWindow.setPosition(x, y);
    return true;
  }
  return false;
});

ipcMain.on('open-external', (event, url) => {
  // Trust boundary enforcement: duplicate allowlist check in main process
  const allowedDomains = ['claude.ai', 'github.com', 'paypal.me'];
  try {
    const parsedUrl = new URL(url);
    const isAllowed = allowedDomains.some(domain => 
      parsedUrl.hostname === domain || parsedUrl.hostname.endsWith('.' + domain)
    );
    if (isAllowed) {
      shell.openExternal(url);
    } else {
      console.warn(`[Security] Blocked openExternal call to disallowed domain: ${parsedUrl.hostname}`);
    }
  } catch (err) {
    console.warn(`[Security] Blocked openExternal call with invalid URL: ${url}`);
  }
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

ipcMain.handle('uninstall-app', async () => {
  const path = require('path');
  const fs = require('fs');
  const { spawn } = require('child_process');

  try {
    if (process.platform === 'win32') {
      const installDir = path.dirname(process.execPath);
      let uninstaller = null;
      try {
        const entries = fs.readdirSync(installDir);
        const match = entries.find(f => /^Uninstall.*\.exe$/i.test(f));
        if (match) uninstaller = path.join(installDir, match);
      } catch (_) { /* ignore */ }

      if (uninstaller && fs.existsSync(uninstaller)) {
        spawn(uninstaller, [], { detached: true, stdio: 'ignore' }).unref();
      } else {
        // Fallback: open Windows Apps & Features
        spawn('cmd', ['/c', 'start', '', 'ms-settings:appsfeatures'], { detached: true, stdio: 'ignore' }).unref();
      }
    } else if (process.platform === 'darwin') {
      // macOS: open the Applications folder so the user can drag the app to Trash
      shell.showItemInFolder(app.getPath('exe'));
    } else {
      // Linux: open the folder containing the app
      shell.showItemInFolder(process.execPath);
    }

    setTimeout(() => app.quit(), 500);
    return { success: true };
  } catch (err) {
    console.error('[Uninstall] Failed:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-usage-history', () => {
  const history = store.get('usageHistory', []);
  const cutoff = Date.now() - (CHART_DAYS * 24 * 60 * 60 * 1000);
  return history
    .filter((entry) => entry.timestamp > cutoff)
    .sort((a, b) => a.timestamp - b.timestamp);
});

// Wipe settings + graph history. Leaves credentials and window position
// alone so the user doesn't have to log in again or hunt for the widget.
ipcMain.handle('reset-app-data', () => {
  try {
    store.delete('usageHistory');
    store.delete('settings');
    store.delete('latestUsageData');
    return { success: true };
  } catch (err) {
    console.error('[Reset] Failed:', err);
    return { success: false, error: err.message };
  }
});

// Show a native OS desktop notification (Windows toast, macOS NC, Linux libnotify)
ipcMain.on('show-notification', (event, { title, body }) => {
  if (Notification.isSupported()) {
    const n = new Notification({ title, body, silent: false });
    n.show();
  }
});

// Resize window for compact vs normal mode
// Compact: 290px wide, normal: 530px wide. Height stays managed by renderer.
ipcMain.on('set-compact-mode', (event, compact) => {
  if (mainWindow) {
    const bounds = mainWindow.getBounds();
    const width = compact ? 290 : WIDGET_WIDTH;
    const height = compact ? 60 : WIDGET_HEIGHT;
    mainWindow.setBounds({ x: bounds.x, y: bounds.y, width, height });
  }
});

// Settings handlers
ipcMain.handle('get-settings', () => {
  return {
    autoStart: store.get('settings.autoStart', false),
    minimizeToTray: store.get('settings.minimizeToTray', false),
    alwaysOnTop: store.get('settings.alwaysOnTop', true),
    theme: store.get('settings.theme', 'dark'),
    warnThreshold: store.get('settings.warnThreshold', 75),
    dangerThreshold: store.get('settings.dangerThreshold', 90),
    timeFormat: store.get('settings.timeFormat', '12h'),
    weeklyDateFormat: store.get('settings.weeklyDateFormat', 'date'),
    usageAlerts: store.get('settings.usageAlerts', true),
    compactMode: store.get('settings.compactMode', false),
    refreshInterval: store.get('settings.refreshInterval', '300'),
    graphVisible: store.get('settings.graphVisible', false),
    expandedOpen: store.get('settings.expandedOpen', false),
    graphRange: store.get('settings.graphRange', '7'),
    showTrayStats: store.get('settings.showTrayStats', false),
    compactBgOpacity: store.get('settings.compactBgOpacity', 100),
    compactBarOpacity: store.get('settings.compactBarOpacity', 100),
    compactOutlineEnabled: store.get('settings.compactOutlineEnabled', true),
    compactSessionColor: store.get('settings.compactSessionColor', '#8b5cf6'),
    compactWeeklyColor: store.get('settings.compactWeeklyColor', '#3b82f6'),
    compactBarBgColor: store.get('settings.compactBarBgColor', '#ffffff'),
    regularSessionColor: store.get('settings.regularSessionColor', '#8b5cf6'),
    regularWeeklyColor: store.get('settings.regularWeeklyColor', '#3b82f6'),
    regularBarBgColor: store.get('settings.regularBarBgColor', '#ffffff')
  };
});

ipcMain.handle('save-settings', (event, settings) => {
  const supportsLoginItems = process.platform !== 'linux';
  const autoStart = supportsLoginItems ? settings.autoStart : false;

  store.set('settings.autoStart', autoStart);
  store.set('settings.minimizeToTray', settings.minimizeToTray);
  store.set('settings.alwaysOnTop', settings.alwaysOnTop);
  store.set('settings.theme', settings.theme);
  store.set('settings.warnThreshold', settings.warnThreshold);
  store.set('settings.dangerThreshold', settings.dangerThreshold);
  store.set('settings.timeFormat', settings.timeFormat);
  store.set('settings.weeklyDateFormat', settings.weeklyDateFormat);
  store.set('settings.usageAlerts', settings.usageAlerts);
  store.set('settings.compactMode', settings.compactMode);
  store.set('settings.refreshInterval', settings.refreshInterval);
  store.set('settings.graphVisible', settings.graphVisible);
  store.set('settings.expandedOpen', settings.expandedOpen);
  if (settings.graphRange !== undefined) store.set('settings.graphRange', settings.graphRange);
  store.set('settings.showTrayStats', settings.showTrayStats);
  if (settings.compactBgOpacity !== undefined) store.set('settings.compactBgOpacity', settings.compactBgOpacity);
  if (settings.compactBarOpacity !== undefined) store.set('settings.compactBarOpacity', settings.compactBarOpacity);
  if (settings.compactOutlineEnabled !== undefined) store.set('settings.compactOutlineEnabled', settings.compactOutlineEnabled);
  if (settings.compactSessionColor !== undefined) store.set('settings.compactSessionColor', settings.compactSessionColor);
  if (settings.compactWeeklyColor !== undefined) store.set('settings.compactWeeklyColor', settings.compactWeeklyColor);
  if (settings.compactBarBgColor !== undefined) store.set('settings.compactBarBgColor', settings.compactBarBgColor);
  if (settings.regularSessionColor !== undefined) store.set('settings.regularSessionColor', settings.regularSessionColor);
  if (settings.regularWeeklyColor !== undefined) store.set('settings.regularWeeklyColor', settings.regularWeeklyColor);
  if (settings.regularBarBgColor !== undefined) store.set('settings.regularBarBgColor', settings.regularBarBgColor);

  // openAtLogin is not supported on Linux — Electron silently ignores it.
  // Skip the call entirely to avoid misleading behaviour.
  if (supportsLoginItems) {
    app.setLoginItemSettings({
      openAtLogin: autoStart,
      ...(process.platform !== 'darwin' && { path: app.getPath('exe') })
    });
  }

  if (mainWindow) {
    if (process.platform === 'darwin') {
      if (settings.minimizeToTray) { app.dock.hide(); } else { app.dock.show(); }
    } else {
      mainWindow.setSkipTaskbar(settings.minimizeToTray);
    }
    mainWindow.setAlwaysOnTop(settings.alwaysOnTop, 'floating');
  }

  if (!settings.showTrayStats) {
    // Remove tray icons immediately when the setting is turned off from the UI.
    destroyTrayIcons();
  } else {
    // Refresh tray icons immediately with new threshold settings
    const latestUsageData = store.get('latestUsageData');
    if (latestUsageData) {
      updateTrayIcon(latestUsageData);
    } else {
      // Create empty tray icons now; the next usage refresh will draw the stats.
      createTray();
    }
  }

  return true;
});

// Open a visible BrowserWindow for the user to log in to Claude.ai.
//
// Why we don't embed login directly in the app:
// Claude.ai (via Cloudflare) detects and blocks Electron-embedded logins.
// Instead, we open a standalone browser window, let the user authenticate
// normally, then capture the sessionKey cookie once login completes.
// Do NOT attempt to "fix" this back to an embedded login without verifying
// that Claude.ai/Cloudflare no longer blocks it.
//
// SECURITY: Navigation is restricted to trusted domains (claude.ai and OAuth
// providers) to prevent phishing attacks. Popup windows are blocked. Current
// URL is displayed in the window title bar for transparency.
ipcMain.handle('detect-session-key', async () => {
  // Clear any leftover sessionKey cookie
  try {
    await session.defaultSession.cookies.remove('https://claude.ai', 'sessionKey');
  } catch (e) { /* ignore */ }

  return new Promise((resolve) => {
    const loginWin = new BrowserWindow({
      width: 1000,
      height: 700,
      title: 'Claude Login - https://claude.ai/login',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    let resolved = false;

    // Security: restrict navigation to trusted domains only
    const allowedLoginDomains = [
      'claude.ai',
      'accounts.google.com',
      'appleid.apple.com',
      'login.microsoftonline.com'
    ];

    loginWin.webContents.on('will-navigate', (event, url) => {
      try {
        const hostname = new URL(url).hostname;
        const isAllowed = allowedLoginDomains.some(domain =>
          hostname === domain || hostname.endsWith('.' + domain)
        );
        if (!isAllowed) {
          event.preventDefault();
          console.warn('[Security] Blocked login navigation to untrusted domain:', url);
        } else {
          // Update title bar to show current URL (read-only)
          loginWin.setTitle(`Claude Login - ${url}`);
        }
      } catch (err) {
        event.preventDefault();
        console.warn('[Security] Blocked login navigation with invalid URL:', url);
      }
    });

    // Update title on OAuth redirects and in-page navigation
    loginWin.webContents.on('did-navigate', (event, url) => {
      loginWin.setTitle(`Claude Login - ${url}`);
    });

    loginWin.webContents.on('did-navigate-in-page', (event, url) => {
      loginWin.setTitle(`Claude Login - ${url}`);
    });

    // Security: block popup windows from login page
    loginWin.webContents.setWindowOpenHandler(() => {
      console.warn('[Security] Blocked popup window attempt from login page');
      return { action: 'deny' };
    });

    // Listen for sessionKey cookie being set after login
    const onCookieChanged = (event, cookie, cause, removed) => {
      if (
        cookie.name === 'sessionKey' &&
        cookie.domain.includes('claude.ai') &&
        !removed &&
        cookie.value
      ) {
        resolved = true;
        session.defaultSession.cookies.removeListener('changed', onCookieChanged);
        loginWin.close();
        resolve({ success: true, sessionKey: cookie.value });
      }
    };

    session.defaultSession.cookies.on('changed', onCookieChanged);

    loginWin.on('closed', () => {
      session.defaultSession.cookies.removeListener('changed', onCookieChanged);
      if (!resolved) {
        resolve({ success: false, error: 'Login window closed' });
      }
    });

    loginWin.loadURL('https://claude.ai/login');
  });
});

// Check GitHub releases for a newer version
ipcMain.handle('check-for-update', () => {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
      method: 'GET',
      headers: {
        'User-Agent': 'claude-usage-widget',
        'Accept': 'application/vnd.github+json'
      },
      timeout: 5000
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const tag = (data.tag_name || '').replace(/^v/, '');
          const current = app.getVersion();
          if (tag && isNewerVersion(tag, current)) {
            resolve({ hasUpdate: true, version: tag });
          } else {
            resolve({ hasUpdate: false, version: null });
          }
        } catch {
          resolve({ hasUpdate: false, version: null });
        }
      });
    });

    req.on('error', () => resolve({ hasUpdate: false, version: null }));
    req.on('timeout', () => { req.destroy(); resolve({ hasUpdate: false, version: null }); });
    req.end();
  });
});

ipcMain.handle('fetch-usage-data', async (event, options = {}) => {
  // Use the same credential retrieval logic as get-credentials
  let sessionKey = null;
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = store.get('sessionKey_encrypted');
    if (encrypted) {
      try {
        sessionKey = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      } catch (err) {
        console.error('[Keychain] Failed to decrypt session key:', err.message);
      }
    }
  } else {
    sessionKey = store.get('sessionKey');
  }

  const organizationId = store.get('organizationId');

  if (!sessionKey || !organizationId) {
    throw new Error('Missing credentials');
  }

  // Ensure cookie is set
  await setSessionCookie(sessionKey);

  const usageUrl = `https://claude.ai/api/organizations/${organizationId}/usage`;
  const overageUrl = `https://claude.ai/api/organizations/${organizationId}/overage_spend_limit`;
  const prepaidUrl = `https://claude.ai/api/organizations/${organizationId}/prepaid/credits`;

  // When the user has just clicked expand (forceExtended: true) and we already
  // have recent usage data cached, skip the usage refetch — only the two extra
  // endpoints are needed to fill in the Extra row.
  const cachedUsage = options.forceExtended === true ? store.get('latestUsageData') : null;
  const reuseCachedUsage = !!(cachedUsage && cachedUsage.five_hour);

  // Fetch in PARALLEL using separate hidden BrowserWindows. The previous
  // sequential reuse-one-window approach cost 3–9s of wall time, which made
  // the Extra Usage row appear seconds after the rest of the widget.
  const fetchTasks = [];
  if (!reuseCachedUsage) fetchTasks.push(fetchViaWindow(usageUrl));
  fetchTasks.push(fetchViaWindow(overageUrl), fetchViaWindow(prepaidUrl));

  const settled = await Promise.allSettled(fetchTasks);

  let cursor = 0;
  const usageResult = reuseCachedUsage
    ? { status: 'fulfilled', value: cachedUsage }
    : settled[cursor++];
  const overageResult = settled[cursor++];
  const prepaidResult = settled[cursor++];

  // Usage endpoint is mandatory
  if (usageResult.status === 'rejected') {
    const error = usageResult.reason;
    debugLog('API request failed:', error.message);
    const isBlocked = error.message.startsWith('CloudflareBlocked')
      || error.message.startsWith('CloudflareChallenge')
      || error.message.startsWith('UnexpectedHTML');
    if (isBlocked) {
      store.delete('sessionKey');
      store.delete('organizationId');
      if (mainWindow) {
        mainWindow.webContents.send('session-expired');
      }
      throw new Error('SessionExpired');
    }
    throw error;
  }

  const data = usageResult.value;

  // Merge overage spending data into data.extra_usage
  if (overageResult.status === 'fulfilled' && overageResult.value) {
    const overage = overageResult.value;
    const limit = overage.monthly_credit_limit ?? overage.spend_limit_amount_cents;
    const used = overage.used_credits ?? overage.balance_cents;
    const enabled = overage.is_enabled !== undefined ? overage.is_enabled : (limit != null);

    if (enabled && typeof limit === 'number' && limit > 0 && typeof used === 'number') {
      data.extra_usage = {
        utilization: (used / limit) * 100,
        resets_at: null,
        used_cents: used,
        limit_cents: limit,
        is_enabled: true,
        currency: overage.currency || 'USD',
      };
    } else if (!enabled) {
      // Extra usage is off — still pass the flag so the renderer can show status
      if (!data.extra_usage) data.extra_usage = {};
      data.extra_usage.is_enabled = false;
      data.extra_usage.currency = overage.currency || 'USD';
    }
  } else {
    debugLog('Overage fetch skipped or failed:', overageResult.reason?.message || 'no data');
  }

  // Merge prepaid balance into data.extra_usage
  if (prepaidResult.status === 'fulfilled' && prepaidResult.value) {
    const prepaid = prepaidResult.value;
    if (typeof prepaid.amount === 'number') {
      if (!data.extra_usage) data.extra_usage = {};
      data.extra_usage.balance_cents = prepaid.amount;
      // Use prepaid currency if overage didn't already set one
      if (!data.extra_usage.currency && prepaid.currency) {
        data.extra_usage.currency = prepaid.currency;
      }
    }
  } else {
    debugLog('Prepaid fetch skipped or failed:', prepaidResult.reason?.message || 'no data');
  }

  storeUsageHistory(data);

  // Store latest usage data for settings refresh
  store.set('latestUsageData', data);

  // Update tray icon with current usage data
  updateTrayIcon(data);

  // Re-assert always-on-top after hidden BrowserWindows from fetchViaWindow
  // are destroyed — creating/destroying BrowserWindows can temporarily disrupt
  // the main window's z-order on some OS/window manager combinations.
  if (mainWindow && !mainWindow.isDestroyed()) {
    const alwaysOnTop = store.get('settings.alwaysOnTop', true);
    if (alwaysOnTop) {
      mainWindow.setAlwaysOnTop(true, 'floating');
    }
  }

  return data;
});

// App lifecycle
app.whenReady().then(async () => {
  // Restore session cookie if we have stored credentials
  let sessionKey = null;
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = store.get('sessionKey_encrypted');
    if (encrypted) {
      try {
        sessionKey = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      } catch (err) {
        console.error('[Keychain] Failed to decrypt session key on startup:', err.message);
      }
    }
  } else {
    sessionKey = store.get('sessionKey');
  }

  if (sessionKey) {
    await setSessionCookie(sessionKey);
  }

  createMainWindow();
  // Avoid creating temporary tray icons during startup when tray stats are disabled.
  if (store.get('settings.showTrayStats', false)) {
    createTray();
  }

  // Apply persisted settings
  const minimizeToTray = store.get('settings.minimizeToTray', false);
  const alwaysOnTop = store.get('settings.alwaysOnTop', true);
  if (mainWindow) {
    if (process.platform === 'darwin') {
      if (minimizeToTray) app.dock.hide();
    } else {
      if (minimizeToTray) mainWindow.setSkipTaskbar(true);
    }
    mainWindow.setAlwaysOnTop(alwaysOnTop, 'floating');
  }

  // Periodic always-on-top re-assertion to recover from z-order disruptions
  // (hidden window spawns, window manager shortcuts, alt-tab, etc.)
  setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const alwaysOnTopSetting = store.get('settings.alwaysOnTop', true);
      if (alwaysOnTopSetting) {
        mainWindow.setAlwaysOnTop(true, 'floating');
      }
    }
  }, 5000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Keep running in tray
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createMainWindow();
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
