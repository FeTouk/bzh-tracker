const axios = require('axios')
const crypto = require('crypto')
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
  }

  // ─── Auth ─────────────────────────────────────────────────────────────────
  async login (email, password) {
    const res = await this.http.post('/tracker/login', { email, password })
    const { token, user } = res.data

    const hash = crypto.createHash('md5').update(email.trim().toLowerCase()).digest('hex')
    user.avatar = `https://www.gravatar.com/avatar/${hash}?s=72&d=mp`

    this.setToken(token)
    this._sendApiStatus('ok', 'Connecté')
    return { token, user }
  }

  async exchangeToken (token) {
    const res = await this.http.post('/tracker/auth/exchange', { token })
    const { token: sanctumToken, user } = res.data

    const hash = crypto.createHash('md5').update((user.email || '').trim().toLowerCase()).digest('hex')
    user.avatar = `https://www.gravatar.com/avatar/${hash}?s=72&d=mp`

    this.setToken(sanctumToken)
    this._sendApiStatus('ok', 'Connecté via le site')
    return { token: sanctumToken, user }
  }

  async logout () {
    try {
      await this.http.post('/tracker/logout')
    } catch (_) {}
    this.setToken(null)
    this.currentFlightId = null
  }

  async getPreflight () {
    const res = await this.http.get('/tracker/preflight')
    return res.data
  }

  async createBooking (routeId) {
    const res = await this.http.post('/tracker/booking', { route_id: routeId })
    return res.data
  }

  async getNearestAirport (lat, lng) {
    try {
      const res = await this.http.get('/tracker/airport/nearest', { params: { lat, lng } })
      return res.data.icao || null
    } catch (_) {
      return null
    }
  }

  // ─── Vol ──────────────────────────────────────────────────────────────────
  async startFlight (data) {
    try {
      const res = await this.http.post('/tracker/session/start', {
        orig_icao:     data.origIcao     || 'ZZZZ',
        dest_icao:     data.destIcao     || 'ZZZZ',
        aircraft:      data.aircraft     || 'Unknown',
        flight_number: data.flightNumber || null
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
        flight_hash:  this.currentFlightId,
        latitude:     data.latitude,
        longitude:    data.longitude,
        altitude_msl: data.altitude,
        gs_kts:       data.gs,
        heading_true: data.heading,
        on_ground:    data.onGround,
        epoch_time:   Math.floor(data.timestamp / 1000)
      })
      this._sendApiStatus('ok')
    } catch (err) {
      this._sendApiStatus('error', err.message)
    }
  }

  endFlight (data) {
    // Stocke les données techniques pour submitPirep
    this.pendingFlightData = {
      flight_hash:   this.currentFlightId,
      block_minutes: data.duration,
      distance:      data.distance   || 0,
      fuel_used:     data.fuelUsed   ?? null,
      landing_fpm:   data.landingFpm ?? null
    }
    this._sendApiStatus('ok', 'Atterrissage détecté')
  }

  async submitPirep (pirepData) {
    if (!this.pendingFlightData) throw new Error('Aucun vol en attente')
    const res = await this.http.post('/tracker/session/end', {
      ...this.pendingFlightData,
      comments: pirepData.remarks || null
    })
    this.currentFlightId = null
    this.pendingFlightData = null
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
