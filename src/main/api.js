const axios = require('axios')
const { io } = require('socket.io-client')

// À configurer selon l'URL de breizhairV2
const API_BASE = process.env.BZH_API_URL || 'https://breizhair.fr/api'
const WS_URL   = process.env.BZH_WS_URL  || 'https://breizhair.fr'

class ApiClient {
  constructor (store, mainWindow) {
    this.store = store
    this.mainWindow = mainWindow
    this.token = null
    this.socket = null
    this.currentFlightId = null

    this.http = axios.create({
      baseURL: API_BASE,
      timeout: 10000,
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' }
    })

    // Intercepteur pour ajouter le token Sanctum
    this.http.interceptors.request.use((config) => {
      if (this.token) {
        config.headers['Authorization'] = `Bearer ${this.token}`
      }
      return config
    })

    // Intercepteur pour gérer les erreurs globalement
    this.http.interceptors.response.use(
      (res) => res,
      (err) => {
        const msg = err.response?.data?.message || err.message
        this._sendApiStatus('error', msg)
        return Promise.reject(new Error(msg))
      }
    )
  }

  setToken (token) {
    this.token = token
    if (token) {
      this._connectWebSocket()
    } else {
      this._disconnectWebSocket()
    }
  }

  // ─── Auth ─────────────────────────────────────────────────────────────────
  async login (email, password) {
    const res = await this.http.post('/tracker/login', { email, password })
    const { token, user } = res.data

    this.setToken(token)
    this._sendApiStatus('ok', 'Connecté')
    return { token, user }
  }

  async logout () {
    try {
      await this.http.post('/tracker/logout')
    } catch (_) {}
    this.setToken(null)
    this.currentFlightId = null
  }

  // ─── Vol ──────────────────────────────────────────────────────────────────
  async startFlight (data) {
    try {
      const res = await this.http.post('/tracker/session/start', {
        dep_lat:    data.lat,
        dep_lng:    data.lng,
        started_at: new Date().toISOString()
      })
      this.currentFlightId = res.data.flight_hash
      this._sendApiStatus('ok', `Vol ${this.currentFlightId} démarré`)
      console.log('[API] Vol démarré:', this.currentFlightId)
    } catch (err) {
      console.error('[API] startFlight error:', err.message)
    }
  }

  async sendPosition (data) {
    if (!this.currentFlightId) return
    try {
      await this.http.post('/tracker/posrep', {
        flight_hash: this.currentFlightId,
        lat: data.latitude,
        lng: data.longitude,
        alt: data.altitude,
        ias: data.ias,
        hdg: data.heading,
        vs:  data.vs,
        ts:  data.timestamp
      })
      this._sendApiStatus('ok')
    } catch (err) {
      this._sendApiStatus('error', err.message)
    }
  }

  async endFlight (data) {
    if (!this.currentFlightId) return
    try {
      await this.http.post('/tracker/session/end', {
        flight_hash:   this.currentFlightId,
        arr_lat:       data.lat,
        arr_lng:       data.lng,
        block_minutes: data.duration,
        ended_at:      new Date().toISOString()
      })
      this._sendApiStatus('ok', 'Vol terminé')
    } catch (err) {
      console.error('[API] endFlight error:', err.message)
    }
  }

  async submitPirep (pirepData) {
    const res = await this.http.post('/tracker/session/end', {
      flight_hash:   this.currentFlightId,
      dep_icao:      pirepData.depIcao,
      arr_icao:      pirepData.arrIcao,
      aircraft:      pirepData.aircraft,
      block_minutes: pirepData.flightTime,
      fuel_used:     pirepData.fuelUsed,
      pax:           pirepData.pax,
      cargo:         pirepData.cargo,
      remarks:       pirepData.remarks,
      rating:        pirepData.rating
    })
    this.currentFlightId = null
    return res.data
  }

  // ─── WebSocket (Laravel Reverb) ───────────────────────────────────────────
  _connectWebSocket () {
    if (this.socket) return

    this.socket = io(WS_URL, {
      auth: { token: this.token },
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 3000
    })

    this.socket.on('connect', () => {
      console.log('[WS] Connecté à Reverb')
      this._sendApiStatus('ok', 'WebSocket connecté')
    })

    this.socket.on('disconnect', () => {
      console.log('[WS] Déconnecté')
      this._sendApiStatus('warning', 'WebSocket déconnecté')
    })

    this.socket.on('connect_error', (err) => {
      console.warn('[WS] Erreur:', err.message)
    })
  }

  _disconnectWebSocket () {
    if (this.socket) {
      this.socket.disconnect()
      this.socket = null
    }
  }

  _sendApiStatus (status, message = '') {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('api:status', { status, message })
    }
  }
}

module.exports = ApiClient
