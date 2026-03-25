const dgram = require('dgram')

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
]

const ID_TO_KEY = {}
DATAREFS.forEach(dr => { ID_TO_KEY[dr.id] = dr.key })

class XPlaneBridge {
  constructor (mainWindow, apiClient, onDisconnect) {
    this.mainWindow = mainWindow
    this.apiClient = apiClient
    this.onDisconnect = onDisconnect || null
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
        resolve()
      })
    })
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
    this._processGroundState(data)
  }

  _buildDataObject () {
    const v = this.values
    if (v.lat === undefined) return null

    const ias = Math.round(Math.abs(v.ias    || 0))
    const gs  = Math.round(Math.abs((v.gs_ms  || 0) * 1.94384))
    const tas = Math.round(Math.abs((v.tas_ms || 0) * 1.94384))
    // Carburant : kg → gallons (avgas ≈ 2.72 kg/gal)
    const fuel = Math.round(Math.abs((v.fuel_kg || 0) / 2.72))

    return {
      latitude:  v.lat     || 0,
      longitude: v.lon     || 0,
      altitude:  Math.round((v.alt_m || 0) * 3.28084), // m → ft
      ias,
      tas,
      gs,
      vs:        Math.round(v.vs      || 0),
      heading:   Math.round(v.heading || 0),
      pitch:     parseFloat((v.pitch  || 0).toFixed(1)),
      bank:      parseFloat((v.bank   || 0).toFixed(1)),
      fuel,
      onGround:  (v.onground || 0) > 0.5,
      timestamp: Date.now()
    }
  }

  _processGroundState (data) {
    if (this.isOnGround && !data.onGround && data.ias > 40) {
      this.landingCandidate = false
      this._onTakeoff(data)
    } else if (!this.isOnGround && data.onGround && this.flightStarted) {
      this.landingCandidate = true
      this.touchdownVs = data.vs
      console.log('[X-Plane] Touchdown, VS:', data.vs, 'fpm')
    } else if (this.landingCandidate && !data.onGround) {
      this.landingCandidate = false
      console.log('[X-Plane] Remise des gaz détectée')
    } else if (this.landingCandidate && data.onGround && data.gs < 10) {
      this.landingCandidate = false
      this._onLanding(data)
    }

    if (this.flightStarted && this.lastPosition) {
      this.totalDistanceNm += _haversineNm(
        this.lastPosition.latitude, this.lastPosition.longitude,
        data.latitude, data.longitude
      )
    }

    this.isOnGround = data.onGround
    if (this.flightStarted) this.lastPosition = data
  }

  async _onTakeoff (data) {
    this.flightStarted = true
    this.flightStartTime = Date.now()
    this.totalDistanceNm = 0
    this.lastPosition = data
    this.fuelAtTakeoff = data.fuel
    console.log('[X-Plane] Décollage détecté')

    const depIcao = await this.apiClient.getNearestAirport(data.latitude, data.longitude)
    console.log('[X-Plane] AD départ:', depIcao || 'inconnu')

    this.mainWindow.webContents.send('sim:flight-start', {
      lat: data.latitude, lng: data.longitude,
      time: this.flightStartTime, depIcao
    })
  }

  async _onLanding (data) {
    this.flightStarted = false
    const duration   = Math.round((Date.now() - this.flightStartTime) / 60000)
    const distance   = Math.round(this.totalDistanceNm)
    const landingFpm = this.touchdownVs
    const fuelUsed   = this.fuelAtTakeoff !== null ? Math.round(this.fuelAtTakeoff - data.fuel) : null

    const arrIcao = await this.apiClient.getNearestAirport(data.latitude, data.longitude)
    console.log('[X-Plane] Atterrissage — durée:', duration, 'min | dist:', distance, 'NM | VS:', landingFpm, 'fpm | carb:', fuelUsed, 'gal')

    this.mainWindow.webContents.send('sim:flight-end', { duration, distance, landingFpm, fuelUsed, arrIcao })
    this.apiClient.endFlight({ duration, distance, fuelUsed, landingFpm })
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
