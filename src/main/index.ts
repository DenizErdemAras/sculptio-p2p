import { app, shell, BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../build/icon.png?asset'
import { initializeStorageHandlers } from './storage';
import { 
  getKeysFromSeed, 
  initializeSwarm, 
  joinLobby,
  startRoomServer,
  announceRoom,
  stopAnnouncingRoom,
  joinRoomServer,
  broadcastToRoom,
  sendToPlayer,
  sendToServer,
  disconnectAll,
  refreshLobby,
  kickPlayer,
  setModerationPolicy
} from './swarm';

if (process.env.SEED) {
  const newPath = join(app.getPath('userData'), `player_${process.env.SEED}_dev`);
  app.setPath('userData', newPath);
  console.log(`[DEV] Running with SEED ${process.env.SEED}. Data dir: ${newPath}`);
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 800,
    minWidth: 760,
    minHeight: 330,
    show: false,
    autoHideMenuBar: true,
    frame: false,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true
    }
  })

  mainWindow.on('enter-full-screen', () => {
    mainWindow.webContents.send('fullscreen-changed', true);
  });

  mainWindow.on('leave-full-screen', () => {
    mainWindow.webContents.send('fullscreen-changed', false);
  });

  ipcMain.removeAllListeners('window-fullscreen');
  ipcMain.on('window-fullscreen', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      win.setFullScreen(!win.isFullScreen());
    }
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.commandLine.appendSwitch('force_high_performance_gpu');

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  initializeStorageHandlers();

  ipcMain.on('window-minimize', () => {
    const win = BrowserWindow.getFocusedWindow();
    if (win) win.minimize();
  });

  ipcMain.on('window-maximize', () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return;
    
    // This handles the "Restore" logic automatically
    if (win.isMaximized()) {
      win.unmaximize(); 
    } else {
      win.maximize();
    }
  });

  ipcMain.on('window-fullscreen', (event) => {
    // Get the specific window that sent the click
    const webContents = event.sender;
    const win = BrowserWindow.fromWebContents(webContents);
    
    if (win) {
      // Toggle the fullscreen state on or off
      win.setFullScreen(!win.isFullScreen());
    }
  });

  ipcMain.on('window-close', () => {
    const win = BrowserWindow.getFocusedWindow();
    if (win) win.close();
  });

  let wasHovering = false;
  const titleBarThickness = 36;

  setInterval(() => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return;

    const mouse = screen.getCursorScreenPoint(); // Global OS X/Y
    const bounds = win.getBounds();              // Window OS X/Y and Size

    // Check if mouse is inside the top 32px of the window
    const isHovering = (
      mouse.x >= bounds.x &&
      mouse.x <= bounds.x + bounds.width &&
      mouse.y >= bounds.y &&
      mouse.y <= bounds.y + titleBarThickness // Your var(--t-height)
    );

    // Only send a message to React if the state actually changed
    if (isHovering !== wasHovering) {
      wasHovering = isHovering;
      win.webContents.send('titlebar-hover-state', isHovering);
    }
  }, 10); // 10ms = 100 checks per second.

  // --- CRYPTO & LOBBY IPC ---
  ipcMain.handle('get-keys', async (_event, seed: string) => {
    return getKeysFromSeed(seed);
  });

  ipcMain.handle('swarm-connect', (_event, seedHex, networkOptions) => {
    return initializeSwarm(seedHex, networkOptions);
  });

  ipcMain.handle('swarm-join-lobby', async () => {
    return joinLobby();
  });

  ipcMain.handle('refresh-lobby', async () => {
    return await refreshLobby();
  });

  // --- GAME ROOM LIFECYCLE IPC ---
  ipcMain.handle('swarm-start-server', async (_event, config: any, seedHex: string) => {
    return startRoomServer(config, seedHex);
  });

  ipcMain.handle('swarm-announce-room', async (_event, config: any, seedHex: string, seq: number) => {
    return announceRoom(config, seedHex, seq);
  });

  ipcMain.handle('swarm-stop-announcing', async (_event, seedHex: string, seq: number) => {
    return stopAnnouncingRoom(seedHex, seq);
});

  ipcMain.handle('swarm-join-room', async (_event, hostPubKeyStr: string, userProfile: any) => {
    return joinRoomServer(hostPubKeyStr, userProfile);
  });

  // --- IN-GAME MESSAGING IPC (Using .on since these are synchronous fire-and-forget actions) ---
  ipcMain.on('swarm-broadcast', (_event, msgTypeName: string, payload: any) => {
    broadcastToRoom(msgTypeName as any, payload);
  });

  ipcMain.on('swarm-send-to-player', (_event, pubKeyStr: string, msgTypeName: string, payload: any) => {
    sendToPlayer(pubKeyStr, msgTypeName as any, payload);
  });

  ipcMain.on('swarm-send-to-server', (_event, msgTypeName: string, payload: any) => {
    sendToServer(msgTypeName as any, payload);
  });

  ipcMain.handle('kick-player', async (_, pubKeyStr: string, reason?: string) => {
    return kickPlayer(pubKeyStr, reason);
  });

  ipcMain.handle('set-moderation-policy', async (_event, policy: any) => {
    return setModerationPolicy(policy);
  });

  ipcMain.handle('swarm-disconnect', async () => {
    return disconnectAll();
  });

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})