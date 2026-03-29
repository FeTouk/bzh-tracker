const {
  open,
  Protocol,
  SimConnectDataType,
  SimObjectType
} = require('node-simconnect')

const { findNearest } = require('./airports')

const SEND_INTERVAL_MS = 5000
const DEF_ID          = 0
const REQ_ID          = 0
const DEF_ID_AIRCRAFT = 1
const REQ_ID_AIRCRAFT = 1
const EVT_PAUSE       = 1

class SimConnectBridge {
  constructor (mainWindow, apiClient, onDisconnect) {
    this.mainWindow = mainWindow
    this.apiClient = apiClient
    this.onDisconnect = onDisconnect || null
    this.onAircraft   = null
    this.handle = null
    this.interval = null
    this.currentData = null
    this.isOnGround = true
    this.flightStarted = false
    this.flightStartTime = null
    this.flightLog = []
    this.totalDistanceNm = 0
    this.lastPosition = null
    this.lastVs = 0
    this.touchdownVs = 0
    this.landingCandidate = false
    this.fuelAtTakeoff = null
    // Pause tracking
    this.isPaused = false
    this.pauseStartTime = null
    this.totalPauseSeconds = 0
    // Speed violation tracking (IAS > 250 kts sous FL100)
    this.speedViolationStartTime = null
    this.totalSpeedViolationSeconds = 0
    this._lastDataTime = null
  }

  async connect () {
    let recvOpen, handle
    try {
      ;({ recvOpen, handle } = await open('BZH Tracker', Protocol.SunRise))
    } catch (e) {
      if (e.message && e.message.includes('protocol')) {
        ;({ recvOpen, handle } = await open('BZH Tracker', Protocol.KittyHawk))
      } else {
        throw e
      }
    }
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

    // Détection de l'avion (ATC TYPE = code ICAO, ex: "B738")
    handle.addToDataDefinition(DEF_ID_AIRCRAFT, 'ATC TYPE', null, SimConnectDataType.STRING32)
    handle.requestDataOnSimObjectType(REQ_ID_AIRCRAFT, DEF_ID_AIRCRAFT, 0, SimObjectType.USER)

    // Polling toutes les 5 secondes
    this.interval = setInterval(() => {
      handle.requestDataOnSimObjectType(REQ_ID, DEF_ID, 0, SimObjectType.USER)
    }, SEND_INTERVAL_MS)

    // Abonnement à l'événement de pause
    handle.subscribeToSystemEvent(EVT_PAUSE, 'Pause')
    handle.on('event', (recv) => {
      if (recv.clientEventId === EVT_PAUSE) {
        this._onPauseChange(recv.data === 1)
      }
    })

    handle.on('simObjectDataByType', (recv) => {
      if (recv.requestID === REQ_ID_AIRCRAFT) {
        try {
          // readString32() calls skip(32) which throws when newOffset === limit (ByteBuffer quirk).
          // readCString(offset) reads the null-terminated string at an absolute position
          // without advancing the cursor, so it never hits the boundary.
          const type = recv.data.buffer.readCString(recv.data.getOffset()).string.trim().toUpperCase()
          if (type) {
            console.log('[SimConnect] Avion détecté:', type)
            if (this.onAircraft) this.onAircraft(type)
          }
        } catch (e) {
          console.warn('[SimConnect] Lecture type avion échouée:', e.message)
        }
      } else {
        this._onData(recv)
      }
    })
    handle.on('exception',           (e)    => console.error('[SimConnect] Exception:', e))
    handle.on('error',               (e)    => { console.error('[SimConnect] Erreur:', e.message); this._onDisconnect() })
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
      // Décollage détecté
      this.landingCandidate = false
      this._onTakeoff(data)
    } else if (!this.isOnGround && data.onGround && this.flightStarted) {
      // Roues au sol — début du candidat atterrissage
      this.landingCandidate = true
      this.touchdownVs = data.vs
      console.log('[SimConnect] Roues au sol, attente immobilisation...')
    } else if (this.landingCandidate && !data.onGround) {
      // Remise des gaz détectée
      this.landingCandidate = false
      console.log('[SimConnect] Remise des gaz détectée, vol continue')
    } else if (this.landingCandidate && data.onGround && data.gs < 10) {
      // Avion immobilisé → atterrissage confirmé
      this.landingCandidate = false
      this._onLanding(data)
    }

