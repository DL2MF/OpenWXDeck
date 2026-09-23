# OpenWXDeck HTTP API

The receiver serves a small REST API on the port `webui.port` in `config.yaml`
(80 by default) whenever `webui.enabled` is true and Wi-Fi is up. The panel in
`data/` is written against it, and nothing in it is private to the panel: the
same calls work from `curl`, a script or another station.

The shapes follow OpenWXSDR's where the two products answer the same question,
so a consumer written for one mostly reads the other.

## Before anything else

**One request at a time.** This is an ESP32 with a radio to serve and a single
`WebServer`. It accepts one connection, answers it, and then looks at the next
one. A client that fires requests in parallel will have some of them refused;
a client that reads a large file should not also be polling on another
connection. The panel pauses its own polling while it reads a track for
exactly this reason.

**Nothing blocks for long.** No endpoint reads more than 64 kB of a file per
call, because anything longer stalls the decoder. Large files are read in
slices — see *Reading files* below.

**No credentials are ever served.** `config.yaml` holds the MQTT and SondeHub
passwords, so it is not readable over HTTP by any route: not as a static file,
not through `/api/fs/read`, not by a path that tries to walk up to it.
`/api/config` publishes only the parts a browser may see.

**All responses are `Cache-Control: no-store`.** Times are milliseconds unless
a field says otherwise; `_ms` is a duration, `utc` is Unix seconds from a GPS
clock, `null` means the receiver does not know rather than zero.

## Endpoints

| Method | Path | What it is |
| --- | --- | --- |
| GET | `/`, `/index.html` | the panel (LiveMap), or a built-in fallback page |
| GET | `/api/status` | everything the receiver is doing right now |
| GET | `/api/sondes` | the sonde being decoded, and the ones it remembers |
| GET | `/api/health` | one word per component |
| GET | `/api/config` | the settings a browser may see |
| POST | `/api/config` | change one of them, and write `config.yaml` |
| GET | `/api/spectrum` | the band scan, while a browser has asked for one |
| GET/POST | `/api/control` | do something: retune, toggle, reset |
| GET | `/api/logs` | the tracks on the SD card |
| GET | `/api/log` | a slice of one of them |
| GET | `/api/fs` | what is on the device's own filesystem |
| GET | `/api/fs/read` | a slice of one of those files |
| POST | `/api/fs/write` | put a data file on it |
| GET | *anything else* | served from LittleFS if it is there |

---

### GET /api/status

The snapshot the panel polls, rebuilt at most once a second. Every block is
always present; fields inside it are `null` when unknown.

