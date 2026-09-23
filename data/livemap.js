/* OpenWXDeck LiveMap.
 *
 * The device reports only the sonde it is decoding right now, so both the
 * flight tracks and the list of sondes seen this session are built here.
 * Reloading the page starts both again from nothing.
 *
 * Marker set, path colours, labels and the receiver popup follow OpenWXTTGO
 * so the two receivers read the same way on a map.
 */

'use strict';

var REFRESH_MS = 2000;
var MAX_TRACK_POINTS = 3000;

// A sonde counts as active, and its card stays green, for this long after the
// last frame. A signal drops in and out constantly on a recovery, and a sonde
// that flips to history on every gap is unreadable.
var SONDE_STALE_MS = 1800000;       // config.yaml webui.sonde_stale_time overrides this

// As long as SondeStore keeps an entry: three days. Used only for a stored
// sonde whose time nothing on the device could supply.
var STORE_MAX_AGE_MS = 72 * 3600000;

// Sondes are dropped from the sidebar and the map after this long.
var SONDE_RETENTION_MS = 3600000;   // config.yaml webui.sonde_retention_time overrides this

// The track colours OpenWXTTGO's map uses: what the receiver is following now
// against what it has already heard.
var TRACK_ACTIVE = '#f47a20';

var TILE_KEY = 'owx_deck_livemap_tiles';
var OPTS_KEY = 'owx_deck_map_opts';
var FRAME_KEY = 'owx_deck_frames_today';

/* ---------- sonde types ---------- */

// The families OpenWXDeck knows, with the colours OpenWXTTGO uses on its map:
// blue for the Vaisala pair, amber for Graw, green for Meteomodem.
var TYPE_COLOURS = {
  'RS41': '#3f84dd', 'RS41-SGP': '#3f84dd',
  'RS92': '#4DA6FF', 'RS92-SGP': '#4DA6FF',
  'DFM': '#f59f00', 'DFM-06': '#f6a609', 'DFM-09': '#f59f00', 'DFM-17': '#e8860c',
  'M10': '#43e97b', 'M20': '#38d9a9'
};
var TYPE_UNKNOWN = '#cbd5e0';

// The firmware sends "RS41", "DFM", "--" and so on; a decoder that learns the
// subtype later will send "DFM-09" or "RS41-SGP". Both spellings land on the
// same badge.
function normType(value) {
  var s = String(value == null ? '' : value).trim().toUpperCase().replace(/[\s_]+/g, '-');
  if (!s || s === '--' || s === '-' || s === 'UNKNOWN') { return ''; }
  s = s.replace(/^DFM-?(\d)$/, 'DFM-0$1');
  s = s.replace(/^DFM-?(\d\d)$/, 'DFM-$1');
  s = s.replace(/^(RS41|RS92)-?SGP$/, '$1-SGP');
  return s;
}

function typeColour(value) {
  var s = normType(value);
  if (!s) { return TYPE_UNKNOWN; }
  if (TYPE_COLOURS[s]) { return TYPE_COLOURS[s]; }
  return TYPE_COLOURS[s.split('-')[0]] || TYPE_UNKNOWN;
}

function typeLabel(value) { return normType(value) || 'unknown'; }

function typeBadge(value) {
  var colour = typeColour(value);
  var ink = colour === TYPE_UNKNOWN ? '#4a5568' : '#fff';
  return '<span class="sonde-type" style="background:' + colour + ';color:' + ink + '">' +
         esc(typeLabel(value)) + '</span>';
}

/* ---------- state ---------- */

var map = null;
var mapReady = false;
var rxMarker = null;
var sightLine = null;
// Map options belong to the person looking at the map, not to the device, so
// they live in this browser rather than in config.yaml.
var opts = { follow: true, labels: true, retentionMin: 60 };
var follow = true;

var sondes = {};        // serial -> registry entry, with its own track and markers
var seenSerials = {};   // every serial this page has seen, never pruned
var lastData = null;

var config = {
  lat: NaN, lon: NaN, alt: NaN, zoom: 11,
  station: 'OpenWXDeck', antenna: '', radio: 'SX1262 GFSK',
  tileServer: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  hardware: 'LilyGO T-Deck Plus',
  decoders: {}, uploads: {}, fromFile: false
};

var tileMetric = { sondes: 'active', frames: 'total', load: 'live' };

// CPU and memory over time. The device reports instantaneous values, so the
// history is this browser's - about ten minutes at the 2 s poll.
var LOAD_HISTORY = 300;
var loadHistory = [];
var framesToday = { day: '', frames: 0, last: null };

/* ---------- formatting ---------- */

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function num(value, decimals, suffix) {
  if (!Number.isFinite(value)) { return '--'; }
  return value.toFixed(decimals == null ? 1 : decimals) + (suffix || '');
}

function distance(metres) {
  if (!Number.isFinite(metres)) { return '--'; }
  return metres < 1000 ? metres.toFixed(0) + ' m' : (metres / 1000).toFixed(2) + ' km';
}

function shortAge(ms) {
  if (!Number.isFinite(ms)) { return '--'; }
  if (ms < 1000) { return '0s'; }
  if (ms < 60000) { return Math.round(ms / 1000) + 's'; }
  if (ms < 3600000) { return Math.round(ms / 60000) + 'm'; }
  return Math.round(ms / 3600000) + 'h';
}

function two(n) { return n < 10 ? '0' + n : String(n); }

// The device has no clock, so timestamps are this browser's.
function stamp(date) {
  return two(date.getDate()) + '.' + two(date.getMonth() + 1) + '.' + date.getFullYear() +
         ' ' + two(date.getHours()) + ':' + two(date.getMinutes()) + ':' + two(date.getSeconds());
}

function clock(date) {
  return two(date.getHours()) + ':' + two(date.getMinutes()) + ':' + two(date.getSeconds());
}

// Radiosonde work is done in UTC, and the sonde's own clock is the only one
// the device ever sees, so times that came from a sonde are shown as UTC.
function clockUtc(date) {
  return two(date.getUTCHours()) + ':' + two(date.getUTCMinutes()) +
         ':' + two(date.getUTCSeconds()) + 'Z';
}

function stampUtc(date) {
  return date.getUTCFullYear() + '-' + two(date.getUTCMonth() + 1) + '-' +
         two(date.getUTCDate()) + ' ' + two(date.getUTCHours()) + ':' +
         two(date.getUTCMinutes()) + ':' + two(date.getUTCSeconds());
}

function mmss(ms) {
  if (!Number.isFinite(ms) || ms < 0) { return '--'; }
  var total = Math.round(ms / 1000);
  return two(Math.floor(total / 60)) + ':' + two(total % 60);
}

var COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
               'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
function compass(deg) {
  if (!Number.isFinite(deg)) { return ''; }
  return COMPASS[Math.round((deg % 360) / 22.5) % 16];
}

// N52.81218 / E9.94988, the way OpenWXTTGO writes a position.
function hemisphere(value, positive, negative) {
  if (!Number.isFinite(value)) { return '--'; }
  return (value >= 0 ? positive : negative) + Math.abs(value).toFixed(5);
}

function icon(name) {
  return '<svg class="i"><use href="#ic-' + name + '"></use></svg>';
}

function setBadge(text, state) {
  var el = document.getElementById('statusBadge');
  el.textContent = text;
  el.className = 'owx-status-badge' + (state ? ' ' + state : '');
}

/* ---------- station config ---------- */

// config.yaml holds the MQTT and SondeHub credentials, so the device does not
// serve it as a file. /api/config publishes the parts a browser may see.
function applyConfig(d) {
  if (!d) { return; }

  var st = d.station || {};
  if (st.callsign) { config.station = st.callsign; }
  if (Number.isFinite(st.lat)) { config.lat = st.lat; }
  if (Number.isFinite(st.lon)) { config.lon = st.lon; }
  if (Number.isFinite(st.alt)) { config.alt = st.alt; }
  if (st.receiver) { config.radio = st.receiver; }
  config.antenna = st.antenna || '';

  var map = d.map || {};
  if (Number.isFinite(map.zoom)) { config.zoom = map.zoom; }
  if (map.tile_server) { config.tileServer = map.tile_server; }
  // The device's retention is the default the first time this browser opens
  // the map; after that the Map settings dialogue owns it.
  if (Number.isFinite(map.retention_s) && map.retention_s > 0 && !config.seenOpts) {
    opts.retentionMin = Math.round(map.retention_s / 60);
    applyRetention();
  }

  // Whether every sonde is named on the map is set on the device too, so the
  // Config screen and the panel agree; this browser's own choice wins once it
  // has made one.
  if (typeof map.labels === 'boolean' && !config.seenOpts) {
    opts.labels = map.labels;

    var labelBox = document.getElementById('optLabels');
    if (labelBox) { labelBox.checked = opts.labels; }
  }

  // When a track stops being live is the device's call, not this browser's:
  // it is the receiver that knows how long it has been silent.
  if (Number.isFinite(map.stale_s) && map.stale_s > 0) {
    SONDE_STALE_MS = map.stale_s * 1000;
  }

  config.decoders = d.decoders || {};
  config.uploads = d.uploads || {};
  config.fromFile = !!d.loaded;
}

function loadConfig() {
  return fetch('/api/config', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(applyConfig)
    .catch(function () { /* older firmware: the GPS fix is the only home */ });
}

function configHome() {
  return Number.isFinite(config.lat) && Number.isFinite(config.lon) ? [config.lat, config.lon] : null;
}

// The receiver marker sits on the live GPS fix when there is one; the station
// position from config.yaml is the fallback for a device indoors or without a
// GPS antenna.
function receiverAt(d) {
  if (d && d.local && d.local.fix) { return { at: [d.local.lat, d.local.lon], fix: true }; }
  var home = configHome();
  return home ? { at: home, fix: false } : null;
}

/* ---------- tile metric ---------- */

function loadOpts() {
  try {
    var stored = JSON.parse(window.localStorage.getItem(OPTS_KEY) || 'null');
    if (stored) {
      if (typeof stored.follow === 'boolean') { opts.follow = stored.follow; }
      if (typeof stored.labels === 'boolean') { opts.labels = stored.labels; }
      if (Number.isFinite(stored.retentionMin)) { opts.retentionMin = stored.retentionMin; }

      // This browser has chosen before, so the device's retention is no longer
      // the default to fall back to.
      config.seenOpts = true;
    }
  } catch (e) { /* private mode: the defaults are fine */ }

  follow = opts.follow;
  applyRetention();
}

function saveOpts() {
  try { window.localStorage.setItem(OPTS_KEY, JSON.stringify(opts)); } catch (e) { }
}

// 0 means keep everything, which is what a recovery wants: the track from two
// hours ago is the reason you are standing in a field.
function applyRetention() {
  SONDE_RETENTION_MS = opts.retentionMin > 0 ? opts.retentionMin * 60000 : 0;
}

function retained(entry) {
  // What the receiver kept in its own filesystem stays until the receiver
  // drops it: sixteen sondes, three days, its rules. After a reboot those
  // pins are the only record of where the last flights went, and dropping
  // them because this browser's window is shorter would throw away the one
  // thing that survived. Once a live frame arrives the entry stops being a
  // stored one and ages like any other.
  if (entry.fromDevice || entry.fromStore) { return true; }

  return SONDE_RETENTION_MS === 0 || Date.now() - entry.lastSeen < SONDE_RETENTION_MS;
}

function loadTileMetric() {
  try {
    var stored = JSON.parse(window.localStorage.getItem(TILE_KEY) || 'null');
    if (stored) {
      if (stored.sondes === 'total' || stored.sondes === 'active') { tileMetric.sondes = stored.sondes; }
      if (stored.frames === 'total' || stored.frames === 'today') { tileMetric.frames = stored.frames; }
      if (stored.load === 'live' || stored.load === 'graph') { tileMetric.load = stored.load; }
    }
  } catch (e) { /* private mode: the defaults are fine */ }
}

function saveTileMetric() {
  try { window.localStorage.setItem(TILE_KEY, JSON.stringify(tileMetric)); } catch (e) { }
}

// The device has no clock, so it cannot count frames per day itself. This
// browser accumulates the counter's deltas instead, which survives a reload
// and a device reboot but not a different browser.
function loadFramesToday() {
  try {
    var stored = JSON.parse(window.localStorage.getItem(FRAME_KEY) || 'null');
    if (stored && stored.day) { framesToday = stored; }
  } catch (e) { }
}

function updateFramesToday(valid) {
  if (!Number.isFinite(valid)) { return; }

  var day = new Date().toISOString().slice(0, 10);
  if (framesToday.day !== day) { framesToday = { day: day, frames: 0, last: valid }; }
  if (framesToday.last == null) { framesToday.last = valid; }

  var delta = valid - framesToday.last;
  if (delta < 0) { delta = valid; }          // the device rebooted and started again

  framesToday.frames += delta;
  framesToday.last = valid;

  try { window.localStorage.setItem(FRAME_KEY, JSON.stringify(framesToday)); } catch (e) { }
}

/* ---------- channel repository ----------
   Every frequency this browser has seen a sonde on, kept across reloads. The
   device has no room to keep such a log, so the page does it: confirmed means
   a decode produced telemetry there, detected means the band scan found a
   carrier that never decoded. */

var REPO_KEY = 'owx_deck_channel_log';
var repo = {};

function loadRepo() {
  try { repo = JSON.parse(window.localStorage.getItem(REPO_KEY) || 'null') || {}; }
  catch (e) { repo = {}; }
}

function saveRepo() {
  try { window.localStorage.setItem(REPO_KEY, JSON.stringify(repo)); } catch (e) { }
}

function repoNote(mhz, patch) {
  if (!Number.isFinite(mhz)) { return; }

  var key = mhz.toFixed(3);
  var entry = repo[key];

  if (!entry) { entry = repo[key] = { mhz: mhz, status: 'detected', seen: 0 }; }

  Object.keys(patch).forEach(function (k) { entry[k] = patch[k]; });
  saveRepo();
}

// A carrier the scan found. It never overwrites what a decode has confirmed:
// a peak says something is transmitting, not what.
function repoDetect(mhz, dbm, noise) {
  if (!Number.isFinite(mhz)) { return; }

  var entry = repo[mhz.toFixed(3)];
  if (entry && entry.status === 'confirmed') { return; }

  repoNote(mhz, {
    status: 'detected',
    rssi: Number.isFinite(dbm) ? dbm : null,
    snr: Number.isFinite(dbm) && Number.isFinite(noise) ? dbm - noise : null,
    seen: Date.now()
  });
}

function repoList() {
  return Object.keys(repo)
    .map(function (k) { return repo[k]; })
    .filter(function (e) { return Number.isFinite(e.mhz); })
    .sort(function (a, b) { return a.mhz - b.mhz; });
}

/* ---------- sonde registry ---------- */

function rememberSonde(d) {
  if (!d.sonde.heard || !d.sonde.serial) { return; }

  var entry = sondes[d.sonde.serial];
  if (!entry) {
    entry = sondes[d.sonde.serial] = { firstSeen: Date.now(), points: [] };
  }
  seenSerials[d.sonde.serial] = true;

  // last_seen_ms counts from the device's last frame, so this is when the
  // frame was received rather than when this poll happened.
  var seenAt = Date.now() - (Number.isFinite(d.sonde.last_seen_ms) ? d.sonde.last_seen_ms : 0);

  // heard stays true after the radio has moved on, so the tuned frequency is
  // only this sonde's while a frame is actually arriving. Stamping it on every
  // poll is what put the scan's current channel on a sonde heard elsewhere.
  var freshFrame = !entry.lastSeen || seenAt > entry.lastSeen + 500;

  entry.serial = d.sonde.serial;
  entry.type = d.sonde.type;

  // It came out of the device's file, or out of this browser's own store,
  // but it is being received now.
  entry.fromDevice = false;
  entry.fromStore = false;

  // rx_mhz is the channel the frame actually arrived on, recorded by the
  // device at decode time. Without it (older firmware) the tuned frequency is
  // the best guess, and only while a frame is genuinely fresh.
  var rxMhz = Number.isFinite(d.sonde.rx_mhz) ? d.sonde.rx_mhz : d.frequency.mhz;

  if (Number.isFinite(d.sonde.rx_mhz)) { entry.freqMhz = rxMhz; }

  if (freshFrame || !Number.isFinite(entry.freqMhz)) {
    entry.freqMhz = rxMhz;

    repoNote(rxMhz, {
      status: 'confirmed',
      type: d.sonde.type,
      serial: d.sonde.serial,
      rssi: d.sonde.rssi_dbm,
      seen: seenAt
    });
  }

  if (Number.isFinite(d.sonde.batt_v)) { entry.battV = d.sonde.batt_v; }

  // Only the DFM decoder measures a temperature so far; when one is there it
  // belongs on the sonde, not in a log nobody opens.
  if (Number.isFinite(d.sonde.temp_c)) { entry.tempC = d.sonde.temp_c; }
  if (Number.isFinite(d.sonde.hum)) { entry.humidity = d.sonde.hum; }
  if (Number.isFinite(d.sonde.pres)) { entry.pressure = d.sonde.pres; }
  if (Number.isFinite(d.sonde.utc) && d.sonde.utc > 0) { entry.utc = d.sonde.utc * 1000; }

  entry.frame = d.sonde.frame;
  entry.rssi = d.sonde.rssi_dbm;
  entry.sats = d.sonde.sats;
  entry.gps = d.sonde.gps;
  entry.velV = d.sonde.vel_v;
  entry.velH = d.sonde.vel_h;

  if (d.sonde.gps) {
    entry.lat = d.sonde.lat;
    entry.lon = d.sonde.lon;
    entry.alt = d.sonde.alt_m;

    // The first fix is worth keeping on its own: once the track is trimmed or
    // cleared, points[0] is no longer where the sonde was first seen.
    if (!Number.isFinite(entry.firstLat)) {
      entry.firstLat = entry.lat;
      entry.firstLon = entry.lon;
      entry.firstAlt = entry.alt;
      entry.firstSeen = Date.now();
    }

    var last = entry.points.length > 0 ? entry.points[entry.points.length - 1] : null;
    if (!last || last[0] !== entry.lat || last[1] !== entry.lon) {
      entry.points.push([entry.lat, entry.lon]);
      if (entry.points.length > MAX_TRACK_POINTS) { entry.points.shift(); }
      entry.pointsChanged = true;
    }
  }

  if (d.recovery.ready) {
    entry.rangeM = d.recovery.range_m;
    entry.bearing = d.recovery.bearing_deg;
    entry.elevation = d.recovery.elevation_deg;
  }

  entry.lastSeen = seenAt;
  entry.stamp = stamp(new Date(entry.lastSeen));
}

// The device keeps the last sondes it heard in a file of its own, so the list
// is there after a reboot even with no SD card fitted. They are seeded into
// the registry before the first poll, and a live frame simply overwrites them.
/* ---------- the tracks this browser watched ---------- */

// The device remembers where each sonde was last heard; it cannot remember
// how it got there. That track only ever existed in this page, so a reload -
// or a night's sleep - used to leave a flight as a single pin. A thinned copy
// goes into browser storage instead, and comes back with the page.
//
// Thinned, because a two-hour flight is thousands of points and none of them
// are needed to see the shape of it; rounded to five decimals, which is about
// a metre and more than a map at any zoom can show.
var TRACK_KEY = 'owx_deck_tracks';
var TRACK_VERSION = 1;
var TRACK_POINTS = 240;                    // per sonde, after thinning
var TRACK_KEEP = 16;                       // as many sondes as the device keeps
var TRACK_MAX_AGE_MS = 72 * 3600000;       // and for as long as it keeps them
var TRACK_SAVE_MS = 20000;

var lastTrackSaveMs = 0;
var trackStore = null;

// The store is read once and then kept, because it is also what a save
// merges into: a sonde the map's retention window has let go of stays in it
// until the store's own window lets go too. Rebuilding it from what is on
// the map would throw away last night's flight at the moment it went stale -
// which is the moment it starts being worth keeping.
function loadTrackStore() {
  if (trackStore) { return trackStore; }

  try {
    var raw = JSON.parse(window.localStorage.getItem(TRACK_KEY) || 'null');
    trackStore = raw && raw.v === TRACK_VERSION && raw.sondes ? raw.sondes : {};
  } catch (e) {
    trackStore = {};
  }

  return trackStore;
}

function round5(value) {
  return Number.isFinite(value) ? Math.round(value * 100000) / 100000 : null;
}

function round1(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

// Every nth point, with the first and the last always kept: a balloon's track
// is smooth enough that this is the same shape drawn with less of it.
function thinPoints(points, limit) {
  if (points.length <= limit) {
    return points.map(function (p) { return [round5(p[0]), round5(p[1])]; });
  }

  var out = [];
  var step = (points.length - 1) / (limit - 1);

  for (var i = 0; i < limit; i++) {
    var p = points[Math.round(i * step)];
    out.push([round5(p[0]), round5(p[1])]);
  }

  return out;
}

function trackRecord(entry) {
  return {
    t: entry.type || '',
    f: Number.isFinite(entry.freqMhz) ? Math.round(entry.freqMhz * 1000) / 1000 : null,
    s: entry.lastSeen,
    u: Number.isFinite(entry.utc) ? entry.utc : 0,
    fr: Number.isFinite(entry.frame) ? entry.frame : null,
    n: Number.isFinite(entry.frames) ? entry.frames : null,
    a: Number.isFinite(entry.alt) ? Math.round(entry.alt) : null,
    vv: round1(entry.velV),
    vh: round1(entry.velH),
    tc: round1(entry.tempC),
    hu: round1(entry.humidity),
    pr: round1(entry.pressure),
    b: round1(entry.battV),
    fs: entry.firstSeen || entry.lastSeen,
    fl: round5(entry.firstLat),
    fo: round5(entry.firstLon),
    fa: Number.isFinite(entry.firstAlt) ? Math.round(entry.firstAlt) : null,
    p: thinPoints(entry.points, TRACK_POINTS)
  };
}

function saveTracks(force) {
  var now = Date.now();

  if (!force && now - lastTrackSaveMs < TRACK_SAVE_MS) { return; }
  lastTrackSaveMs = now;

  var store = loadTrackStore();

  // Only a track is worth keeping. A single position is what the device
  // remembers by itself, and copying that here would just be this browser
  // repeating what /api/sondes already says.
  sondeList().forEach(function (e) {
    if (!e.points || e.points.length < 2 || !Number.isFinite(e.lat)) { return; }
    if (now - e.lastSeen > TRACK_MAX_AGE_MS) { return; }

    store[e.serial] = trackRecord(e);
  });

  Object.keys(store).forEach(function (serial) {
    var r = store[serial];

    if (!r || !(r.s > 0) || now - r.s > TRACK_MAX_AGE_MS) { delete store[serial]; }
  });

  // Newest first, and only as many as the device itself keeps.
  var order = Object.keys(store).sort(function (a, b) { return store[b].s - store[a].s; });
  order.slice(TRACK_KEEP).forEach(function (serial) { delete store[serial]; });

  try {
    window.localStorage.setItem(TRACK_KEY, JSON.stringify(
      { v: TRACK_VERSION, at: now, sondes: store }));
  } catch (e) {
    // A full quota, or a browser that keeps none: let the oldest half go and
    // try once more, then leave it. The map is no worse off than before.
    try {
      order.slice(Math.ceil(TRACK_KEEP / 2)).forEach(function (serial) { delete store[serial]; });
      window.localStorage.setItem(TRACK_KEY, JSON.stringify(
        { v: TRACK_VERSION, at: now, sondes: store }));
    } catch (e2) { }
  }
}

function restoreTracks() {
  var store = loadTrackStore();
  var now = Date.now();
  var restored = 0;

  Object.keys(store).forEach(function (serial) {
    var r = store[serial];

    if (!r || !Array.isArray(r.p) || r.p.length === 0) { return; }
    if (!(r.s > 0) || now - r.s > TRACK_MAX_AGE_MS) { return; }
    if (sondes[serial]) { return; }

    var last = r.p[r.p.length - 1];

    sondes[serial] = {
      serial: serial,
      type: r.t || '',
      freqMhz: Number.isFinite(r.f) ? r.f : NaN,
      lat: last[0],
      lon: last[1],
      alt: Number.isFinite(r.a) ? r.a : NaN,
      velV: Number.isFinite(r.vv) ? r.vv : NaN,
      velH: Number.isFinite(r.vh) ? r.vh : NaN,
      tempC: Number.isFinite(r.tc) ? r.tc : NaN,
      humidity: Number.isFinite(r.hu) ? r.hu : NaN,
      pressure: Number.isFinite(r.pr) ? r.pr : NaN,
      battV: Number.isFinite(r.b) ? r.b : NaN,
      frame: Number.isFinite(r.fr) ? r.fr : undefined,
      frames: Number.isFinite(r.n) ? r.n : undefined,
      utc: r.u > 0 ? r.u : undefined,
      firstSeen: r.fs || r.s,
      firstLat: Number.isFinite(r.fl) ? r.fl : undefined,
      firstLon: Number.isFinite(r.fo) ? r.fo : undefined,
      firstAlt: Number.isFinite(r.fa) ? r.fa : undefined,
      lastSeen: r.s,
      stamp: stamp(new Date(r.s)),
      fromStore: true,
      points: r.p.map(function (p) { return [p[0], p[1]]; })
    };

    seenSerials[serial] = true;
    ++restored;

    if (Number.isFinite(sondes[serial].freqMhz)) {
      repoNote(sondes[serial].freqMhz, {
        status: 'confirmed',
        type: sondes[serial].type,
        serial: serial,
        seen: r.s
      });
    }
  });

  return restored;
}

// The page can be closed between two saves, and on a phone it is usually
// hidden rather than closed.
window.addEventListener('pagehide', function () { saveTracks(true); });
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'hidden') { saveTracks(true); }
});