    this.isOnGround = data.onGround

    this.lastVs = data.vs

    if (this.flightStarted) {
      // Violation de vitesse : IAS > 250 kts sous 10 000 ft
      const now = Date.now()
      const dt = this._lastDataTime ? (now - this._lastDataTime) / 1000 : 0
      if (data.ias > 250 && data.altitude < 10000) {
        this.totalSpeedViolationSeconds += dt
      }
      this._lastDataTime = now

      if (this.lastPosition) {
        this.totalDistanceNm += _haversineNm(
          this.lastPosition.latitude, this.lastPosition.longitude,
          data.latitude, data.longitude
        )
      }
      this.lastPosition = data
      this.apiClient.sendPosition(data)
    }
  }

  _onPauseChange (paused) {
    if (paused && !this.isPaused) {
      this.isPaused = true
      this.pauseStartTime = Date.now()
      console.log('[SimConnect] Simulateur mis en pause')
      this.mainWindow.webContents.send('sim:paused', true)
    } else if (!paused && this.isPaused) {
      this.isPaused = false
      if (this.pauseStartTime && this.flightStarted) {
        this.totalPauseSeconds += (Date.now() - this.pauseStartTime) / 1000
      }
      this.pauseStartTime = null
      console.log('[SimConnect] Simulateur repris (pause totale:', Math.round(this.totalPauseSeconds), 's)')
      this.mainWindow.webContents.send('sim:paused', false)
    }
  }

  _onTakeoff (data) {
    this.flightStarted = true
    this.flightStartTime = Date.now()
    this.flightLog = []
    this.totalDistanceNm = 0
    this.lastPosition = data
    this.fuelAtTakeoff = data.fuel
    this.totalPauseSeconds = 0
    this.totalSpeedViolationSeconds = 0
    this._lastDataTime = Date.now()
    console.log('[SimConnect] Décollage détecté')

    const depIcao = findNearest(data.latitude, data.longitude)
    console.log('[SimConnect] AD départ détecté:', depIcao || 'inconnu')

    this.mainWindow.webContents.send('sim:flight-start', {
      lat: data.latitude,
      lng: data.longitude,
      time: this.flightStartTime,
      depIcao
    })
  }

  _onLanding (data) {
    this.flightStarted = false
    const duration             = Math.round((Date.now() - this.flightStartTime) / 1000 / 60)
    const distance             = Math.round(this.totalDistanceNm)
    const landingFpm           = this.touchdownVs
    const fuelUsed             = this.fuelAtTakeoff !== null ? Math.round(this.fuelAtTakeoff - data.fuel) : null
    const pauseSeconds         = Math.round(this.totalPauseSeconds)
    const speedViolationSeconds = Math.round(this.totalSpeedViolationSeconds)

    const arrIcao = findNearest(data.latitude, data.longitude)
    console.log('[SimConnect] Atterrissage — durée:', duration, 'min | distance:', distance, 'NM | VS:', landingFpm, 'fpm | carburant:', fuelUsed, 'gal | arr:', arrIcao || 'inconnu | pause:', pauseSeconds, 's | overspeed:', speedViolationSeconds, 's')

    this.mainWindow.webContents.send('sim:flight-end', { duration, distance, landingFpm, fuelUsed, arrIcao, pauseSeconds, speedViolationSeconds })
    this.apiClient.endFlight({ duration, distance, fuelUsed, landingFpm, pauseSeconds, speedViolationSeconds })
  }

  _onDisconnect () {
    this._sendStatus('disconnected')
    this.disconnect()
    if (this.onDisconnect) this.onDisconnect()
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

function _haversineNm (lat1, lon1, lat2, lon2) {
  const R = 3440.065 // rayon terrestre en NM
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

module.exports = SimConnectBridge
