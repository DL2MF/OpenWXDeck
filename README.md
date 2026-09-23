# <h1 align="center">OpenWX ((•)) Deck</h1>

![](https://img.shields.io/badge/OpenWX-((%E2%80%A2))_Deck-4AA6FF?style=for-the-badge&labelColor=0D1117)

**OpenWX <img src="https://cdn.jsdelivr.net/npm/bootstrap-icons/icons/broadcast.svg" height="22"> Deck** is handheld weather-radiosonde receiver firmware for the
**LilyGO T-Deck Plus**. It uses the onboard **SX1262** radio to receive radiosonde
frames, decodes telemetry on-device, shows recovery and navigation information on the
TFT, logs to microSD, and serves a phone-friendly web panel over Wi-Fi.


<img width="325" height="246" alt="Screenshot 2026-09-22 203002" src="https://github.com/user-attachments/assets/14f1dc5a-aa8e-422a-8a9c-2303e9efff87" />

<img width="325" height="246" alt="grafik" src="https://github.com/user-attachments/assets/969cc73b-ad3d-4b27-be5a-e14527215637" />

<img width="330" height="252" alt="Screenshot 2026-09-21 054835" src="https://github.com/user-attachments/assets/469667f0-ce46-4aa9-a2c3-019e754b0e1b" />

<img width="329" height="248" alt="grafik" src="https://github.com/user-attachments/assets/1bf84436-097d-46f5-8608-d85fe20b6abd" />

<img width="330" height="248" alt="Screenshot 2026-09-22 143357" src="https://github.com/user-attachments/assets/41802b22-87e2-44be-b1c0-e82e3fdf4d69" />

<img width="327" height="248" alt="Screenshot 2026-09-20 131117" src="https://github.com/user-attachments/assets/a41f1f39-4bbf-46de-a6ce-cd980cc4e2c1" />

<img width="325" height="245" alt="grafik" src="https://github.com/user-attachments/assets/be895415-00b5-4302-948e-3d5819d88245" />

<img width="325" height="243" alt="grafik" src="https://github.com/user-attachments/assets/de954f3f-1d3d-4fc5-a787-7eb1e7c75a99" />

<img width="331" height="246" alt="grafik" src="https://github.com/user-attachments/assets/13baa87c-af4b-4a26-a048-43132f93b09d" />


##
OpenWX <img src="https://cdn.jsdelivr.net/npm/bootstrap-icons/icons/broadcast.svg" height="20"> Deck is the handheld member of the **OpenWX** family (alongside
[OpenWXSDR](https://github.com/DL2MF/OpenWXSDR), [OpenWXTTGO](https://github.com/DL2MF/OpenWXTTGO), [OpenWX Fleet-Monitor](https://github.com/DL2MF/OpenWX-Fleet-Monitor) and the [OpenWX MQTT](http://mqtt.openwx.de/) frontend.

- **Version:** v1.0.6 (`src/config/version.h`)
- **Licence:** GPL-3.0-or-later
- **Architecture notes:** [`ARCHITECTURE.md`](ARCHITECTURE.md)
- **Third-party components:** [`THIRD_PARTY.md`](THIRD_PARTY.md)

---

## Hardware

| Component | Part |
|---|---|
| Board | LilyGO T-Deck Plus |
| MCU | ESP32-S3, 16 MB flash, 8 MB OPI PSRAM |
| Radio | Semtech SX1262 (400–406 MHz used here) |
| Display | ST7789 320×240 TFT |
| Touch | GT911 capacitive |
| Input | I2C QWERTY keyboard, trackball |
| GNSS | u-blox MIA-M10Q, 38400 baud, ESP RX = GPIO44, ESP TX = GPIO43 |
| Storage | optional microSD |

All GPIO assignments live in `src/board_pins.h`.

## Supported radiosondes

**Currently decoded**

- Vaisala RS41 / RS41-SG
- Graw DFM06 / DFM09 / DFM17
- Meteomodem M10 and M20
- Vaisala RS92

Not planned: LMS6, iMet, MRZ.

All decoders are based on the reliable OpenWXTTGO / rdzTTGO / rs1729 decoders for ESP32 platforms.

## Features

**Receive and decode**

- SX1262 GFSK receive at 4800 bps with the RS41 sync word, long-packet FIFO draining for
  the full 320-byte frame
- Dewhitening, two-codeword Reed–Solomon correction, per-block CRC-16
- ECEF → WGS-84 position, ground speed, heading and vertical rate
- Stale-fix rejection: a position is only shown when the GPS3 block CRC is valid and at
  least 4 satellites are in the solved fix

**Tuning**

- Country-aware launch-site channels, read from `sondeqrg.txt` on the filesystem
- Two source modes: **Preset** (steps/scans the selected country only) and
  **Set Freq** (manual, 400.0–406.0 MHz in 0.1 MHz steps)
- Scanning with a 2.5 s dwell, automatically suspended while a sonde is locked
- Best-RSSI tracking across the scan
- Country, source mode and manual frequency persist in flash

**Recovery**

- Range, bearing and elevation from the local GPS to the sonde, on the same page as
  the own-position fix
- Spectrum page: 401.000-406.000 MHz band scan in 50 kHz steps, with the vertical
  scale following the measured noise floor so noise and signal are both visible
- Read-only SondeHub landing-prediction lookup by serial

**Offline Maps**

<img width="315" height="236" alt="grafik" src="https://github.com/user-attachments/assets/8ca4c253-a205-4415-b10a-c877650c1dcc" />

- On device offline Maps for the sonde position
- With mobile hotspot Tawhiri predictions are supported
- Up to 17 zoom levels supported (use MapTiler for offline map generation of your area)
- T-Deck supporting up to 64GB microSD cards (exFAT formatted required)

**Device**

- OpenWXDeck support several screen templates and layouts, including a tactical view
- Two menu screens, 16 pages behind a 4×2 Home grid, touch or keyboard driven
- microSD logging of tracks, per-sonde summaries and a last-seen record
- Wi-Fi with credentials editable on-device
- Battery percentage, screen/keyboard brightness, auto-dim, touch enable

**Bluetooth BLE support**

- Full compatibility with MySondy BT protocol 4.1 supporting these mobile device apps:
  - [MySondyGo 3.x, 4.x](https://mysondy.altervista.org/mysondygo.php) - Mirko Dalmonte, IZ4PNN
  - [TrovaLaSonda 2.0.0.68](https://play.google.com/store/apps/details?id=eu.ydiaeresis.trovalasonda&hl=de) -  Maurizio Butti
  - [Hunter Tracker](https://huntertracker.eu/in3isu/) - Giovanni, IN3ISU

You can use each of these apps with this firmware, simply enable BT BLE on the device.

**Gateway Web panel**

- OpenWXDeck provides an integrated, fully featured web panel with controls if you want to operate a T-Deck at home or remote

<img width="1458" height="890" alt="grafik" src="https://github.com/user-attachments/assets/fcd2e53b-e52c-4283-b51b-1684deec9e89" />

- Providing a dedicated dashboard view, livemap and screen mirroring of the T-Deck live screen

- <img width="1230" height="1099" alt="grafik" src="https://github.com/user-attachments/assets/1b6ad601-6816-4837-bde3-3239fb383b91" />

- Configuration settings, decoder options, device settings like display brightness, timeout and much more are available
- An integrated filemanager handles up and download of frequency list, temporary logfiles and lastheard sondes also withour an SDcard


## Building

Install [PlatformIO](https://platformio.org/), then from the project root:

```powershell
pio run                 # build firmware
pio run -t upload       # flash the T-Deck Plus
pio run -t uploadfs     # flash the web interface from data/
pio device monitor -b 115200
```

`uploadfs` writes the LittleFS image holding the web interface
(`index.html`, `style.css`, `openwx.js`, `livemap.html`, `livemap.css`, `livemap.js`)
and `sondeqrg.txt`. It is only needed when those files change — UI edits never require a
firmware rebuild. If the filesystem was never flashed, the device serves a compact
built-in status page instead, so the panel still works.

Clean rebuild:

```powershell
pio run -t clean
pio run
```

There is one environment (`T-Deck`) using a custom board definition in
`boards/T-Deck.json` (16 MB flash, OPI PSRAM, 240 MHz). `TFT_eSPI`, `TinyGPSPlus` and the
RS41 FEC code are vendored under `lib/`; the Semtech `sx126x_driver` and `SensorLib` are
pulled by PlatformIO.

> `lib/TFT_eSPI/User_Setup_Select.h` is modified to select
> `Setup210_LilyGo_T_Deck.h`. Do not replace the vendored TFT_eSPI with a registry
> version without re-applying that selection.

### Configuration


### Station settings

Everything about the station lives in `data/config.yaml` on the device
filesystem, using the same section names as OpenWXSDR: `station`, `telemetry`,
`decoders`, `logging`, `webui`, `openwx`, `sondehub`, `import_api`. Changing it
needs `pio run -t uploadfs` and no firmware rebuild.

It holds MQTT and SondeHub credentials, copy `data/config.yaml.example` 
to `data/config.yaml` and fill it in. 

For the same reason the web server refuses to serve it: the panel reads the harmless subset
from `/api/config`, and writes back one setting at a time through
`POST /api/config` — an allow-list that covers the station identity, the
enabled sonde families and the map defaults, and no credential.

The Configuration dialogue on the LiveMap (System &rarr; Configuration) edits
the same file; a save rewrites one line and leaves the comments, ordering and
indentation alone, so the file stays yours to hand-edit.

### Channel list

Launch-site presets are **not compiled in**. They live in `data/sondeqrg.txt` on the
device filesystem, so changing them needs `pio run -t uploadfs` and no firmware rebuild:

```text
# country  frequency(MHz)  site-code  site name
DE   405.700   10238   Bergen
DE   403.330   -       TrUebPl 2
FR   404.000   07110   Brest
```

The site code is the WMO station number, or `-` for sites without one — those display as
the site name alone. The site name is the rest of the line, so spaces are fine. Group by
country and sort by frequency inside each country: stepping (`Z`/`X`) and scanning (`S`)
follow file order. Up to 64 channels and 12 countries.

If `sondeqrg.txt` is missing the device has no presets and stays in manual (Set Freq)
mode; `/api/health` reports what was loaded. Defaults at first boot: country `DE`,
405.700 MHz, Preset mode.

## Controls

**Pages**

```text
Space  Scan         L   Logfile        H      Home
D   Decoder         C   Config         I      Help -> Icons -> About -> close
S   Spectrum        Q   Channel        , .    Previous / next page or Home tile
G   GPS             U   Upload         Enter  Open selected Home tile
```

Home tile carries an icon, a label and its shortcut key with a status bar down its left edge
— green, amber or red where the page has a state, chrome blue where it does not. 
The Scan tile shows the tuned frequency in place of its shortcut key.

**Frequency**

```text
Z / X   Previous / next preset, or manual 0.1 MHz step
F       Scan on/off
V       Toggle Preset / Set Freq
Y       Cycle country
```

**Wi-Fi editing** (Upload page)

```text
N   Edit SSID       Enter / trackball  Save
W   Edit password   Backspace          Delete
                    Space              Cycle ABC / 123 / SYM
```

In `123` mode `W E R` → `1 2 3`, `S D F` → `4 5 6`, `Z X C` → `7 8 9`, and `Q`/`P` act as
`0` (the printed `0`/mic key does not report through the keyboard MCU on some units).
In `SYM` mode `Q T Y U I O P` → `# ( ) - ' " @`, `A G H J K` → `* / _ ; :`,
`V B N M` → `? ! , $`.


## Web Mode

Web Mode uses **Wi-Fi STA only** — OpenWXDeck joins an existing network (for example a
phone hotspot) and you open its IP address. It does not create an access point and does
not scan for networks.

Routes:

```text
GET  /                    dashboard (data/index.html from LittleFS)
GET  /livemap.html        map view
GET  /api/status          cached device status (rebuilt at most once per second),
                          including decoder frame counters and sonde velocities
GET  /api/sondes          currently received sondes, OpenWXSDR shape
GET  /api/health          radio / decoder / GPS / storage / network state
GET  /api/control?cmd=…   queue a control command
POST /api/control?cmd=…
```

`/api/sondes` and `/api/health` follow the OpenWXSDR REST surface so the same consumers
can read a handheld and a Pi station.

The panel follows the OpenWXSDR dashboard: indigo/purple gradient, white cards, stat
tiles, a receiver panel with a status badge and manual tune, configuration cards with
accent bars, and a decoded-radiosonde table. It is self-contained — no CDN — so it works
on a hotspot with no internet.

**Map View** (`livemap.html`) opens an OpenWXSDR-style map page: Leaflet map on the left,
a sidebar with System Statistics (active sondes, session frames, frequency, RSSI), the
sonde cards and System Health on the right. A card stays green while the sonde is being
received and for two minutes after its last frame; older ones drop into *Recently
received*. Both the flight track and the sonde list are built in the browser from what
the device reports, so they start fresh on reload. A map needs tiles, so this one page loads Leaflet from a CDN and falls back to
a notice when there is no internet; the sidebar keeps working from the device either way.

It shows sonde type and serial, frame number, RSSI and peak RSSI, sonde and local
position, range/bearing/elevation, frequency, country and site, scan and logging state,
battery and Wi-Fi status — and can change country, source mode, frequency, scan, SD
logging, brightness, touch, auto-dim, counters and Wi-Fi credentials.

Radio capture keeps priority: the web server is handled in short non-blocking calls and
the page reads a cached snapshot.

## SD card logging

With a card present, logging can be toggled with `L`, from the Logging page, or from the
web panel:

```text
/logs/index.csv              one row per sonde seen
/logs/latest.csv             most recent track
/logs/last_seen.txt          last-seen record
/logs/sondes/<serial>/       per-sonde track and summary
```

Without a SDcard, OpenWXDeck runs normally with logging disabled.

## Known limitations

- Predictions are read-only and require internet access to SondeHub
- **MQTT telemetry upload to OpenWX only yet** — MQTT upload to OpenWX 
- **No sondehub upload yet** — SondeHub upload are planned, data verification is pending
- No RTC/NTP: logs carry uptime, not UTC
y may not report through the keyboard library

## Roadmap

1. Verify decoders: RS41, DFM, M10, M20, RS92 upload by Sondehub
2. Telemetry upload to SondeHub
3. Enhanced use of the ESP32-S3: dual-core radio/UI split, interrupt-driven sync
   detection, PSRAM buffers

## Safety and legal notes

Only receive signals you are legally allowed to receive in your location.

Radiosonde recovery may involve access restrictions, private land, roads, weather,
water, cliffs, trees, livestock and other hazards. Follow local law and obtain
permission where required.

## Credits and licence

OpenWX <img src="https://cdn.jsdelivr.net/npm/bootstrap-icons/icons/broadcast.svg" height="20"> Deck builds on the radiosonde decoding work of:

[rs1729/RS](https://github.com/rs1729/RS)

[DL9RDZ/rdz_ttgo_sonde](https://github.com/dl9rdz/rdz_ttgo_sonde)

[DL2MF/OpenWXTTGO](https://github.com/DL2MF/OpenWXTTGO)

[A-DECK SondeDeck](https://github.com/aarondrew313/SondeDeck)

with Reed–Solomon and geodesy from Christian Rabler's dxlAPRS. `THIRD_PARTY.md`
has the details and the licences.

<img width="330" height="246" alt="grafik" src="https://github.com/user-attachments/assets/ac673672-4013-45d3-8642-3b57c979d85e" />


OpenWXDeck is not affiliated with or endorsed by SondeHub.

Released under the GNU General Public License v3.0 or later — see [`LICENSE`](LICENSE)
and [`THIRD_PARTY.md`](THIRD_PARTY.md).