function seedStored() {
  return fetch('/api/sondes', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || !Array.isArray(d.stored)) { return; }

      d.stored.forEach(function (s) {
        if (!s.serial) { return; }

        // age_ms is only there for a sonde heard in this run; one that came
        // back from the file has the sonde's own clock instead. A receiver
        // that has never had a clock at all has neither - and the position
        // is still worth a pin, so it gets one and says the time is not
        // something it can answer for.
        var timeUnknown = false;
        var lastSeen = Number.isFinite(s.age_ms)
          ? Date.now() - s.age_ms
          : (s.utc > 0 ? s.utc * 1000 : null);

        if (lastSeen === null) {
          if (!Number.isFinite(s.lat)) { return; }
          timeUnknown = true;
          lastSeen = Date.now() - STORE_MAX_AGE_MS;
        }

        // This browser may already have restored its own track for that
        // serial. The device's entry is the authority on where it was last
        // heard and how many frames it gave; the track is the part the
        // device could not keep, so the two are put together rather than one
        // of them thrown away.
        var known = sondes[s.serial];

        if (known) {
          if (!known.type && s.type) { known.type = s.type; }
          if (!Number.isFinite(known.freqMhz) && Number.isFinite(s.rx_mhz)) {
            known.freqMhz = s.rx_mhz;
          }
          if (!Number.isFinite(known.frames) && Number.isFinite(s.frames)) {
            known.frames = s.frames;
          }

          if (lastSeen > known.lastSeen && Number.isFinite(s.lat)) {
            known.lat = s.lat;
            known.lon = s.lon;
            known.alt = Number.isFinite(s.alt_m) ? s.alt_m : known.alt;
            known.lastSeen = lastSeen;
            known.stamp = stamp(new Date(lastSeen));
            known.points.push([s.lat, s.lon]);
            known.pointsChanged = true;
          }

          return;
        }

        var entry = sondes[s.serial] = {
          serial: s.serial,
          type: s.type || '',
          freqMhz: Number.isFinite(s.rx_mhz) ? s.rx_mhz : NaN,
          lat: Number.isFinite(s.lat) ? s.lat : NaN,
          lon: Number.isFinite(s.lon) ? s.lon : NaN,
          alt: Number.isFinite(s.alt_m) ? s.alt_m : NaN,
          velV: Number.isFinite(s.vel_v) ? s.vel_v : NaN,
          velH: Number.isFinite(s.vel_h) ? s.vel_h : NaN,
          utc: s.utc > 0 ? s.utc * 1000 : undefined,
          frames: s.frames,
          fromDevice: true,
          timeUnknown: timeUnknown,
          firstSeen: lastSeen,
          lastSeen: lastSeen,
          stamp: timeUnknown ? 'time not recorded' : stamp(new Date(lastSeen)),
          points: []
        };

        seenSerials[s.serial] = true;

        if (Number.isFinite(entry.lat)) {
          entry.points.push([entry.lat, entry.lon]);
          entry.firstLat = entry.lat;
          entry.firstLon = entry.lon;
          entry.firstAlt = entry.alt;
        }

        if (Number.isFinite(entry.freqMhz)) {
          repoNote(entry.freqMhz, {
            status: 'confirmed',
            type: entry.type,
            serial: entry.serial,
            seen: lastSeen
          });
        }
      });
    })
    .catch(function () { });
}

function sondeList() {
  var now = Date.now();

  return Object.keys(sondes)
    .map(function (key) { return sondes[key]; })
    .filter(retained)
    .sort(function (a, b) { return b.lastSeen - a.lastSeen; });
}

function isFresh(entry) {
  return Date.now() - entry.lastSeen < SONDE_STALE_MS;
}

function dropExpired() {
  Object.keys(sondes).forEach(function (key) {
    if (retained(sondes[key])) { return; }
    if (mapReady) { clearLayers(sondes[key]); }
    delete sondes[key];
  });
}

/* ---------- map icons ---------- */

function svgIcon(svg, w, h, anchorY) {
  return L.icon({
    iconUrl: 'data:image/svg+xml;base64,' + window.btoa(svg),
    iconSize: [w, h],
    iconAnchor: [w / 2, anchorY],
    popupAnchor: [0, -anchorY]
  });
}

// Ascending and descending markers: the same two images OpenWXTTGO serves
// from its filesystem, so a sonde looks identical on both maps.
function pngIcon(url, w, h) {
  return L.icon({ iconUrl: url, iconSize: [w, h], iconAnchor: [w / 2, h], popupAnchor: [0, -h] });
}

var balloonIcon = null;
var chuteIcon = null;
var landingIcon = null;
var startIcon = null;
var storedIcon = null;
var gatewayIcon = null;

function buildIcons() {
  balloonIcon = pngIcon('balloon.png', 23, 42);
  chuteIcon = pngIcon('chute.png', 23, 42);

  startIcon = svgIcon(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12">' +
    '<circle cx="6" cy="6" r="5" fill="#00ff88" stroke="#0a3d24" stroke-width="1.5"/></svg>', 12, 12, 6);

  // Last known position of a sonde that is no longer being received.
  storedIcon = svgIcon(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 32">' +
    '<path d="M12 1C6.8 1 2.6 5.2 2.6 10.4c0 7 9.4 20.6 9.4 20.6s9.4-13.6 9.4-20.6C21.4 5.2 17.2 1 12 1z"' +
    ' fill="#8d99ae" stroke="#ffffff" stroke-width="1.6"/>' +
    '<circle cx="12" cy="10.4" r="3.6" fill="#ffffff"/></svg>', 20, 27, 27);

  // Where the sonde is predicted to come down. Deliberately not a pin: it is
  // a forecast, and it should not look like something that was measured.
  landingIcon = svgIcon(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 26 26">' +
    '<circle cx="13" cy="13" r="8" fill="none" stroke="#ff5a5a" stroke-width="2.4"/>' +
    '<circle cx="13" cy="13" r="2.6" fill="#ff5a5a"/>' +
    '<path d="M13 1.5 L13 6 M13 20 L13 24.5 M1.5 13 L6 13 M20 13 L24.5 13"' +
    ' stroke="#ff5a5a" stroke-width="2.4" stroke-linecap="round"/></svg>', 26, 26, 13);

  // Receiver / gateway marker: blue disc, white broadcast glyph.
  gatewayIcon = svgIcon(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 34 34">' +
    '<circle cx="17" cy="17" r="15" fill="#2f7fd6" stroke="#ffffff" stroke-width="3"/>' +
    '<circle cx="17" cy="19" r="2.6" fill="#ffffff"/>' +
    '<path d="M11.6 13.6a7.6 7.6 0 0 1 10.8 0" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>' +
    '<path d="M14.3 16.3a3.8 3.8 0 0 1 5.4 0" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>' +
    '<path d="M17 21.4 L17 25.6" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/></svg>', 34, 34, 17);
}

function endIconFor(entry, fresh) {
  if (!fresh) { return storedIcon; }
  return Number.isFinite(entry.velV) && entry.velV < 0 ? chuteIcon : balloonIcon;
}

/* ---------- map ---------- */

function initMap() {
  if (typeof L === 'undefined') {
    document.getElementById('noMap').style.display = 'block';
    return false;
  }

  // Centre on the station when config.yaml gives one: a handheld is almost
  // always looking at its own patch of sky, not at the whole country.
  var home = configHome();

  map = L.map('map', { zoomControl: true })
    .setView(home || [51.0, 10.0], home ? config.zoom : 6);

  var tiles = L.tileLayer(config.tileServer, {
    maxZoom: 18,
    attribution: '&copy; OpenStreetMap contributors'
  });

  // One failed tile is normal at the edge of the world; a burst of them means
  // there is no route to the tile server, and the overlay explains that
  // rather than leaving a grey rectangle.
  var tileErrors = 0;
  tiles.on('tileerror', function () {
    tileErrors += 1;
    if (tileErrors === 8) { document.getElementById('noMap').style.display = 'block'; }
  });
  tiles.on('tileload', function () { tileErrors = 0; });
  tiles.addTo(map);

  buildIcons();
  addHomeButton();

  sightLine = L.polyline([], { color: '#d97706', weight: 2, dashArray: '6 6' }).addTo(map);

  mapReady = true;
  return true;
}

// Leaflet's own bar styling, so the button sits under the zoom control and
// looks like part of it. EasyButton is a plugin the device does not serve.
function addHomeButton() {
  var Home = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function () {
      var bar = L.DomUtil.create('div', 'leaflet-bar owx-mapbar');
      var link = L.DomUtil.create('a', 'owx-mapbtn', bar);

      link.href = '#';
      link.title = 'Centre on the receiver';
      link.id = 'homeBtn';
      link.setAttribute('role', 'button');
      link.innerHTML = '<svg class="i"><use href="#ic-home"></use></svg>';

      L.DomEvent.on(link, 'click', function (e) { L.DomEvent.stop(e); goHome(); });
      L.DomEvent.disableClickPropagation(bar);
      return bar;
    }
  });

  map.addControl(new Home());
}

function goHome() {
  var here = configHome() || (lastData && lastData.local && lastData.local.fix
    ? [lastData.local.lat, lastData.local.lon] : null);

  if (!here) { setBadge('No station position in config.yaml', 'warn'); return; }

  setFollow(false);
  map.setView(here, Math.max(map.getZoom(), config.zoom));
  if (rxMarker) { rxMarker.openPopup(); }
}



/* ---------- map layers per sonde ---------- */

function clearLayers(entry) {
  ['line', 'marker', 'startMarker', 'predLine', 'predMarker'].forEach(function (key) {
    if (!entry[key]) { return; }
    try { map.removeLayer(entry[key]); } catch (e) { }
    entry[key] = null;
  });
  entry.styleKey = '';
}

// Every track is solid orange, as on OpenWXSDR's map: a sonde still being
// received and one that has gone quiet draw the same line, and the marker and
// its label say which of the two it is.
function pathStyle(entry, fresh) {
  return fresh
    ? { color: TRACK_ACTIVE, weight: 3, opacity: 0.95, dashArray: null }
    : { color: TRACK_ACTIVE, weight: 2.5, opacity: 0.85, dashArray: null };
}

function markerLabel(entry, fresh) {
  var head = esc(entry.serial) + ' &middot; ' + num(entry.freqMhz, 3, ' MHz') +
             ' &middot; ' + esc(typeLabel(entry.type));

  var detail = fresh
    ? num(entry.alt, 0, ' m') + ' &middot; ' + num(entry.velV, 1, ' m/s') + ' &middot; ' +
      num(Number.isFinite(entry.velH) ? entry.velH * 3.6 : NaN, 1, ' km/h')
    : 'Last position &middot; ' + num(entry.alt, 0, ' m') + ' &middot; ' +
      shortAge(Date.now() - entry.lastSeen) + ' ago';

  return '<div class="sonde-label"><span class="sl-head">' + head + '</span>' +
         '<span class="sl-detail" style="color:' + typeColour(entry.type) + '">' + detail + '</span></div>';
}

// Where this browser first saw the sonde. It is deliberately not called the
// launch point: the device only knows what it has heard, and a sonde picked up
// mid-flight was already well on its way.
function startPopup(entry) {
  const at = Number.isFinite(entry.firstLat)
    ? [entry.firstLat, entry.firstLon, entry.firstAlt]
    : [entry.points.length ? entry.points[0][0] : NaN,
       entry.points.length ? entry.points[0][1] : NaN, NaN];

  const when = entry.firstSeen ? stamp(new Date(entry.firstSeen)) : '--';

  return '<div class="start-popup">' +
    '<div class="start-hdr"><strong>' + esc(entry.serial) + '</strong> - First position seen</div>' +
    '<div class="start-note">Where this browser started following it</div>' +
    esc(when) + '<br>' +
    '<span class="coord">Lat: ' + hemisphere(at[0], 'N', 'S') +
      ' Lon: ' + hemisphere(at[1], 'E', 'W') + '</span><br>' +
    '<span class="coord">Alt=' + num(at[2], 0, ' m') + '</span>' +
    '</div>';
}

// The sonde's popup, laid out as OpenWXSDR's: serial, frequency and type in
// the heading, then one fact per line.
function markerPopup(entry, fresh) {
  var km = Number.isFinite(entry.rangeM)
    ? (entry.rangeM < 1000 ? entry.rangeM.toFixed(0) + ' m' : (entry.rangeM / 1000).toFixed(1) + ' km')
    : '--';

  // A sonde that came back from the device's file has no frame number, only
  // how many frames it gave before it went.
  var frame = entry.frame != null
    ? 'Frame# ' + entry.frame
    : (Number.isFinite(entry.frames) ? 'Frames: ' + entry.frames : 'Frame# --');

  var rows =
    '<div class="owx-pop-hdr"><strong>' + esc(entry.serial) + '</strong> - ' +
      num(entry.freqMhz, 3, ' MHz') + ' - ' + esc(typeLabel(entry.type)) + '</div>' +
    esc(entry.stamp) + '<br>' +
    'Lat: ' + hemisphere(entry.lat, 'N', 'S') + ' Lon: ' + hemisphere(entry.lon, 'E', 'W') + '<br>' +
    'Alt=' + num(entry.alt, 0, ' m') + ' | ' + frame;

  if (Number.isFinite(entry.tempC) || Number.isFinite(entry.humidity)) {
    rows += '<br>Temp: ' + num(entry.tempC, 1, ' &deg;C') +
            ' | Hum: ' + num(entry.humidity, 0, ' %');
  }

  if (Number.isFinite(entry.pressure)) {
    rows += '<br>Pressure: ' + num(entry.pressure, 1, ' hPa');
  }

  if (Number.isFinite(entry.rangeM)) {
    rows += '<br>Distance: ' + km + ' @ ' + num(entry.bearing, 0, '&deg;');
  }

  return '<div class="owx-pop">' + rows + '<br>via: ' + esc(config.station) +
    '<div class="popup-act">' +
      '<button type="button" class="btn-play" data-track="' + esc(entry.serial) + '">' +
        'Track from card</button>' +
    '</div></div>';
}

// Permanent labels are readable with two sondes up and unreadable with ten,
// so they are a switch rather than a decision.
function applyLabel(entry, fresh) {
  if (!entry.marker) { return; }

  if (!opts.labels) {
    if (entry.marker.getTooltip && entry.marker.getTooltip()) { entry.marker.unbindTooltip(); }
    return;
  }

  if (entry.marker.getTooltip && entry.marker.getTooltip()) {
    entry.marker.setTooltipContent(markerLabel(entry, fresh));
  } else {
    entry.marker.bindTooltip(markerLabel(entry, fresh),
      { permanent: true, direction: 'right', offset: [11, 0], className: 'sonde-tooltip' });
  }
}

function syncSondeLayers() {
  if (!mapReady) { return; }

  sondeList().forEach(function (entry) {
    if (!Number.isFinite(entry.lat)) { return; }

    var fresh = isFresh(entry);
    var at = [entry.lat, entry.lon];

    // End of the path: the sonde itself while it is being received, a muted
    // pin once it has gone quiet.
    if (!entry.marker) {
      entry.marker = L.marker(at, { icon: endIconFor(entry, fresh) }).addTo(map);
      entry.marker.bindPopup(markerPopup(entry, fresh));
    }

    applyLabel(entry, fresh);

    // Rewriting an identical popup on every poll tears down an open one, so
    // only touch the marker when something actually changed.
    var key = [at[0], at[1], entry.frame, entry.alt, entry.velV, entry.velH,
               entry.type, entry.rssi, fresh, opts.labels].join('|');

    if (entry.styleKey !== key) {
      entry.styleKey = key;
      entry.marker.setLatLng(at).setIcon(endIconFor(entry, fresh));
      entry.marker.setPopupContent(markerPopup(entry, fresh));
      if (entry.line) { entry.line.setStyle(pathStyle(entry, fresh)); }
    }

    if (entry.points.length < 2) { return; }

    if (!entry.line) {
      entry.line = L.polyline(entry.points, pathStyle(entry, fresh)).addTo(map);
      entry.pointsChanged = false;
    } else if (entry.pointsChanged) {
      entry.line.setLatLngs(entry.points);
      entry.pointsChanged = false;
    }

    // Start of the path. Placed only once the sonde has moved, otherwise it
    // lands under the end marker and claims to be the launch point.
    if (!entry.startMarker) {
      entry.startMarker = L.marker(entry.points[0], { icon: startIcon }).addTo(map);
      entry.startMarker.bindPopup(startPopup(entry));
      entry.startMarker.bindTooltip('Track start &middot; ' + esc(entry.serial),
        { direction: 'right', offset: [8, 0], className: 'sonde-tooltip' });
    }
  });
}

