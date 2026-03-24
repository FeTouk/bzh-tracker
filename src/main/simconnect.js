const {
  open,
  Protocol,
  SimConnectDataType,
  SimObjectType
} = require('node-simconnect')

const SEND_INTERVAL_MS = 5000
const DEF_ID = 0
const REQ_ID = 0

class SimConnectBridge {
  constructor (mainWindow, apiClient) {
    this.mainWindow = mainWindow
    this.apiClient = apiClient
    this.handle = null
    this.interval = null
    this.currentData = null
    this.isOnGround = true
    this.flightStarted = false
    this.flightStartTime = null
    this.flightLog = []
  }

  async connect () {
    const { recvOpen, handle } = await open('BZH Tracker', Protocol.FSX_SP2)
    this.handle = handle
    console.log('[SimConnect] Connecté :', recvOpen.applicationName)

    // Définir les variables à suivre
    handle.addToDataDefinition(DEF_ID, 'PLANE LATITUDE',                 'Degrees',         SimConnectDataType.FLOAT64)
    handle.addToDataDefinition(DEF_ID, 'PLANE LONGITUDE',                'Degrees',         SimConnectDataType.FLOAT64)
    handle.addToDataDefinition(DEF_ID, 'PLANE ALTITUDE',                 'Feet',            SimConnectDataType.FLOAT64)
    handle.addToDataDefinition(DEF_ID, 'AIRSPEED INDICATED',             'Knots',           SimConnectDataType.FLOAT64)
    handle.addToDataDefinition(DEF_ID, 'AIRSPEED TRUE',                  'Knots',           SimConnectDataType.FLOAT64)
    handle.addToDataDefinition(DEF_ID, 'VERTICAL SPEED',                 'Feet per minute', SimConnectDataType.FLOAT64)
    handle.addToDataDefinition(DEF_ID, 'PLANE HEADING DEGREES MAGNETIC', 'Degrees',         SimConnectDataType.FLOAT64)
    handle.addToDataDefinition(DEF_ID, 'SIM ON GROUND',                  'Bool',            SimConnectDataType.FLOAT64)
    handle.addToDataDefinition(DEF_ID, 'FUEL TOTAL QUANTITY',            'Gallons',         SimConnectDataType.FLOAT64)
    handle.addToDataDefinition(DEF_ID, 'GROUND VELOCITY',                'Knots',           SimConnectDataType.FLOAT64)
    handle.addToDataDefinition(DEF_ID, 'PLANE BANK DEGREES',             'Degrees',         SimConnectDataType.FLOAT64)
    handle.addToDataDefinition(DEF_ID, 'PLANE PITCH DEGREES',            'Degrees',         SimConnectDataType.FLOAT64)

    // Polling toutes les 5 secondes
    this.interval = setInterval(() => {
      handle.requestDataOnSimObjectType(REQ_ID, DEF_ID, 0, SimObjectType.USER)
    }, SEND_INTERVAL_MS)

    handle.on('simObjectDataByType', (recv) => this._onData(recv))
    handle.on('exception',           (e)    => console.error('[SimConnect] Exception:', e))
    handle.on('quit',                ()     => this._onDisconnect())
    handle.on('close',               ()     => this._onDisconnect())

    this._sendStatus('connected')
  }

  _onData (recv) {
    const d = recv.data

    const data = {
      latitude:  d.readFloat64(),
      longitude: d.readFloat64(),
      altitude:  Math.round(d.readFloat64()),
      ias:       Math.round(d.readFloat64()),
      tas:       Math.round(d.readFloat64()),
      vs:        Math.round(d.readFloat64()),
      heading:   Math.round(d.readFloat64()),
      onGround:  d.readFloat64() === 1,
      fuel:      Math.round(d.readFloat64()),
      gs:        Math.round(d.readFloat64()),
      bank:      parseFloat(d.readFloat64().toFixed(1)),
      pitch:     parseFloat(d.readFloat64().toFixed(1)),
      timestamp: Date.now()
    }

    this.currentData = data
    this.mainWindow.webContents.send('sim:data', data)

    if (this.isOnGround && !data.onGround && data.ias > 40) {
      this._onTakeoff(data)
    } else if (!this.isOnGround && data.onGround && data.gs < 30) {
      this._onLanding(data)
    }

    this.isOnGround = data.onGround

    if (this.flightStarted) {
      this.flightLog.push({
        lat: data.latitude, lng: data.longitude,
        alt: data.altitude, ias: data.ias,
        hdg: data.heading,  vs:  data.vs,
        ts:  data.timestamp
      })
      this.apiClient.sendPosition(data)
    }
  }

  _onTakeoff (data) {
    this.flightStarted = true
    this.flightStartTime = Date.now()
    this.flightLog = []
    console.log('[SimConnect] Décollage détecté')
    this.mainWindow.webContents.send('sim:flight-start', {
      lat: data.latitude,
      lng: data.longitude,
      time: this.flightStartTime
    })
    this.apiClient.startFlight({ lat: data.latitude, lng: data.longitude })
  }

  _onLanding (data) {
    this.flightStarted = false
    const duration = Math.round((Date.now() - this.flightStartTime) / 1000 / 60) // minutes
    console.log('[SimConnect] Atterrissage détecté, durée:', duration, 'min')
    this.mainWindow.webContents.send('sim:flight-end', {
      lat: data.latitude,
      lng: data.longitude,
      duration,
      log: this.flightLog
    })
    this.apiClient.endFlight({ lat: data.latitude, lng: data.longitude, duration })
  }

  _onDisconnect () {
    this._sendStatus('disconnected')
    this.disconnect()
  }

  _sendStatus (status) {
    this.mainWindow.webContents.send('sim:status', { type: 'simconnect', status })
  }

  disconnect () {
    if (this.interval) { clearInterval(this.interval); this.interval = null }
    if (this.handle) {
      try { this.handle.close() } catch (_) {}
      this.handle = null
    }
    this._sendStatus('disconnected')
  }
}

module.exports = SimConnectBridge
