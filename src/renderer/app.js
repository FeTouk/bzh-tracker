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
  detectedDepIcao: null
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
    if (btn.dataset.page === 'page-preflight' && state.simConnected) loadPreflight()
  })
})

// ─── Titlebar (frameless) ─────────────────────────────────────────────────
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
  }
})

// ─── Connexion via site web ───────────────────────────────────────────────
$('btn-web-auth').addEventListener('click', () => {
  window.bzh.openWebAuth()
  $('web-auth-waiting').classList.remove('hidden')
  $('btn-web-auth').disabled = true
})

window.bzh.on('auth:web-error', ({ error }) => {
  $('web-auth-waiting').classList.add('hidden')
  $('btn-web-auth').disabled = false
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
    setUserInfo(res.user)
    showView('main')
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

// Restauration auto token (et retour deep link web auth)
window.bzh.on('auth:restored', async ({ user }) => {
  $('web-auth-waiting').classList.add('hidden')
  $('btn-web-auth').disabled = false
  if (user) {
    setUserInfo(user)
    showView('main')
    const simType = await window.bzh.getSimType()
    if (simType) $('sim-select').value = simType
  }
})

// ─── Pré-vol ──────────────────────────────────────────────────────────────
let preflightRoutes = []
let preflightMode = 'ligne'

function loadPreflight () {
  window.bzh.getPreflight().then((data) => {
    if (!data) return

    $('pf-orig-display').value = data.current_airport || ''
    $('pf-orig-libre').value   = data.current_airport || ''
    preflightRoutes = data.routes || []

    const sel = $('pf-route-select')
    sel.innerHTML = preflightRoutes.length
      ? '<option value="">— Choisir une ligne —</option>' +
        preflightRoutes.map(r =>
          `<option value="${r.id}">${r.departure_icao} → ${r.arrival_icao} · ${r.aircraft_type} [${r.line_type}]</option>`
        ).join('')
      : '<option value="">Aucune ligne depuis cet aéroport</option>'

    // Pré-sélectionner la réservation active si elle existe
    if (data.active_booking) {
      const b = data.active_booking
      const match = preflightRoutes.find(r =>
        r.arrival_icao === b.dest_icao && r.aircraft_type === b.aircraft
      )
      if (match) sel.value = match.id
      $('pf-flight-number').value = b.flight_number || ''
      updateRouteDetails(match || null)
      setBookingActive(true)
    }
  })
}

$('pf-route-select').addEventListener('change', () => {
  const route = preflightRoutes.find(r => r.id == $('pf-route-select').value)
  updateRouteDetails(route || null)
})

function setBookingActive (active) {
  $('btn-create-booking').classList.toggle('hidden', active)
  $('btn-cancel-booking').classList.toggle('hidden', !active)
}

function updateRouteDetails (route) {
  $('pf-booking-status').className = 'hidden'
  $('pf-booking-status').textContent = ''

  if (route) {
    $('pf-dest-display').textContent     = route.arrival_icao
    $('pf-aircraft-display').textContent = route.aircraft_type
    $('pf-route-details').style.display  = 'grid'

    if (route.ifps_route) {
      $('pf-ifps-text').textContent = route.ifps_route
      $('pf-route-string').classList.remove('hidden')
    } else {
      $('pf-route-string').classList.add('hidden')
    }

    $('pf-actions').classList.remove('hidden')
  } else {
    $('pf-route-details').style.display = 'none'
    $('pf-route-string').classList.add('hidden')
    $('pf-actions').classList.add('hidden')
  }
}

// Créer un booking
$('btn-create-booking').addEventListener('click', async () => {
  const route = preflightRoutes.find(r => r.id == $('pf-route-select').value)
  if (!route) return

  $('btn-create-booking').disabled = true
  const res = await window.bzh.createBooking(route.id)
  $('btn-create-booking').disabled = false

  const statusEl = $('pf-booking-status')
  statusEl.classList.remove('hidden')
  if (res.success) {
    $('pf-flight-number').value = res.flight_number
    statusEl.className = 'pf-booking-ok'
    statusEl.textContent = `Réservation créée : ${res.flight_number}`
    setBookingActive(true)
  } else {
    statusEl.className = 'pf-booking-err'
    statusEl.textContent = res.error || 'Erreur lors de la réservation'
  }
})

// Annuler un booking
$('btn-cancel-booking').addEventListener('click', async () => {
  $('btn-cancel-booking').disabled = true
  const res = await window.bzh.cancelBooking()
  $('btn-cancel-booking').disabled = false

  const statusEl = $('pf-booking-status')
  statusEl.classList.remove('hidden')
  if (res.success) {
    $('pf-flight-number').value = ''
    statusEl.className = 'pf-booking-err'
    statusEl.textContent = 'Réservation annulée'
    setBookingActive(false)
  } else {
    statusEl.className = 'pf-booking-err'
    statusEl.textContent = res.error || 'Erreur lors de l\'annulation'
  }
})

// Ouvrir SimBrief
$('btn-simbrief').addEventListener('click', () => {
  const route = preflightRoutes.find(r => r.id == $('pf-route-select').value)
  if (!route) return
  const user = window._bzhUser || {}
  window.bzh.openSimBrief({
    orig:     route.departure_icao,
    dest:     route.arrival_icao,
    route:    route.ifps_route || route.route_string || '',
    callsign: user.callsign || ''
  })
})

// Toggle ligne / vol libre
document.querySelectorAll('.pf-mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    preflightMode = btn.dataset.mode
    document.querySelectorAll('.pf-mode-btn').forEach(b => b.classList.toggle('active', b === btn))
    $('pf-mode-ligne').style.display = preflightMode === 'ligne' ? '' : 'none'
    $('pf-mode-libre').style.display = preflightMode === 'libre' ? '' : 'none'
  })
})

