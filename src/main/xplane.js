const dgram = require('dgram')

// X-Plane envoie des datagrams UDP sur le port 49000 (DATA output)
// On configure X-Plane pour envoyer les groupes de données nécessaires
// via le menu Data Output dans X-Plane

const XPLANE_UDP_PORT = 49000
const SEND_INTERVAL_MS = 5000

// Index des groupes de données X-Plane (DATA groups)
// Voir X-Plane manual pour la liste complète
const DATA_GROUPS = {
  3:  'speeds',       // speeds (IAS, TAS, GS...)
  17: 'pitch_roll',   // pitch & roll
  18: 'heading',      // heading
  20: 'altitude',     // altitude
  21: 'position',     // lat/lon/alt
  45: 'fuel',         // fuel quantity
  134: 'onground'     // on_ground (gear forces)
}

class XPlaneBridge {
  constructor (mainWindow, apiClient) {
    this.mainWindow = mainWindow
    this.apiClient = apiClient
    this.socket = null
    this.interval = null
    this.lastData = {}
    this.currentData = null
    this.isOnGround = true
    this.flightStarted = false
    this.flightStartTime = null
    this.flightLog = []
    this._sendTimer = null
  }

  async connect () {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket('udp4')

      this.socket.bind(XPLANE_UDP_PORT, '0.0.0.0', () => {
        console.log('[X-Plane] UDP écouté sur port', XPLANE_UDP_PORT)
        this._sendStatus('connected')
        resolve()
      })

      this.socket.on('error', (err) => {
        console.error('[X-Plane] Erreur UDP:', err)
        this._sendStatus('error')
        reject(err)
      })

      this.socket.on('message', (msg) => this._parseMessage(msg))

      // Timer d'envoi agrégé (toutes les 5s)
      this._sendTimer = setInterval(() => {
        if (this.currentData) {
          this._processData(this.currentData)
        }
      }, SEND_INTERVAL_MS)
    })
  }

  _parseMessage (buf) {
    // Format X-Plane DATA: header "DATA" (4 bytes) + index_byte + 8 floats × 4 bytes
    if (buf.length < 5) return
    const header = buf.slice(0, 4).toString('ascii')
    if (header !== 'DATA') return

    let offset = 5
    while (offset + 36 <= buf.length) {
      const groupId = buf.readInt32LE(offset)
      offset += 4
      const values = []
      for (let i = 0; i < 8; i++) {
        values.push(buf.readFloatLE(offset))
        offset += 4
      }
      this.lastData[groupId] = values
    }

    // Construire un objet data consolidé
    this.currentData = this._buildDataObject()
    // Envoi immédiat à l'UI (throttlé par le timer pour l'API)
    if (this.currentData) {
      this.mainWindow.webContents.send('sim:data', this.currentData)
    }
  }

  _buildDataObject () {
    const d = this.lastData
    if (!d[21]) return null // pas encore de position

    const speeds    = d[3]  || [0, 0, 0, 0, 0, 0, 0, 0]
    const pitchRoll = d[17] || [0, 0, 0, 0, 0, 0, 0, 0]
    const heading   = d[18] || [0, 0, 0, 0, 0, 0, 0, 0]
    const position  = d[21]
    const fuel      = d[45] || [0, 0, 0, 0, 0, 0, 0, 0]
    const onground  = d[134]

    return {
      latitude:  position[0],
      longitude: position[1],
      altitude:  Math.round(position[2] * 3.28084), // mètres → pieds
      ias:       Math.round(speeds[0] * 1.94384),   // m/s → noeuds
      tas:       Math.round(speeds[2] * 1.94384),
      gs:        Math.round(speeds[4] * 1.94384),
      vs:        Math.round(d[20] ? d[20][2] * 196.85 : 0), // m/s → fpm
      heading:   Math.round(heading[0]),
      pitch:     parseFloat(pitchRoll[0].toFixed(1)),
      bank:      parseFloat(pitchRoll[1].toFixed(1)),
      fuel:      Math.round(fuel[0] * 0.264172),  // litres → gallons
      onGround:  onground ? onground[0] > 0.5 : true,
      timestamp: Date.now()
    }
  }

  _processData (data) {
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
        hdg: data.heading,  vs: data.vs,
        ts:  data.timestamp
      })
      this.apiClient.sendPosition(data)
    }
  }

  _onTakeoff (data) {
    this.flightStarted = true
    this.flightStartTime = Date.now()
    this.flightLog = []
    this.mainWindow.webContents.send('sim:flight-start', {
      lat: data.latitude, lng: data.longitude, time: this.flightStartTime
    })
    this.apiClient.startFlight({ lat: data.latitude, lng: data.longitude })
  }

  _onLanding (data) {
    this.flightStarted = false
    const duration = Math.round((Date.now() - this.flightStartTime) / 60000)
    this.mainWindow.webContents.send('sim:flight-end', {
      lat: data.latitude, lng: data.longitude, duration, log: this.flightLog
    })
    this.apiClient.endFlight({ lat: data.latitude, lng: data.longitude, duration })
  }

  _sendStatus (status) {
    this.mainWindow.webContents.send('sim:status', { type: 'xplane', status })
  }

  disconnect () {
    if (this._sendTimer) { clearInterval(this._sendTimer); this._sendTimer = null }
    if (this.socket) {
      try { this.socket.close() } catch (_) {}
      this.socket = null
    }
    this._sendStatus('disconnected')
  }
}

module.exports = XPlaneBridge