/* ---------- landing prediction ---------- */

// The same predictor OpenWXSDR asks: Tawhiri, the CUSF trajectory model, as
// SondeHub hosts it. A sonde already on its way down is a descent from where
// it is now - a burst one metre above it makes the ascent a single step - so
// what comes back is the path to the ground and the point it reaches it at.
//
// Only once it is low enough to mean something: higher up the answer moves
// further between frames than the map can usefully show.
var PRED_URL = 'https://api.v2.sondehub.org/tawhiri';
var PRED_CEILING_M = 5000;
var PRED_INTERVAL_MS = 60000;
var PRED_COLOUR = '#ff5a5a';

function predictable(entry) {
  return isFresh(entry) &&
         Number.isFinite(entry.lat) && Number.isFinite(entry.lon) &&
         Number.isFinite(entry.alt) && entry.alt > 0 && entry.alt < PRED_CEILING_M &&
         Number.isFinite(entry.velV) && entry.velV < -1;
}

function dropPrediction(entry) {
  ['predLine', 'predMarker'].forEach(function (key) {
    if (!entry[key]) { return; }
    try { map.removeLayer(entry[key]); } catch (e) { }
    entry[key] = null;
  });

  entry.pred = null;
}

function predictionPopup(entry) {
  var p = entry.pred;
  if (!p) { return ''; }

  var rows =
    '<div class="popup-hdr"><strong>' + esc(entry.serial) + '</strong> - Predicted landing</div>' +
    '<div class="start-note">Tawhiri descent from ' + num(p.fromAlt, 0, ' m') +
      ' at ' + num(p.descent, 1, ' m/s') + '</div>' +
    num(p.lat, 6) + ', ' + num(p.lon, 6) + '<br>' +
    'Touchdown ' + esc(p.when || '--');

  if (Number.isFinite(p.rangeM)) {
    rows += '<br>Distance ' + distance(p.rangeM) + ' from the receiver';
  }

  return '<div class="sonde-popup">' + rows + '</div>';
}

function drawPrediction(entry) {
  var p = entry.pred;
  if (!mapReady || !p) { return; }

  if (!entry.predLine) {
    entry.predLine = L.polyline(p.path, {
      color: PRED_COLOUR, weight: 2, opacity: 0.8, dashArray: '4 6'
    }).addTo(map);
  } else {
    entry.predLine.setLatLngs(p.path);
  }

  if (!entry.predMarker) {
    entry.predMarker = L.marker([p.lat, p.lon], { icon: landingIcon }).addTo(map);
    entry.predMarker.bindPopup(predictionPopup(entry));
    entry.predMarker.bindTooltip('Predicted landing &middot; ' + esc(entry.serial),
      { direction: 'right', offset: [10, 0], className: 'sonde-tooltip' });
  } else {
    entry.predMarker.setLatLng([p.lat, p.lon]);
    entry.predMarker.setPopupContent(predictionPopup(entry));
  }
}