function getPreflightData () {
  if (preflightMode === 'ligne') {
    const route = preflightRoutes.find(r => r.id == $('pf-route-select').value)
    return {
      origIcao:     $('pf-orig-display').value,
      destIcao:     route ? route.arrival_icao : '',
      aircraft:     route ? route.aircraft_type : '',
      flightNumber: $('pf-flight-number').value.trim()
    }
  } else {
    return {
      origIcao:     $('pf-orig-libre').value.trim().toUpperCase(),
      destIcao:     $('pf-dest-libre').value.trim().toUpperCase(),
      aircraft:     $('pf-aircraft-libre').value.trim(),
      flightNumber: $('pf-flight-number-libre').value.trim()
    }
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
    $('card-preflight').classList.remove('hidden')
    loadPreflight()
  } else {
    state.simConnected = false
    setSimStatus('disconnected', 'Déconnecté')
    $('btn-connect-sim').textContent = 'Connecter'
    $('btn-connect-sim').disabled = false
    $('sim-badge').textContent = 'DÉCONNECTÉ'
    $('sim-badge').className = 'badge'
    $('sim-select').disabled = false
    $('card-preflight').classList.add('hidden')
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

// ─── Événements de vol ────────────────────────────────────────────────────
window.bzh.on('sim:flight-start', (data) => {
  state.flightActive = true
  state.flightStartTime = data.time
  state.pirepFuelStart = null
  state.detectedDepIcao = data.depIcao || null
  startTimer()
  showPage('page-vol')
  const pf = getPreflightData()
  // Utiliser l'AD détecté si le champ pré-vol est vide
  if (!pf.origIcao && data.depIcao) pf.origIcao = data.depIcao
  window.bzh.startFlight({ ...data, ...pf })
})

window.bzh.on('sim:flight-end', (data) => {
  state.flightActive = false
  stopTimer()
  state.pirepDuration = data.duration

  const pf = getPreflightData()
  $('pirep-dep').value      = pf.origIcao || state.detectedDepIcao || ''
  $('pirep-arr').value      = data.arrIcao || pf.destIcao || ''
  $('pirep-aircraft').value = pf.aircraft || ''
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
    rating:     state.pirepRating
  })

  setPirepLoading(false)

  if (res.success) {
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
