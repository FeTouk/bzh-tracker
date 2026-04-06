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
    this._touchdownCaptured = false
    this.fuelAtTakeoff = null
    // Pause tracking
    this.isPaused = false
    this.pauseStartTime = null
    this.totalPauseSeconds = 0
    // Speed violation tracking (IAS > 250 kts sous FL100)
    this.speedViolationStartTime = null
    this.totalSpeedViolationSeconds = 0
    this._lastDataTime = null
    // FSACARS extended data
    this._landingCompleted = false
    this.maxTaxiSpeedOnGround = 0
    this.maxTaxiSpeedOrigin   = 0
    this.maxTaxiSpeedDest     = 0
    this.fuelAtGroundStart    = null
    this.taxiFuelKg           = null
    this.takeoffSnapshot      = null
    this.touchdownSnapshot    = null
    this._windSamples         = []
    this._initialDataReceived = false  // évite un faux décollage si connexion en vol
    this._lastPosrepTime      = null
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
    // FSACARS extended data
    handle.addToDataDefinition(DEF_ID, 'TRAILING EDGE FLAPS LEFT ANGLE', 'Degrees',         SimConnectDataType.FLOAT64)
    handle.addToDataDefinition(DEF_ID, 'TOTAL WEIGHT',                   'Pounds',          SimConnectDataType.FLOAT64)
    handle.addToDataDefinition(DEF_ID, 'EMPTY WEIGHT',                   'Pounds',          SimConnectDataType.FLOAT64)
    handle.addToDataDefinition(DEF_ID, 'AMBIENT WIND DIRECTION',         'Degrees',         SimConnectDataType.FLOAT64)
    handle.addToDataDefinition(DEF_ID, 'AMBIENT WIND VELOCITY',          'Knots',           SimConnectDataType.FLOAT64)
    handle.addToDataDefinition(DEF_ID, 'PLANE ALT ABOVE GROUND',         'Feet',            SimConnectDataType.FLOAT64)

    // Détection de l'avion via TITLE (nom complet depuis aircraft.cfg)
    handle.addToDataDefinition(DEF_ID_AIRCRAFT, 'TITLE', null, SimConnectDataType.STRING256)
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
          const type = recv.data.buffer.readCString(recv.data.getOffset()).string.trim()
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

    const latitude  = d.readFloat64()
    const longitude = d.readFloat64()
    const altitude  = Math.round(d.readFloat64())
    const ias       = Math.round(d.readFloat64())
    const tas       = Math.round(d.readFloat64())
    const vs        = Math.round(d.readFloat64())
    const heading   = Math.round(d.readFloat64())
    const onGround  = d.readFloat64() === 1
    const fuel      = Math.round(d.readFloat64())
    const gs        = Math.round(d.readFloat64())
    const bank      = parseFloat(d.readFloat64().toFixed(1))
    const pitch     = parseFloat(d.readFloat64().toFixed(1))
    // FSACARS extended vars
    const flaps         = Math.round(d.readFloat64())
    const totalWtLbs    = d.readFloat64()
    const emptyWtLbs    = d.readFloat64()
    const windDir       = Math.round(d.readFloat64())
    const windSpeed     = Math.round(d.readFloat64())
    const altAgl        = parseFloat(d.readFloat64().toFixed(1))
    // Derived weights (lbs → kg, Jet-A ≈ 3.04 kg/gal)
    const totalWeightKg = Math.round(totalWtLbs * 0.453592)
    const emptyWeightKg = Math.round(emptyWtLbs * 0.453592)
    const fuelWeightKg  = Math.round(fuel * 3.04)
    const zfw           = Math.max(0, totalWeightKg - fuelWeightKg)
    const payload       = Math.max(0, zfw - emptyWeightKg)
    // Wind components relative to heading
    const windRad  = (windDir - heading) * Math.PI / 180
    const headwind  = parseFloat((windSpeed * Math.cos(windRad)).toFixed(1))
    const crosswind = parseFloat((windSpeed * Math.sin(windRad)).toFixed(1))

    const data = {
      latitude, longitude, altitude, ias, tas, vs, heading, onGround,
      fuel, gs, bank, pitch, altAgl, timestamp: Date.now(),
      flaps, totalWeightKg, zfw, payload, windDir, windSpeed, headwind, crosswind
    }

    this.currentData = data
    this.mainWindow.webContents.send('sim:data', data)

    // Premier paquet : calibrer isOnGround sans déclencher de détection
    if (!this._initialDataReceived) {
      this._initialDataReceived = true
      this.isOnGround = onGround
      return
    }

    // Taxi & fuel tracking (pre-flight)
    if (onGround) {
      if (this.fuelAtGroundStart === null && !this.flightStarted) {
        this.fuelAtGroundStart = fuel
      }
      if (!this.flightStarted && !this._landingCompleted) {
        if (gs > this.maxTaxiSpeedOnGround) this.maxTaxiSpeedOnGround = gs
      } else if (this._landingCompleted) {
        if (gs > this.maxTaxiSpeedDest) {
          this.maxTaxiSpeedDest = gs
          if (this.apiClient.pendingFlightData) {
            this.apiClient.pendingFlightData.destination_max_taxi_speed = this.maxTaxiSpeedDest
          }
        }
      }
    }
    // Wind sampling during flight
    if (this.flightStarted && !onGround && windSpeed > 0) {
      this._windSamples.push({ dir: windDir, speed: windSpeed })
    }

    // Capture VS au touchdown (transition air→sol) — le vol démarre/s'arrête manuellement
    if (!this.isOnGround && data.onGround && this.flightStarted) {
      this._touchdownCaptured = true
      this.touchdownVs = Math.max(Math.abs(this.lastVs), Math.abs(data.vs))
      this.touchdownSnapshot = {
        flaps: data.flaps, ias: data.ias, weight: data.totalWeightKg,
        headwind: data.headwind, crosswind: data.crosswind,
        bank: data.bank, pitch: data.pitch, altAgl: data.altAgl
      }
      console.log('[SimConnect] Touchdown, VS:', this.touchdownVs, 'fpm (lastVs:', this.lastVs, ', onGroundVs:', data.vs, ')')
      this.mainWindow.webContents.send('sim:touchdown', { fpm: this.touchdownVs })
      this.apiClient.sendLanding({
        fpm: this.touchdownVs, ias: data.ias,
        bank: data.bank, pitch: data.pitch, altAgl: data.altAgl
      })
    } else if (this.flightStarted && this.isOnGround && !data.onGround) {
      // Remise des gaz après touchdown
      this._touchdownCaptured = false
      this.touchdownVs = 0
      this.touchdownSnapshot = null
      console.log('[SimConnect] Remise des gaz détectée, vol continue')
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

      const posrepInterval = data.altitude < 10000 ? 5000 : 20000
      if (!this._lastPosrepTime || now - this._lastPosrepTime >= posrepInterval) {
        this._lastPosrepTime = now
        this.apiClient.sendPosition(data)
      }
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
    this._landingCompleted = false
    this._touchdownCaptured = false
    this.touchdownVs = 0
    this.touchdownSnapshot = null
    this._windSamples = []
    // Taxi fuel
    const taxiFuelGal = this.fuelAtGroundStart !== null ? Math.max(0, this.fuelAtGroundStart - data.fuel) : null
    this.taxiFuelKg = taxiFuelGal !== null ? Math.round(taxiFuelGal * 3.04) : null
    this.fuelAtGroundStart = null
    // Lock taxi speed origin
    this.maxTaxiSpeedOrigin  = this.maxTaxiSpeedOnGround
    this.maxTaxiSpeedOnGround = 0
    this.maxTaxiSpeedDest     = 0
    // Takeoff snapshot
    this.takeoffSnapshot = {
      flaps: data.flaps, ias: data.ias, weight: data.totalWeightKg,
      headwind: data.headwind, crosswind: data.crosswind,
      zfw: data.zfw, payload: data.payload
    }
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
    this._landingCompleted = true
    this.maxTaxiSpeedDest = 0
    const duration              = Math.round((Date.now() - this.flightStartTime) / 1000 / 60)
    const distance              = Math.round(this.totalDistanceNm)
    const landingFpm            = this.touchdownVs
    const fuelUsed              = this.fuelAtTakeoff !== null ? Math.round(this.fuelAtTakeoff - data.fuel) : null
    const pauseSeconds          = Math.round(this.totalPauseSeconds)
    const speedViolationSeconds = Math.round(this.totalSpeedViolationSeconds)

    // Avg wind (vector average)
    let avgWindDir = null, avgWindSpeed = null
    if (this._windSamples.length > 0) {
      avgWindSpeed = Math.round(this._windSamples.reduce((s, w) => s + w.speed, 0) / this._windSamples.length)
      const sinSum = this._windSamples.reduce((s, w) => s + Math.sin(w.dir * Math.PI / 180), 0)
      const cosSum = this._windSamples.reduce((s, w) => s + Math.cos(w.dir * Math.PI / 180), 0)
      avgWindDir = Math.round(((Math.atan2(sinSum, cosSum) * 180 / Math.PI) + 360) % 360)
    }

    const to  = this.takeoffSnapshot  || {}
    const lnd = this.touchdownSnapshot || {}
    const arrIcao = findNearest(data.latitude, data.longitude)
    console.log('[SimConnect] Atterrissage — durée:', duration, 'min | dist:', distance, 'NM | VS:', landingFpm, 'fpm | carb:', fuelUsed, 'gal | arr:', arrIcao || 'inconnu')

    this.mainWindow.webContents.send('sim:flight-end', { duration, distance, landingFpm, fuelUsed, arrIcao, pauseSeconds, speedViolationSeconds })
    this.apiClient.endFlight({
      duration, distance, fuelUsed, landingFpm, pauseSeconds, speedViolationSeconds,
      takeoffFlaps:    to.flaps    ?? null,
      takeoffSpeed:    to.ias      ?? null,
      takeoffWeight:   to.weight   ?? null,
      takeoffHeadwind: to.headwind ?? null,
      takeoffCrosswind:to.crosswind?? null,
      zfw:             to.zfw      ?? null,
      payload:         to.payload  ?? null,
      landingFlaps:    lnd.flaps   ?? null,
      landingSpeed:    lnd.ias     ?? null,
      landingWeight:   lnd.weight  ?? null,
      landingHeadwind: lnd.headwind?? null,
      landingCrosswind:lnd.crosswind?? null,
      originMaxTaxiSpeed: this.maxTaxiSpeedOrigin || null,
      destMaxTaxiSpeed:   0, // mis à jour dynamiquement pendant le taxi d'arrivée
      taxiFuelKg:         this.taxiFuelKg ?? null,
      avgWindDir, avgWindSpeed,
      fsVersion: 'MSFS',
    })
  }

  manualStart () {
    if (!this.currentData) return { error: 'Pas de données simulateur disponibles' }
    if (this.flightStarted) return { error: 'Vol déjà en cours' }
    this._onTakeoff(this.currentData)
    return { success: true }
  }

  manualStop () {
    if (!this.flightStarted) return { error: 'Aucun vol en cours' }
    const data = this.currentData || {}
    // Si pas encore de touchdown capturé (arrêt manuel en vol), utiliser le VS courant
    if (!this._touchdownCaptured) {
      this.touchdownVs = Math.abs(data.vs || this.lastVs || 0)
    }
    this._onLanding(data)
    return { success: true }
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