// One request per sonde per minute, and never two at once for the same one.
// A failure is silent: the predictor is somebody else's server, and a map
// that shouts every time it is slow is a map nobody leaves open.
function requestPrediction(entry) {
  if (entry.predBusy) { return; }

  var now = Date.now();
  if (entry.predAskedMs && now - entry.predAskedMs < PRED_INTERVAL_MS) { return; }

  entry.predBusy = true;
  entry.predAskedMs = now;

  var descent = Math.max(1, Math.abs(entry.velV));
  var lon = entry.lon < 0 ? entry.lon + 360 : entry.lon;   // Tawhiri wants 0..360
  var when = new Date(Number.isFinite(entry.utc) ? entry.utc : now).toISOString();

  var url = PRED_URL +
    '?profile=standard_profile&pred_type=single' +
    '&launch_latitude=' + entry.lat.toFixed(5) +
    '&launch_longitude=' + lon.toFixed(5) +
    '&launch_altitude=' + Math.round(entry.alt) +
    '&launch_datetime=' + encodeURIComponent(when.replace(/\.\d+Z$/, 'Z')) +
    '&ascent_rate=5&burst_altitude=' + (Math.round(entry.alt) + 1) +
    '&descent_rate=' + descent.toFixed(1);

  var fromAlt = entry.alt;

  fetch(url, { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
    .then(function (data) {
      var path = [];
      var last = null;

      (data && data.prediction ? data.prediction : []).forEach(function (stage) {
        (stage.trajectory || []).forEach(function (point) {
          var plon = point.longitude > 180 ? point.longitude - 360 : point.longitude;
          path.push([point.latitude, plon]);
          last = { lat: point.latitude, lon: plon, when: point.datetime };
        });
      });

      if (!last || path.length < 2) { return; }

      entry.pred = {
        lat: last.lat,
        lon: last.lon,
        when: String(last.when).replace('T', ' ').replace(/(\.\d+)?Z$/, '') + ' UTC',
        path: path,
        fromAlt: fromAlt,
        descent: descent,
        rangeM: predictionRange(last.lat, last.lon),
        at: Date.now()
      };

      drawPrediction(entry);
    })
    .catch(function () { })
    .then(function () { entry.predBusy = false; });
}

// How far the predicted point is from wherever the receiver is, which is the
// number somebody about to drive there actually wants.
function predictionRange(lat, lon) {
  var place = receiverAt(lastData);
  if (!place) { return NaN; }

  var R = 6371000;
  var p1 = place.at[0] * Math.PI / 180;
  var p2 = lat * Math.PI / 180;
  var dp = (lat - place.at[0]) * Math.PI / 180;
  var dl = (lon - place.at[1]) * Math.PI / 180;

  var a = Math.sin(dp / 2) * Math.sin(dp / 2) +
          Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function syncPredictions() {
  if (!mapReady || typeof fetch !== 'function') { return; }

  sondeList().forEach(function (entry) {
    if (!predictable(entry)) {
      // Back above the ceiling, climbing again, or gone quiet: the forecast
      // that was drawn for it is no longer about anything.
      if (entry.pred || entry.predMarker) { dropPrediction(entry); }
      return;
    }

    requestPrediction(entry);

    if (entry.pred) { drawPrediction(entry); }
  });
}

/* ---------- receiver marker ---------- */

function receiverPopup(d) {
  var place = receiverAt(d);
  var fresh = sondeList().filter(isFresh);
  var frames = d.counters ? d.counters.valid : (d.logging ? d.logging.frames : 0);

  // The same line OpenWXTTGO's gateway popup shows: when, how far, how high
  // the sonde was and what its own battery said.
  var recent = sondeList().map(function (s) {
    var bits = [clockUtc(new Date(Number.isFinite(s.utc) ? s.utc : s.lastSeen))];
    if (Number.isFinite(s.rangeM)) { bits.push(distance(s.rangeM)); }
    if (Number.isFinite(s.elevation)) { bits.push('el ' + num(s.elevation, 1, '&deg;')); }
    if (Number.isFinite(s.bearing)) { bits.push(num(s.bearing, 0, '&deg;') + ' ' + compass(s.bearing)); }
    if (Number.isFinite(s.alt)) { bits.push(num(s.alt, 0, ' m')); }
    if (Number.isFinite(s.battV)) { bits.push(num(s.battV, 2, ' V')); }

    return '<div class="gw-rx"><span class="gw-rx-id" style="color:' + typeColour(s.type) + '">' +
           esc(typeLabel(s.type)) + ' ' + esc(s.serial) +
           '<span class="gw-rx-qrg">' + num(s.freqMhz, 3, ' MHz') + '</span></span>' +
           '<span class="gw-rx-line">' + bits.join(' &middot; ') + '</span></div>';
  }).join('') || '<div class="gw-none">Nothing received yet this session.</div>';

  // How far back the list can reach is the retention window, not a fixed 8 h.
  var span = opts.retentionMin > 0
    ? (opts.retentionMin >= 60
        ? 'last ' + (opts.retentionMin / 60).toFixed(opts.retentionMin % 60 ? 1 : 0) + ' h'
        : 'last ' + opts.retentionMin + ' min')
    : 'this session';

  var online = !!(d.network && d.network.connected);
  var position = place
    ? num(place.at[0], 5) + ', ' + num(place.at[1], 5) + ' &middot; ' +
      num(place.fix ? d.local.alt_m : config.alt, 0, ' m') +
      ' <span class="gw-src">' + (place.fix ? 'GPS fix' : 'config.yaml') + '</span>'
    : 'unknown';

  return '<div class="gw-popup">' +
    '<div class="gw-hdr">' + icon('server') + 'Receiver: ' + esc(config.station) + '</div>' +
    '<div><span class="gw-key">Status:</span> <span class="' +
      (online ? 'gw-online">online' : 'gw-offline">standalone') + '</span>' +
      (d.network && d.network.ip ? ' &nbsp;|&nbsp; <b>' + esc(d.network.ip) + '</b>' : '') + '</div>' +
    '<div><span class="gw-key">Radio:</span> <b>' + esc(config.radio) + '</b></div>' +
    '<div><span class="gw-key">Position:</span> ' + position + '</div>' +
    '<div><span class="gw-key">Sondes:</span> <b>' + fresh.length + '</b> &nbsp;|&nbsp; ' +
      '<span class="gw-key">Frames:</span> <b>' + frames + '</b></div>' +
    '<div><span class="gw-key">Hardware:</span> <b>' + esc(config.hardware) + '</b></div>' +
    '<div><span class="gw-key">Firmware:</span> <b>OpenWXDeck ' + esc(d.version || '') + '</b></div>' +
    '<hr>' +
    '<div class="gw-sub">' + icon('history') + 'Received (' + span + ')</div>' +
    '<div class="gw-rxlist">' + recent + '</div>' +
    '</div>';
}

// Which families config.yaml has switched on, in the order the badges use.
// DFM needs two sync words, one per frame polarity, so it costs two turns.
function enabledProfileTurns() {
  var turns = 0;
  ['rs41', 'rs92', 'dfm', 'm10', 'm20'].forEach(function (key) {
    if (config.decoders[key]) { turns += key === 'dfm' ? 2 : 1; }
  });
  return turns;
}

function enabledFamilies() {
  var names = [];
  ['rs41', 'rs92', 'dfm', 'm10', 'm20'].forEach(function (key) {
    if (config.decoders[key]) { names.push(key.toUpperCase()); }
  });
  return names.length ? names.join(', ') : 'RS41';
}

function syncReceiver(d) {
  if (!mapReady) { return; }

  var place = receiverAt(d);
  if (!place) { return; }

  if (!rxMarker) {
    rxMarker = L.marker(place.at, { icon: gatewayIcon, zIndexOffset: 500 }).addTo(map);
    rxMarker.bindPopup(receiverPopup(d), { maxWidth: 340 });
    rxMarker.bindTooltip(esc(config.station),
      { direction: 'top', offset: [0, -14], className: 'sonde-tooltip rx-tooltip' });
  } else {
    rxMarker.setLatLng(place.at);
    if (!rxMarker.isPopupOpen()) { rxMarker.setPopupContent(receiverPopup(d)); }
  }
}

function updateMap(d) {
  if (!mapReady) { return; }

  syncReceiver(d);
  syncSondeLayers();
  syncPredictions();

  var sondeAt = d.sonde.gps ? [d.sonde.lat, d.sonde.lon] : null;
  var place = receiverAt(d);

  sightLine.setLatLngs(sondeAt && place ? [place.at, sondeAt] : []);

  if (sondeAt && follow) { map.setView(sondeAt, Math.max(map.getZoom(), 11)); }
}

/* ---------- sidebar ---------- */

function sondeCard(s, fresh) {
  var climbIcon = Number.isFinite(s.velV) && s.velV < 0 ? 'down' : 'up';
  var kmh = Number.isFinite(s.velH) ? s.velH * 3.6 : NaN;

  var rows =
    '<div class="data-item">' + icon('rss') +
      '<span class="data-value">' + num(s.freqMhz, 3, ' MHz') + '</span></div>' +
    '<div class="data-item">' + icon(climbIcon) +
      '<span class="data-value">' + num(s.velV, 1, ' m/s') + '</span></div>' +
    '<div class="data-item">' + icon('speed') +
      '<span class="data-value">' + num(kmh, 1, ' km/h') + '</span></div>' +
    '<div class="data-item">' + icon('pin') +
      '<span class="data-value">' + num(s.alt, 0, ' m') + '</span></div>' +
    '<div class="data-item">' + icon('hash') +
      '<span class="data-value">' +
        (s.frame != null
          ? '#' + s.frame
          : (Number.isFinite(s.frames) ? s.frames + ' fr' : '#--')) +
      '</span></div>' +
    '<div class="data-item">' + icon('clock') +
      '<span class="data-value">' +
        (s.timeUnknown ? '--' : shortAge(Date.now() - s.lastSeen)) + '</span></div>';

  if (Number.isFinite(s.lat)) {
    rows += '<div class="data-item wide">' + icon('cross') +
            '<span class="data-value">' + num(s.lat, 4) + ', ' + num(s.lon, 4) + '</span></div>';
  }

  if (Number.isFinite(s.rangeM)) {
    rows += '<div class="data-item half">' + icon('arrow') +
            '<span class="data-value">' + distance(s.rangeM) + ' &middot; ' +
            num(s.bearing, 0, '&deg;') + '</span></div>' +
            '<div class="data-item">' + icon('sat') +
            '<span class="data-value">' + s.rssi + ' dBm</span></div>';
  }

  return '<div class="sonde-card' + (fresh ? ' active-decode' : '') +
    '" data-serial="' + esc(s.serial) + '" title="Centre on the map">' +
    '<div class="sonde-header">' +
      '<span class="sonde-serial">' + esc(s.serial) +
        '<span class="sonde-meta">' + esc(s.stamp) + '</span></span>' +
      '<span style="display:flex;align-items:center">' + typeBadge(s.type) +
        sondeMenu(s.serial) + '</span>' +
    '</div>' +
    '<div class="sonde-data">' + rows + '</div>' +
    '<div class="sonde-gateway">' + icon('server') +
      '<span class="gw-name">' + esc(config.station) + '</span></div>' +
    '</div>';
}

// Per-sonde actions. Centring zooms in, because a card is usually clicked to
// go and look at where the thing actually is.
function sondeMenu(serial) {
  var id = esc(serial);
  return '<span class="sonde-menu">' +
    '<button type="button" class="sonde-dots" data-sonde-dots="' + id + '" ' +
      'title="Actions" aria-label="Actions">' + icon('dots') + '</button>' +
    '<span class="sonde-pop" id="sondepop-' + id + '">' +
      '<a href="#" data-sonde-act="centre" data-serial="' + id + '">' +
        icon('zoom') + 'Centre on map</a>' +
      '<a href="#" data-sonde-act="clear" data-serial="' + id + '">' +
        icon('trash') + 'Clear track</a>' +
    '</span></span>';
}

function setTile(valueId, labelId, value, label, hint) {
  document.getElementById(valueId).textContent = value;
  var el = document.getElementById(labelId);
  el.textContent = label;
  el.title = hint;
}

function renderTiles(d) {
  var all = sondeList();
  var fresh = all.filter(isFresh);

  if (tileMetric.sondes === 'total') {
    setTile('statSondes', 'statSondesLabel', Object.keys(seenSerials).length,
            'Total sondes', 'Every serial seen since this page was opened');
  } else {
    setTile('statSondes', 'statSondesLabel', fresh.length,
            'Active sondes', 'Heard within the last 2 minutes');
  }

  var total = d.counters ? d.counters.valid : (d.logging ? d.logging.frames : 0);

  if (tileMetric.frames === 'today') {
    setTile('statFrames', 'statFramesLabel', framesToday.frames,
            "Today's frames", 'Counted by this browser since 00:00 UTC');
  } else {
    setTile('statFrames', 'statFramesLabel', total,
            'Total frames', 'Decoded since the device booted');
  }

  var scanItem = document.getElementById('scanItem');
  if (scanItem) {
    scanItem.textContent = d.frequency.scan ? 'Stop Scanning' : 'Start Scanning';
  }

  // Top half: where the radio is listening right now. Bottom half: the
  // channels sondes have actually been heard on, which is a different question.
  document.getElementById('statScanFreq').textContent = num(d.frequency.mhz, 3, ' MHz');
  // A channel being held after a decode is counting down to the moment the
  // scan takes it back, and that is worth seeing before it happens.
  var hold = Number.isFinite(d.frequency.hold_s) ? d.frequency.hold_s : 0;

  document.getElementById('statScanLabel').textContent = hold > 0
    ? 'Holding ' + shortAge(hold * 1000)
    : (d.frequency.scan ? 'Scanning' : (d.frequency.preset_mode ? 'Tuned' : 'Detect'));

  var heard = (fresh.length ? fresh : all)
    .map(function (s) { return s.freqMhz; })
    .filter(function (mhz) { return Number.isFinite(mhz); })
    .filter(function (mhz, index, list) { return list.indexOf(mhz) === index; })
    .sort(function (a, b) { return b - a; })
    .slice(0, 4)
    .map(function (mhz) { return mhz.toFixed(3); });

  var rx = document.getElementById('statRxFreqs');
  rx.innerHTML = heard.length
    ? heard.map(function (mhz) { return '<div class="qrg-row">' + mhz + ' MHz</div>'; }).join('')
    : 'none yet';
  rx.className = 'stat-value small-font' + (heard.length ? '' : ' none');
  rx.title = heard.length
    ? 'Where a sonde was heard: ' + (fresh.length ? 'active' : 'recent') + ' sondes'
    : 'No sonde decoded yet in the retention window';

  renderRxDevice(d);
  renderLoad(d);
}

/* ---------- receiver ---------- */

// How long the radio has been on this channel. The device does not report it,
// so the page times it from the moment the frequency changed under it.
var channelMhz = NaN;
var channelSince = 0;

function noteChannel(d) {
  var mhz = d.frequency ? d.frequency.mhz : NaN;
  if (!Number.isFinite(mhz)) { return; }

  if (!Number.isFinite(channelMhz) || Math.abs(mhz - channelMhz) > 0.0005) {
    channelMhz = mhz;
    channelSince = Date.now();
  }
}

function radioName() {
  var parts = String(config.radio || 'SX1262').split('/');
  return parts[parts.length - 1].trim() || 'SX1262';
}

function renderRxDevice(d) {
  var host = document.getElementById('rxDevice');
  if (!host) { return; }

  // Decoding means frames are arriving now, not that one arrived two minutes
  // ago on a channel the scan has long since left.
  var recent = d.sonde.heard && Number.isFinite(d.sonde.last_seen_ms) &&
               d.sonde.last_seen_ms < 30000;

  var state = recent ? 'Decoding' : (d.frequency.scan ? 'Scanning' : 'Listening');
  var cls = recent ? 'decoding' : (d.frequency.scan ? 'scanning' : 'held');

  var sonde = recent && d.sonde.serial
    ? esc(d.sonde.serial) + ' ' + typeBadge(d.sonde.type)
    : '<span class="rx-idle">' + esc(d.frequency.family && d.frequency.family !== 'auto'
        ? d.frequency.family + ' only'
        : (d.frequency.profile || enabledFamilies())) + '</span>';

  var timer = d.frequency.scan || !d.frequency.locked
    ? mmss(Date.now() - channelSince)
    : '&ndash;';

  host.innerHTML =
    '<table class="rx-table"><thead><tr>' +
      '<th>Device</th><th>Frequency</th><th>Sonde</th><th>Status</th><th>Timer</th>' +
    '</tr></thead><tbody><tr>' +
      '<td><span class="rx-dev"><span class="status-indicator ' +
        (recent ? 'status-healthy' : 'status-warning') + '"></span>' +
        esc(radioName().toLowerCase()) + '</span></td>' +
      '<td class="mhz">' + num(d.frequency.mhz, 3) + '</td>' +
      '<td>' + sonde + '</td>' +
      '<td class="rx-state ' + cls + '">' + state + '</td>' +
      '<td>' + timer + '</td>' +
    '</tr></tbody></table>';
}

/* ---------- CPU and memory ---------- */

function recordLoad(d) {
  var load = d.system;
  if (!load || !Number.isFinite(load.cpu)) { return; }

  loadHistory.push({ t: Date.now(), cpu: load.cpu, ram: load.ram });
  if (loadHistory.length > LOAD_HISTORY) { loadHistory.shift(); }
}

function renderLoad(d) {
  var load = d.system || {};
  var graph = tileMetric.load === 'graph';
  var cpu = Number.isFinite(load.cpu) ? load.cpu + ' %' : '--';
  var ram = Number.isFinite(load.ram) ? load.ram + ' %' : '--';

  document.getElementById('statCpu').textContent = cpu;
  document.getElementById('statRam').textContent = ram;
  document.getElementById('legCpu').textContent = cpu;
  document.getElementById('legRam').textContent = ram;

  document.getElementById('statLoad').hidden = graph;
  document.getElementById('loadGraph').hidden = !graph;
  document.getElementById('loadLegend').hidden = !graph;
  document.querySelector('.stats-grid').classList.toggle('graph', graph);

  var label = document.getElementById('statLoadLabel');
  label.textContent = 'CPU / memory';
  label.title = Number.isFinite(load.heap_free)
    ? 'Heap ' + Math.round(load.heap_free / 1024) + ' kB free of ' +
      Math.round(load.heap_size / 1024) + ' kB' +
      (load.psram_size ? ', PSRAM ' + Math.round(load.psram_free / 1024) + ' kB free of ' +
        Math.round(load.psram_size / 1024) + ' kB' : '') +
      '. CPU is the main loop\u2019s duty: the share of time it works rather than waits.'
    : '';

  var span = document.getElementById('legSpan');
  if (loadHistory.length > 1) {
    span.textContent = 'last ' + shortAge(loadHistory[loadHistory.length - 1].t - loadHistory[0].t);
  } else {
    span.textContent = '';
  }

  if (graph) { drawLoad(); }
}

var loadHover = -1;

function loadPlot() {
  var canvas = document.getElementById('loadCanvas');
  if (!canvas || canvas.clientWidth === 0) { return null; }

  return {
    canvas: canvas,
    w: canvas.clientWidth,
    h: canvas.clientHeight,
    padL: 26,
    // Clear of the three-dot button in the tile's top right corner.
    padR: 20,
    padT: 8,
    padB: 16
  };
}

function drawLoad() {
  var p = loadPlot();
  if (!p) { return; }

  var ratio = window.devicePixelRatio || 1;
  p.canvas.width = Math.round(p.w * ratio);
  p.canvas.height = Math.round(p.h * ratio);

  var ctx = p.canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, p.w, p.h);

  var plotW = p.w - p.padL - p.padR;
  var plotH = p.h - p.padT - p.padB;

  // 0-100 fixed: a percentage axis that rescales to the data makes a quiet
  // device look busy.
  function yAt(value) { return p.padT + plotH * (100 - value) / 100; }
  function xAt(i) {
    return loadHistory.length < 2
      ? p.padL + plotW
      : p.padL + plotW * i / (loadHistory.length - 1);
  }

  ctx.font = '10px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';

  [0, 50, 100].forEach(function (v) {
    var y = Math.round(yAt(v)) + 0.5;
    ctx.strokeStyle = 'rgba(0,0,0,.10)';
    ctx.beginPath();
    ctx.moveTo(p.padL, y);
    ctx.lineTo(p.padL + plotW, y);
    ctx.stroke();
    ctx.fillStyle = '#868e96';
    ctx.fillText(String(v), p.padL - 6, y);
  });

  if (loadHistory.length === 0) {
    ctx.textAlign = 'center';
    ctx.fillStyle = '#868e96';
    ctx.fillText('collecting\u2026', p.padL + plotW / 2, p.padT + plotH / 2);
    return;
  }

  // Lines, not areas. Two filled areas on one axis overlap, and where they do
  // the two colours mix into a third that belongs to neither series - the
  // muddy-overlap trap. Two clean strokes on a fixed 0-100 grid read faster
  // and never lie about which series is which.
  [['ram', '#c2660a'], ['cpu', '#3f84dd']].forEach(function (series) {
    var key = series[0];

    ctx.beginPath();
    loadHistory.forEach(function (sample, i) {
      var x = xAt(i);
      var y = yAt(sample[key]);
      if (i === 0) { ctx.moveTo(x, y); } else { ctx.lineTo(x, y); }
    });

    ctx.strokeStyle = series[1];
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
  });

  // Crosshair for the sample under the pointer.
  if (loadHover >= 0 && loadHover < loadHistory.length) {
    var hx = Math.round(xAt(loadHover)) + 0.5;

    ctx.strokeStyle = 'rgba(0,0,0,.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hx, p.padT);
    ctx.lineTo(hx, p.padT + plotH);
    ctx.stroke();

    [['cpu', '#3f84dd'], ['ram', '#c2660a']].forEach(function (series) {
      ctx.beginPath();
      ctx.arc(xAt(loadHover), yAt(loadHistory[loadHover][series[0]]), 3.5, 0, Math.PI * 2);
      ctx.fillStyle = series[1];
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  }
}

function moveLoadHover(event) {
  var p = loadPlot();
  if (!p || loadHistory.length === 0) { return; }

  var box = p.canvas.getBoundingClientRect();
  var plotW = p.w - p.padL - p.padR;
  var ratio = (event.clientX - box.left - p.padL) / plotW;

  var index = Math.round(ratio * (loadHistory.length - 1));
  if (index < 0) { index = 0; }
  if (index > loadHistory.length - 1) { index = loadHistory.length - 1; }

  loadHover = index;
  drawLoad();

  var sample = loadHistory[index];
  var tip = document.getElementById('loadTip');

  tip.innerHTML =
    '<div>' + esc(clock(new Date(sample.t))) + '</div>' +
    '<div><i style="background:#3f84dd"></i>CPU <b>' + sample.cpu + ' %</b></div>' +
    '<div><i style="background:#c2660a"></i>RAM <b>' + sample.ram + ' %</b></div>';

  var x = p.padL + plotW * index / Math.max(loadHistory.length - 1, 1);
  tip.style.left = Math.min(Math.max(x, 46), p.w - 46) + 'px';
  tip.style.top = (p.padT - 2) + 'px';
  tip.hidden = false;
}

function leaveLoadHover() {
  loadHover = -1;
  var tip = document.getElementById('loadTip');
  if (tip) { tip.hidden = true; }
  drawLoad();
}

// "Is it actually sending?" is the question the uplink has to answer, so the
// row says what the client is doing and how much it has published.
function mqttHealth(d, health) {
  var mqtt = d.uplink && d.uplink.mqtt;

  if (!mqtt) { return ''; }
  if (!mqtt.enabled) { return health('server', 'MQTT', 'off', ''); }

  return health('server', 'MQTT',
                mqtt.connected ? mqtt.published + ' sent' : (mqtt.state || 'not connected'),
                mqtt.connected ? 'status-healthy' : 'status-error');
}

// The MySondy BLE service, which the phone apps connect to. Only worth a row
// when config.yaml has it on: a receiver without it is not broken.
function bluetoothHealth(d, health) {
  var ble = d.bluetooth;

  if (!ble || !ble.enabled) { return ''; }

  return health('rss', 'Bluetooth',
                ble.connected ? 'app connected' : (ble.state || 'advertising'),
                ble.active ? 'status-healthy' : 'status-warning');
}

// SondeHub: uploading, or writing the same payloads to the card. Off is not
// worth a row - most receivers never turn it on.
function sondeHubHealth(d, health) {
  var sh = d.uplink && d.uplink.sondehub;

  if (!sh || !sh.active) { return ''; }

  return health('server', sh.json_only ? 'SondeHub (SD)' : 'SondeHub',
                sh.sent > 0 ? sh.sent + (sh.json_only ? ' logged' : ' sent') : (sh.state || 'waiting'),
                sh.sent > 0 ? 'status-healthy' : 'status-warning');
}

function renderSidebar(d) {
  // Station first, then firmware, the way OpenWXTTGO labels its header. The
  // address is one hover away rather than taking a third of the bar.
  const nav = document.getElementById('navVersion');
  nav.textContent = config.station + ' \u2013 ' + (d.version || '');
  nav.title = d.network.ip ? 'http://' + d.network.ip + '/' : '';

  renderTiles(d);

  var all = sondeList();
  var fresh = all.filter(isFresh);
  var older = all.filter(function (s) { return !isFresh(s); });

  document.getElementById('sondeList').innerHTML = fresh.length === 0
    ? '<div class="no-sondes">Waiting for a radiosonde&hellip;</div>'
    : fresh.map(function (s) { return sondeCard(s, true); }).join('');

  document.getElementById('storedList').innerHTML = older.length === 0
    ? ''
    : '<div class="hist-hdr">' + icon('history') + 'Recently received</div>' +
      older.map(function (s) { return sondeCard(s, false); }).join('');

  function health(name, label, value, state) {
    return '<div class="health-item"><span class="health-label">' +
           '<span class="status-indicator ' + state + '"></span>' + icon(name) + esc(label) +
           '</span><span class="health-value">' + esc(value) + '</span></div>';
  }

  var points = 0;
  all.forEach(function (s) { points += s.points.length; });

  document.getElementById('healthList').innerHTML =
    health('rss', 'Radio',
           d.frequency.locked ? 'locked' : (d.frequency.scan ? 'scanning' : 'searching'),
           d.frequency.locked ? 'status-healthy' : 'status-warning') +
    health('sat', 'Local GPS', d.local.fix ? d.local.sats + ' sats' : 'no fix',
           d.local.fix ? 'status-healthy' : 'status-error') +
    health('server', 'Storage',
           d.logging.enabled ? 'logging' : (d.logging.available ? 'ready' : 'no card'),
           d.logging.enabled ? 'status-healthy' : (d.logging.available ? 'status-warning' : 'status-error')) +
    health('rss', 'Wi-Fi', d.network.status,
           d.network.connected ? 'status-healthy' : 'status-warning') +
    health('speed', 'Battery', d.battery.percent + ' %',
           d.battery.percent > 30 ? 'status-healthy' : 'status-warning') +
    health('pin', 'Track points', String(points), 'status-healthy') +
    mqttHealth(d, health) +
    sondeHubHealth(d, health) +
    bluetoothHealth(d, health);
}

/* ---------- polling ---------- */

function refresh() {
  // One request at a time is all the device can serve. While a track is being
  // read off the card the poll would be competing with it for the one
  // connection the server has, and losing that race is a slice this browser
  // never gets - so the poll stands aside until the file is in.
  if (logReading) { return; }

  fetch('/api/status', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      lastData = d;
      setBadge(d.sonde.heard ? 'Decoding' : 'Connected', d.sonde.heard ? 'ok' : 'warn');
      updateFramesToday(d.counters ? d.counters.valid : NaN);
      recordLoad(d);
      noteChannel(d);
      rememberSonde(d);
      dropExpired();
      renderSidebar(d);
      updateMap(d);
      saveTracks();
    })
    .catch(function () { setBadge('No link to device', ''); });
}

/* ---------- controls ---------- */

function closeTilePops() {
  Array.prototype.forEach.call(document.querySelectorAll('.tile-pop'), function (p) {
    p.classList.remove('open');
  });
}

function paintTilePops() {
  Array.prototype.forEach.call(document.querySelectorAll('.tile-pop a'), function (a) {
    a.classList.toggle('sel', tileMetric[a.dataset.tile] === a.dataset.metric);
  });
}

function closeSondePops() {
  Array.prototype.forEach.call(document.querySelectorAll('.sonde-pop'), function (p) {
    p.classList.remove('open');
  });
}

function closeDropdowns() {
  Array.prototype.forEach.call(document.querySelectorAll('.owx-dd'), function (d) {
    d.classList.remove('open');
  });
}

function setFollow(on) {
  follow = on;
  opts.follow = on;
  saveOpts();

  var box = document.getElementById('optFollow');
  if (box) { box.checked = on; }
}

function centreOn(serial, zoomIn) {
  var entry = sondes[serial];
  if (!mapReady || !entry || !Number.isFinite(entry.lat)) { return; }

  setFollow(false);
  map.setView([entry.lat, entry.lon], zoomIn ? Math.max(map.getZoom(), 13) : map.getZoom());
  if (entry.marker) { entry.marker.openPopup(); }
}

// Drops the drawn path but keeps the sonde: the card, the end marker and the
// registry entry all survive, and the track starts again from the next frame.
function clearTrack(serial) {
  var entry = sondes[serial];
  if (!entry) { return; }

  entry.points = [];
  entry.pointsChanged = false;

  if (mapReady) {
    ['line', 'startMarker'].forEach(function (key) {
      if (!entry[key]) { return; }
      try { map.removeLayer(entry[key]); } catch (e) { }
      entry[key] = null;
    });
  }

  toast('Track cleared for ' + serial);
}

function clearAllTracks() {
  Object.keys(sondes).forEach(function (serial) { clearTrack(serial); });
  if (sightLine) { sightLine.setLatLngs([]); }
  toast('All tracks cleared');
}

var toastTimer = null;

function toast(text, bad) {
  var el = document.getElementById('toast');
  if (!el) { return; }

  el.textContent = text;
  el.className = 'owx-toast' + (bad ? ' bad' : '');
  el.hidden = false;

  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(function () { el.hidden = true; }, 3200);
}

// One setting, one POST: that is the shape of the device's API, where each
// request rewrites exactly one line of config.yaml.
function saveSetting(key, value) {
  return fetch('/api/config?key=' + encodeURIComponent(key) +
               '&value=' + encodeURIComponent(value),
               { method: 'POST', cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .catch(function () { return { ok: false, error: 'no link to the device' }; });
}

// Every control command goes through here so a device that has gone away says
// so once, in one place.
function control(params) {
  return fetch('/api/control?' + params, { method: 'POST', cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d.ok) { toast(d.error || 'The device refused that', true); }
      return d;
    })
    .catch(function () { toast('No link to the device', true); return { ok: false }; });
}

document.addEventListener('click', function (e) {
  var target = e.target;
  if (!target || !target.closest) { return; }

  // --- navbar dropdowns ---
  var toggle = target.closest('#navMenu, #navSystem');
  if (toggle) {
    e.preventDefault();
    var dd = toggle.parentElement;
    var wasOpen = dd.classList.contains('open');
    closeDropdowns();
    if (!wasOpen) { dd.classList.add('open'); }
    return;
  }

  var item = target.closest('.owx-dd-menu a[data-act]');
  if (item) {
    e.preventDefault();
    closeDropdowns();
    runAction(item.dataset.act);
    return;
  }

  if (target.closest('#navAbout')) {
    e.preventDefault();
    closeDropdowns();
    runAction('about');
    return;
  }

  // --- three-dot pickers on the statistics tiles ---
  var choice = target.closest('.tile-pop a');
  if (choice) {
    e.preventDefault();
    tileMetric[choice.dataset.tile] = choice.dataset.metric;
    saveTileMetric();
    closeTilePops();
    if (lastData) { renderTiles(lastData); }
    return;
  }

  var dots = target.closest('.tile-dots');
  if (dots) {
    e.preventDefault();
    var pop = document.getElementById('tilepop-' + dots.dataset.tile);
    var openAlready = pop.classList.contains('open');
    closeTilePops();
    if (!openAlready) { paintTilePops(); pop.classList.add('open'); }
    return;
  }

  // --- three-dot menu on a sonde tile ---
  var sondeAct = target.closest('.sonde-pop a[data-sonde-act]');
  if (sondeAct) {
    e.preventDefault();
    closeSondePops();

    if (sondeAct.dataset.sondeAct === 'centre') { centreOn(sondeAct.dataset.serial, true); }
    else { clearTrack(sondeAct.dataset.serial); }
    return;
  }

  var sondeDots = target.closest('.sonde-dots');
  if (sondeDots) {
    e.preventDefault();
    e.stopPropagation();
    var sondePop = document.getElementById('sondepop-' + sondeDots.dataset.sondeDots);
    var sondeOpen = sondePop && sondePop.classList.contains('open');
    closeSondePops();
    if (sondePop && !sondeOpen) { sondePop.classList.add('open'); }
    return;
  }

  closeTilePops();
  closeSondePops();
  if (!target.closest('.owx-dd')) { closeDropdowns(); }

  // --- a card centres the map, without zooming ---
  if (target.closest('.owx-modal')) { return; }

  var card = target.closest('.sonde-card');
  if (card) { centreOn(card.dataset.serial, false); }
});

document.addEventListener('input', function (e) {
  if (e.target && e.target.id === cfgId('openwx.mqtt.topic_prefix')) { cfgTopicPreview(); }
});

document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') { return; }
  closeDropdowns();
  closeTilePops();
  closeSondePops();
  closeModal();
});

/* ---------- modals ---------- */

// One shell, filled in per dialogue. Six small modals sharing a frame beats
// six copies of the frame, and Escape and the backdrop close all of them.
var modalKind = '';
var modalTimer = null;

function closeModal() {
  var box = document.getElementById('modal');
  if (!box || box.hidden) { return; }

  if (modalTimer) { window.clearInterval(modalTimer); modalTimer = null; }

  // The band scan holds the radio away from decoding, so it is released the
  // moment nobody is looking at it.
  if (modalKind === 'spectrum') { control('cmd=spectrum&on=0'); }

  modalKind = '';
  box.hidden = true;
}

function openModal(kind, title, bodyHtml, footHtml, wide) {
  closeModal();

  modalKind = kind;
  document.getElementById('modalTitle').innerHTML = title;
  document.getElementById('modalBody').innerHTML = bodyHtml;
  document.getElementById('modalFoot').innerHTML = footHtml || '';
  document.querySelector('.owx-modal-box').className = 'owx-modal-box' + (wide ? ' wide' : '');
  document.getElementById('modal').hidden = false;
}

document.addEventListener('click', function (e) {
  if (e.target && e.target.closest && e.target.closest('[data-close]')) {
    e.preventDefault();
    closeModal();
  }
});

function runAction(act) {
  if (act === 'freq') { openFrequency(); }
  else if (act === 'channels') { openChannels(); }
  else if (act === 'scan') { toggleScan(); }
  else if (act === 'spectrum') { openSpectrum(); }
  else if (act === 'logfile') { openLogfile(); }
  else if (act === 'downloadfs') { openFilesystem(); }
  else if (act === 'about') { openAbout(); }
  else if (act === 'reset') { resetCounters(); }
  else if (act.indexOf('config:') === 0) { openConfig(act.slice(7)); }
}

function toggleScan() {
  const wasScanning = !!(lastData && lastData.frequency && lastData.frequency.scan);

  control('cmd=toggle_scan').then(function (d) {
    if (d.ok) { toast(wasScanning ? 'Scanning stopped' : 'Scanning started'); }
  });
}

function resetCounters() {
  control('cmd=reset_counters').then(function (d) {
    if (d.ok) { toast('Frame counters reset'); }
  });
}

/* ---------- configuration ---------- */

function field(id, label, value, hint, type) {
  return '<div class="field"><label for="' + id + '">' + esc(label) + '</label>' +
    '<input type="' + (type || 'text') + '" id="' + id + '" value="' + esc(value) + '"' +
    (type === 'number' ? ' step="any"' : '') + '>' +
    (hint ? '<div class="hint">' + hint + '</div>' : '') + '</div>';
}

function check(id, label, checked) {
  return '<label class="check"><input type="checkbox" id="' + id + '"' +
    (checked ? ' checked' : '') + '> ' + esc(label) + '</label>';
}

/*
 * The Configuration dialogue, laid out as OpenWXTTGO's: one tab per area, a
 * grid of fields, switches for on/off, sub-headings, info and warning boxes.
 *
 * Section: [ id, title, icon, [ field, ... ] ]
 * Field:   [ key, label, type, extra, help, columns, flags ]
 *   type  "num" extra = [min, max]   "sel" extra = [[value, text], ...]
 *         "sw" switch   "pw" write-only secret   "txt" text   "ro" read-only
 *   key   ""  sub-heading (label is the caption)
 *         "!" info box, "!!" warning box (label is the text)
 *   flags "R" needs a restart to take effect
 * Keys are the dotted paths of config.yaml; /api/settings gives the values
 * and a batch POST to /api/config writes the changed ones in one go. Two keys
 * are not in config.yaml: wifi.ssid and wifi.pass go to the Wi-Fi store.
 */
var LATER = 'Stored in config.yaml for a later release: this firmware does not act on it yet.';

var CFG = [

['general', 'General', 'sliders', [
  ['', 'Wi-Fi', 0, 0, 0, 12],
  ['wifi.ssid', 'Network (SSID)', 'txt', 0, 'The access point the deck joins. Kept in the device\'s own store, not in config.yaml.', 6],
  ['wifi.pass', 'Wi-Fi password', 'pw', 0, 'Leave empty to keep the stored one.', 6],
  ['', 'Web panel', 0, 0, 0, 12],
  ['webui.background', 'Web server alongside the screens', 'sw', 0, 'Off: the WEB button starts it. Hold WEB for Remote only.', 6],
  ['webui.port', 'Port', 'num', [1, 65535], 'Needs a restart.', 6, 'R'],
  ['webui.user', 'User', 'txt', 0, 'Basic Auth for settings, control and uploads', 6],
  ['webui.password', 'Password', 'pw', 0, 'Empty keeps the current one. Without a stored password, no login is asked.', 6],
  ['', 'Logging', 0, 0, 0, 12],
  ['logging.sd_enabled', 'Write decoded frames to the SD card', 'sw', 0, 0, 6],
  ['logging.level', 'Log level', 'sel', [['DEBUG', 'Debug'], ['INFO', 'Info'], ['WARNING', 'Warning'], ['ERROR', 'Error']], LATER, 6],
  ['logging.raw_frames', 'Raw frames', 'sw', 0, LATER, 6],
  ['logging.debug_radio', 'Radio tracing', 'sw', 0, LATER, 6],
  ['', 'Anonymous installation counter', 0, 0, 0, 12],
  ['telemetry.enabled', 'Count this installation', 'sw', 0, 'Only a random id, the version and the radio type - never the callsign, the position or a credential. ' + LATER, 6],
  ['telemetry.interval_hours', 'Interval (hours)', 'num', [1, 168], 0, 6]
]],

['station', 'Station', 'rss', [
  ['station.callsign', 'Gateway callsign', 'txt', 0, 'How this station names itself: the map, the MQTT topic and the uploads.', 6],
  ['station.upload_position', 'Publish the listener position', 'sw', 0, LATER, 6],
  ['', 'Home position', 0, 0, 0, 12],
  ['station.lat', 'Latitude', 'txt', 0, 0, 4],
  ['station.lon', 'Longitude', 'txt', 0, 0, 4],
  ['station.alt', 'Altitude (m)', 'txt', 0, 0, 4],
  ['!', 'The LiveMap home button centres here, and it stands in for the receiver position for distances, bearings and uploads whenever the deck\'s own GPS has no fix. With a fix, the GPS position is used.', 0, 0, 0, 12],
  ['station.receiver', 'Receiver', 'txt', 0, 'Shown with the station on the map and in uploads', 6],
  ['station.antenna', 'Antenna', 'txt', 0, 'Free text, shown next to the receiver on the map', 6],
  ['station.upload_interval', 'Gateway status interval (min)', 'num', [1, 1440], LATER, 6],
  ['', 'OpenWX HTTP gateway', 0, 0, 0, 12],
  ['!!', 'The HTTP gateway upload is not built into this firmware yet; OpenWX is reached over MQTT. ' + LATER, 0, 0, 0, 12],
  ['openwx.http.enabled', 'Enable HTTP upload', 'sw', 0, 0, 4],
  ['openwx.http.url', 'Gateway URL', 'txt', 0, 0, 8],
  ['openwx.http.api_key', 'API key', 'pw', 0, 'Empty keeps the current one.', 6]
]],

['import', 'Import API', 'down', [
  ['!!', 'The Import API is not built into this firmware yet. ' + LATER, 0, 0, 0, 12],
  ['import_api.enabled', 'Enable Import API', 'sw', 0, 'Detect nearby sondes from an external API and check their channels first.', 12],
  ['import_api.url', 'API base URL', 'sel', [['api.opnwx.de', 'api.opnwx.de'], ['api.v2.sondehub.org', 'api.v2.sondehub.org'], ['api.wettersonde.net', 'api.wettersonde.net']], 'Without https://', 8],
  ['import_api.check_interval_s', 'Check interval (s)', 'num', [60, 86400], 'How often to poll the API', 4],
  ['import_api.distance_km', 'Max. distance (km)', 'num', [1, 999], 0, 4],
  ['import_api.time_range_minutes', 'Time range (min)', 'num', [1, 1440], 'Sondes active within this window', 4],
  ['import_api.max_sondes', 'Max. sondes', 'num', [1, 20], 0, 4],
  ['import_api.sonde_type', 'Sonde type', 'sel', [['all', 'All'], ['RS41', 'RS41'], ['DFM', 'DFM'], ['M10', 'M10'], ['M20', 'M20']], 0, 4],
  ['import_api.lat', 'Search latitude', 'txt', 0, 'Empty: the station position', 4],
  ['import_api.lon', 'Search longitude', 'txt', 0, 0, 4]
]],

['receiver', 'SX1262', 'server', [
  ['', 'Sonde families', 0, 0, 0, 12],
  ['decoders.rs41', 'RS41 / RS41-SGP', 'sw', 0, 'OpenWXTTGO decoder', 4],
  ['decoders.dfm', 'DFM-06 / 09 / 17', 'sw', 0, 0, 4],
  ['decoders.m10', 'M10', 'sw', 0, 'One profile hears M10 and M20', 4],
  ['decoders.m20', 'M20', 'sw', 0, 0, 4],
  ['decoders.rs92', 'RS92', 'sw', 0, 'Needs broadcast ephemeris', 4],
  ['!', 'The SX1262 holds one modulation and one sync word at a time, so every family you add costs another dwell on every channel. DFM counts twice: its two frame polarities need a sync word each.', 0, 0, 0, 12],
  ['', 'Scan and lock', 0, 0, 0, 12],
  ['decoders.dwell_ms', 'Dwell per family (ms)', 'num', [200, 10000], 'Listening time per family per channel', 4],
  ['decoders.scan_squelch_db', 'Scan squelch (dB)', 'num', [0, 40], 'Skip a channel this close to the noise floor. 0 is off.', 4],
  ['decoders.rx_boost', 'Boosted RX gain', 'sw', 0, 'Off: the SX1262\'s power-saving gain', 4],
  ['decoders.signal_lost_ms', 'Signal lost after (ms)', 'num', [1000, 120000], 'Silence after which a locked sonde is lost', 4],
  ['decoders.resume_scan', 'Resume scan', 'sw', 0, 'Hand the channel back to the scan once the sonde goes quiet', 4],
  ['decoders.max_idle_time', 'Auto decoder idle (s)', 'num', [10, 86400], 'Without frames before an auto-detected sonde is given up', 4],
  ['decoders.manual_idle_time', 'Manual decoder idle (s)', 'num', [10, 86400], 'Without frames before a manually tuned one is given up', 4],
  ['', 'RS92 and ephemeris', 0, 0, 0, 12],
  ['!', 'An RS92 sends the GPS pseudoranges it measures instead of a position, so the receiver solves them against the daily broadcast ephemeris. Without that file an RS92 gives its serial and time but no position.', 0, 0, 0, 12],
  ['ephemeris.enabled', 'Fetch ephemeris', 'sw', 0, 'Downloads the RINEX file once Wi-Fi is up', 4],
  ['ephemeris.max_age_hours', 'Fetch again after (h)', 'num', [1, 168], 0, 4],
  ['decoders.rs92_alt2d', 'RS92 2D altitude (m)', 'num', [0, 40000], 'Assumed height when only three satellites are heard', 4],
  ['ephemeris.url', 'Ephemeris URL', 'txt', 0, 'printf template: year, day of year, two-digit year', 8],
  ['decoders.rs92_rx_bandwidth', 'RS92 bandwidth (Hz)', 'num', [3000, 50000], 0, 4],
  ['', 'Speaker', 0, 0, 0, 12],
  ['audio.output', 'Speaker on at boot', 'sw', 0, 'Frames play as the receiver hears them', 4],
  ['audio.signal_tone', 'Signal strength beep', 'sw', 0, 'The two-tone indicator between frames', 4],
  ['audio.volume', 'Volume', 'num', [0, 10], '0 to 10', 4]
]],

['bluetooth', 'Bluetooth', 'bt', [
  ['bluetooth.enabled', 'MySondy Go over BLE', 'sw', 0, 'Serves the MySondy Go v4.1 protocol over Bluetooth Low Energy, for the MySondy and Trova la Sonda apps. <b>Needs a restart</b>: the Bluetooth controller\'s memory is claimed at boot.', 12, 'R'],
  ['bluetooth.call', 'MYCALL', 'txt', 0, 'Shown by the app, max 8 characters. Empty: the station callsign.', 6, 'R'],
  ['bluetooth.name', 'BLE device name', 'txt', 0, 'Empty: MySondyGO-&lt;chip id&gt;', 6, 'R'],
  ['!', 'Wi-Fi and Bluetooth share one radio. With BLE on, Wi-Fi has to run in power-save mode, which makes the web panel and MQTT slower to answer. With BLE off, Wi-Fi stays fully awake.', 0, 0, 0, 12]
]],

['mqtt', 'MQTT', 'up', [
  ['openwx.mqtt.enabled', 'Enable MQTT', 'sw', 0, 'Publish decoded frames and receiver status. Needs a restart.', 12, 'R'],
  ['openwx.mqtt.server', 'Broker host', 'txt', 0, 0, 8],
  ['openwx.mqtt.port', 'Port', 'num', [1, 65535], 0, 4],
  ['openwx.mqtt.topic_prefix', 'Topic prefix', 'txt', 0, 0, 6],
  ['station.callsign', 'Gateway callsign', 'ro', 0, 'Set on the Station tab', 6],
  ['openwx.mqtt.client_id', 'Client ID', 'txt', 0, 'Identifies the connection to the broker, not the topic', 4],
  ['openwx.mqtt.username', 'Username', 'txt', 0, 0, 4],
  ['openwx.mqtt.password', 'Password', 'pw', 0, 'Empty keeps the current one.', 4],
  ['openwx.mqtt.keepalive', 'Keepalive (s)', 'num', [5, 3600], 0, 6],
  ['openwx.mqtt.tls_enabled', 'TLS', 'sw', 0, 'Whether the broker wants TLS depends on the broker, not on the port.', 6]
]],

['display', 'Display', 'display', [
  ['', 'Screen and keyboard', 0, 0, 0, 12],
  ['display.brightness', 'Screen brightness (%)', 'num', [5, 100], 'The screen key still steps through 25 / 50 / 75 / 100', 6],
  ['display.keyboard', 'Keyboard light (%)', 'num', [0, 100], '0 is off', 6],
  ['', 'Dimming', 0, 0, 0, 12],
  ['display.dim_enabled', 'Dim when idle', 'sw', 0, 'After no key or touch for the time set here', 4],
  ['display.dim_after_s', 'Dim after (s)', 'num', [5, 3600], 0, 4],
  ['display.dim_level', 'Dimmed brightness (%)', 'num', [0, 100], 'The keyboard light goes off while dimmed', 4],
  ['!', 'Brightness, keyboard light and dimming take effect as soon as they are saved.', 0, 0, 0, 12],
  ['', 'Home menu', 0, 0, 0, 12],
  ['display.homepage_style', 'Home menu style', 'sel', [['standard', 'Standard'], ['icom', 'ICOM (MENU / FUNCTION keys)'], ['d75', 'Kenwood TH-D75']], 'Both menu pages; changes at once', 6],
  ['', 'Receiver view', 0, 0, 0, 12],
  ['webui.receiver_color', 'Receiver skin', 'sel', [['blue', 'Blue'], ['yellow', 'Yellow'], ['tactical', 'Tactical'], ['icom', 'ICOM'], ['r9500', 'IC-R9500'], ['ts890', 'TS-890'], ['rs', 'R&S'], ['atak', 'ATAK'], ['d75', 'TH-D75']], 0, 6],
  ['webui.boot_receiver', 'Start in the receiver view', 'sel', [['off', 'Off - start on the home screen'], ['blue', 'Blue'], ['yellow', 'Yellow'], ['tactical', 'Tactical'], ['icom', 'ICOM'], ['r9500', 'IC-R9500'], ['ts890', 'TS-890'], ['rs', 'R&S'], ['atak', 'ATAK'], ['d75', 'TH-D75']], 'Takes effect at the next start', 6, 'R'],
  ['', 'Device map', 0, 0, 0, 12],
  ['webui.map.default_zoom', 'Default zoom', 'num', [2, 18], 0, 4],
  ['webui.map.sd_root', 'Tile folder on the SD card', 'txt', 0, '&lt;folder&gt;/&lt;zoom&gt;/&lt;x&gt;/&lt;y&gt;.png, 256 or 512 px', 8],
  ['', 'LiveMap', 0, 0, 0, 12],
  ['webui.map.tile_server', 'Tile server', 'txt', 0, 0, 12],
  ['webui.sonde_retention_time', 'Sonde retention (s)', 'num', [60, 604800], 'How long a sonde stays on the LiveMap', 4],
  ['webui.sonde_stale_time', 'Stale after (s)', 'num', [30, 86400], 'Marker and label change after this', 4],
  ['webui.permanent_labels', 'Permanent labels', 'sw', 0, 'Off: on hover', 4]
]],

['sondehub', 'SondeHub', 'globe', [
  ['sondehub.enabled', 'SondeHub upload', 'sel', [['false', 'Off'], ['true', 'Upload to SondeHub'], ['json', 'Write the payloads to the SD card']], 'The JSON mode builds the same payloads and appends them to /sondehub/&lt;serial&gt;.json', 6],
  ['sondehub.queue_mode', 'Batch uploads', 'sw', 0, 'Off: every frame is sent on its own', 6],
  ['sondehub.uploader_callsign', 'Uploader callsign', 'txt', 0, 0, 6],
  ['sondehub.station_id', 'Station ID', 'txt', 0, 0, 6],
  ['sondehub.contact_email', 'E-mail', 'txt', 0, 'Used only to contact you about upload errors', 6],
  ['sondehub.uploader_antenna', 'Antenna', 'txt', 0, 'Shown on the SondeHub tracker', 6],
  ['sondehub.uploader_radio', 'Radio', 'txt', 0, 0, 6],
  ['', 'Listener position', 0, 0, 0, 12],
  ['sondehub.uploader_lat', 'Latitude', 'txt', 0, 'Empty: the station position', 4],
  ['sondehub.uploader_lon', 'Longitude', 'txt', 0, 0, 4],
  ['sondehub.uploader_alt', 'Altitude (m)', 'txt', 0, 0, 4],
  ['', 'Timing', 0, 0, 0, 12],
  ['sondehub.upload_rate_s', 'Upload every (s)', 'num', [5, 600], 0, 3],
  ['sondehub.listener_upload_interval_s', 'Listener every (s)', 'num', [60, 86400], 0, 3],
  ['sondehub.queue_batch_max', 'Batch size', 'num', [1, 200], 0, 3],
  ['sondehub.queue_max_size', 'Queue size', 'num', [1, 1000], 0, 3],
  ['', 'Endpoints', 0, 0, 0, 12],
  ['sondehub.upload_url', 'Telemetry URL', 'txt', 0, 'Do not change unless you know why', 12],
  ['sondehub.listeners_url', 'Listeners URL', 'txt', 0, 0, 12]
]],

['hardware', 'Hardware', 'cpu', []]

];

var cfgState = { values: {}, secrets: {}, tab: 'general' };

function cfgId(key) { return 'cf_' + key.replace(/[^a-z0-9]/gi, '_'); }

function cfgHelp(text) { return text ? '<div class="hint">' + text + '</div>' : ''; }

function cfgIcon(name) { return '<svg class="i"><use href="#ic-' + name + '"></use></svg>'; }

function cfgValue(key) {
  if (key === 'wifi.ssid') { return (lastData && lastData.network && lastData.network.ssid) || ''; }
  var v = cfgState.values[key];
  return v == null ? '' : String(v);
}

function cfgOn(v) { return v === 'true' || v === '1' || v === 'on'; }

function cfgField(f) {
  var key = f[0], label = f[1], type = f[2], extra = f[3], help = f[4];
  var cls = 'cf-col cf-' + (f[5] || 6);
  var restart = f[6] === 'R' ? ' <span class="cf-restart" title="Takes effect after a restart">restart</span>' : '';

  if (key === '') { return '<div class="cf-col cf-12 cf-sub">' + esc(label) + '</div>'; }
  if (key === '!' || key === '!!') {
    return '<div class="cf-col cf-12"><div class="cf-box ' + (key === '!' ? 'info' : 'warn') + '">' +
      cfgIcon('info') + '<span>' + label + '</span></div></div>';
  }

  var id = cfgId(key) + (type === 'ro' ? '_ro' : '');
  var v = cfgValue(key);

  if (type === 'sw') {
    return '<div class="' + cls + '"><label class="cf-switch"><input type="checkbox" id="' + id +
      '" data-key="' + esc(key) + '"' + (cfgOn(v) ? ' checked' : '') + '><span class="cf-track"></span>' +
      '<b>' + esc(label) + '</b>' + restart + '</label>' + cfgHelp(help) + '</div>';
  }

  var head = '<label for="' + id + '">' + esc(label) + restart + '</label>';

  if (type === 'ro') {
    return '<div class="' + cls + ' field">' + head +
      '<input type="text" id="' + id + '" value="' + esc(v) + '" disabled>' + cfgHelp(help) + '</div>';
  }

  if (type === 'sel') {
    var lower = v.toLowerCase();
    var known = extra.some(function (o) { return String(o[0]).toLowerCase() === lower; });
    var options = extra.map(function (o) {
      return '<option value="' + esc(o[0]) + '"' + (String(o[0]).toLowerCase() === lower ? ' selected' : '') +
        '>' + esc(o[1]) + '</option>';
    }).join('');

    // A value the list does not know is kept as it is rather than replaced.
    if (v && !known) {
      options = '<option value="' + esc(v) + '" selected>' + esc(v) + '</option>' + options;
    }

    return '<div class="' + cls + ' field">' + head + '<select id="' + id + '" data-key="' + esc(key) + '">' +
      options + '</select>' + cfgHelp(help) + '</div>';
  }

  if (type === 'pw') {
    var isSet = key === 'wifi.pass' || !!cfgState.secrets[key];
    return '<div class="' + cls + ' field">' + head +
      '<input type="password" id="' + id + '" data-key="' + esc(key) + '" value="" autocomplete="new-password"' +
      ' placeholder="' + (isSet ? '•••••• (stored)' : 'not set') + '">' + cfgHelp(help) + '</div>';
  }

  var attrs = type === 'num'
    ? ' type="number" step="any"' + (extra ? ' min="' + extra[0] + '" max="' + extra[1] + '"' : '')
    : ' type="text"';

  var after = key === 'openwx.mqtt.topic_prefix' ? '<div class="hint" id="cfTopic"></div>' : '';

  return '<div class="' + cls + ' field">' + head + '<input' + attrs + ' id="' + id + '" data-key="' + esc(key) +
    '" value="' + esc(v) + '">' + cfgHelp(help) + after + '</div>';
}

function cfgTopicPreview() {
  var box = document.getElementById('cfTopic');
  if (!box) { return; }

  var input = document.getElementById(cfgId('openwx.mqtt.topic_prefix'));
  var prefix = input ? input.value : cfgValue('openwx.mqtt.topic_prefix');
  box.innerHTML = prefix ? 'Publishes under <code>' + esc(prefix) + '</code>' : 'No prefix set.';
}

/* The Hardware tab: what the board is and how it is doing, from
   /api/hardware, with GPS and battery from the status the page already
   polls. Read-only, plus the one thing worth a button: a restart. */
function cfgKv(rows) {
  return '<dl class="kv cf-kv">' + rows.map(function (r) {
    return '<dt>' + esc(r[0]) + '</dt><dd>' + r[1] + '</dd>';
  }).join('') + '</dl>';
}

function cfgBytes(n) {
  if (!Number.isFinite(n)) { return '--'; }
  if (n >= 1073741824) { return (n / 1073741824).toFixed(1) + ' GB'; }
  if (n >= 1048576) { return (n / 1048576).toFixed(1) + ' MB'; }
  if (n >= 1024) { return (n / 1024).toFixed(0) + ' kB'; }
  return n + ' B';
}

function cfgUptime(s) {
  if (!Number.isFinite(s)) { return '--'; }
  var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return (d ? d + ' d ' : '') + h + ' h ' + m + ' min';
}

function renderHardware(hw) {
  var box = document.getElementById('cfHardware');
  if (!box) { return; }

  if (!hw) {
    box.innerHTML = '<div class="cf-box warn">' + cfgIcon('info') +
      '<span>The device did not answer. Firmware older than this page has no /api/hardware.</span></div>';
    return;
  }

  var d = lastData || {};
  var gps = d.local || {};
  var bat = d.battery || {};
  var log = d.logging || {};
  var c = hw.chip || {}, w = hw.wifi || {}, sd = hw.sd || {}, fs = hw.littlefs || {};
  var yes = function (b) { return b ? '<span class="cf-ok">yes</span>' : '<span class="cf-no">no</span>'; };

  box.innerHTML =
    '<div class="cf-card"><h4>' + cfgIcon('cpu') + ' Board</h4>' + cfgKv([
      ['Board', esc(hw.board || '--')],
      ['Radio', esc(hw.radio || '--')],
      ['Display', esc(hw.display || '--')],
      ['Firmware', esc(hw.firmware || '--')],
      ['Chip', esc((c.model || '--') + ' rev ' + (c.revision != null ? c.revision : '-') + ', ' +
                   (c.cores || '-') + ' cores, ' + (c.cpu_mhz || '-') + ' MHz')],
      ['Flash', cfgBytes(c.flash) + ' (firmware ' + cfgBytes(c.sketch) + ')'],
      ['Heap', cfgBytes(c.heap_free) + ' free, block ' + cfgBytes(c.heap_block) + ', lowest ' + cfgBytes(c.heap_min)],
      ['PSRAM', cfgBytes(c.psram_free) + ' free of ' + cfgBytes(c.psram)],
      ['SDK', esc(c.sdk || '--')],
      ['Uptime', cfgUptime(c.uptime_s)]
    ]) + '</div>' +
    '<div class="cf-card"><h4>' + cfgIcon('rss') + ' Wi-Fi</h4>' + cfgKv([
      ['Connected', yes(w.connected)],
      ['SSID', esc(w.ssid || '--')],
      ['Signal', w.rssi != null ? w.rssi + ' dBm' : '--'],
      ['Channel', w.channel != null ? String(w.channel) : '--'],
      ['Access point', esc(w.bssid || '--')],
      ['IP address', esc(w.ip || '--')],
      ['Gateway / DNS', esc((w.gateway || '--') + ' / ' + (w.dns || '--'))],
      ['MAC', esc(w.mac || '--')],
      ['Power save', w.power_save ? 'on (Bluetooth shares the radio)' : 'off']
    ]) + '</div>' +
    '<div class="cf-card"><h4>' + cfgIcon('file') + ' SD card</h4>' + cfgKv([
      ['Card', sd.present ? esc(sd.type) : '<span class="cf-no">none</span>'],
      ['Size', sd.present ? cfgBytes(sd.size_mb * 1048576) : '--'],
      ['File system', sd.present ? cfgBytes(sd.fs_mb * 1048576) : '--'],
      ['Logging', log.available ? (log.enabled ? 'on, ' + (log.frames || 0) + ' frames' : 'ready, off') : 'unavailable'],
      ['Map tiles', sd.present
        ? esc(sd.map_root || '/map') + (sd.map_tiles ? ' found' : ' <span class="cf-no">missing</span>')
        : '--']
    ]) + '</div>' +
    '<div class="cf-card"><h4>' + cfgIcon('sat') + ' GPS</h4>' + cfgKv([
      ['Fix', yes(gps.fix)],
      ['Satellites', gps.sats != null ? String(gps.sats) : '--'],
      ['HDOP', num(gps.hdop, 1)],
      ['Position', gps.fix ? num(gps.lat, 5) + ', ' + num(gps.lon, 5) : '--'],
      ['Altitude', gps.fix ? num(gps.alt_m, 0, ' m') : '--'],
      ['Characters read', gps.chars != null ? String(gps.chars) : '--']
    ]) + '</div>' +
    '<div class="cf-card"><h4>' + cfgIcon('power') + ' Power and storage</h4>' + cfgKv([
      ['Battery', bat.percent != null && bat.percent >= 0 ? bat.percent + ' %' : '--'],
      ['Voltage', num(bat.voltage, 2, ' V')],
      ['External power', bat.external ? 'yes' : 'no'],
      ['Device filesystem', fs.mounted ? cfgBytes(fs.used) + ' used of ' + cfgBytes(fs.bytes)
                                       : '<span class="cf-no">not mounted</span>']
    ]) +
    '<div class="cf-actions"><button type="button" class="btn btn-danger" data-cfreboot="1">' +
      cfgIcon('power') + 'Restart device</button></div></div>';
}

function loadHardware() {
  return fetch('/api/hardware', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .catch(function () { return null; })
    .then(renderHardware);
}

function cfgBody() {
  var tabs = '', panes = '';

  CFG.forEach(function (sec) {
    tabs += '<button type="button" class="owx-tab' + (sec[0] === cfgState.tab ? ' sel' : '') +
      '" data-cfgtab="' + sec[0] + '">' + cfgIcon(sec[2]) + ' ' + esc(sec[1]) + '</button>';

    var rows = sec[0] === 'hardware'
      ? '<div class="cf-col cf-12 cf-hw" id="cfHardware"><span class="readonly">Reading the board…</span></div>'
      : sec[3].map(cfgField).join('');

    panes += '<div class="cf-pane" data-pane="' + sec[0] + '"' + (sec[0] === cfgState.tab ? '' : ' hidden') + '>' +
      '<div class="cf-grid">' + rows + '</div></div>';
  });

  return '<div class="owx-tabs cf-tabs">' + tabs + '</div>' + panes;
}

function cfgSelectTab(tab) {
  cfgState.tab = tab;
  document.querySelectorAll('.cf-tabs .owx-tab').forEach(function (b) {
    b.classList.toggle('sel', b.dataset.cfgtab === tab);
  });
  document.querySelectorAll('.cf-pane').forEach(function (p) {
    p.hidden = p.dataset.pane !== tab;
  });
  if (tab === 'hardware') { loadHardware(); }
}

function cfgFetchSettings() {
  return fetch('/api/settings', { cache: 'no-store' })
    .then(function (r) {
      if (r.status === 401) { throw new Error('login'); }
      if (!r.ok) { throw new Error('http ' + r.status); }
      return r.json();
    })
    .then(function (d) {
      cfgState.values = d.values || {};
      cfgState.secrets = d.secrets || {};
      return d;
    });
}

function openConfig(tab) {
  // "scan" is this browser's own map options: a dialogue of its own.
  if (tab === 'scan') { openMapOptions(); return; }

  var known = CFG.some(function (s) { return s[0] === tab; });
  cfgState.tab = known ? tab : 'general';

  var foot = '<span class="note" id="cfNote">Saved to config.yaml on the device.</span>' +
    '<button type="button" class="btn btn-close" data-close="1">Close</button>' +
    '<button type="button" class="btn btn-save" id="cfgSave">' + cfgIcon('down') + 'Save changes</button>';

  openModal('config', cfgIcon('cog') + ' Configuration',
            '<div class="readonly">Reading the settings…</div>', foot, true);

  cfgFetchSettings()
    .then(function () {
      if (modalKind !== 'config') { return; }
      document.getElementById('modalBody').innerHTML = cfgBody();
      cfgTopicPreview();
      if (cfgState.tab === 'hardware') { loadHardware(); }
    })
    .catch(function (e) {
      if (modalKind !== 'config') { return; }
      document.getElementById('modalBody').innerHTML =
        '<div class="cf-box warn">' + cfgIcon('info') + '<span>' +
        (e && e.message === 'login'
          ? 'The device asked for its web password. Reload the page and log in.'
          : 'The settings could not be read. Firmware older than this page has no /api/settings.') +
        '</span></div>';
    });
}

// What differs from what the device sent, as [key, value] pairs. A switch is
// "true" or "false"; an empty password field means "leave it as it is".
function cfgChanges() {
  var changes = [];
  var wifi = { ssid: null, pass: '' };

  document.querySelectorAll('.cf-pane [data-key]').forEach(function (el) {
    var key = el.dataset.key;
    var value = el.type === 'checkbox' ? (el.checked ? 'true' : 'false') : String(el.value).trim();

    if (key === 'wifi.ssid') { if (value !== cfgValue('wifi.ssid')) { wifi.ssid = value; } return; }
    if (key === 'wifi.pass') { wifi.pass = value; return; }
    if (el.type === 'password') { if (value) { changes.push([key, value]); } return; }

    var before = cfgValue(key);
    if (el.type === 'checkbox') { before = cfgOn(before) ? 'true' : 'false'; }
    if (el.type === 'number' && before !== '' && value !== '' && Number(before) === Number(value)) { return; }
    if (el.tagName === 'SELECT' && value.toLowerCase() === before.toLowerCase()) { return; }
    if (value !== before) { changes.push([key, value]); }
  });

  return { changes: changes, wifi: wifi };
}

function cfgNeedsRestart(changes) {
  var restart = {};
  CFG.forEach(function (sec) { sec[3].forEach(function (f) { if (f[6] === 'R') { restart[f[0]] = true; } }); });
  return changes.some(function (c) { return restart[c[0]]; });
}

function cfgPost(pairs) {
  var body = new URLSearchParams();
  pairs.forEach(function (p) { body.append(p[0], p[1]); });

  return fetch('/api/config', { method: 'POST', cache: 'no-store', body: body })
    .then(function (r) { return r.json(); })
    .catch(function () { return { ok: false, error: 'no link to the device' }; });
}

function saveConfig() {
  var found = cfgChanges();
  var changes = found.changes;
  var wifi = found.wifi;
  var wifiChanged = wifi.ssid !== null || !!wifi.pass;
  var note = document.getElementById('cfNote');

  if (!changes.length && !wifiChanged) {
    toast('Nothing changed');
    return;
  }

  if (note) { note.textContent = 'Writing to the device…'; }

  // The device keeps twenty pending edits at most, so larger saves go in parts.
  var batches = [];
  for (var i = 0; i < changes.length; i += 15) { batches.push(changes.slice(i, i + 15)); }

  var refused = [];

  var step = function (index) {
    if (index >= batches.length) { return Promise.resolve(); }
    return cfgPost(batches[index]).then(function (d) {
      if (!d.ok) {
        refused = refused.concat(d.refused && d.refused.length
          ? d.refused : batches[index].map(function (c) { return c[0]; }));
      }
      return step(index + 1);
    });
  };

  step(0)
    .then(function () {
      if (!wifiChanged) { return; }
      var ssid = wifi.ssid !== null ? wifi.ssid : cfgValue('wifi.ssid');
      return control('cmd=set_wifi&ssid=' + encodeURIComponent(ssid) +
                     '&pass=' + encodeURIComponent(wifi.pass));
    })
    .then(function () {
      if (refused.length) {
        toast(refused.length + ' setting(s) refused: ' + refused.join(', '), true);
      } else {
        toast('Saved ' + changes.length + ' setting(s)' + (wifiChanged ? ' and the Wi-Fi login' : ''));
      }

      if (note) {
        note.innerHTML = cfgNeedsRestart(changes)
          ? 'Some changes take effect after a restart. <button type="button" class="btn btn-danger btn-sm" ' +
            'data-cfreboot="1">' + cfgIcon('power') + 'Restart now</button>'
          : 'Saved to config.yaml on the device.';
      }

      // The password fields go back to "stored" and the next save compares
      // against what the device now holds.
      document.querySelectorAll('.cf-pane input[type=password]').forEach(function (el) { el.value = ''; });

      return cfgFetchSettings().catch(function () { })
        .then(loadConfig)
        .then(function () { if (lastData) { renderSidebar(lastData); } });
    });
}

function rebootDevice() {
  if (!window.confirm('Restart the deck now? The web panel is gone for about 20 seconds.')) { return; }

  control('cmd=reboot').then(function (d) {
    if (d.ok) { toast('Restarting - the page reconnects by itself'); closeModal(); }
  });
}

function openMapOptions() {
  var foot = '<span class="note">Map options are kept in this browser.</span>' +
    '<button type="button" class="btn" data-close="1">Close</button>' +
    '<button type="button" class="btn btn-primary" id="mapOptSave">' + cfgIcon('check') + 'Apply</button>';

  openModal('mapopts', cfgIcon('pin') + ' Map settings', scanBody(lastData), foot);
}

function scanBody(d) {
  const freq = (d && d.frequency) || {};

  return check('optFollow', 'Follow the tuned sonde', opts.follow) +
    check('optLabels', 'Show permanent labels on the map', opts.labels) +
    field('optRetention', 'Track retention (minutes, 0 keeps everything)',
          String(opts.retentionMin),
          'How long a sonde stays on the map and in the sidebar after its last frame.',
          'number') +
    '<hr style="border:none;border-top:1px solid #dee2e6;margin:16px 0">' +
    '<dl class="kv">' +
      '<dt>Tuned</dt><dd>' + num(freq.mhz, 3, ' MHz') + '</dd>' +
      '<dt>Source</dt><dd>' + esc(freq.preset_mode ? 'channel list' : 'manual') + '</dd>' +
      '<dt>Scanning</dt><dd>' + (freq.scan ? 'yes' : 'no') + '</dd>' +
      '<dt>Listening for</dt><dd>' + esc(enabledFamilies()) + '</dd>' +
    '</dl>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">' +
      '<button type="button" class="btn" data-scanact="toggle">' +
        (freq.scan ? 'Stop scanning' : 'Start scanning') + '</button>' +
      '<button type="button" class="btn" data-scanact="presets">Use channel list</button>' +
      '<button type="button" class="btn btn-danger" data-scanact="cleartracks">' +
        icon('trash') + 'Clear all tracks</button>' +
    '</div>';
}

function saveScanOptions() {
  const box = document.getElementById('optRetention');
  const minutes = box ? parseInt(box.value, 10) : opts.retentionMin;

  opts.follow = !!(document.getElementById('optFollow') || {}).checked;
  opts.labels = !!(document.getElementById('optLabels') || {}).checked;
  opts.retentionMin = Number.isFinite(minutes) && minutes >= 0 ? minutes : 60;

  follow = opts.follow;
  saveOpts();
  applyRetention();
  config.seenOpts = true;

  // Labels are bound per marker, so the change has to reach the ones already
  // on the map rather than only the next one created.
  Object.keys(sondes).forEach(function (key) { sondes[key].styleKey = ''; });
  syncSondeLayers();

  toast('Map options applied');
  closeModal();
}

document.addEventListener('click', function (e) {
  const target = e.target;
  if (!target || !target.closest) { return; }

  const tab = target.closest('[data-cfgtab]');
  if (tab) { e.preventDefault(); cfgSelectTab(tab.dataset.cfgtab); return; }

  if (target.closest('#cfgSave')) { e.preventDefault(); saveConfig(); return; }
  if (target.closest('#mapOptSave')) { e.preventDefault(); saveScanOptions(); return; }
  if (target.closest('[data-cfreboot]')) { e.preventDefault(); rebootDevice(); return; }

  const scanAct = target.closest('[data-scanact]');
  if (scanAct) {
    e.preventDefault();
    const what = scanAct.dataset.scanact;

    if (what === 'toggle') { toggleScan(); closeModal(); }
    else if (what === 'presets') { control('cmd=preset_mode').then(function (d) {
      if (d.ok) { toast('Following the channel list'); }
    }); }
    else { clearAllTracks(); closeModal(); }
  }
});

/* ---------- frequency and channels ---------- */

var channels = [];

// The channel list is a file on the device's filesystem, so the page reads it
// straight rather than asking for an API that would only repeat it.
function loadChannels() {
  if (channels.length) { return Promise.resolve(channels); }

  return fetch('sondeqrg.txt', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.text() : ''; })
    .then(function (text) {
      channels = [];

      String(text || '').split('\n').forEach(function (raw) {
        var line = raw.split('#')[0].trim();
        if (!line) { return; }

        // country  MHz  site-code  site name
        var parts = line.split(/\s+/);
        if (parts.length < 2) { return; }

        var mhz = parseFloat(parts[1]);
        if (!Number.isFinite(mhz)) { return; }

        channels.push({
          country: parts[0],
          mhz: mhz,
          code: parts[2] || '-',
          site: parts.slice(3).join(' ') || ''
        });
      });

      return channels;
    })
    .catch(function () { return channels; });
}

function tuneTo(mhz, family) {
  return control('cmd=set_manual_freq&mhz=' + mhz.toFixed(3))
    .then(function (d) {
      if (!d.ok) { return d; }
      return control('cmd=manual_mode');
    })
    .then(function (d) {
      if (!d.ok) { return d; }
      return control('cmd=set_family&family=' + encodeURIComponent(family || ''));
    })
    .then(function (d) {
      if (d.ok) {
        toast('Tuned to ' + mhz.toFixed(3) + ' MHz' +
              (family ? ', listening for ' + family : ''));
      }
      return d;
    });
}

// Only families this build can decode and config.yaml leaves on. Offering a
// type the device cannot tune for would just be a way to make it deaf.
function familyOptions(selected) {
  var families = [['', 'Any enabled family'],
                  ['RS41', 'RS41'], ['RS92', 'RS92'],
                  ['DFM', 'DFM'], ['M10', 'M10'], ['M20', 'M20']];

  return families.filter(function (f) {
    return f[0] === '' || config.decoders[f[0].toLowerCase()];
  }).map(function (f) {
    return '<option value="' + f[0] + '"' +
      (f[0] === selected ? ' selected' : '') + '>' + f[1] + '</option>';
  }).join('');
}

function openFrequency() {
  var freq = (lastData && lastData.frequency) || {};
  var current = Number.isFinite(freq.mhz) ? freq.mhz : 405.7;
  var family = freq.family && freq.family !== 'auto' ? freq.family : '';

  var body =
    '<p class="readonly" style="margin-bottom:14px">Holds the receiver on one ' +
    'channel. Scanning stops advancing until you release it or start scanning ' +
    'again.</p>' +
    '<div class="field-row">' +
      field('tuneFreq', 'Frequency (MHz)',
            current.toFixed(3), '', 'number') +
      '<div class="field"><label for="tuneType">Sonde type</label>' +
        '<select id="tuneType">' + familyOptions(family) + '</select>' +
        '<div class="hint">Pinning a type stops the radio taking turns with ' +
        'the other families, so a known sonde is heard every dwell instead of ' +
        'one in ' + Math.max(enabledProfileTurns(), 1) + '.</div>' +
      '</div>' +
    '</div>' +
    '<div id="tuneQuick" style="display:flex;gap:6px;flex-wrap:wrap"></div>';

  var foot =
    '<span class="note" id="tuneState"></span>' +
    '<button type="button" class="btn" id="tuneRelease">Release</button>' +
    '<button type="button" class="btn btn-primary" id="tuneApply">' + icon('check') + 'Tune</button>';

  openModal('freq', icon('rss') + ' Enter Frequency', body, foot);

  var state = document.getElementById('tuneState');
  if (state) {
    state.textContent =
      (freq.preset_mode
        ? 'Following the channel list'
        : 'Held on ' + num(freq.mhz, 3, ' MHz')) +
      ', listening for ' +
      (family ? family : 'every enabled family') +
      (freq.profile ? ' (now: ' + freq.profile + ')' : '') + '.';
  }

  loadChannels().then(function (list) {
    var quick = document.getElementById('tuneQuick');
    if (!quick) { return; }

    quick.innerHTML = list.slice(0, 8).map(function (c) {
      return '<button type="button" class="btn" data-quick="' + c.mhz.toFixed(3) + '">' +
             c.mhz.toFixed(3) + '</button>';
    }).join('');
  });
}

function openChannels() {
  openModal('channels', icon('list') + ' Fixed Channels',
            '<p class="readonly">Reading sondeqrg.txt&hellip;</p>',
            '<span class="note">From sondeqrg.txt on the device.</span>' +
            '<button type="button" class="btn" id="usePresets">Follow the list</button>' +
            '<button type="button" class="btn" data-close="1">Close</button>');

  loadChannels().then(function (list) {
    if (modalKind !== 'channels') { return; }

    var tuned = lastData && lastData.frequency ? lastData.frequency.mhz : NaN;

    var html = list.length === 0
      ? '<p class="readonly">No channel list on the device. Put one in ' +
        'data/sondeqrg.txt and run <code>pio run -t uploadfs</code>.</p>'
      : '<table class="owx-table"><thead><tr><th>Country</th><th>Frequency</th>' +
        '<th>Site</th><th>WMO</th></tr></thead><tbody>' +
        list.map(function (c) {
          var here = Number.isFinite(tuned) && Math.abs(tuned - c.mhz) < 0.0005;
          return '<tr class="pick' + (here ? ' tuned' : '') +
                 '" data-mhz="' + c.mhz.toFixed(3) + '">' +
                 '<td>' + esc(c.country) + '</td>' +
                 '<td class="mhz">' + c.mhz.toFixed(3) + ' MHz</td>' +
                 '<td>' + esc(c.site) + '</td>' +
                 '<td class="readonly">' + esc(c.code) + '</td></tr>';
        }).join('') + '</tbody></table>';

    document.getElementById('modalBody').innerHTML = html;
  });
}

/* ---------- spectrum ---------- */

function drawSpectrum(d) {
  var canvas = document.getElementById('specCanvas');
  if (!canvas) { return; }

  var ratio = window.devicePixelRatio || 1;
  var w = canvas.clientWidth;
  var h = canvas.clientHeight;

  canvas.width = Math.round(w * ratio);
  canvas.height = Math.round(h * ratio);

  var ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, w, h);

  var padL = 58;
  var padB = 22;
  var padT = 8;
  var plotW = w - padL - 8;
  var plotH = h - padT - padB;

  var floor = d.floor_dbm;
  var ceiling = d.ceiling_dbm;
  var span = ceiling - floor;

  // Same fixed -127..-25 dBm window the device's own Spectrum page uses: two
  // rounds of auto-scaling produced a graph that tracked the data instead of
  // showing it.
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  for (var db = ceiling; db >= floor; db -= 25) {
    var y = padT + plotH * (ceiling - db) / span;
    ctx.strokeStyle = 'rgba(255,255,255,.12)';
    ctx.beginPath();
    ctx.moveTo(padL, y + 0.5);
    ctx.lineTo(padL + plotW, y + 0.5);
    ctx.stroke();
    ctx.fillStyle = '#8a93a0';
    ctx.fillText(db + ' dBm', padL - 6, y);
  }

  var bins = d.bins || [];
  var barW = plotW / Math.max(bins.length, 1);

  bins.forEach(function (dbm, i) {
    if (dbm <= -128) { return; }

    var level = Math.max(floor, Math.min(ceiling, dbm));
    var barH = Math.max(3, plotH * (level - floor) / span);
    var x = padL + i * barW;

    ctx.fillStyle = i === d.peak_bin ? '#ffffff' : '#4da3ff';
    ctx.fillRect(x + 0.5, padT + plotH - barH, Math.max(barW - 1, 1), barH);
  });

  ctx.strokeStyle = 'rgba(255,255,255,.3)';
  ctx.beginPath();
  ctx.moveTo(padL, padT + plotH + 0.5);
  ctx.lineTo(padL + plotW, padT + plotH + 0.5);
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.fillStyle = '#8a93a0';

  var startMhz = d.start_hz / 1e6;
  var stopMhz = d.stop_hz / 1e6;

  for (var mhz = Math.ceil(startMhz); mhz <= stopMhz; mhz += 1) {
    var tx = padL + plotW * (mhz - startMhz) / (stopMhz - startMhz);
    ctx.fillText(mhz.toFixed(0), Math.min(Math.max(tx, padL + 10), padL + plotW - 10),
                 padT + plotH + 11);
  }

  var legend = document.getElementById('specLegend');
  if (legend) {
    legend.innerHTML =
      '<span>Peak <b>' + (d.peak_dbm <= -128 ? '--' : d.peak_dbm + ' dBm') + '</b>' +
      (d.peak_hz ? ' at <b>' + (d.peak_hz / 1e6).toFixed(3) + ' MHz</b>' : '') + '</span>' +
      '<span>Noise floor <b>' + (d.noise_dbm <= -128 ? '--' : d.noise_dbm + ' dBm') + '</b></span>' +
      '<span>Sweeps <b>' + d.sweeps + '</b></span>' +
      (d.read_errors ? '<span style="color:#dc3545">Read errors <b>' + d.read_errors + '</b></span>' : '');
  }
}

function pollSpectrum() {
  fetch('/api/spectrum', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (modalKind !== 'spectrum') { return; }

      if (!d.active) {
        var legend = document.getElementById('specLegend');
        if (legend) { legend.innerHTML = '<span>Waiting for the first sweep&hellip;</span>'; }
        return;
      }

      // A peak well clear of the noise is a channel worth remembering, even
      // though a sweep cannot say which family is on it.
      if (Number.isFinite(d.peak_hz) && Number.isFinite(d.peak_dbm) &&
          Number.isFinite(d.noise_dbm) && d.peak_dbm - d.noise_dbm > 6) {
        repoDetect(Math.round(d.peak_hz / 1000) / 1000, d.peak_dbm, d.noise_dbm);
      }

      drawSpectrum(d);
    })
    .catch(function () { });
}