```jsonc
{
  "version": "v1.0.2",
  "status": {                 // what the device's own status bar shows
    "gps": 11,                // satellites, 0 to 32 - a number, not a code
    "sonde": "OK",            // OK position, LH heard only, NO nothing
    "logging": "LOG",         // LOG writing, SD card ready, SD! no card
    "frequency": "L",         // L locked, SCAN sweeping, "" sitting on a channel
    "online": "Wifi"          // Wifi on a network, BT a phone on BLE, "" neither
  },
  "sonde": {
    "heard": true,          // a frame has arrived recently
    "type": "RS41",         // family, or the model when the decoder knows it
    "gps": true,            // the sonde's own position is usable
    "serial": "V1220868",
    "frame": 11116,
    "rssi_dbm": -106,
    "peak_rssi_dbm": -78,
    "last_seen_ms": 320,    // since the last valid frame
    "lat": 52.610830, "lon": 10.282830, "alt_m": 31234.5,
    "sats": 9,
    "vel_h": 9.2, "vel_v": -3.5, "heading": 107.0,
    "rx_mhz": 405.700,      // the channel THIS frame came in on
    "batt_v": 2.70,
    "temp_c": -51.2,        // only where the decoder measures one (DFM, M10)
    "utc": 1789500123       // the sonde's GPS clock, Unix seconds
  },
  "bluetooth": { "enabled": false, "active": false, "connected": false, "state": "off" },
  "uplink": {
    "mqtt": { "enabled": true, "connected": true, "published": 1483, "state": "connected" },
    "sondehub": { "active": true, "json_only": false, "sent": 96, "queued": 0, "state": "ready" }
  },
  "counters": { "valid": 1521, "gps": 1490, "rejected": 12, "peak_rssi_dbm": -78 },
  "local": { "fix": true, "chars": 90210, "sats": 11, "hdop": 1.1,
             "lat": 52.610830, "lon": 10.282830, "alt_m": 59.0 },
  "recovery": { "ready": true, "range_m": 46900.0, "bearing_deg": 107.0,
                "elevation_deg": 1.6, "line_m": 47000.0 },
  "battery": { "percent": 76, "voltage": 3.98, "external": false },
  "frequency": {
    "mhz": 405.700, "manual_mhz": 405.700,
    "country": "DE", "site_name": "Bergen", "site_code": "10238", "site": "Bergen",
    "source": "scan", "preset_mode": true, "preset_index": 2, "preset_count": 14,
    "family": "auto",      // the family pinned, or "auto"
    "profile": "RS41",     // the radio profile running now
    "hold_s": 240,         // left before the scan takes this channel back
    "hold_manual": false,  // whether that is the manual timeout
    "scan": false, "locked": true,
    "countries": ["DE", "UK"]
  },
  "logging": { "available": true, "enabled": true, "frames": 9153 },
  "system": { "cpu": 18, "ram": 71, "heap_free": 141000, "heap_size": 327680,
              "psram_free": 7900000, "psram_size": 8388608, "uptime_s": 3600 },
  "network": { "configured": true, "connected": true, "status": "connected",
               "ssid": "MGPG", "ip": "192.168.1.44" },
  "settings": { "screen_brightness": 80, "keyboard_brightness": 30,
                "touch_enabled": true, "auto_dim": true }
}
```

`status.frequency` is empty when the receiver is parked on a channel and
hearing nothing, which is what it does most of the time - there is no code for
it because it is not a fault. There is no recovery code either: `recovery`
below carries the range and bearing, which is the thing worth reading.

`sonde.heard` stays true after the radio has moved on, so `rx_mhz` — recorded
at decode time — is the only honest answer to "where was this sonde heard".
`frequency.mhz` is where the radio is **now**, which is not the same thing.

`system.cpu` is the main loop's duty, not an RTOS load: the share of wall time
it spends working rather than waiting. The firmware starts no tasks of its own,
so there is no idle task to measure against.

### GET /api/sondes

OpenWXSDR's shape. `sondes` holds at most one entry — a handheld has one
receiver — and `stored` is what the device keeps in its own filesystem, which
survives a reboot and needs no SD card.

```jsonc
{
  "sondes": [{
    "sonde_type": "RS41", "serial": "V1220868", "frame_number": 11116,
    "frequency": 405700000, "rssi": -106, "satellites": 9,
    "position": { "lat": 52.610830, "lon": 10.282830, "alt": 31234.5 },
    "velocity": { "horizontal": 9.2, "vertical": -3.5, "heading": 107.0 },
    "age_ms": 320
  }],
  "stored": [{
    "serial": "V1220868", "type": "RS41",
    "lat": 52.610830, "lon": 10.282830, "alt_m": 1263,
    "rx_mhz": 405.700, "vel_v": -6.1, "vel_h": 5.2,
    "utc": 1789500123, "frames": 9153,
    "age_ms": null          // null: it came back from the file, not from this run
  }]
}
```

Sixteen entries at most, three days at most; older ones are dropped by the
device. A stored entry is a **last known position**, not a track: the receiver
does not keep the path, only where the sonde ended up. The track is on the SD
card (`/api/logs`) when logging was on.

### GET /api/health

```json
{ "radio": "locked", "decoder": "decoding", "local_gps": "fix",
  "storage": "logging", "network": "connected", "webui_assets": "littlefs",
  "channel_list": "142 channels, 3 countries",
  "frames": { "valid": 1521, "gps": 1490, "rejected": 12, "radio_aborted": 3 } }
```

`radio` is `locked`, `scanning` or `searching`; `decoder` is `decoding` or
`idle`; `local_gps` is `fix`, `no fix` or `no data`; `storage` is `logging`,
`ready` or `unavailable`; `network` is `connected`, `connecting` or
`unconfigured`; `webui_assets` is `littlefs` or `built-in`. `channel_list` is
whatever `sondeqrg.txt` amounted to, or why it did not load.

