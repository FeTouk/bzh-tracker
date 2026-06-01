/* ═══════════════════════════════════════════════════════════════
   BZH TRACKER — Renderer / UI Logic
   ═══════════════════════════════════════════════════════════════ */

// ─── State ────────────────────────────────────────────────────────────────
const state = {
  simConnected: false,
  flightActive: false,
  flightStartTime: null,
  timerInterval: null,
  pirepRating: 5,
  pirepDuration: 0,
  pirepFuelStart: null,
  detectedDepIcao: null,
  detectedDestIcao: null,
  detectedAircraft: null
}

// ─── DOM refs ─────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id)
const views = { login: $('view-login'), main: $('view-main') }

// ─── Navigation vues ──────────────────────────────────────────────────────
function showView (name) {
  Object.entries(views).forEach(([k, el]) => {
    el.classList.toggle('active', k === name)
  })
}

// ─── Navigation pages ─────────────────────────────────────────────────────
function showPage (pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === pageId))
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.page === pageId))
}

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    showPage(btn.dataset.page)
    if (btn.dataset.page === 'page-preflight' && !allRoutes.length) loadDispatch()
  })
})

// ─── Titlebar (frameless) ─────────────────────────────────────────────────
$('btn-tray').onclick     = () => window.bzh.hide()
$('btn-minimize').onclick = () => window.bzh.minimize()
$('btn-close').onclick    = () => window.bzh.close()

// ─── Thème jour/nuit ──────────────────────────────────────────────────────
function applyTheme (theme) {
  document.documentElement.setAttribute('data-theme', theme)
  $('btn-theme').textContent = theme === 'light' ? '🌙' : '☀'
}

window.bzh.getTheme().then(applyTheme)

$('btn-theme').onclick = () => {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light'
  applyTheme(next)
  window.bzh.setTheme(next)
}

// ─── Pré-remplir si credentials sauvegardés ───────────────────────────────
window.bzh.getSaved().then((saved) => {
  if (saved) {
    $('input-email').value = saved.email
    $('chk-remember').checked = true
    $('btn-refresh-auth').classList.remove('hidden')
  }
})

$('btn-refresh-auth').addEventListener('click', async () => {
  const btn = $('btn-refresh-auth')
  btn.disabled = true
  btn.textContent = '↺ Connexion en cours…'
  $('login-error').classList.add('hidden')

  const res = await window.bzh.refresh()
  btn.disabled = false
  btn.textContent = '↺ Rafraîchir la connexion'

  if (res.success) {
    await afterLogin(res.user)
  } else {
    $('login-error').textContent = res.error || 'Impossible de se reconnecter'
    $('login-error').classList.remove('hidden')
  }
})

// ─── Connexion via site web ───────────────────────────────────────────────
let _webAuthTimeout = null

function resetWebAuth () {
  clearTimeout(_webAuthTimeout)
  $('web-auth-waiting').classList.add('hidden')
  $('btn-web-auth').disabled = false
}

$('btn-web-auth').addEventListener('click', () => {
  window.bzh.openWebAuth()
  $('web-auth-waiting').classList.remove('hidden')
  $('btn-web-auth').disabled = true
  // Annulation automatique après 3 minutes
  _webAuthTimeout = setTimeout(() => {
    resetWebAuth()
    $('login-error').textContent = 'Délai dépassé — réessayez ou connectez-vous via le formulaire.'
    $('login-error').classList.remove('hidden')
  }, 180000)
})

$('btn-web-auth-refresh').addEventListener('click', () => {
  window.bzh.openWebAuth()
})

$('btn-web-auth-cancel').addEventListener('click', () => {
  resetWebAuth()
  $('login-error').classList.add('hidden')
})

window.bzh.on('auth:web-error', ({ error }) => {
  resetWebAuth()
  $('login-error').textContent = error || 'Échec de la connexion via le site'
  $('login-error').classList.remove('hidden')
})