/* ---------- frequency repository ---------- */

function openFreqRepo() {
  var list = repoList();
  var tuned = lastData && lastData.frequency ? lastData.frequency.mhz : NaN;

  var body =
    '<p class="repo-note">Radiosonde channels seen this session. ' +
    '<span class="badge-bs badge-ok">confirmed</span> = a decode produced telemetry; ' +
    '<span class="badge-bs badge-seen">detected</span> = a scan peak not (yet) decoded.' +
    '<span class="repo-file">' + list.length + ' channel' +
      (list.length === 1 ? '' : 's') + ' kept in this browser</span></p>';

  body += list.length === 0
    ? '<p class="readonly">Nothing heard yet. Start scanning, or open the ' +
      'spectrum to let the band scan find carriers.</p>'
    : '<table class="owx-table repo-table"><thead><tr><th>MHz</th><th>Status</th><th>Type</th>' +
      '<th>Serial</th><th>SNR</th><th>RSSI</th><th>Last seen (UTC)</th><th></th>' +
      '</tr></thead><tbody>' +
      list.map(function (c) {
        var here = Number.isFinite(tuned) && Math.abs(tuned - c.mhz) < 0.0005;
        var family = normType(c.type).split('-')[0];

        return '<tr class="pick' + (here ? ' tuned' : '') +
          '" data-mhz="' + c.mhz.toFixed(3) + '" data-family="' + esc(family) + '">' +
          '<td class="mhz">' + c.mhz.toFixed(3) + '</td>' +
          '<td><span class="badge-bs ' +
            (c.status === 'confirmed' ? 'badge-ok">confirmed' : 'badge-seen">detected') +
            '</span></td>' +
          '<td>' + (c.type ? typeBadge(c.type) : '<span class="dim">&mdash;</span>') + '</td>' +
          '<td>' + (c.serial ? esc(c.serial) : '<span class="dim">&mdash;</span>') + '</td>' +
          '<td class="dim">' + (Number.isFinite(c.snr) ? num(c.snr, 1, ' dB') : '&mdash;') + '</td>' +
          '<td class="dim">' + (Number.isFinite(c.rssi) ? c.rssi + ' dBm' : '&mdash;') + '</td>' +
          '<td class="dim seen">' + (c.seen ? esc(stampUtc(new Date(c.seen))) : '&mdash;') + '</td>' +
          '<td class="act"><button type="button" class="btn-play" title="Tune here">&#9654;</button></td>' +
          '</tr>';
      }).join('') + '</tbody></table>';

  openModal('repo', icon('list') + ' Frequency Repository', body,
    '<span class="note">Click a row to tune the receiver there.</span>' +
    '<button type="button" class="btn" id="repoClear">' + icon('trash') + 'Clear</button>' +
    '<button type="button" class="btn" data-close="1">Close</button>' +
    '<button type="button" class="btn" id="repoRefresh">' + icon('history') + 'Refresh</button>', true);
}

