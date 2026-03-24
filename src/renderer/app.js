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
  pirepFuelStart: null
}

// ─── DOM refs ─────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id)
const views = { login: $('view-login'), main: $('view-main') }

// ─── Navigation ───────────────────────────────────────────────────────────
function showView (name) {
  Object.entries(views).forEach(([k, el]) => {
    el.classList.toggle('active', k === name)
  })
}

// ─── Titlebar (frameless) ─────────────────────────────────────────────────
$('btn-minimize').onclick = () => window.bzh.minimize()
$('btn-close').onclick    = () => window.bzh.close()

// ─── Auth ─────────────────────────────────────────────────────────────────
$('form-login').addEventListener('submit', async (e) => {
  e.preventDefault()
  const email    = $('input-email').value.trim()
  const password = $('input-password').value

  if (!email || !password) return

  setLoginLoading(true)
  $('login-error').classList.add('hidden')

  const res = await window.bzh.login(email, password)

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
  $('pilot-name').textContent = user.name || user.email
  $('pilot-rank').textContent = user.rank || 'Pilote BreizhAir'
}

// Restauration auto token
window.bzh.on('auth:restored', async () => {
  const user = await window.bzh.getUser()
  if (user) {
    setUserInfo(user)
    showView('main')
  }
})

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
  } else {
    state.simConnected = false
    setSimStatus('disconnected', 'Déconnecté')
    $('btn-connect-sim').textContent = 'Connecter'
    $('btn-connect-sim').disabled = false
    $('sim-badge').textContent = 'DÉCONNECTÉ'
    $('sim-badge').className = 'badge'
    $('sim-select').disabled = false
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
  startTimer()
  $('card-pirep').classList.add('hidden')
})

window.bzh.on('sim:flight-end', (data) => {
  state.flightActive = false
  stopTimer()
  state.pirepDuration = data.duration

  // Pré-remplir PIREP
  $('pirep-duration').value = data.duration

  // Afficher le formulaire PIREP
  $('card-pirep').classList.remove('hidden')
  $('card-pirep').scrollIntoView({ behavior: 'smooth' })
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
    $('card-pirep').classList.add('hidden')
    resetPirepForm()
    // Feedback visuel
    const badge = $('sim-badge')
    badge.textContent = 'PIREP ENVOYÉ ✓'
    badge.className = 'badge badge--success'
    setTimeout(() => {
      badge.textContent = state.simConnected ? 'CONNECTÉ' : 'DÉCONNECTÉ'
      badge.className = state.simConnected ? 'badge badge--connected' : 'badge'
    }, 3000)
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
  $('pirep-fuel').value = ''
  $('pirep-remarks').value = ''
  state.pirepRating = 5
  document.querySelectorAll('#pirep-rating span').forEach((s) => s.classList.add('active'))
}

function resetFlight () {
  state.simConnected = false
  state.flightActive = false
  stopTimer()
  $('card-pirep').classList.add('hidden')
  setSimStatus('disconnected', 'En attente de connexion...')
  $('sim-badge').textContent = 'DÉCONNECTÉ'
  $('sim-badge').className = 'badge'
  $('sim-select').disabled = false
  $('btn-connect-sim').textContent = 'Connecter'
  ;['data-alt', 'data-ias', 'data-hdg', 'data-vs', 'data-fuel', 'data-gs'].forEach(
    (id) => { $(id).textContent = '—' }
  )
}