// ─── Auth ─────────────────────────────────────────────────────────────────
$('form-login').addEventListener('submit', async (e) => {
  e.preventDefault()
  const email    = $('input-email').value.trim()
  const password = $('input-password').value

  if (!email || !password) return

  setLoginLoading(true)
  $('login-error').classList.add('hidden')

  const remember = $('chk-remember').checked
  const res = await window.bzh.login(email, password, remember)

  if (res.success) {
    await afterLogin(res.user)
  } else {
    $('login-error').textContent = res.error || 'Erreur de connexion'
    $('login-error').classList.remove('hidden')
  }
  setLoginLoading(false)
})

$('btn-logout').onclick = async () => {
  await window.bzh.logout()
  resetFlight()
  showView('login')
}

function setLoginLoading (loading) {
  $('btn-login').disabled = loading
  $('btn-login-text').classList.toggle('hidden', loading)
  $('btn-login-spinner').classList.toggle('hidden', !loading)
}

function setUserInfo (user) {
  window._bzhUser = user
  $('pilot-name').textContent = user.name || user.email
  $('pilot-rank').textContent = user.callsign || 'Pilote BreizhAir'
  if (user.avatar) $('pilot-avatar').src = user.avatar
}

// Initialisation commune après login (formulaire, web auth, ou token restauré)
async function afterLogin (user) {
  setUserInfo(user)
  showView('main')
  loadDispatch()
  loadLogbook()

  const simType = await window.bzh.getSimType()
  if (simType) {
    $('sim-select').value = simType
    // Tentative de connexion automatique au sim
    $('btn-connect-sim').disabled = true
    setSimStatus('connecting', 'Connexion au simulateur…')
    const res = await window.bzh.connectSim(simType)
    $('btn-connect-sim').disabled = false
    if (!res.success) {
      // Le retry automatique est lancé en arrière-plan dans index.js
      setSimStatus('error', 'Simulateur non disponible — nouvelle tentative en cours…')
    }
  }
}

// Session expirée — retour au login
window.bzh.on('auth:session-expired', async () => {
  await window.bzh.logout()
  resetFlight()
  $('login-error').textContent = 'Session expirée, veuillez vous reconnecter.'
  $('login-error').classList.remove('hidden')
  showView('login')
})

// Bouton reconnecter (erreur API sans 401)
$('btn-api-reconnect').addEventListener('click', async () => {
  $('btn-api-reconnect').classList.add('hidden')
  $('api-status-text').textContent = 'Reconnexion…'
  const user = await window.bzh.getUser()
  if (!user) {
    showView('login')
    return
  }
  // Juste rafraîchir le preflight pour vérifier la connexion
  const pf = await window.bzh.getPreflight()
  if (pf) {
    $('api-dot').className = 'api-dot ok'
    $('api-status-text').textContent = 'En ligne'
  }
})

// Restauration auto token (et retour deep link web auth)
window.bzh.on('auth:restored', async ({ user }) => {
  resetWebAuth()
  if (user) await afterLogin(user)
})

// ─── Dispatch ─────────────────────────────────────────────────────────────
let allRoutes        = []
let activeBooking    = null   // { route_id, flight_number, orig_icao, dest_icao, aircraft }
let activeTypeFilter = ''     // '' | 'Local' | 'Régional' | 'Moyen courrier' | 'Long courrier'

function loadPreflight () {
  loadDispatch()
}

async function loadDispatch (attempt = 1) {
  const data = await window.bzh.getLines()
  if (!data) {
    if (attempt < 4) setTimeout(() => loadDispatch(attempt + 1), attempt * 2000)
    return
  }

  allRoutes     = data.routes || []
  activeBooking = data.active_booking || null
  const origin  = data.current_airport || ''
  $('dispatch-origin').textContent = origin ? `— ${origin}` : ''

  renderActiveBooking()
  renderRoutesList($('dispatch-filter').value)
}

function renderActiveBooking () {
  const card = $('card-active-booking')
  if (!activeBooking) {
    card.classList.add('hidden')
    $('pf-flight-number').value = ''
    return
  }
  card.classList.remove('hidden')
  $('ab-dep').textContent          = activeBooking.orig_icao  || '—'
  $('ab-arr').textContent          = activeBooking.dest_icao  || '—'
  $('ab-aircraft').textContent     = activeBooking.aircraft   || '—'
  $('ab-flight-number').textContent = activeBooking.flight_number || '—'
  $('pf-flight-number').value      = activeBooking.flight_number || ''
  // Stocker la route réservée pour getPreflightData
  $('pf-route-select').value = activeBooking.route_id || ''
}

