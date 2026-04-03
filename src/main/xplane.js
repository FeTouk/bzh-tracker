const dgram = require('dgram')
const http  = require('http')
const { findNearest } = require('./airports')

// Protocole RREF : le tracker s'abonne directement aux datarefs X-Plane
// Aucune configuration requise dans X-Plane (Settings > Data Output non nécessaire)
// X-Plane doit tourner sur 127.0.0.1:49000 (par défaut)
const XPLANE_HOST  = '127.0.0.1'
const XPLANE_PORT  = 49000   // port où X-Plane écoute
const LISTEN_PORT  = 49001   // port où on reçoit les réponses
const RREF_HZ      = 4       // fréquence de mise à jour en Hz
const API_SEND_INTERVAL_MS = 5000

// Datarefs à lire — chaque ID est arbitraire mais unique
const DATAREFS = [
  { id: 0,  key: 'lat',      path: 'sim/flightmodel/position/latitude'           }, // degrés
  { id: 1,  key: 'lon',      path: 'sim/flightmodel/position/longitude'          }, // degrés
  { id: 2,  key: 'alt_m',    path: 'sim/flightmodel/position/elevation'          }, // mètres MSL
  { id: 3,  key: 'ias',      path: 'sim/flightmodel/position/indicated_airspeed' }, // kias (noeuds)
  { id: 4,  key: 'tas_ms',   path: 'sim/flightmodel/position/true_airspeed'      }, // m/s
  { id: 5,  key: 'gs_ms',    path: 'sim/flightmodel/position/groundspeed'        }, // m/s
  { id: 6,  key: 'vs',       path: 'sim/flightmodel/position/vh_ind_fpm'         }, // ft/min
  { id: 7,  key: 'heading',  path: 'sim/flightmodel/position/psi'                }, // degrés vrai
  { id: 8,  key: 'bank',     path: 'sim/flightmodel/position/phi'                }, // degrés
  { id: 9,  key: 'pitch',    path: 'sim/flightmodel/position/theta'              }, // degrés
  { id: 10, key: 'onground', path: 'sim/flightmodel/failures/onground_any'       }, // 0 ou 1
  { id: 11, key: 'fuel_kg',  path: 'sim/flightmodel/weight/m_fuel_total'         }, // kg
  { id: 12, key: 'paused',     path: 'sim/time/paused'                                          }, // 0 ou 1
  // FSACARS extended data
  { id: 13, key: 'flap_ratio', path: 'sim/cockpit2/controls/flap_handle_deploy_ratio'           }, // 0..1
  { id: 14, key: 'flap_max',   path: 'sim/aircraft/controls/acf_flap1'                          }, // deg max
  { id: 15, key: 'weight_kg',  path: 'sim/flightmodel/weight/m_total'                           }, // kg total
  { id: 16, key: 'empty_kg',   path: 'sim/aircraft/weight/acf_m_empty'                          }, // kg vide
  { id: 17, key: 'wind_dir',   path: 'sim/cockpit2/gauges/indicators/wind_heading_deg_mag'      }, // degrés
  { id: 18, key: 'wind_speed', path: 'sim/cockpit2/gauges/indicators/wind_speed_kts'            }, // kts
]

const ID_TO_KEY = {}
DATAREFS.forEach(dr => { ID_TO_KEY[dr.id] = dr.key })

class XPlaneBridge {
  constructor (mainWindow, apiClient, onDisconnect) {
    this.mainWindow = mainWindow
    this.apiClient = apiClient
    this.onDisconnect = onDisconnect || null
    this.onAircraft   = null
    this.socket = null
    this.values = {}
    this.currentData = null
    this.isOnGround = true
    this.flightStarted = false
    this.flightStartTime = null
    this.totalDistanceNm = 0
    this.lastPosition = null
    this.touchdownVs = 0
    this.landingCandidate = false
    this.fuelAtTakeoff = null
    this._sendTimer = null
    this._pingTimer = null
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
    this._initialDataReceived = false
  }

