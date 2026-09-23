/* OpenWXDeck dashboard.
 *
 * Reads the cached device snapshot from /api/status once per second and posts
 * control commands to /api/control. The device rebuilds that snapshot at most
 * once per second and serves the web page in short non-blocking slices, so
 * polling faster gains nothing and costs decoded frames.
 */

'use strict';

var REFRESH_MS = 1000;
var feedbackTimer = null;
var lastData = null;

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

function age(ms) {
  if (!Number.isFinite(ms)) { return '--'; }
  if (ms < 1000) { return 'just now'; }
  if (ms < 60000) { return Math.round(ms / 1000) + ' s ago'; }
  return Math.round(ms / 60000) + ' min ago';
}

function row(label, value) {
  return '<div class="info-row"><div class="info-label">' + esc(label) +
         '</div><div class="info-value">' + (value == null ? '--' : value) + '</div></div>';
}

function configItem(label, value) {
  return '<div class="config-item"><div class="config-label">' + esc(label) +
         '</div><div class="config-value">' + (value == null ? '--' : value) + '</div></div>';
}

function badgeClass(type) {
  var known = ['rs41', 'rs92', 'dfm', 'm10', 'm20'];
  var key = String(type || '').toLowerCase();
  return known.indexOf(key) >= 0 ? 'badge-' + key : 'badge-none';
}

function mapsUrl(lat, lon) {
  return 'https://www.google.com/maps/search/?api=1&query=' + lat + ',' + lon;
}

/* ---------- commands ---------- */

function showFeedback(message, state) {
  var el = document.getElementById('feedback');
  if (!el) { return; }
  el.textContent = message;
  el.className = 'feedback show ' + (state || 'ok');
  if (feedbackTimer) { clearTimeout(feedbackTimer); }
  feedbackTimer = setTimeout(function () { el.className = 'feedback'; }, 2400);
}

function commandLabel(cmd) {
  return String(cmd || 'command').split('_').join(' ');
}

function ctrl(cmd, params, element) {
  if (element && element.classList) { element.classList.add('pressed'); }
  showFeedback('Sending: ' + commandLabel(cmd), 'warn');

  var query = new URLSearchParams(Object.assign({ cmd: cmd }, params || {}));

  fetch('/api/control?' + query.toString(), { method: 'POST', cache: 'no-store' })
    .then(function (response) {
      showFeedback((response.ok ? 'Sent: ' : 'Failed: ') + commandLabel(cmd),
                   response.ok ? 'ok' : 'bad');
    })
    .catch(function () { showFeedback('Failed: ' + commandLabel(cmd), 'bad'); })
    .then(function () {
      if (element && element.classList) {
        setTimeout(function () { element.classList.remove('pressed'); }, 400);
      }
      setTimeout(refresh, 200);
    });
}

function toggleAbout() {
  var card = document.getElementById('aboutCard');
  card.style.display = card.style.display === 'none' ? 'block' : 'none';
  if (card.style.display === 'block') { loadHealth(); }
}

window.ctrl = ctrl;
window.toggleAbout = toggleAbout;
window.refresh = refresh;

/* ---------- rendering ---------- */

function renderHeader(d) {
  document.getElementById('version').textContent = d.version || '--';
  document.getElementById('ipAddress').textContent = d.network.ip || d.network.status || '--';
  document.getElementById('aboutVersion').textContent = d.version || '--';
  document.getElementById('aboutDecoders').textContent = d.sonde.type && d.sonde.heard
    ? d.sonde.type : 'RS41';
}

function renderStats(d) {
  document.getElementById('statSonde').textContent =
    d.sonde.heard ? (d.sonde.serial || d.sonde.type) : '–';
  // Decoder totals, not the SD logger's count: that one is zero without a card.
  document.getElementById('statFrames').textContent =
    d.counters ? d.counters.valid : 0;
  document.getElementById('statRange').textContent =
    d.recovery.ready ? distance(d.recovery.range_m) : '–';
  document.getElementById('statBattery').textContent = d.battery.percent + ' %';
}

function renderReceiver(d) {
  var card = document.getElementById('receiverCard');
  var badge = document.getElementById('receiverStatus');

  if (d.sonde.heard) {
    card.className = 'receiver-card decoding';
    badge.className = 'receiver-status status-decoding';
    badge.textContent = 'DECODING';
  } else if (d.frequency.scan) {
    card.className = 'receiver-card';
    badge.className = 'receiver-status status-scanning';
    badge.textContent = 'SCANNING';
  } else {
    card.className = 'receiver-card idle';
    badge.className = 'receiver-status status-idle';
    badge.textContent = 'WAITING';
  }

  document.getElementById('receiverRows').innerHTML =
    row('Frequency', num(d.frequency.mhz, 3, ' MHz')) +
    row('Site', esc((d.frequency.country || '') + ' ' + (d.frequency.site || '--'))) +
    row('Sonde', d.sonde.heard ? esc(d.sonde.serial) : '–') +
    row('Type', d.sonde.heard ? esc(d.sonde.type) : '–') +
    row('RSSI', d.sonde.heard ? d.sonde.rssi_dbm + ' dBm (peak ' + d.sonde.peak_rssi_dbm + ')' : '–') +
    row('Local GPS', d.local.fix
      ? num(d.local.lat, 5) + ', ' + num(d.local.lon, 5) + '  ' + d.local.sats + ' sats'
      : 'no fix');

  var scanButton = document.getElementById('scanButton');
  scanButton.textContent = 'Scan: ' + (d.frequency.scan ? 'ON' : 'OFF');
  scanButton.classList.toggle('btn-primary-action', !!d.frequency.scan);

  document.getElementById('sourceButton').textContent = 'Mode: ' + esc(d.frequency.source);

  var manual = document.getElementById('manualMHz');
  if (document.activeElement !== manual) {
    manual.value = num(d.frequency.manual_mhz, 1);
  }

  // Show the SSID the device is actually configured for, unless it is being
  // edited right now.
  var ssid = document.getElementById('wifiSsid');
  if (document.activeElement !== ssid) { ssid.value = d.network.ssid || ''; }

  var select = document.getElementById('countrySelect');
  var wanted = (d.frequency.countries || []).join(',');
  if (select.dataset.countries !== wanted) {
    select.dataset.countries = wanted;
    select.innerHTML = (d.frequency.countries || []).map(function (code) {
      return '<option value="' + esc(code) + '">' + esc(code) + '</option>';
    }).join('');
  }
  if (document.activeElement !== select) { select.value = d.frequency.country; }
}

