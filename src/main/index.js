require('dotenv').config()

const fs   = require('fs')
const os   = require('os')
const path = require('path')
const _logFile = path.join(os.homedir(), 'bzh-tracker-debug.log')
function _log (msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { fs.appendFileSync(_logFile, line) } catch (_) {}
  console.log(msg)
}
_log('=== BZH Tracker démarrage ===')

// Single instance + deep link handler (Windows)
const { app: _appEarly } = require('electron')
const gotTheLock = _appEarly.requestSingleInstanceLock()
if (!gotTheLock) { _appEarly.quit(); process.exit(0) }

// Intercepter les erreurs SimConnect non-catchées (protocol mismatch, pipe fermé)
process.on('uncaughtException', (err) => {
  _log('[CRASH] uncaughtException: ' + err.message + '\n' + err.stack)
  if (err.message && (err.message.includes('protocol') || err.message.includes('SimConnect') || err.message.includes('ENOENT') || err.message.includes('ECONNREFUSED'))) {
    console.warn('[SimConnect] Erreur interceptée (sim non disponible):', err.message)
    if (simBridge) { try { simBridge.disconnect() } catch (_) {} simBridge = null }
    return
  }
  console.error('[Main] Uncaught exception:', err)
})

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } = require('electron')
const { autoUpdater } = require('electron-updater')
_log('electron chargé')
const Store = require('electron-store')
_log('electron-store chargé')
let SimConnectBridge, XPlaneBridge
try { SimConnectBridge = require('./simconnect'); _log('simconnect chargé') }
catch (e) { _log('[WARN] simconnect non disponible: ' + e.message); SimConnectBridge = null }
try { XPlaneBridge = require('./xplane'); _log('xplane chargé') }
catch (e) { _log('[WARN] xplane non disponible: ' + e.message); XPlaneBridge = null }
const ApiClient = require('./api')
_log('api chargé')

const store = new Store()
let mainWindow = null
let tray = null
let simBridge = null
let apiClient = null
let autoRetryTimer = null

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
    icon: path.join(__dirname, '../../assets/icon.png'),
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
  const iconPath = process.platform === 'win32'
    ? path.join(__dirname, '../../assets/icons/win/icon.ico')
    : path.join(__dirname, '../../assets/icons/png/256x256.png')
  const icon = nativeImage.createFromPath(iconPath)
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Ouvrir BZH Tracker', click: () => mainWindow.show() },
    { type: 'separator' },
    { label: 'Quitter', click: () => { app.isQuitting = true; app.quit() } }
  ])

  tray.setContextMenu(contextMenu)
  tray.setToolTip('BZH Tracker')
  tray.on('double-click', () => mainWindow.show())
}

// ─── Deep link handler ────────────────────────────────────────────────────────
const _processedTokens = new Set()

function handleDeepLink (url) {
  console.log('[DeepLink] URL reçue:', url)
  try {
    const parsed = new URL(url)
    console.log('[DeepLink] protocol:', parsed.protocol, '| hostname:', parsed.hostname)
    if (parsed.protocol === 'bzh-tracker:') {
      // Accepte bzh-tracker://auth?token=xxx ET bzh-tracker://?token=xxx
      const token = parsed.searchParams.get('token')
      console.log('[DeepLink] token extrait:', token ? token.substring(0, 8) + '...' : 'NULL')
      if (token) _handleTrackerAuthToken(token)
    }
  } catch (err) {
    console.error('[DeepLink] Erreur parsing URL:', err.message)
  }
}

async function _handleTrackerAuthToken (token) {
  if (_processedTokens.has(token)) {
    console.log('[Auth] Token déjà traité, ignoré')
    return
  }
  _processedTokens.add(token)
  setTimeout(() => _processedTokens.delete(token), 30000)

  try {
    const result = await apiClient.exchangeToken(token)
    store.set('auth.token', result.token)
    store.set('auth.user', result.user)
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
      mainWindow.webContents.send('auth:restored', { user: result.user })
      const savedSim = store.get('sim.type')
      if (savedSim) startAutoConnectSim(savedSim)
    }
  } catch (err) {
    console.error('[Auth] Échange token échoué:', err.message)
    if (mainWindow) mainWindow.webContents.send('auth:web-error', { error: err.message })
  }
}