function renderRoutesList (filter) {
  const list  = $('dispatch-lines-list')
  const q     = (filter || '').toUpperCase().trim()
  const shown = allRoutes.filter(r => {
    if (activeTypeFilter && r.aircraft_type !== activeTypeFilter) return false
    if (q && !r.departure_icao.includes(q) && !r.arrival_icao.includes(q) &&
        !r.aircraft_type.toUpperCase().includes(q)) return false
    return true
  })

  if (!shown.length) {
    list.innerHTML = `<div class="dispatch-empty">${allRoutes.length ? 'Aucune ligne correspondante' : 'Aucune ligne disponible'}</div>`
    return
  }

  list.innerHTML = shown.map(r => {
    const isBooked = activeBooking && activeBooking.route_id == r.id
    return `<div class="dispatch-route${isBooked ? ' booked' : ''}" data-id="${r.id}">
      <div class="dispatch-route-airports">
        <span class="dispatch-icao">${r.departure_icao}</span>
        <span class="dispatch-arrow">→</span>
        <span class="dispatch-icao">${r.arrival_icao}</span>
      </div>
      <div class="dispatch-route-meta">
        <span class="dispatch-aircraft">${r.aircraft_type || ''}</span>
        <span class="dispatch-type">${r.flight_regime || ''}</span>
      </div>
      ${isBooked
        ? `<span class="btn btn--ghost btn--sm dispatch-book-btn" style="color:var(--success)">✓ Réservé</span>`
        : `<button class="btn btn--primary btn--sm dispatch-book-btn" data-book="${r.id}">Réserver</button>`
      }
    </div>`
  }).join('')

  // Boutons Réserver
  list.querySelectorAll('[data-book]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const routeId = btn.dataset.book
      btn.disabled = true
      btn.textContent = '…'
      const res = await window.bzh.createBooking(routeId)
      if (res.success) {
        activeBooking = {
          route_id:      routeId,
          flight_number: res.flight_number,
          orig_icao:     allRoutes.find(r => r.id == routeId)?.departure_icao,
          dest_icao:     allRoutes.find(r => r.id == routeId)?.arrival_icao,
          aircraft:      allRoutes.find(r => r.id == routeId)?.aircraft_type,
        }
        renderActiveBooking()
        renderRoutesList($('dispatch-filter').value)
      } else {
        btn.disabled = false
        btn.textContent = 'Réserver'
        $('pf-booking-status').className = 'pf-booking-err'
        $('pf-booking-status').textContent = res.error || 'Erreur'
        $('pf-booking-status').classList.remove('hidden')
      }
    })
  })
}

$('dispatch-filter').addEventListener('input', () => renderRoutesList($('dispatch-filter').value))

$('pf-dest-libre').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase()
})

document.querySelectorAll('.dispatch-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    activeTypeFilter = tab.dataset.type
    document.querySelectorAll('.dispatch-tab').forEach(t => t.classList.toggle('active', t === tab))
    renderRoutesList($('dispatch-filter').value)
  })
})

// Annuler un booking
$('btn-cancel-booking').addEventListener('click', async () => {
  $('btn-cancel-booking').disabled = true
  const res = await window.bzh.cancelBooking()
  $('btn-cancel-booking').disabled = false

  if (res.success) {
    activeBooking = null
    renderActiveBooking()
    renderRoutesList($('dispatch-filter').value)
  } else {
    $('pf-booking-status').className = 'pf-booking-err'
    $('pf-booking-status').textContent = res.error || 'Erreur lors de l\'annulation'
    $('pf-booking-status').classList.remove('hidden')
  }
})

// Ouvrir SimBrief depuis la réservation active
$('btn-simbrief').addEventListener('click', () => {
  if (!activeBooking) return
  const route = allRoutes.find(r => r.id == activeBooking.route_id)
  if (!route) return
  const user = window._bzhUser || {}
  window.bzh.openSimBrief({
    orig:     route.departure_icao,
    dest:     route.arrival_icao,
    route:    route.ifps_route || route.route_string || '',
    callsign: user.callsign || ''
  })
})