function openSpectrum() {
  openModal('spectrum', icon('chart') + ' Spectrum &ndash; 401 to 406 MHz',
    '<p class="readonly" style="margin-bottom:12px">Sweeping and receiving cannot ' +
    'share one radio, so decoding is paused while this is open.</p>' +
    '<canvas id="specCanvas"></canvas>' +
    '<div class="spec-legend" id="specLegend"><span>Starting the sweep&hellip;</span></div>',
    '<span class="note">Closing this hands the radio back to the decoder.</span>' +
    '<button type="button" class="btn" data-close="1">Close</button>', true);

  control('cmd=spectrum&on=1');
  modalTimer = window.setInterval(pollSpectrum, 1000);
  window.setTimeout(pollSpectrum, 400);
}

// Closing the tab with the dialogue open would otherwise leave the device
// sweeping until its lease runs out. keepalive lets the request survive the
// page going away; the lease is what covers the cases where it does not.
window.addEventListener('pagehide', function () {
  if (modalKind !== 'spectrum') { return; }

  try {
    fetch('/api/control?cmd=spectrum&on=0', { method: 'POST', keepalive: true });
  } catch (e) { /* the device releases it on its own soon enough */ }
});

/* ---------- logfile and about ---------- */

/* ---------- the device's own filesystem ---------- */