### GET /api/config

The parts of `config.yaml` a browser may see. No credential, no URL that
carries one, and no path on the filesystem.

```jsonc
{
  "station": { "callsign": "DL2MF-8", "lat": 52.610830, "lon": 10.282830,
               "alt": 59.0, "receiver": "LilyGO T-Deck Plus / SX1262",
               "antenna": "1/4 wave UHF vertical" },
  "decoders": { "rs41": true, "rs92": false, "dfm": true, "m10": false,
                "m20": false, "dwell_ms": 1400 },
  "map": { "zoom": 11, "tile_server": "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
           "retention_s": 28800,   // webui.sonde_retention_time
           "stale_s": 1800,        // webui.sonde_stale_time
           "labels": true },       // webui.permanent_labels: the LiveMap's
                                   // default for naming every sonde on it
  "uploads": { "openwx_mqtt": false, "openwx_http": false,
               "sondehub": true, "import_api": false },
  "loaded": true                   // false when config.yaml was not found
}
```

### POST /api/config?key=&value=

Changes one setting and writes `config.yaml` immediately — a handheld loses
power without warning, and a setting that only lived in RAM would be a setting
the operator thinks they changed.

```
curl -X POST "http://192.168.1.44/api/config?key=webui.sonde_stale_time&value=900"
{"ok":true,"written":1}
```

Only these keys are editable; anything else is refused with 403:

```
station.callsign   station.lat   station.lon   station.alt
station.upload_position   station.receiver   station.antenna
bluetooth.enabled
decoders.rs41  decoders.rs92  decoders.dfm  decoders.m10  decoders.m20
decoders.dwell_ms   decoders.signal_lost_ms
decoders.max_idle_time   decoders.manual_idle_time
logging.level   logging.sd_enabled
webui.sonde_retention_time   webui.sonde_stale_time   webui.permanent_labels
webui.map.default_zoom
```

The Config screen on the device writes the same keys through the same
allow-list: the decoder switches, `decoders.dwell_ms` and
`webui.permanent_labels` are the rows on it.

Errors: `400 missing key`, `403 setting is not editable from the web`,
`400 value rejected`, `500 config.yaml could not be written`.

### GET /api/spectrum

The band scan. The bins are the bulk of it, so they are only built while a
browser has actually asked for a sweep (`/api/control?cmd=spectrum&on=1`);
otherwise this says `{"active":false}`.

```jsonc
{
  "active": true,
  "start_hz": 401000000, "stop_hz": 406000000, "step_hz": 50000,
  "floor_dbm": -127, "ceiling_dbm": -25,
  "sweeps": 4,
  "peak_bin": 54, "peak_dbm": -78, "peak_hz": 403700000,
  "noise_dbm": -118, "read_errors": 0,
  "bins": [-118, -117, -119]   // one dBm per step, start_hz upwards
}
```

Sweeping and receiving cannot share one radio: decoding is paused while a
sweep is running.

`start_hz`, `stop_hz` and `step_hz` describe the window actually being swept,
which is no longer always the whole band: the device's Spectrum page offers a
few windows and one that can be typed, and its Band sweep page takes whichever
was typed. The step follows the window so the same hundred bins always fill
it - a 1 MHz window is swept at 10 kHz. A browser asking for a sweep still
gets the whole band unless the device is already sweeping a narrower one.

### GET/POST /api/control?cmd=…

Queues a command for the main loop, which applies it on its next pass. The
answer says the command was accepted, not that it has been carried out yet;
read `/api/status` to see the result.

| `cmd` | extra | what it does |
| --- | --- | --- |
| `toggle_log` | | SD logging on/off |
| `toggle_scan` | | scanning on/off |
| `prev_freq`, `next_freq` | | step through the channel list |
| `toggle_source` | | preset list ↔ manual frequency |
| `preset_mode`, `manual_mode` | | pick one of those directly |
| `set_country` | `country=DE` | switch the channel list's country |
| `set_manual_freq` | `mhz=403.05` | tune, and leave the list |
| `set_family` | `family=RS41` | pin one family; empty releases it |
| `spectrum` | `on=1` / `on=0` | ask for a band scan, or give it back |
| `set_wifi` | `ssid=`, `pass=` | store Wi-Fi credentials |
| `cycle_screen`, `cycle_keyboard` | | brightness steps |
| `toggle_dim`, `toggle_touch` | | auto-dim, touch input |
| `reset_counters` | | frame counters back to zero |