function getPreflightData () {
  const route = allRoutes.find(r => r.id == $('pf-route-select').value)
  if (route) {
    return {
      intendedDest: route.arrival_icao,
      aircraft:     route.aircraft_type,
      flightNumber: $('pf-flight-number').value.trim()
    }
  }
  // Vol libre — pas de réservation active
  return {
    intendedDest: ($('pf-dest-libre').value || '').trim().toUpperCase(),
    aircraft:     ($('pf-aircraft-libre').value || '').trim(),
    flightNumber: null
  }
}

// ─── Simulateur ───────────────────────────────────────────────────────────
$('btn-connect-sim').addEventListener('click', async () => {
  const btn = $('btn-connect-sim')

  if (state.simConnected) {
    await window.bzh.disconnectSim()
    return
  }

  const simType = $('sim-select').value
  btn.disabled = true
  setSimStatus('connecting', 'Connexion en cours...')

  const res = await window.bzh.connectSim(simType)
  btn.disabled = false

  if (!res.success) {
    setSimStatus('error', 'Échec : ' + (res.error || 'Erreur inconnue'))
  }
})

window.bzh.on('sim:status', ({ status }) => {
  if (status === 'connected') {
    state.simConnected = true
    setSimStatus('connected', 'Simulateur connecté')
    $('btn-connect-sim').textContent = 'Déconnecter'
    $('sim-badge').textContent = 'CONNECTÉ'
    $('sim-badge').className = 'badge badge--connected'
    $('sim-select').disabled = true
    updateFlightButtons()
  } else {
    state.simConnected = false
    setSimStatus('disconnected', 'Déconnecté')
    $('btn-connect-sim').textContent = 'Connecter'
    $('btn-connect-sim').disabled = false
    $('sim-badge').textContent = 'DÉCONNECTÉ'
    $('sim-badge').className = 'badge'
    $('sim-select').disabled = false
    updateFlightButtons()
  }
})

function setSimStatus (type, text) {
  const dot = $('sim-dot')
  dot.className = 'status-dot'
  if (type === 'connected')   dot.classList.add('connected')
  if (type === 'error')       dot.classList.add('error')
  if (type === 'connecting')  dot.classList.add('connecting')
  $('sim-status-text').textContent = text
}

// ─── Données de vol ───────────────────────────────────────────────────────
window.bzh.on('sim:data', (data) => {
  $('data-alt').textContent  = data.altitude !== undefined ? data.altitude.toLocaleString('fr-FR') : '—'
  $('data-ias').textContent  = data.ias  ?? '—'
  $('data-hdg').textContent  = data.heading !== undefined ? String(data.heading).padStart(3, '0') : '—'
  $('data-vs').textContent   = data.vs   !== undefined ? (data.vs > 0 ? '+' : '') + data.vs : '—'
  $('data-fuel').textContent = data.fuel ?? '—'
  $('data-gs').textContent   = data.gs   ?? '—'

  // Phase de vol
  let phase = 'Sol'
  if (!data.onGround) {
    if (data.vs > 200) phase = 'Montée'
    else if (data.vs < -200) phase = 'Descente'
    else phase = 'Croisière'
  }
  $('flight-phase').textContent = phase

  // Couleur V/S
  const vsEl = $('data-vs')
  if (data.vs > 0) vsEl.style.color = 'var(--success)'
  else if (data.vs < -500) vsEl.style.color = 'var(--danger)'
  else vsEl.style.color = 'var(--accent)'
})

// ─── Détection avion ─────────────────────────────────────────────────────
window.bzh.on('sim:aircraft', (data) => {
  const name = data.name
  if (!name) return

  state.detectedAircraft = name

  const libreField = $('pf-aircraft-libre')
  if (libreField && !libreField.value) libreField.value = name

  const pirepField = $('pirep-aircraft')
  if (pirepField && !pirepField.value) pirepField.value = name
})

