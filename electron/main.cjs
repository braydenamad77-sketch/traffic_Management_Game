const path = require('node:path');
const { app, BrowserWindow, nativeImage, shell } = require('electron');

const appName = 'GRIDLOCK';
const devServerUrl = process.env.GRIDLOCK_DEV_SERVER_URL || 'http://127.0.0.1:5173';
const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
let mainWindow = null;

app.name = appName;
app.setName(appName);
app.commandLine.appendSwitch('disable-http-cache');

function createWindow() {
  const icon = nativeImage.createFromPath(iconPath);
  if (process.platform === 'darwin' && !icon.isEmpty()) {
    app.dock.setIcon(icon);
  }

  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 700,
    title: appName,
    backgroundColor: '#111518',
    icon: iconPath,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = win;

  win.once('ready-to-show', () => {
    win.show();
  });

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadURL(devServerUrl);

  if (process.env.GRIDLOCK_OPEN_DEVTOOLS === '1') {
    win.webContents.openDevTools({ mode: 'detach' });
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) {
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
