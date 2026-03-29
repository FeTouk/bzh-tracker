const { contextBridge, ipcRenderer } = require('electron')

// Expose une API sécurisée au renderer (contextIsolation)
contextBridge.exposeInMainWorld('bzh', {
  // Auth
  login:   (email, password, remember) => ipcRenderer.invoke('auth:login', { email, password, remember }),
  refresh: () => ipcRenderer.invoke('auth:refresh'),
  openWebAuth: () => ipcRenderer.invoke('auth:openWebAuth'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  getUser: () => ipcRenderer.invoke('auth:getUser'),
  getSaved: () => ipcRenderer.invoke('auth:getSaved'),
  getTheme:  () => ipcRenderer.invoke('theme:get'),
  setTheme:  (t) => ipcRenderer.invoke('theme:set', t),
  getSimType: () => ipcRenderer.invoke('sim:getType'),

  // Sim
  connectSim: (simType) => ipcRenderer.invoke('sim:connect', { simType }),
  disconnectSim: () => ipcRenderer.invoke('sim:disconnect'),

  // Vol
  getPreflight:   () => ipcRenderer.invoke('flight:preflight'),
  createBooking:  (routeId) => ipcRenderer.invoke('flight:booking', routeId),
  cancelBooking:  () => ipcRenderer.invoke('flight:cancelBooking'),
  openSimBrief:   (params) => ipcRenderer.invoke('shell:simbrief', params),
  startFlight:  (data) => ipcRenderer.invoke('flight:start', data),

  // PIREP
  submitPirep: (data) => ipcRenderer.invoke('pirep:submit', data),

  // Fenêtre frameless
  minimize: () => ipcRenderer.send('window:minimize'),
  hide: () => ipcRenderer.send('window:hide'),
  close: () => ipcRenderer.send('window:close'),

  // Événements venant du main process
  on: (channel, callback) => {
    const allowed = [
      'auth:restored',
      'auth:web-error',
      'auth:session-expired',
      'sim:status',
      'sim:data',
      'sim:paused',
      'sim:aircraft',
      'sim:flight-start',
      'sim:flight-end',
      'api:status'
    ]
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_, data) => callback(data))
    }
  },
  off: (channel) => ipcRenderer.removeAllListeners(channel)
})