// ─── Boutons start/stop manuel ───────────────────────────────────────────
function updateFlightButtons () {
  const canStart = state.simConnected && !state.flightActive
  const canStop  = state.simConnected &&  state.flightActive
  $('btn-flight-start').disabled = !canStart
  $('btn-flight-start').classList.toggle('hidden', state.flightActive)
  $('btn-flight-stop').classList.toggle('hidden', !state.flightActive)
}

$('btn-flight-start').addEventListener('click', async () => {
  const btn = $('btn-flight-start')
  btn.disabled = true
  btn.textContent = 'Démarrage…'
  const res = await window.bzh.manualStartFlight()
  if (res && res.error) {
    btn.disabled = false
    btn.textContent = 'Démarrer le vol'
    alert(res.error)
  }
})

$('btn-flight-stop').addEventListener('click', async () => {
  if (!confirm('Terminer le vol et générer le PIREP ?')) return
  const btn = $('btn-flight-stop')
  btn.disabled = true
  try {
    const res = await window.bzh.manualStopFlight()
    if (res && res.error) {
      btn.disabled = false
      alert(res.error)
    }
  } catch (err) {
    btn.disabled = false
    alert('Erreur lors de l\'arrêt du vol : ' + (err.message || err))
  }
})

// Notification touchdown pendant le vol (retour visuel)
function landingQuality (fpm) {
  const v = Math.abs(fpm)
  if (v <= 100) return { label: 'Parfaite',   emoji: '🟢', color: '#22c55e' }
  if (v <= 200) return { label: 'Bonne',       emoji: '🟡', color: '#eab308' }
  if (v <= 300) return { label: 'Acceptable',  emoji: '🟠', color: '#f97316' }
  if (v <= 500) return { label: 'Difficile',   emoji: '🔴', color: '#ef4444' }
  return               { label: 'Crash !',     emoji: '💀', color: '#dc2626' }
}

let _touchdownToastTimer = null

// ─── Version & mises à jour ───────────────────────────────────────────────────
window.bzh.getVersion().then(v => { $('app-version').textContent = `v${v}` })

window.bzh.on('update:available', (data) => {
  $('app-version').textContent = `v${data.version} ↓`
})

window.bzh.on('update:ready', (data) => {
  $('app-version').textContent = ''
  const btn = $('btn-titlebar-update')
  btn.textContent = `↑ v${data.version}`
  btn.classList.remove('hidden')
  btn.addEventListener('click', () => window.bzh.installUpdate())
})

window.bzh.on('sim:touchdown', (data) => {
  if (!state.flightActive) return
  const q = landingQuality(data.fpm)
  $('flight-phase').textContent = `Touchdown ${data.fpm} fpm`

  // Toast
  const toast = $('touchdown-toast')
  $('touchdown-fpm-val').textContent = `${data.fpm} fpm`
  $('touchdown-quality-val').textContent = `${q.emoji} ${q.label}`
  $('touchdown-quality-val').style.color = q.color
  toast.classList.remove('hidden')

  if (_touchdownToastTimer) clearTimeout(_touchdownToastTimer)
  _touchdownToastTimer = setTimeout(() => {
    toast.classList.add('hidden')
    _touchdownToastTimer = null
  }, 5000)
})

// ─── Événements de vol ────────────────────────────────────────────────────
window.bzh.on('sim:flight-start', (data) => {
  state.flightActive    = true
  state.flightStartTime = data.time
  state.pirepFuelStart  = null
  // AD de départ = position GPS réelle au décollage
  state.detectedDepIcao = data.depIcao || null
  if (data.depIcao) $('pf-orig-display').value = data.depIcao
  startTimer()
  updateFlightButtons()
  showPage('page-vol')

  const pf = getPreflightData()
  // origIcao = GPS réel ; destIcao = arrivée prévue de la ligne (meilleure estimation)
  window.bzh.startFlight({
    origIcao:     data.depIcao    || 'ZZZZ',
    destIcao:     pf.intendedDest || 'ZZZZ',
    aircraft:     state.detectedAircraft || pf.aircraft || 'Unknown',
    flightNumber: pf.flightNumber || null,
    lat:          data.lat,
    lng:          data.lng,
    time:         data.time,
  })
})