// Second instance = deep link (Windows/Linux)
app.on('second-instance', (_, commandLine) => {
  const url = commandLine.map(a => a.replace(/"/g, '')).find(arg => arg.startsWith('bzh-tracker://'))
  if (url) handleDeepLink(url)
  if (mainWindow) { mainWindow.show(); mainWindow.focus() }
})

// macOS : deep link via open-url, clic dock via activate
app.on('open-url', (event, url) => {
  event.preventDefault()
  handleDeepLink(url)
  if (mainWindow) { mainWindow.show(); mainWindow.focus() }
})

app.on('activate', () => {
  if (mainWindow) mainWindow.show()
})

// ─── Initialisation ──────────────────────────────────────────────────────────
app.whenReady().then(() => {
  _log('app.whenReady fired')
  try {
    // En dev mode (electron .), il faut passer le chemin de l'app en argument
    // sinon Windows ne sait pas comment relancer le processus avec le deep link
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('bzh-tracker', process.execPath, [path.resolve(process.argv[1])])
    } else {
      app.setAsDefaultProtocolClient('bzh-tracker')
    }
    _log('Protocol bzh-tracker:// enregistré (defaultApp=' + process.defaultApp + ')')
  } catch (e) { _log('setProtocolClient error: ' + e.message) }
  try { createWindow(); _log('createWindow OK') } catch (e) { _log('createWindow ERROR: ' + e.message + '\n' + e.stack) }
  try { createTray();  _log('createTray OK')  } catch (e) { _log('createTray ERROR: '  + e.message) }

  apiClient = new ApiClient(store, mainWindow)

  // Auto-login si credentials sauvegardés
  const savedEmail    = store.get('auth.email')
  const savedPassword = store.get('auth.password')
  mainWindow.webContents.once('did-finish-load', async () => {
    // Vérification des mises à jour (silencieux en dev)
    if (!process.defaultApp) autoUpdater.checkForUpdates().catch(() => {})

    if (savedEmail && savedPassword) {
      try {
        const result = await apiClient.login(savedEmail, savedPassword)
        store.set('auth.token', result.token)
        store.set('auth.user', result.user)
        mainWindow.webContents.send('auth:restored', { user: result.user })
        const savedSim = store.get('sim.type')
        if (savedSim) startAutoConnectSim(savedSim)
      } catch (_) {
        // Credentials expirés ou invalides, on reste sur l'écran de login
      }
    }
  })
})

app.on('window-all-closed', (e) => e.preventDefault())

// ─── Auto-updater ─────────────────────────────────────────────────────────────
autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = true
autoUpdater.logger = null // pas de logs verbose

autoUpdater.on('update-available', (info) => {
  _log(`[Updater] Nouvelle version disponible : ${info.version}`)
  if (mainWindow) mainWindow.webContents.send('update:available', { version: info.version })
})

autoUpdater.on('update-downloaded', (info) => {
  _log(`[Updater] Version ${info.version} téléchargée`)
  if (mainWindow) mainWindow.webContents.send('update:ready', { version: info.version })
})

autoUpdater.on('error', (err) => {
  _log(`[Updater] Erreur : ${err.message}`)
})

ipcMain.handle('update:install', () => {
  app.isQuitting = true
  autoUpdater.quitAndInstall()
})

// ─── IPC : Authentification ───────────────────────────────────────────────────
ipcMain.handle('auth:login', async (_, { email, password, remember }) => {
  try {
    const result = await apiClient.login(email, password)
    store.set('auth.token', result.token)
    store.set('auth.user', result.user)
    if (remember) {
      store.set('auth.email', email)
      store.set('auth.password', password)
    } else {
      store.delete('auth.email')
      store.delete('auth.password')
    }
    const savedSim = store.get('sim.type')
    if (savedSim) startAutoConnectSim(savedSim)
    return { success: true, user: result.user }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('auth:getSaved', () => {
  const email = store.get('auth.email')
  return email ? { email, remember: true } : null
})

ipcMain.handle('auth:refresh', async () => {
  const email    = store.get('auth.email')
  const password = store.get('auth.password')
  if (!email || !password) return { success: false, error: 'Aucun identifiant sauvegardé' }
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
  stopAutoRetry()
  stopSimBridge()
  return { success: true }
})

ipcMain.handle('auth:getUser', () => {
  return store.get('auth.user') || null
})

// ─── IPC : Connexion simulateur ───────────────────────────────────────────────
ipcMain.handle('sim:connect', async (_, { simType }) => {
  store.set('sim.type', simType)
  stopAutoRetry()
  const ok = await tryConnectSim(simType)
  if (ok) return { success: true }
  // Sim pas encore lancé — on démarre le retry silencieux
  startAutoConnectSim(simType)
  return { success: false, error: 'Simulateur non disponible, nouvelle tentative toutes les 10s…' }
})

ipcMain.handle('sim:disconnect', () => {
  stopAutoRetry()
  stopSimBridge()
  return { success: true }
})

// ─── IPC : Pré-vol & démarrage ───────────────────────────────────────────────
ipcMain.handle('flight:preflight', async () => {
  try { return await apiClient.getPreflight() }
  catch (_) { return null }
})

ipcMain.handle('flight:lines', async () => {
  try { return await apiClient.getLines() }
  catch (_) { return null }
})

ipcMain.handle('flight:logbook', async () => {
  try { return await apiClient.getLogbook() }
  catch (_) { return null }
})

ipcMain.handle('flight:booking', async (_, routeId) => {
  try {
    const result = await apiClient.createBooking(routeId)
    return { success: true, ...result }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('flight:cancelBooking', async () => {
  try {
    const result = await apiClient.cancelBooking()
    return { success: result.success }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('auth:openWebAuth', () => {
  const baseUrl = process.env.BZH_WEB_URL || 'https://breizhair.fr'
  shell.openExternal(baseUrl + '/tracker/auth')
})

ipcMain.handle('shell:simbrief', async (_, { orig, dest, route, callsign }) => {
  const fltnum = (callsign || '').slice(-4)
  const url = `https://www.simbrief.com/system/dispatch.php?` +
    `airline=BZH&fltnum=${fltnum}` +
    `&orig=${orig}&dest=${dest}` +
    `&route=${encodeURIComponent(route || '')}` +
    `&rmk=IVAOVA/BZH`
  shell.openExternal(url)
})

ipcMain.handle('flight:start', async (_, data) => {
  await apiClient.startFlight(data)
})

ipcMain.handle('flight:manualStart', () => {
  if (!simBridge) return { error: 'Simulateur non connecté' }
  return simBridge.manualStart()
})

ipcMain.handle('flight:manualStop', () => {
  if (!simBridge) return { error: 'Simulateur non connecté' }
  return simBridge.manualStop()
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

// ─── IPC : Logbook (CSV local) ───────────────────────────────────────────────
const CSV_HEADER = 'date,flight_number,dep_icao,arr_icao,aircraft,duration_min,distance_nm,landing_fpm,fuel_gal,remarks\n'

function getLogbookPath () {
  return path.join(app.getPath('userData'), 'logbook.csv')
}

function escapeCsv (val) {
  if (val === null || val === undefined) return ''
  const s = String(val)
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s
}

ipcMain.handle('logbook:append', (_, entry) => {
  const file = getLogbookPath()
  if (!fs.existsSync(file)) fs.writeFileSync(file, CSV_HEADER, 'utf8')
  const row = [
    entry.date, entry.flightNumber, entry.depIcao, entry.arrIcao,
    entry.aircraft, entry.durationMin, entry.distanceNm,
    entry.landingFpm, entry.fuelGal, entry.remarks
  ].map(escapeCsv).join(',') + '\n'
  fs.appendFileSync(file, row, 'utf8')
  return { success: true }
})

ipcMain.handle('logbook:read', () => {
  const file = getLogbookPath()
  if (!fs.existsSync(file)) return { entries: [] }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  // Skip header
  const entries = lines.slice(1).reverse().map(line => {
    const [date, flightNumber, depIcao, arrIcao, aircraft, durationMin,
           distanceNm, landingFpm, fuelGal, ...remarkParts] = line.split(',')
    return { date, flightNumber, depIcao, arrIcao, aircraft,
             durationMin, distanceNm, landingFpm, fuelGal,
             remarks: remarkParts.join(',').replace(/^"|"$/g, '') }
  })
  return { entries }
})

// ─── IPC : Simulateur type ───────────────────────────────────────────────────
ipcMain.handle('sim:getType', () => store.get('sim.type', 'msfs'))

// ─── IPC : Thème ─────────────────────────────────────────────────────────────
ipcMain.handle('theme:get', () => store.get('theme', 'dark'))
ipcMain.handle('theme:set', (_, theme) => { store.set('theme', theme) })
ipcMain.handle('app:version', () => app.getVersion())

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

function stopAutoRetry () {
  if (autoRetryTimer) {
    clearInterval(autoRetryTimer)
    autoRetryTimer = null
  }
}

async function tryConnectSim (simType) {
  stopSimBridge()
  const onSimDisco = () => {
    simBridge = null
    startAutoConnectSim(simType)
  }
  try {
    if ((simType === 'msfs' || simType === 'p3d' || simType === 'fsx') && SimConnectBridge) {
      simBridge = new SimConnectBridge(mainWindow, apiClient, onSimDisco)
    } else if (simType === 'xplane' && XPlaneBridge) {
      simBridge = new XPlaneBridge(mainWindow, apiClient, onSimDisco)
    } else {
      return false
    }
    // Callback détection avion : match API puis envoi au renderer
    simBridge.onAircraft = (name) => {
      mainWindow.webContents.send('sim:aircraft', { name })
    }

    await simBridge.connect()
    stopAutoRetry()
    console.log('[AutoConnect] Simulateur connecté')
    return true
  } catch (err) {
    console.log('[AutoConnect] Sim indisponible :', err.message)
    simBridge = null
    return false
  }
}

function startAutoConnectSim (simType) {
  stopAutoRetry()
  tryConnectSim(simType)
  autoRetryTimer = setInterval(() => {
    if (!simBridge) tryConnectSim(simType)
  }, 10000)
}