// A handheld is often run with no SD card at all, and then LittleFS is the
// only place the sondes it heard are written down. This takes a copy of what
// the receiver keeps there - the panel's own files are listed too, but they
// are the ones already in the repository, so they are not what is offered.
function openFilesystem() {
  openModal('fs', icon('down') + ' Device filesystem',
    '<p class="repo-note">Reading the filesystem\u2026</p>',
    '<button type="button" class="btn" data-close="1">Close</button>');

  fetch('/api/fs', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
    .then(function (d) {
      // The panel's own files are on there too. They are the ones in the
      // repository, they are replaced with `pio run -t uploadfs`, and a list
      // of them is only something to scroll past.
      var data = (d.files || []).filter(function (f) { return f.data; });

      var body =
        '<p class="repo-note">What the receiver keeps on its own filesystem. ' +
        'The panel\'s own files are not listed, and config.yaml is never ' +
        'served - it holds the broker credentials.' +
        '<span class="repo-file">' +
          (d.mounted
            ? Math.round((d.used || 0) / 1024) + ' kB of ' +
              Math.round((d.bytes || 0) / 1024) + ' kB used'
            : 'no filesystem mounted') +
        '</span></p>';

      body += data.length === 0
        ? '<p class="readonly">The receiver has written nothing to it yet.</p>'
        : '<table class="owx-table repo-table"><thead><tr>' +
          '<th>File</th><th>Size</th><th></th>' +
          '</tr></thead><tbody>' +
          data.map(function (f) {
            return '<tr>' +
              '<td class="mhz">' + esc(f.path) + '</td>' +
              '<td class="dim logsize">' + logSize(f.bytes) + '</td>' +
              '<td class="act">' +
                '<button type="button" class="btn-play" data-fs="' + esc(f.path) +
                  '">Save</button> ' +
                '<button type="button" class="btn-play" data-fsup="' + esc(f.path) +
                  '" title="Replace this file">Upload</button>' +
              '</td></tr>';
          }).join('') + '</tbody></table>';

      openModal('fs', icon('down') + ' Device filesystem', body,
        '<span class="note">' + data.length + ' file' + (data.length === 1 ? '' : 's') +
          ' the receiver wrote. Uploads take txt, csv, json, gpx, png, jpg, bmp, ico.</span>' +
        '<button type="button" class="btn" id="fsAdd">' + icon('up') + 'Upload file</button>' +
        '<button type="button" class="btn" data-close="1">Close</button>' +
        '<button type="button" class="btn btn-primary" id="fsAll">' +
          icon('down') + 'Save receiver data</button>', true);
    })
    .catch(function (why) {
      openModal('fs', icon('down') + ' Device filesystem',
        '<p class="readonly">The device did not answer (' + esc(String(why)) + '). ' +
        'A firmware without the filesystem endpoints serves no listing.</p>',
        '<button type="button" class="btn" data-close="1">Close</button>');
    });
}

// The same sliced reader the logs use, because a filesystem file is read off
// the same single-connection server.
function downloadFsFile(path) {
  var name = path.replace(/^\//, '').replace(/\//g, '-');

  toast('Reading ' + path + '\u2026');

  return readLogFile('/api/fs/read?path=' + encodeURIComponent(path), null, true)
    .then(function (file) {
      saveBlob(new Blob([file.bytes], { type: 'text/plain' }), name);
      toast(name + ' saved (' + logSize(file.bytes.length) + ')');
    })
    .catch(function (why) {
      toast('Could not read ' + path + ' (' + why + ')', true);
    });
}

// One file onto the device. A path means replace that one; without it the
// file keeps the name it had on the way in.
function uploadFsFile(path) {
  var picker = document.createElement('input');

  picker.type = 'file';
  picker.hidden = true;

  if (path) {
    var dot = path.lastIndexOf('.');
    if (dot > 0) { picker.accept = path.slice(dot); }
  }

  document.body.appendChild(picker);

  picker.addEventListener('change', function () {
    var file = picker.files && picker.files[0];
    document.body.removeChild(picker);

    if (!file) { return; }

    var target = path || '/' + file.name;
    var form = new FormData();

    form.append('file', file, file.name);
    toast('Sending ' + file.name + ' (' + logSize(file.size) + ')\u2026');

    fetch('/api/fs/write?path=' + encodeURIComponent(target),
          { method: 'POST', body: form })
      .then(function (r) { return r.json().catch(function () { return { ok: r.ok }; }); })
      .then(function (d) {
        if (!d.ok) { return Promise.reject(d.error || 'refused'); }

        toast(target + ' written (' + logSize(d.bytes) + ')');
        openFilesystem();
      })
      .catch(function (why) { toast('Upload failed: ' + why, true); });
  });

  picker.click();
}

function downloadFsData() {
  fetch('/api/fs', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
    .then(function (d) {
      var data = (d.files || []).filter(function (f) { return f.data; });

      if (data.length === 0) { toast('The receiver has written nothing yet', true); return; }

      // One after another: the device serves one request at a time.
      return data.reduce(function (chain, f) {
        return chain.then(function () { return downloadFsFile(f.path); });
      }, Promise.resolve());
    })
    .catch(function (why) { toast('Could not read the filesystem (' + why + ')', true); });
}

/* ---------- logfiles on the card ---------- */

// What /api/logs last reported, and which of them is open. The device lists;
// this browser sorts, reads, and turns a track into GPX or a line on the map.
var logFiles = [];
// No column yet: the first sortLogs() call chooses one rather than reversing
// the one it was given.
var logSort = { column: '', direction: -1 };
var logOpen = null;          // { entry, text, points }
var logTrackLayer = null;    // a track loaded from the card, drawn over the map

// The same reading of a serial OpenWXSDR uses, so a folder name that never
// made it into this browser's registry still gets a family.
function logTypeFor(entry) {
  if (entry.kind !== 'track' && entry.serial.indexOf('latest') !== 0) { return 'Activity'; }

  var known = sondes[entry.serial];
  if (known && known.type) { return typeLabel(known.type); }

  var s = entry.serial;
  if (/^[A-Z]\d{7}/.test(s)) { return 'RS41'; }
  if (/^[A-Z]\d{6}/.test(s)) { return 'RS92'; }
  if (/^\d{8}$/.test(s)) { return 'DFM'; }
  if (/^\d+-\d+-\d+/.test(s)) { return 'M20'; }
  if (/^M\d+/.test(s)) { return 'M10'; }
  return entry.kind === 'track' ? 'Sonde' : 'Activity';
}

// Every track on the card is called track.csv, so the name that means
// anything is the sonde's. The rollups keep their own names.
function logName(entry) {
  return entry.serial;
}

// What to call it when the full path matters - the head of the reading pane,
// and the name a download is saved under.
function logPathName(entry) {
  return entry.kind === 'track' ? entry.serial + '/track.csv' : entry.serial;
}

// kB up to a megabyte, then MB: a track is one or the other and nobody wants
// to count digits.
function logSize(bytes) {
  if (!Number.isFinite(bytes)) { return '-'; }
  if (bytes < 1024) { return bytes + ' B'; }
  if (bytes < 1024 * 1024) { return Math.round(bytes / 1024) + ' kB'; }

  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function logDate(entry) {
  // The device stamps its files from the GPS clock; before the first fix it
  // has none, and saying so is better than showing 1970. Once a file has
  // been read, the GPS time in its own frames fills the gap.
  if (!(entry.mtime > 1000000000)) { return '-'; }

  return stampUtc(new Date(entry.mtime * 1000)) + (entry.fromFrames ? ' *' : '');
}

function sortLogs(column) {
  if (logSort.column === column) {
    logSort.direction *= -1;
  } else {
    logSort.column = column;
    logSort.direction = column === 'date' ? -1 : 1;
  }

  logFiles.sort(function (a, b) {
    var va, vb;

    if (column === 'name') { va = logName(a); vb = logName(b); }
    else if (column === 'type') { va = logTypeFor(a); vb = logTypeFor(b); }
    else if (column === 'size') { va = a.bytes || 0; vb = b.bytes || 0; }
    else { va = a.mtime || 0; vb = b.mtime || 0; }

    if (va < vb) { return -logSort.direction; }
    if (va > vb) { return logSort.direction; }
    return 0;
  });

  renderLogRows();
}

function renderLogRows() {
  var host = document.getElementById('logRows');
  if (!host) { return; }

  if (logFiles.length === 0) {
    host.innerHTML = '<tr><td colspan="4" class="dim">No logs on the card.</td></tr>';
    return;
  }

  host.innerHTML = logFiles.map(function (f) {
    var live = lastData && lastData.sonde && lastData.sonde.heard &&
               lastData.sonde.serial === f.serial;

    return '<tr class="pick' + (live ? ' tuned' : '') +
      (logOpen && logOpen.entry.path === f.path ? ' open' : '') +
      '" data-log="' + esc(f.path) + '">' +
      '<td class="logname">' + esc(logName(f)) + '</td>' +
      '<td><span class="badge-bs badge-seen">' + esc(logTypeFor(f)) + '</span></td>' +
      '<td class="dim logsize">' + logSize(f.bytes) + '</td>' +
      '<td class="dim seen">' + logDate(f) + '</td>' +
      '</tr>';
  }).join('');
}

// track.csv is a header line and one line per frame; this pulls out what a
// track needs and nothing else.
function parseLogTrack(text) {
  var lines = text.split(/\r?\n/);
  if (lines.length < 2) { return []; }

  var head = lines[0].split(',');
  var at = {};
  head.forEach(function (name, i) { at[name.trim()] = i; });

  if (at.sonde_lat == null || at.sonde_lon == null) { return []; }

  var points = [];

  for (var i = 1; i < lines.length; i++) {
    if (!lines[i]) { continue; }

    var f = lines[i].split(',');
    var lat = parseFloat(f[at.sonde_lat]);
    var lon = parseFloat(f[at.sonde_lon]);

    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) { continue; }

    var alt = parseFloat(f[at.sonde_alt_m]);
    var week = at.gps_week != null ? parseInt(f[at.gps_week], 10) : 0;
    var tow = at.gps_tow_ms != null ? parseInt(f[at.gps_tow_ms], 10) : 0;

    // GPS time, not the device's uptime: 1980-01-06 plus the week and the
    // time of week, less the 18 leap seconds GPS is ahead of UTC.
    var utc = week > 0 ? (315964800 + week * 604800 + Math.round(tow / 1000) - 18) * 1000 : NaN;

    // The last two columns came later, so a track written by an older build
    // simply has nothing in them.
    var freqHz = at.rx_freq_hz != null ? parseInt(f[at.rx_freq_hz], 10) : NaN;

    points.push({
      lat: lat, lon: lon,
      alt: Number.isFinite(alt) ? alt : NaN,
      utc: utc,
      velV: parseFloat(f[at.sonde_vspeed_mps]),
      velH: parseFloat(f[at.sonde_hspeed_mps]),
      frame: at.frame != null ? parseInt(f[at.frame], 10) : NaN,
      tempC: at.sonde_temp_c != null ? parseFloat(f[at.sonde_temp_c]) : NaN,
      freqMhz: Number.isFinite(freqHz) && freqHz > 0 ? freqHz / 1e6 : NaN,
      type: at.sonde_type != null ? (f[at.sonde_type] || '').replace(/"/g, '') : '',
      serial: at.serial != null ? (f[at.serial] || '').replace(/"/g, '') : ''
    });
  }

  return points;
}

// The device hands a track over in pieces. A 600 kB file streamed in one
// response held its loop up for seconds and, if the card hiccuped halfway,
// left this browser waiting for bytes that were never coming. Asking for a
// slice at a time keeps every request short - and makes it possible to say
// how far along the reading has got.
var LOG_CHUNK = 65536;
var LOG_TRIES = 4;
var logReading = false;

function wait(ms) {
  return new Promise(function (done) { setTimeout(done, ms); });
}

function readLogFile(path, onProgress, isUrl) {
  var parts = [];
  var offset = 0;
  var total = NaN;

  var base = isUrl ? path : '/api/log?path=' + encodeURIComponent(path);

  // A card read can fail on its own now and then, and so can a connection to
  // a server that serves one at a time. A slice is worth asking for again
  // before giving up on the whole file.
  function slice(attempt) {
    return fetch(base + '&offset=' + offset + '&len=' + LOG_CHUNK, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) { return Promise.reject(r.status); }
        return r;
      })
      .catch(function (why) {
        if (attempt + 1 >= LOG_TRIES) { return Promise.reject(why); }

        if (onProgress) { onProgress(-1, offset, total, attempt + 1); }

        return wait(200 * (attempt + 1)).then(function () { return slice(attempt + 1); });
      });
  }

  function step() {
    return slice(0)
      .then(function (r) {
        var size = parseInt(r.headers.get('X-Log-Size'), 10);
        if (Number.isFinite(size)) { total = size; }

        return r.arrayBuffer();
      })
      .then(function (buffer) {
        var part = new Uint8Array(buffer);

        parts.push(part);
        offset += part.length;

        if (onProgress) {
          onProgress(total > 0 ? Math.min(100, Math.round(offset * 100 / total)) : 100,
                     offset, total);
        }

        // A short answer means the end of the file, whatever the size said.
        if (part.length === 0 || offset >= total) {
          var all = new Uint8Array(offset);
          var at = 0;

          parts.forEach(function (p) { all.set(p, at); at += p.length; });

          return { bytes: all, text: new TextDecoder('utf-8').decode(all) };
        }

        return step();
      });
  }

  return step();
}

// -1 means a slice is being asked for again; the bar holds where it is and
// says so, rather than pretending nothing happened.
function setLogProgress(percent, done, total, retry) {
  var bar = document.getElementById('logBar');
  var pct = document.getElementById('logPct');
  var wrap = document.getElementById('logProgress');

  if (percent < 0) {
    if (pct) { pct.textContent = 'retry ' + retry; }
    return;
  }

  if (wrap) { wrap.hidden = percent >= 100; }
  if (bar) { bar.style.width = Math.max(2, percent) + '%'; }
  if (pct) { pct.textContent = percent + ' %'; }
}

function openLogEntry(path) {
  var entry = logFiles.filter(function (f) { return f.path === path; })[0];
  if (!entry) { return; }

  var name = document.getElementById('logName');
  var text = document.getElementById('logText');

  if (name) { name.textContent = logPathName(entry) + '  \u00b7  ' + logSize(entry.bytes); }
  if (text) { text.textContent = 'Reading ' + logSize(entry.bytes) + ' from the card\u2026'; }

  setLogProgress(0);
  logReading = true;

  readLogFile(path, setLogProgress)
    .then(function (file) {
      logReading = false;
      var body = file.text;

      var points = entry.kind === 'track' || entry.serial.indexOf('latest') === 0
        ? parseLogTrack(body) : [];

      logOpen = { entry: entry, text: body, bytes: file.bytes, points: points };

      // A flight is thousands of lines; the browser keeps them all for the
      // track and the export, and shows the head of the file.
      var lines = body.split(/\r?\n/);
      var shown = lines.slice(0, 300).join('\n');

      if (text) {
        text.textContent = lines.length > 300
          ? shown + '\n\n... ' + (lines.length - 300) + ' more lines. Download to read them all.'
          : shown;
      }

      var count = document.getElementById('logPoints');
      if (count) {
        count.textContent = points.length
          ? points.length + ' positions'
          : (entry.kind === 'track' ? 'no positions in this file' : '');
      }

      // The card gives a file no date until the receiver has had a clock, so
      // the list shows a dash. The frames themselves carry GPS time, and now
      // that they have been read the row can say when the flight was.
      var last = points.length ? points[points.length - 1] : null;

      if (last && Number.isFinite(last.utc) && !(entry.mtime > 1000000000)) {
        entry.mtime = Math.round(last.utc / 1000);
        entry.fromFrames = true;
      }

      setLogProgress(100);
      renderLogRows();
    })
    .catch(function (why) {
      logReading = false;
      setLogProgress(100);

      if (text) {
        text.textContent = 'Could not read that file from the card' +
          (why ? ' (' + why + ')' : '') + '.\n\n' +
          'It was asked for ' + LOG_TRIES + ' times. Pick it again to retry.';
      }
    });
}

function logGpx() {
  if (!logOpen || logOpen.points.length === 0) { toast('No positions in that log', true); return; }

  var serial = logOpen.entry.serial;
  var body = logOpen.points.map(function (p) {
    return '  <trkpt lat="' + p.lat.toFixed(6) + '" lon="' + p.lon.toFixed(6) + '">' +
      (Number.isFinite(p.alt) ? '<ele>' + p.alt.toFixed(1) + '</ele>' : '') +
      (Number.isFinite(p.utc) ? '<time>' + new Date(p.utc).toISOString() + '</time>' : '') +
      '</trkpt>';
  }).join('\n');

  var gpx = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<gpx version="1.1" creator="OpenWXDeck" xmlns="http://www.topografix.com/GPX/1/1">\n' +
    '<metadata><name>' + esc(serial) + '</name></metadata>\n' +
    '<trk><name>' + esc(serial) + '</name><trkseg>\n' + body + '\n</trkseg></trk>\n</gpx>\n';

  saveBlob(new Blob([gpx], { type: 'application/gpx+xml' }), serial + '.gpx');
  toast(logOpen.points.length + ' points exported');
}

// The file is already here, read a slice at a time; saving it is this
// browser's job, not another trip through the card.
function logDownload() {
  if (!logOpen) { toast('Pick a log first', true); return; }

  var entry = logOpen.entry;
  var name = entry.kind === 'track' ? entry.serial + '-track.csv' : entry.serial;

  saveBlob(new Blob([logOpen.bytes || logOpen.text], { type: 'text/csv' }), name);
  toast(name + ' saved');
}

function saveBlob(blob, name) {
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');

  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
}

// The first row of a track off the card. The same shape as the start marker
// of a track this browser followed itself, but it says where the reading
// came from: the card kept this, nobody was watching.
function logStartPopup(entry, first) {
  var when = Number.isFinite(first.utc) ? stamp(new Date(first.utc)) : 'time not in this log';

  return '<div class="start-popup">' +
    '<div class="start-hdr"><strong>' + esc(first.serial || entry.serial) +
      '</strong> - First position in this log</div>' +
    '<div class="start-note">The earliest frame the card kept</div>' +
    esc(when) + '<br>' +
    '<span class="coord">Lat: ' + hemisphere(first.lat, 'N', 'S') +
      ' Lon: ' + hemisphere(first.lon, 'E', 'W') + '</span><br>' +
    '<span class="coord">Alt=' + num(first.alt, 0, ' m') + '</span>' +
    '</div>';
}

// The last row of a track, written the way a last known position is written
// everywhere else in the OpenWX family: what it was, when it was last heard,
// where, how it was moving, and how many frames it gave.
function logEndPopup(entry, last, frames) {
  var type = last.type || logTypeFor(entry);
  var freq = Number.isFinite(last.freqMhz) ? last.freqMhz : sondeFreqFromRegistry(entry.serial);

  var head = '<strong>' + esc(last.serial || entry.serial) + '</strong>' +
    (Number.isFinite(freq) ? ' - ' + num(freq, 3, ' MHz') : '') +
    (type ? ' - ' + esc(type) : '');

  var when = Number.isFinite(last.utc) ? stamp(new Date(last.utc)) : 'time not in this log';

  var motion = num(last.alt, 0, ' m');
  if (Number.isFinite(last.velV)) { motion = 'Alt=' + motion + ' | ' + num(last.velV, 1, ' m/s'); }
  else { motion = 'Alt=' + motion; }
  if (Number.isFinite(last.velH)) { motion += ' | ' + num(last.velH * 3.6, 1, ' km/h'); }
  if (Number.isFinite(last.tempC)) { motion += ' | ' + num(last.tempC, 1, ' \u00b0C'); }

  return '<div class="sonde-popup log-popup">' +
    '<div class="lp-head">' + head + '</div>' +
    '<div class="lp-note">Last known position</div>' +
    '<div class="lp-data">' + esc(when) + '</div>' +
    '<div class="lp-data">Lat: ' + hemisphere(last.lat, 'N', 'S') +
      ' Lon: ' + hemisphere(last.lon, 'E', 'W') + '</div>' +
    '<div class="lp-data">' + motion + '</div>' +
    '<div class="lp-frames">Frames: ' + frames + '</div>' +
    '</div>';
}

// An older track has no frequency in it; this browser may still know which
// channel that serial was heard on.
function sondeFreqFromRegistry(serial) {
  var known = sondes[serial];
  if (known && Number.isFinite(known.freqMhz)) { return known.freqMhz; }

  for (var key in repo) {
    if (repo[key] && repo[key].serial === serial) { return repo[key].mhz; }
  }

  return NaN;
}

// A track off the card is history, and is drawn as history: the stale dash,
// in a colour no live sonde uses, so it cannot be mistaken for one.
function logShowOnMap() {
  if (!mapReady) { toast('The map is not ready yet', true); return; }
  if (!logOpen || logOpen.points.length < 2) { toast('No track in that log', true); return; }

  closeModal();
  drawLogTrack();
}

function drawLogTrack() {
  var latlngs = logOpen.points.map(function (p) { return [p.lat, p.lon]; });

  clearLogTrack();

  var last = logOpen.points[logOpen.points.length - 1];

  // The end of a loaded track is a last known position like any other, so it
  // gets the marker every other one gets rather than a shape of its own.
  var endMarker = L.marker(latlngs[latlngs.length - 1], { icon: storedIcon })
    .bindPopup(logEndPopup(logOpen.entry, last, logOpen.points.length))
    .bindTooltip(esc(last.serial || logOpen.entry.serial) + ' &middot; from the card',
      { direction: 'right', offset: [11, 0], className: 'sonde-tooltip' });

  logTrackLayer = L.layerGroup([
    L.polyline(latlngs, { color: '#6f42c1', weight: 3, opacity: 0.9, dashArray: '8 4' }),
    L.marker(latlngs[0], { icon: startIcon })
      .bindPopup(logStartPopup(logOpen.entry, logOpen.points[0]))
      .bindTooltip('Log start &middot; ' + esc(logOpen.entry.serial),
        { direction: 'right', offset: [8, 0], className: 'sonde-tooltip' }),
    endMarker
  ]).addTo(map);

  setFollow(false);
  map.fitBounds(L.latLngBounds(latlngs).pad(0.15));
  endMarker.openPopup();
  toast(logOpen.entry.serial + ': ' + logOpen.points.length + ' points on the map');
}

function clearLogTrack() {
  if (!logTrackLayer) { return false; }

  try { map.removeLayer(logTrackLayer); } catch (e) { }
  logTrackLayer = null;
  return true;
}

function openLogfile() {
  var d = lastData || {};
  var log = d.logging || {};

  var body =
    '<p class="repo-note">Tracks the receiver has written to <code>/logs/</code> on the ' +
    'SD card, one folder per sonde.' +
    '<span class="repo-file">' + (log.available ? 'card present' : 'no card detected') +
      ' &middot; logging ' + (log.enabled ? 'on' : 'off') + '</span></p>' +
    '<div class="logs-wrap">' +
      '<div class="logs-list"><table class="owx-table repo-table logs-table"><thead><tr>' +
        '<th data-logsort="name">Filename &#8597;</th>' +
        '<th data-logsort="type">Type &#8597;</th>' +
        '<th data-logsort="size">Size &#8597;</th>' +
        '<th data-logsort="date">Date &amp; Time &#8597;</th>' +
      '</tr></thead><tbody id="logRows">' +
        '<tr><td colspan="4" class="dim">Reading the card&hellip;</td></tr>' +
      '</tbody></table></div>' +
      '<div class="logs-view">' +
        '<div class="logs-bar"><span id="logName">Pick a log to read it</span>' +
          '<span class="logs-acts">' +
            '<button type="button" class="btn btn-sm" id="logGpxBtn">' + icon('down') + 'Export GPX</button>' +
            '<button type="button" class="btn btn-sm" id="logMapBtn">' + icon('pin') + 'Show on Map</button>' +
            '<button type="button" class="btn btn-sm" id="logDlBtn">' + icon('file') + 'Download</button>' +
          '</span></div>' +
        '<div class="logs-progress" id="logProgress" hidden>' +
          '<div class="logs-track"><span id="logBar"></span></div>' +
          '<span class="logs-pct" id="logPct">0 %</span></div>' +
        '<pre id="logText" class="logs-text">The file is read from the card when you pick it.</pre>' +
        '<div class="logs-foot"><span id="logPoints"></span></div>' +
      '</div>' +
    '</div>';

  openModal('logfile', icon('file') + ' Logfiles', body,
    '<span class="note">Sorted newest first. Click a column to re-sort.</span>' +
    '<button type="button" class="btn" id="logClear">Clear map track</button>' +
    '<button type="button" class="btn" data-close="1">Close</button>' +
    '<button type="button" class="btn btn-primary" id="logToggle">' +
      (log.enabled ? 'Stop logging' : 'Start logging') + '</button>', true);

  logOpen = null;

  loadLogList()
    .then(function () { sortLogs('date'); })
    .catch(function () {
      var host = document.getElementById('logRows');
      if (host) {
        host.innerHTML = '<tr><td colspan="4" class="dim">The device did not answer. ' +
          'A firmware without the log endpoints serves no list.</td></tr>';
      }
    });
}

// The listing, for the dialogue and for a marker asking whether the card has
// a track of its own. Re-read at most once a minute: it is a walk of the
// card's directories, not a free call.
var logListAt = 0;

function loadLogList(force) {
  if (!force && logFiles.length > 0 && Date.now() - logListAt < 60000) {
    return Promise.resolve(logFiles);
  }

  return fetch('/api/logs', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
    .then(function (data) {
      logFiles = (data.files || []).filter(function (f) { return f.path.indexOf('/index.csv') < 0; });
      logListAt = Date.now();
      return logFiles;
    });
}

// A sonde that came back from the device's memory has one point: where it was
// last heard. The whole flight is on the card, and this is how it gets onto
// the map - the same reader the dialogue uses, with the progress in a toast
// because there is no dialogue open to put a bar in.
function loadTrackFromCard(serial) {
  if (!mapReady) { toast('The map is not ready yet', true); return; }
  if (logReading) { toast('Still reading the last one', true); return; }

  toast('Looking for ' + serial + ' on the card\u2026');

  loadLogList()
    .then(function (files) {
      var file = files.filter(function (f) {
        return f.kind === 'track' && f.serial === serial;
      })[0];

      if (!file) { return Promise.reject('no log'); }

      logReading = true;

      return readLogFile(file.path, function (percent) {
        if (percent >= 0) {
          toast('Reading ' + serial + ' from the card\u2026 ' + percent + ' %');
        }
      }).then(function (read) {
        logReading = false;

        var points = parseLogTrack(read.text);

        if (points.length < 2) { return Promise.reject('no track in it'); }

        logOpen = { entry: file, text: read.text, bytes: read.bytes, points: points };
        drawLogTrack();
      });
    })
    .catch(function (why) {
      logReading = false;
      toast(why === 'no log'
        ? 'The card has no track for ' + serial
        : 'Could not read ' + serial + ' from the card (' + why + ')', true);
    });
}

function openAbout() {
  var d = lastData || {};

  var body = '<dl class="kv">' +
    '<dt>Firmware</dt><dd>OpenWXDeck ' + esc(d.version || '') + '</dd>' +
    '<dt>Hardware</dt><dd>' + esc(config.hardware) + '</dd>' +
    '<dt>Receiver</dt><dd>' + esc(config.radio) + '</dd>' +
    '<dt>Station</dt><dd>' + esc(config.station) + '</dd>' +
    '<dt>Decoding</dt><dd>' + esc(enabledFamilies()) + '</dd>' +
    '<dt>Address</dt><dd>' + esc((d.network && d.network.ip) || '--') + '</dd>' +
    '</dl>' +
    '<p class="hint" style="margin-top:16px">Part of the OpenWX family, alongside ' +
    'OpenWXSDR and OpenWXTTGO. Decoders derive from rs1729 and from the DFM work ' +
    'of dl9rdz; map tiles from OpenStreetMap. Released under GPL-3.0-or-later.</p>';

  openModal('about', icon('info') + ' About OpenWXDeck', body,
    '<button type="button" class="btn" data-close="1">Close</button>');
}

document.addEventListener('click', function (e) {
  var target = e.target;
  if (!target || !target.closest) { return; }

  var quick = target.closest('[data-quick]');
  if (quick) {
    e.preventDefault();
    var box = document.getElementById('tuneFreq');
    if (box) { box.value = quick.dataset.quick; }
    return;
  }

  if (target.closest('#tuneApply')) {
    e.preventDefault();
    var value = parseFloat((document.getElementById('tuneFreq') || {}).value);

    if (!Number.isFinite(value) || value < 400 || value > 406) {
      toast('Enter a frequency between 400 and 406 MHz', true);
      return;
    }

    var type = (document.getElementById('tuneType') || {}).value || '';
    tuneTo(value, type).then(function (d) { if (d.ok) { closeModal(); } });
    return;
  }

  if (target.closest('#tuneRelease')) {
    e.preventDefault();
    control('cmd=set_family&family=')
      .then(function () { return control('cmd=preset_mode'); })
      .then(function (d) {
        if (d.ok) { toast('Released, following the channel list'); closeModal(); }
      });
    return;
  }

  if (target.closest('#btnFreqRepo')) {
    e.preventDefault();
    openFreqRepo();
    return;
  }

  if (target.closest('#repoRefresh')) {
    e.preventDefault();
    openFreqRepo();
    return;
  }

  if (target.closest('#repoClear')) {
    e.preventDefault();
    repo = {};
    saveRepo();
    openFreqRepo();
    toast('Channel list cleared');
    return;
  }

  var row = target.closest('tr[data-mhz]');
  if (row) {
    e.preventDefault();

    // A row that knows which family was heard there pins it, so the radio
    // does not spend two turns in three listening for something else.
    var wanted = row.dataset.family || '';
    if (wanted && !config.decoders[wanted.toLowerCase()]) { wanted = ''; }

    tuneTo(parseFloat(row.dataset.mhz), wanted)
      .then(function (d) { if (d.ok) { closeModal(); } });
    return;
  }

  if (target.closest('#usePresets')) {
    e.preventDefault();
    control('cmd=preset_mode').then(function (d) {
      if (d.ok) { toast('Following the channel list'); closeModal(); }
    });
    return;
  }

  if (target.closest('#logToggle')) {
    e.preventDefault();
    control('cmd=toggle_log').then(function (d) { if (d.ok) { closeModal(); } });
    return;
  }

  var sorter = target.closest('[data-logsort]');
  if (sorter) {
    e.preventDefault();
    sortLogs(sorter.getAttribute('data-logsort'));
    return;
  }

  var logRow = target.closest('tr[data-log]');
  if (logRow) {
    e.preventDefault();
    openLogEntry(logRow.getAttribute('data-log'));
    return;
  }

  var fsOne = target.closest('[data-fs]');
  if (fsOne) {
    e.preventDefault();
    downloadFsFile(fsOne.getAttribute('data-fs'));
    return;
  }

  if (target.closest('#fsAll')) {
    e.preventDefault();
    downloadFsData();
    return;
  }

  var fsReplace = target.closest('[data-fsup]');
  if (fsReplace) {
    e.preventDefault();
    uploadFsFile(fsReplace.getAttribute('data-fsup'));
    return;
  }

  if (target.closest('#fsAdd')) {
    e.preventDefault();
    uploadFsFile(null);
    return;
  }

  var fromCard = target.closest('[data-track]');
  if (fromCard) {
    e.preventDefault();
    loadTrackFromCard(fromCard.getAttribute('data-track'));
    return;
  }

  if (target.closest('#logGpxBtn')) { e.preventDefault(); logGpx(); return; }
  if (target.closest('#logMapBtn')) { e.preventDefault(); logShowOnMap(); return; }
  if (target.closest('#logDlBtn')) { e.preventDefault(); logDownload(); return; }

  if (target.closest('#logClear')) {
    e.preventDefault();
    toast(clearLogTrack() ? 'Track removed from the map' : 'No log track on the map');
  }
});

/* ---------- the load chart's hover layer ---------- */

(function () {
  const canvas = document.getElementById('loadCanvas');
  if (!canvas) { return; }

  canvas.addEventListener('pointermove', moveLoadHover);
  canvas.addEventListener('pointerleave', leaveLoadHover);
  canvas.addEventListener('pointerdown', moveLoadHover);

  // The tile changes width when it spans both columns, and the canvas is sized
  // from its rendered width, so a resize has to redraw rather than stretch.
  window.addEventListener('resize', function () {
    if (tileMetric.load === 'graph') { drawLoad(); }
  });
})();

/* ---------- start ---------- */

loadTileMetric();
loadFramesToday();
loadOpts();
loadRepo();

// The station position, the tile server and the retention window all come
// from config.yaml, so the map is built after it has been read. loadConfig()
// resolves either way, so older firmware without /api/config still gets a map.
loadConfig()
  .then(function () {
    initMap();

    // What this page itself watched, before what the device remembers: the
    // device knows the last position, this knows how the sonde got there.
    restoreTracks();

    return seedStored();
  })
  .then(function () {
    refresh();
    setInterval(refresh, REFRESH_MS);
  });