window.bzh.on('sim:flight-end', (data) => {
  state.flightActive    = false
  stopTimer()
  updateFlightButtons()
  $('touchdown-toast').classList.add('hidden')
  state.pirepDuration = data.duration

  const pf = getPreflightData()
  // Destination : GPS si trouvé, sinon destination prévue de la ligne (fallback)
  state.detectedDestIcao = data.arrIcao || null

  $('pirep-dep').value      = state.detectedDepIcao  || ''
  $('pirep-arr').value      = state.detectedDestIcao || ''
  $('pirep-aircraft').value = state.detectedAircraft || pf.aircraft || ''
  $('pirep-duration').value = data.duration
  $('pirep-distance').value = data.distance   ?? ''
  $('pirep-fuel').value     = data.fuelUsed   ?? ''
  $('pirep-fpm').value      = data.landingFpm ?? ''

  $('pirep-waiting').classList.add('hidden')
  $('form-pirep').classList.remove('hidden')
  $('pirep-badge').classList.remove('hidden')
  $('nav-pirep-badge').classList.remove('hidden')
  showPage('page-pirep')
})

// ─── Timer de vol ─────────────────────────────────────────────────────────
function startTimer () {
  stopTimer()
  state.timerInterval = setInterval(() => {
    if (!state.flightStartTime) return
    const elapsed = Math.floor((Date.now() - state.flightStartTime) / 1000)
    const h = Math.floor(elapsed / 3600)
    const m = Math.floor((elapsed % 3600) / 60)
    const s = elapsed % 60
    $('flight-timer').textContent =
      `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }, 1000)
}

function stopTimer () {
  if (state.timerInterval) {
    clearInterval(state.timerInterval)
    state.timerInterval = null
  }
  $('flight-timer').textContent = '--:--'
}

// ─── Statut API ───────────────────────────────────────────────────────────
window.bzh.on('api:status', ({ status, message }) => {
  const dot = $('api-dot')
  dot.className = 'api-dot ' + (status || '')
  $('api-status-text').textContent = message || (status === 'ok' ? 'En ligne' : status)
  $('btn-api-reconnect').classList.toggle('hidden', status === 'ok')
})

// ─── PIREP Rating ─────────────────────────────────────────────────────────
document.querySelectorAll('#pirep-rating span').forEach((star) => {
  star.addEventListener('click', () => {
    const val = parseInt(star.dataset.v, 10)
    state.pirepRating = val
    document.querySelectorAll('#pirep-rating span').forEach((s) => {
      s.classList.toggle('active', parseInt(s.dataset.v, 10) <= val)
    })
  })
})
// Init rating visuel
document.querySelectorAll('#pirep-rating span').forEach((s) => {
  s.classList.toggle('active', parseInt(s.dataset.v, 10) <= state.pirepRating)
})

// ─── Soumission PIREP ─────────────────────────────────────────────────────
$('form-pirep').addEventListener('submit', async (e) => {
  e.preventDefault()

  const depIcao  = $('pirep-dep').value.trim().toUpperCase()
  const arrIcao  = $('pirep-arr').value.trim().toUpperCase()
  const aircraft = $('pirep-aircraft').value.trim()

  if (!depIcao || !arrIcao || !aircraft) {
    $('pirep-error').textContent = 'Veuillez remplir les champs obligatoires.'
    $('pirep-error').classList.remove('hidden')
    return
  }

  setPirepLoading(true)
  $('pirep-error').classList.add('hidden')

  const res = await window.bzh.submitPirep({
    depIcao,
    arrIcao,
    aircraft,
    flightTime: parseInt($('pirep-duration').value, 10) || state.pirepDuration,
    fuelUsed:   parseInt($('pirep-fuel').value, 10) || 0,
    remarks:    $('pirep-remarks').value.trim(),
    rating:     state.pirepRating,
    // AD GPS réels confirmés à l'envoi
    origIcao:   state.detectedDepIcao  || depIcao,
    arrIcaoGps: state.detectedDestIcao || arrIcao,
  })

  setPirepLoading(false)

  if (res.success) {
    // Enregistrer dans le logbook local
    await window.bzh.logbookAppend({
      date:        new Date().toISOString().slice(0, 10),
      flightNumber: $('pf-flight-number').value.trim() || '',
      depIcao,
      arrIcao,
      aircraft,
      durationMin:  $('pirep-duration').value || '',
      distanceNm:   $('pirep-distance').value || '',
      landingFpm:   $('pirep-fpm').value      || '',
      fuelGal:      $('pirep-fuel').value     || '',
      remarks:      $('pirep-remarks').value.trim(),
    })
    loadLogbook()
    resetPirepForm()
    $('pirep-badge').classList.add('hidden')
    $('nav-pirep-badge').classList.add('hidden')
    $('pirep-waiting').classList.remove('hidden')
    $('form-pirep').classList.add('hidden')
    showPage('page-vol')
  } else {
    $('pirep-error').textContent = res.error || 'Erreur lors de l\'envoi'
    $('pirep-error').classList.remove('hidden')
  }
})

function setPirepLoading (loading) {
  $('btn-pirep').disabled = loading
  $('btn-pirep-text').classList.toggle('hidden', loading)
  $('btn-pirep-spinner').classList.toggle('hidden', !loading)
}

function resetPirepForm () {
  $('pirep-dep').value = ''
  $('pirep-arr').value = ''
  $('pirep-aircraft').value = ''
  $('pirep-duration').value = ''
  $('pirep-distance').value = ''
  $('pirep-fuel').value = ''
  $('pirep-fpm').value = ''
  $('pirep-remarks').value = ''
  state.pirepRating = 5
  document.querySelectorAll('#pirep-rating span').forEach((s) => s.classList.add('active'))
}

// ─── Logbook ──────────────────────────────────────────────────────────────
async function loadLogbook () {
  const data = await window.bzh.logbookRead()
  renderLogbook(data.entries || [])
}

function fmtDuration (min) {
  if (!min) return '—'
  const h = Math.floor(min / 60)
  const m = min % 60
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${m}min`
}

function renderLogbook (entries) {
  const list = $('logbook-list')
  $('logbook-total').textContent = entries.length ? `${entries.length} vol${entries.length > 1 ? 's' : ''}` : ''

  if (!entries.length) {
    list.innerHTML = '<div class="logbook-empty">Aucun vol enregistré</div>'
    return
  }

  list.innerHTML = entries.map(e => `
    <div class="logbook-entry">
      <div class="logbook-entry-header">
        <div class="logbook-route">
          <span class="logbook-icao">${e.depIcao || '?'}</span>
          <span class="logbook-arrow">→</span>
          <span class="logbook-icao">${e.arrIcao || '?'}</span>
        </div>
        <span class="logbook-aircraft">${e.aircraft || '—'}</span>
        ${e.flightNumber ? `<span class="logbook-fnum">${e.flightNumber}</span>` : ''}
      </div>
      <div class="logbook-entry-stats">
        <span>${fmtDuration(parseInt(e.durationMin))}</span>
        ${e.distanceNm ? `<span><span class="logbook-stat-val">${e.distanceNm}</span> NM</span>` : ''}
        ${e.landingFpm ? `<span><span class="logbook-stat-val">${e.landingFpm}</span> fpm</span>` : ''}
        ${e.fuelGal    ? `<span><span class="logbook-stat-val">${e.fuelGal}</span> gal</span>` : ''}
      </div>
      <div class="logbook-date">${e.date || ''}</div>
    </div>
  `).join('')
}

function resetFlight () {
  state.simConnected = false
  state.flightActive = false
  stopTimer()
  $('nav-pirep-badge').classList.add('hidden')
  $('pirep-badge').classList.add('hidden')
  $('pirep-waiting').classList.remove('hidden')
  $('form-pirep').classList.add('hidden')
  setSimStatus('disconnected', 'En attente de connexion...')
  $('sim-badge').textContent = 'DÉCONNECTÉ'
  $('sim-badge').className = 'badge'
  $('sim-select').disabled = false
  $('btn-connect-sim').textContent = 'Connecter'
  ;['data-alt', 'data-ias', 'data-hdg', 'data-vs', 'data-fuel', 'data-gs'].forEach(
    (id) => { $(id).textContent = '—' }
  )
}