```
curl "http://192.168.1.44/api/control?cmd=set_manual_freq&mhz=403.050"
{"ok":true}
```

An unknown command is `400 {"ok":false,"error":"unknown command"}`.

### GET /api/logs

What is on the SD card. A track is a directory under `/logs/sondes` with a
`track.csv` in it; the two rollups at the top of `/logs` are listed alongside.

```jsonc
{
  "root": "/logs/sondes",
  "files": [
    { "path": "/logs/sondes/V1220868/track.csv", "serial": "V1220868",
      "kind": "track", "bytes": 671744, "mtime": 1789500000 },
    { "path": "/logs/latest.csv", "serial": "latest.csv",
      "kind": "activity", "bytes": 4210, "mtime": 1789500100 }
  ],
  "count": 2,
  "card": true
}
```

`mtime` is a Unix time from the receiver's clock, which is set from whichever
GPS it has — its own or the last sonde's. It is 0 for a file written before
the receiver ever had a clock; the frames themselves carry GPS time, so a
reader can date such a file from its contents.

### GET /api/log?path=…&offset=…&len=…

One slice of a track. See *Reading files*.

### GET /api/fs

The device's own filesystem (LittleFS), which on a handheld with no SD card is
where the only record of what it heard lives.

```jsonc
{
  "mounted": true,
  "bytes": 1441792, "used": 196608,
  "files": [
    { "path": "/lastsondes.txt", "bytes": 1180, "data": true },
    { "path": "/livemap.js", "bytes": 121659, "data": false }
  ],
  "count": 2
}
```

`data` is false for the panel's own files — the ones already in the
repository — and true for what the receiver wrote. `config.yaml` is not
listed and cannot be read. The panel shows only the `data` ones; a consumer
that wants the whole picture has it here.

### GET /api/fs/read?path=…&offset=…&len=…

One slice of one of those files. Same rules as `/api/log`.

### POST /api/fs/write?path=…

Puts one file on the filesystem. `multipart/form-data`, one file part; the
path comes from the query string, or from the uploaded file's own name when
there is none.

```
curl -F "file=@sondeqrg.txt"      "http://192.168.1.44/api/fs/write?path=/sondeqrg.txt"
{"ok":true,"path":"/sondeqrg.txt","bytes":4820}
```

Only data files: `.txt`, `.csv`, `.json`, `.gpx`, `.png`, `.jpg`, `.bmp`,
`.ico`. Anything else is refused with 400 — `.js`, `.html` and `.css` are the
panel itself, and letting a stranger on the same Wi-Fi replace the interface
is not a feature; that is what `pio run -t uploadfs` is for. `config.yaml`
cannot be written by this route either.

The bytes go to `<path>.part` first and are moved into place only once the
whole upload has arrived, so an upload that dies halfway leaves the device
with the file it had. Errors come back as
`{"ok":false,"path":…,"bytes":…,"error":"…"}` with 400: a name the device will
not take, a filesystem that is full, or an upload that stopped early.

Replacing `/sondeqrg.txt` is the useful case — the channel list is read at
boot, so the device takes the new one on its next restart.

---

## Reading files

`/api/log` and `/api/fs/read` both answer with a slice and say how big the
whole file is, so a client can ask for the rest and show progress:

```
GET /api/log?path=/logs/sondes/V1220868/track.csv&offset=0&len=65536

200 OK
X-Log-Size: 671744        # the whole file
X-Log-Offset: 0           # where this slice starts
X-File-Name: track.csv
Content-Length: 65536
```

- `len` is capped at 65536 and defaults to it.
- `offset` past the end returns an empty body; a short body means the end of
  the file, whatever `X-Log-Size` said.
- The file stays open between consecutive slices of the same path, and closes
  on the last slice or after 30 seconds without one.
