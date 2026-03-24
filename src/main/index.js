require('dotenv').config()
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron')
const path = require('path')
const Store = require('electron-store')
const SimConnectBridge = require('./simconnect')
const XPlaneBridge = require('./xplane')
const ApiClient = require('./api')

const store = new Store()
let mainWindow = null
let tray = null
let simBridge = null
let apiClient = null

// ─── Création de la fenêtre principale ───────────────────────────────────────
function createWindow () {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 680,
    minWidth: 380,
    minHeight: 600,
    resizable: true,
    frame: false,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))

  mainWindow.on('close', (e) => {
    // Minimiser dans le tray plutôt que fermer
    if (!app.isQuitting) {
      e.preventDefault()
      mainWindow.hide()
    }
  })
}

// ─── Tray icon ───────────────────────────────────────────────────────────────
function createTray () {
  const icon = nativeImage.createEmpty()
  tray = new Tray(icon)

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Ouvrir BZH Tracker', click: () => mainWindow.show() },
    { type: 'separator' },
    { label: 'Quitter', click: () => { app.isQuitting = true; app.quit() } }
  ])

  tray.setContextMenu(contextMenu)
  tray.setToolTip('BZH Tracker')
  tray.on('double-click', () => mainWindow.show())
}

// ─── Initialisation ──────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow()
  createTray()

  apiClient = new ApiClient(store, mainWindow)

  // Auto-login si token sauvegardé
  const savedToken = store.get('auth.token')
  if (savedToken) {
    apiClient.setToken(savedToken)
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.webContents.send('auth:restored', { token: savedToken })
    })
  }
})

app.on('window-all-closed', (e) => e.preventDefault())

// ─── IPC : Authentification ───────────────────────────────────────────────────
ipcMain.handle('auth:login', async (_, { email, password }) => {
  try {
    const result = await apiClient.login(email, password)
    store.set('auth.token', result.token)
    store.set('auth.user', result.user)
    return { success: true, user: result.user }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('auth:logout', async () => {
  await apiClient.logout()
  store.delete('auth.token')
  store.delete('auth.user')
  stopSimBridge()
  return { success: true }
})

ipcMain.handle('auth:getUser', () => {
  return store.get('auth.user') || null
})

// ─── IPC : Connexion simulateur ───────────────────────────────────────────────
ipcMain.handle('sim:connect', async (_, { simType }) => {
  stopSimBridge()
  try {
    if (simType === 'msfs' || simType === 'p3d' || simType === 'fsx') {
      simBridge = new SimConnectBridge(mainWindow, apiClient)
    } else if (simType === 'xplane') {
      simBridge = new XPlaneBridge(mainWindow, apiClient)
    } else {
      return { success: false, error: 'Simulateur inconnu' }
    }
    await simBridge.connect()
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('sim:disconnect', () => {
  stopSimBridge()
  return { success: true }
})

// ─── IPC : PIREP ─────────────────────────────────────────────────────────────
ipcMain.handle('pirep:submit', async (_, pirepData) => {
  try {
    const result = await apiClient.submitPirep(pirepData)
    return { success: true, data: result }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// ─── IPC : Fenêtre (frameless) ────────────────────────────────────────────────
ipcMain.on('window:minimize', () => mainWindow.minimize())
ipcMain.on('window:hide', () => mainWindow.hide())
ipcMain.on('window:close', () => { app.isQuitting = true; app.quit() })

// ─── Helpers ─────────────────────────────────────────────────────────────────
function stopSimBridge () {
  if (simBridge) {
    simBridge.disconnect()
    simBridge = null
  }
}