function renderConfig(d) {
  document.getElementById('configGrid').innerHTML =
    configItem('Country', esc(d.frequency.country)) +
    configItem('Source mode', esc(d.frequency.source)) +
    configItem('Preset', d.frequency.preset_mode
      ? (d.frequency.preset_index + 1) + ' / ' + d.frequency.preset_count
      : 'manual') +
    configItem('Scan', d.frequency.scan ? 'on' : 'off') +
    configItem('Logging', d.logging.enabled
      ? 'enabled'
      : (d.logging.available ? 'off' : 'no card')) +
    configItem('Wi-Fi', esc(d.network.status));

  document.getElementById('deviceControls').innerHTML =
    '<button class="btn-action" type="button" onclick="ctrl(\'toggle_log\',{},this)">SD logging ' +
      (d.logging.enabled ? 'ON' : 'OFF') + '</button>' +
    '<button class="btn-action" type="button" onclick="ctrl(\'cycle_screen\',{},this)">Screen ' +
      d.settings.screen_brightness + '%</button>' +
    '<button class="btn-action" type="button" onclick="ctrl(\'cycle_keyboard\',{},this)">Keys ' +
      d.settings.keyboard_brightness + '%</button>' +
    '<button class="btn-action" type="button" onclick="ctrl(\'toggle_touch\',{},this)">Touch ' +
      (d.settings.touch_enabled ? 'ON' : 'OFF') + '</button>' +
    '<button class="btn-action" type="button" onclick="ctrl(\'toggle_dim\',{},this)">Auto dim ' +
      (d.settings.auto_dim ? 'ON' : 'OFF') + '</button>' +
    '<button class="btn-action" type="button" onclick="ctrl(\'reset_counters\',{},this)">Reset counters</button>';
}

function renderSondes(d) {
  var body = document.getElementById('sondesBody');

  if (!d.sonde.heard) {
    body.innerHTML =
      '<tr><td colspan="10"><div class="empty-note">' +
      '<svg class="i" viewBox="0 0 16 16"><path d="M11.7 10.3a6 6 0 1 0-1.4 1.4l3.8 3.8 1.4-1.4-3.8-3.8ZM6.5 11a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9Z"/></svg>' +
      'No radiosonde decoded yet</div></td></tr>';
    return;
  }

  var s = d.sonde;
  body.innerHTML =
    '<tr>' +
    '<td class="serial">' + esc(s.serial) + '</td>' +
    '<td><span class="badge-sonde-type ' + badgeClass(s.type) + '">' + esc(s.type) + '</span></td>' +
    '<td>' + num(d.frequency.mhz, 3, ' MHz') + '</td>' +
    '<td>' + (s.gps ? num(s.alt_m, 0, ' m') : '--') + '</td>' +
    '<td>' + (s.gps ? num(s.lat, 4) + ', ' + num(s.lon, 4) : '--') + '</td>' +
    '<td>' + (d.recovery.ready ? distance(d.recovery.range_m) : '--') + '</td>' +
    '<td>' + (d.recovery.ready ? num(d.recovery.bearing_deg, 0, '°') : '--') + '</td>' +
    '<td>' + s.frame + '</td>' +
    '<td>' + age(s.last_seen_ms) + '</td>' +
    '<td>' + (s.gps
      ? '<a class="btn-action" style="padding:6px 12px;font-size:13px" target="_blank" rel="noopener" href="' +
        mapsUrl(s.lat, s.lon) + '">Maps</a>'
      : '') + '</td>' +
    '</tr>';
}

function loadHealth() {
  fetch('/api/health', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (h) {
      document.getElementById('aboutAssets').textContent = h.webui_assets || '--';
      document.getElementById('aboutChannels').textContent = h.channel_list || '--';
    })
    .catch(function () {});
}

function showDisconnected() {
  var badge = document.getElementById('receiverStatus');
  badge.className = 'receiver-status status-idle';
  badge.textContent = 'NO LINK';
  document.getElementById('updateTime').textContent = 'Waiting for OpenWXDeck...';
}

function refresh() {
  fetch('/api/status', { cache: 'no-store' })
    .then(function (response) { return response.json(); })
    .then(function (d) {
      lastData = d;
      renderHeader(d);
      renderStats(d);
      renderReceiver(d);
      renderConfig(d);
      renderSondes(d);
      document.getElementById('updateTime').textContent =
        'Last updated: ' + new Date().toLocaleTimeString();
    })
    .catch(showDisconnected);
}

refresh();
loadHealth();
setInterval(refresh, REFRESH_MS);