- A slice can fail — a card read, or a connection the server could not take —
  and the right answer is to ask for the same offset again rather than start
  over. The panel tries four times with a growing pause.

A 700 kB track is eleven requests. Reading one is a second or two, during
which the receiver keeps decoding.

```bash
# the whole track, in slices, to a file
serial=V1220868; path=/logs/sondes/$serial/track.csv; off=0
while :; do
  sz=$(curl -sD - "http://192.168.1.44/api/log?path=$path&offset=$off&len=65536" \
       -o /tmp/part | awk '/X-Log-Size/{print $2+0}')
  cat /tmp/part >> $serial.csv
  off=$((off + $(stat -c%s /tmp/part)))
  [ "$(stat -c%s /tmp/part)" -eq 0 ] && break
  [ "$off" -ge "$sz" ] && break
done
```

## What the files hold

**`/logs/sondes/<serial>/track.csv`** — one line per decoded frame. The header
names every column; new columns are appended at the end, so a reader that goes
by position keeps working:

```
timestamp_ms,serial,frame,rssi_dbm,sonde_gps_valid,sonde_lat,sonde_lon,
sonde_alt_m,sonde_hspeed_mps,sonde_vspeed_mps,sonde_heading_deg,sonde_sats,
pdop,gps_week,gps_tow_ms,local_fix,local_lat,local_lon,local_alt_m,local_sats,
range_m,bearing_deg,elevation_deg,straight_line_m,relative_alt_m,
battery_percent,battery_voltage,sonde_type,rx_freq_hz,sonde_temp_c
```

`timestamp_ms` is the receiver's uptime, not a wall clock. Real time comes
from `gps_week` and `gps_tow_ms`: `1980-01-06 + week × 604800 + tow ÷ 1000 −
18 s` is UTC.

**`/logs/sondes/<serial>/summary.txt`**, **`/logs/last_seen.txt`** — `key=value`
lines: serial, type, channel, position, navigation, battery, frame counts.

**`/logs/index.csv`** — one line each time a sonde was first heard:
`timestamp_ms,"seen",serial,track_path,summary_path,rx_freq_hz`.

**`/logs/latest.csv`** — the current sonde's frames in the `track.csv` format.
It starts again when a new sonde takes over.

**`/lastsondes.txt`** (LittleFS) — the last sixteen sondes and where each was
last heard, in the format OpenWXTTGO uses, so the two stations' files can be
read by the same tools.

## Uploads the device makes

Not part of this API, but the same data leaves by two other routes when
`config.yaml` switches them on:

- **SondeHub v2** — `PUT https://api.v2.sondehub.org/sondes/telemetry` in
  batches, and a listener record on `/listeners`. `sondehub.enabled: json`
  writes exactly those payloads to `/sondehub/<serial>.json` on the SD card
  and uploads nothing.
- **MQTT** — `<prefix>/<callsign>/status` and `<prefix>/<callsign>/data`, with
  TLS when the broker wants it.

## Requests the device and the panel make

Both ask the same predictor, so the Map page and the LiveMap agree on where a
sonde is coming down:

- **Tawhiri** (CUSF, hosted by SondeHub) — `GET
  https://api.v2.sondehub.org/tawhiri?profile=standard_profile&pred_type=single
  &launch_latitude=&launch_longitude=&launch_altitude=&launch_datetime=
  &ascent_rate=5&burst_altitude=<launch_altitude+1>&descent_rate=<m/s>`.
  A burst one metre above the sonde makes the ascent a single step, so the
  answer is the descent from where the sonde is now. Longitudes go east,
  0 to 360. The device asks for `&format=csv` and keeps only the last line -
  the landing point - while the panel takes the JSON and draws the whole path.
  Asked only for a sonde that is falling: below 5000 m on the LiveMap, and the
  device's Map page draws the point once the sonde is under 2000 m.
- **SondeHub predictions** — `GET https://api.v2.sondehub.org/predictions
  ?vehicles=<serial>`, which is what the device uses while a sonde is still
  climbing or too high for a descent prediction to stay put.

## Versioning

There is no version negotiation. Fields are added, not renamed or removed; a
consumer should ignore what it does not know and treat a missing field as
"this firmware does not report it". `version` in `/api/status` is the firmware
build.
