const { contextBridge, ipcRenderer } = require('electron')

// Expose une API sécurisée au renderer (contextIsolation)
contextBridge.exposeInMainWorld('bzh', {
  // Auth
  login: (email, password) => ipcRenderer.invoke('auth:login', { email, password }),
  logout: () => ipcRenderer.invoke('auth:logout'),
  getUser: () => ipcRenderer.invoke('auth:getUser'),

  // Sim
  connectSim: (simType) => ipcRenderer.invoke('sim:connect', { simType }),
  disconnectSim: () => ipcRenderer.invoke('sim:disconnect'),

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
      'sim:status',
      'sim:data',
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
