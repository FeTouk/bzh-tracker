const fs   = require('fs')
const path = require('path')

// Chargement du CSV au démarrage (31K aéroports, ~1 MB)
const CSV_PATH = path.join(__dirname, '../../assets/airports.csv')

let airports = []

function loadAirports () {
  try {
    const raw  = fs.readFileSync(CSV_PATH, 'utf8').replace(/^\uFEFF/, '') // strip BOM
    const lines = raw.split('\n')
    // Skip header
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue
      const [ident, lat, lon] = line.split(',')
      const la = parseFloat(lat)
      const lo = parseFloat(lon)
      if (ident && !isNaN(la) && !isNaN(lo)) {
        airports.push({ icao: ident, lat: la, lon: lo })
      }
    }
    console.log(`[Airports] ${airports.length} aérodromes chargés`)
  } catch (e) {
    console.error('[Airports] Erreur chargement CSV:', e.message)
  }
}

// Haversine en NM
function haversineNm (lat1, lon1, lat2, lon2) {
  const R  = 3440.065 // Rayon Terre en NM
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/**
 * Retourne l'ICAO du plus proche aérodrome dans un rayon maxNm.
 * @param {number} lat
 * @param {number} lon
 * @param {number} maxNm - rayon max (défaut 30 NM)
 * @returns {string|null}
 */
function findNearest (lat, lon, maxNm = 15) {
  let best     = null
  let bestDist = maxNm

  for (const ap of airports) {
    // Pré-filtre rapide sur les degrés de latitude (1° lat ≈ 60 NM)
    if (Math.abs(ap.lat - lat) > maxNm / 55) continue
    const dist = haversineNm(lat, lon, ap.lat, ap.lon)
    if (dist < bestDist) {
      bestDist = dist
      best = ap.icao
    }
  }

  return best
}

loadAirports()

module.exports = { findNearest }