  async connect () {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4')
      this.socket = socket

      socket.once('error', (err) => reject(err))

      socket.bind(LISTEN_PORT, '0.0.0.0', () => {
        console.log('[X-Plane] Socket sur port', LISTEN_PORT, '→ X-Plane', XPLANE_HOST + ':' + XPLANE_PORT)

        socket.removeAllListeners('error')
        socket.on('error', (err) => {
          console.error('[X-Plane] Erreur socket:', err.message)
          this._onDisconnect()
        })

        socket.on('message', (msg) => this._parseMessage(msg))

        // Abonnement initial aux datarefs
        this._subscribeAll()

        // Ré-abonnement toutes les 30s (si X-Plane redémarre)
        this._pingTimer = setInterval(() => {
          if (this.socket) this._subscribeAll()
        }, 30000)

        // Envoi position API
        this._sendTimer = setInterval(() => {
          if (this.currentData && this.flightStarted) {
            this.apiClient.sendPosition(this.currentData)
          }
        }, API_SEND_INTERVAL_MS)

        this._sendStatus('connected')
        // Détection de l'avion via X-Plane 12 REST API (silencieux si XP11)
        this._detectAircraft()
        resolve()
      })
    })
  }

  _detectAircraft () {
    const options = {
      hostname: '127.0.0.1',
      port: 8086,
      path: '/api/v2/datarefs?filter%5Bname%5D=sim%2Faircraft%2Fview%2Facf_ICAO',
      method: 'GET',
      timeout: 2000,
    }
    const req = http.request(options, (res) => {
      let raw = ''
      res.on('data', chunk => { raw += chunk })
      res.on('end', () => {
        try {
          const json = JSON.parse(raw)
          // Format X-Plane 12: { data: [{ name, value }] }
          const entry = json.data?.[0]
          const icao  = (entry?.value || '').replace(/\0/g, '').trim().toUpperCase()
          if (icao) {
            console.log('[X-Plane] Avion détecté:', icao)
            if (this.onAircraft) this.onAircraft(icao)
          }
        } catch (_) {}
      })
    })
    req.on('error', () => {}) // X-Plane 11 ou REST API désactivé
    req.on('timeout', () => req.destroy())
    req.end()
  }

  _subscribeAll () {
    DATAREFS.forEach(dr => this._sendRREF(dr.id, RREF_HZ, dr.path))
    console.log('[X-Plane] Abonnements RREF envoyés (' + DATAREFS.length + ' datarefs @ ' + RREF_HZ + 'Hz)')
  }

  // Format paquet RREF : "RREF\0" (5) + freq(int32LE,4) + id(int32LE,4) + path(char[400])
  _sendRREF (id, freq, path) {
    const buf = Buffer.alloc(413)
    buf.write('RREF', 0, 'ascii')
    buf[4] = 0
    buf.writeInt32LE(freq, 5)
    buf.writeInt32LE(id,   9)
    buf.write(path, 13, 'ascii')
    this.socket.send(buf, XPLANE_PORT, XPLANE_HOST, (err) => {
      if (err) console.error('[X-Plane] Erreur envoi RREF:', err.message)
    })
  }

  // Réponse RREF : "RREF\0" (5) + N × [id(int32LE,4) + value(float32LE,4)]
  _parseMessage (buf) {
    if (buf.length < 5) return
    const header = buf.slice(0, 4).toString('ascii')
    if (header !== 'RREF') {
      console.log('[X-Plane] Paquet inconnu:', JSON.stringify(header), buf.length, 'octets')
      return
    }

    let offset = 5
    while (offset + 8 <= buf.length) {
      const id    = buf.readInt32LE(offset)
      const value = buf.readFloatLE(offset + 4)
      offset += 8
      const key = ID_TO_KEY[id]
      if (key !== undefined) this.values[key] = value
    }

    const data = this._buildDataObject()
    if (!data) return

    this.currentData = data
    this.mainWindow.webContents.send('sim:data', data)

    // Premier paquet : calibrer isOnGround sans déclencher de détection
    if (!this._initialDataReceived) {
      this._initialDataReceived = true
      this.isOnGround = data.onGround
      return
    }

    this._processGroundState(data)
  }

  _buildDataObject () {
    const v = this.values
    if (v.lat === undefined) return null

    const heading  = Math.round(v.heading || 0)
    const ias      = Math.round(Math.abs(v.ias    || 0))
    const gs       = Math.round(Math.abs((v.gs_ms  || 0) * 1.94384))
    const tas      = Math.round(Math.abs((v.tas_ms || 0) * 1.94384))
    // Carburant : kg → gallons (Jet-A ≈ 3.04 kg/gal) pour affichage
    const fuelKg   = Math.abs(v.fuel_kg || 0)
    const fuel     = Math.round(fuelKg / 3.04)
    // FSACARS weights
    const totalWeightKg = Math.round(v.weight_kg || 0)
    const emptyWeightKg = Math.round(v.empty_kg  || 0)
    const zfw           = Math.max(0, totalWeightKg - Math.round(fuelKg))
    const payload       = Math.max(0, zfw - emptyWeightKg)
    // Flaps (ratio × max_deg)
    const flaps = Math.round((v.flap_ratio || 0) * (v.flap_max || 40))
    // Wind
    const windDir   = Math.round(v.wind_dir   || 0)
    const windSpeed = Math.round(v.wind_speed || 0)
    const windRad   = (windDir - heading) * Math.PI / 180
    const headwind  = parseFloat((windSpeed * Math.cos(windRad)).toFixed(1))
    const crosswind = parseFloat((windSpeed * Math.sin(windRad)).toFixed(1))

    return {
      latitude:  v.lat     || 0,
      longitude: v.lon     || 0,
      altitude:  Math.round((v.alt_m || 0) * 3.28084), // m → ft
      ias, tas, gs,
      vs:        Math.round(v.vs  || 0),
      heading,
      pitch:     parseFloat((v.pitch || 0).toFixed(1)),
      bank:      parseFloat((v.bank  || 0).toFixed(1)),
      fuel, fuelKg: Math.round(fuelKg),
      onGround:  (v.onground || 0) > 0.5,
      timestamp: Date.now(),
      // FSACARS extended
      flaps, totalWeightKg, zfw, payload, windDir, windSpeed, headwind, crosswind
    }
  }

  _processGroundState (data) {
    // Taxi & fuel tracking
    if (data.onGround) {
      if (this.fuelAtGroundStart === null && !this.flightStarted) {
        this.fuelAtGroundStart = data.fuelKg
      }
      if (!this.flightStarted && !this._landingCompleted) {
        if (data.gs > this.maxTaxiSpeedOnGround) this.maxTaxiSpeedOnGround = data.gs
      } else if (this._landingCompleted) {
        if (data.gs > this.maxTaxiSpeedDest) {
          this.maxTaxiSpeedDest = data.gs
          if (this.apiClient.pendingFlightData) {
            this.apiClient.pendingFlightData.destination_max_taxi_speed = this.maxTaxiSpeedDest
          }
        }
      }
    }
    // Wind sampling during flight
    if (this.flightStarted && !data.onGround && data.windSpeed > 0) {
      this._windSamples.push({ dir: data.windDir, speed: data.windSpeed })
    }

    if (this.isOnGround && !data.onGround && data.ias > 40) {
      this.landingCandidate = false
      this._onTakeoff(data)
    } else if (!this.isOnGround && data.onGround && this.flightStarted) {
      this.landingCandidate = true
      this.touchdownVs = Math.abs(data.vs)  // taux de descente positif (convention FSACARS)
      this.touchdownSnapshot = {
        flaps: data.flaps, ias: data.ias, weight: data.totalWeightKg,
        headwind: data.headwind, crosswind: data.crosswind
      }
      console.log('[X-Plane] Touchdown, VS:', data.vs, 'fpm')
    } else if (this.landingCandidate && !data.onGround) {
      this.landingCandidate = false
      console.log('[X-Plane] Remise des gaz détectée')
    } else if (this.landingCandidate && data.onGround && data.gs < 10) {
      this.landingCandidate = false
      this._onLanding(data)
    }

    if (this.flightStarted) {
      // Pause via dataref sim/time/paused
      const paused = (this.values.paused || 0) > 0.5
      if (paused !== this.isPaused) {
        if (paused) {
          this.isPaused = true
          this.pauseStartTime = Date.now()
          console.log('[X-Plane] Simulateur mis en pause')
          this.mainWindow.webContents.send('sim:paused', true)
        } else {
          this.isPaused = false
          if (this.pauseStartTime) {
            this.totalPauseSeconds += (Date.now() - this.pauseStartTime) / 1000
          }
          this.pauseStartTime = null
          console.log('[X-Plane] Simulateur repris (pause totale:', Math.round(this.totalPauseSeconds), 's)')
          this.mainWindow.webContents.send('sim:paused', false)
        }
      }

      // Violation de vitesse : IAS > 250 kts sous 10 000 ft
      if (!paused) {
        const now = Date.now()
        const dt = this._lastDataTime ? (now - this._lastDataTime) / 1000 : 0
        if (data.ias > 250 && data.altitude < 10000) {
          this.totalSpeedViolationSeconds += dt
        }
        this._lastDataTime = now
      }

      if (this.lastPosition) {
        this.totalDistanceNm += _haversineNm(
          this.lastPosition.latitude, this.lastPosition.longitude,
          data.latitude, data.longitude
        )
      }
    }

    this.isOnGround = data.onGround
    if (this.flightStarted) this.lastPosition = data
  }

  _onTakeoff (data) {
    this.flightStarted = true
    this.flightStartTime = Date.now()
    this.totalDistanceNm = 0
    this.lastPosition = data
    this.fuelAtTakeoff = data.fuel
    this.totalPauseSeconds = 0
    this.totalSpeedViolationSeconds = 0
    this._lastDataTime = Date.now()
    this._landingCompleted = false
    this._windSamples = []
    // Taxi fuel (X-Plane fuel en kg)
    const taxiFuelKg = this.fuelAtGroundStart !== null ? Math.max(0, Math.round(this.fuelAtGroundStart - data.fuelKg)) : null
    this.taxiFuelKg = taxiFuelKg
    this.fuelAtGroundStart = null
    // Lock taxi speed origin
    this.maxTaxiSpeedOrigin   = this.maxTaxiSpeedOnGround
    this.maxTaxiSpeedOnGround = 0
    this.maxTaxiSpeedDest     = 0
    // Takeoff snapshot
    this.takeoffSnapshot = {
      flaps: data.flaps, ias: data.ias, weight: data.totalWeightKg,
      headwind: data.headwind, crosswind: data.crosswind,
      zfw: data.zfw, payload: data.payload
    }
    console.log('[X-Plane] Décollage détecté')

    const depIcao = findNearest(data.latitude, data.longitude)
    console.log('[X-Plane] AD départ:', depIcao || 'inconnu')

    this.mainWindow.webContents.send('sim:flight-start', {
      lat: data.latitude, lng: data.longitude,
      time: this.flightStartTime, depIcao
    })
  }

  _onLanding (data) {
    this.flightStarted = false
    this._landingCompleted = true
    this.maxTaxiSpeedDest = 0
    const duration              = Math.round((Date.now() - this.flightStartTime) / 60000)
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
    console.log('[X-Plane] Atterrissage — durée:', duration, 'min | dist:', distance, 'NM | VS:', landingFpm, 'fpm | carb:', fuelUsed, 'gal | arr:', arrIcao || 'inconnu')

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
      destMaxTaxiSpeed:   0,
      taxiFuelKg:         this.taxiFuelKg ?? null,
      avgWindDir, avgWindSpeed,
      fsVersion: 'XP',
    })
  }

  _onDisconnect () {
    this._sendStatus('disconnected')
    this.disconnect()
    if (this.onDisconnect) this.onDisconnect()
  }

  _sendStatus (status) {
    this.mainWindow.webContents.send('sim:status', { type: 'xplane', status })
  }

  disconnect () {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null }
    if (this._sendTimer) { clearInterval(this._sendTimer); this._sendTimer = null }
    if (this.socket) {
      // Désabonnement propre avant fermeture
      try { DATAREFS.forEach(dr => this._sendRREF(dr.id, 0, dr.path)) } catch (_) {}
      setTimeout(() => {
        try { this.socket.close() } catch (_) {}
        this.socket = null
      }, 200)
    }
    this._sendStatus('disconnected')
  }
}

function _haversineNm (lat1, lon1, lat2, lon2) {
  const R = 3440.065
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

module.exports = XPlaneBridge
