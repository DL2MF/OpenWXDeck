# OpenWXDeck — user manual

For the LilyGO T-Deck Plus, firmware v1.0.6.

A handheld that listens for radiosondes, decodes them, shows you where they
are, records them, uploads them, and helps you walk up to the one that has
landed.

---

## Contents

1. [Before you start](#1-before-you-start)
2. [First run](#2-first-run)
3. [The screen](#3-the-screen)
4. [The keyboard](#4-the-keyboard)
5. [The pages](#5-the-pages)
6. [The receiver views](#6-the-receiver-views)
7. [Hunting a sonde](#7-hunting-a-sonde)
8. [The web panel](#8-the-web-panel)
9. [Sound](#9-sound)
10. [The SD card](#10-the-sd-card)
11. [Uploading](#11-uploading)
12. [Every setting](#12-every-setting)
13. [When something is wrong](#13-when-something-is-wrong)

---

## 1. Before you start

**The antenna matters more than anything else in this manual.** The stock whip
will hear a sonde overhead. A quarter-wave ground plane cut for 403 MHz, or a
small yagi, is the difference between hearing a sonde at 200 km and hearing it
at 20.

**A microSD card is optional but wanted.** Without one the device still
receives, decodes and uploads; it just cannot log, and the map has no tiles.
Format it FAT32.

**Legality.** Receiving is legal nearly everywhere. Picking up a sonde you have
found is usually fine too — they are not expected back — but that is your local
question, not this manual's.

### Flashing

```bash
cp data/config.yaml.example data/config.yaml     # then edit it
cp src/config/wifi_secrets.example.h src/config/wifi_secrets.h
pio run -t upload
pio run -t uploadfs      # the web pages and config.yaml — don't skip this
```

`uploadfs` is a separate step and is easy to forget. Without it there is no web
panel, no channel list and no configuration.

If the board refuses to be flashed: close every serial monitor, then hold the
trackball down while switching it on to force the download mode.

### The minimum you must set

In `data/config.yaml`:

```yaml
station:
  callsign: DL2MF            # yours
  lat: 52.83                 # your position, so ranges and bearings mean something
  lon: 10.68
  alt: 75
```

And your Wi-Fi in `src/config/wifi_secrets.h`, or type it on the device later
(**N**, then **W**).

---

## 2. First run

The splash runs for five seconds, then the Home menu appears.

Work through this once:

1. **Check the clock and position.** Open **GPS** (`G`). Outdoors you should
   have a fix in a minute or two. The device has no battery-backed clock, so
   until the GPS or a sonde gives it one, the time is 1970 and log files are
   stamped accordingly.
2. **Choose your country.** On the Config page press `Y` until your country
   shows. That selects which channel list the scan walks.
3. **Turn on the families that fly near you.** Config page: `A` RS41, `S`
   RS92, `D` DFM, `F` M10, `G` M20. **Turn the others off** — each one you
   enable costs another dwell on every channel, so the scan gets slower in
   proportion. In most of Europe RS41 and DFM is the right pair.
4. **Start the scan.** `T`, or Space then the SCAN key. The channel steps, and
   the top bar shows `[L]` when it locks on a sonde.
5. **Have a look at the receiver.** `R`.

---

## 3. The screen

### The top bar

| | |
|---|---|
| your callsign | top left |
| satellite | local GPS — green with a fix, amber receiving data, red nothing |
| SD | green logging, red no card |
| sweep / `[L]` | sweeping; `[L]` locked on a sonde |
| Wi-Fi | green up, amber trying |
| Bluetooth | blue when BLE is up |

### The footer

Home on the left, the web globe on the right, and between them the keys that
page has — usually channel down, scan, channel up.

**A long press on the globe** opens Web Mode: the panel takes the screen and
the device becomes a thing you drive from a browser. A short tap only starts or
stops the background web server.

### The two menus

Eight tiles each. `,` and `.` step between them.

**Menu 1** — Receiver · Scan · Map · Spectrum · Logfile · Upload · GPS · Config
**Menu 2** — Hunter · Ranges · Sweep · Waterfall · Channel · CH list · Sondetype · About

The menus have three looks, set by `display.homepage_style`: `standard`,
`icom` (keys like a transceiver's) and `d75` (glossy plates, Kenwood style).

---

## 4. The keyboard

Press **I** at any time for this list on the device.

### Pages

| | | | |
|---|---|---|---|
| `Space` | Scan | `D` | Decoder |
| `M` | Map | `W` | Waterfall |
| `S` | Spectrum | `E` | Sweep |
| `G` | GPS | `L` | Logfile |
| `C` | Config | `Q` | Channel |
| `R` | Receiver | `J` | CH list |
| `F` | Hunter | `U` | Upload |
| `H` | Home | `I` | Info |

Sondetype is on menu 2.

### Doing things

| | |
|---|---|
| `T` | scan on/off |
| `Z` / `X` | previous / next channel |
| `V` | frequency source: the channel list or the manual frequency |
| `Y` | next country |
| `O` | touch screen on/off |
| `B` | screen brightness · `K` keyboard light · `P` dim timer |
| `A` | reset the counters |
| `N` then `W` | Wi-Fi credentials |
| `,` `.` | page left / right |
| `R` | on the Logfile page only: SD logging on/off |

On the **Config** page the letter keys change settings instead: `A` RS41, `S`
RS92, `D` DFM, `F` M10, `G` M20, `L` permanent map labels, `W` the dwell, `Y`
the country.

On the **CH list** and **Sondetype** pages, `Space` or `Enter` switches the
highlighted row.

---

## 5. The pages

**Receiver** — the one to leave it on. A map at the top, the frequency, the
sonde and an S-meter below. Tap the frequency panel for the full-screen view
(§6). A long press on the frequency opens the tuning screen.

**Scan** — what the radio is doing right now: the channel, the family, the
level, the frames counted, and the sonde if there is one.

**Map** — the tiles from the SD card, the track, the station, the sonde and the
landing point. Drag to pan, and the zoom buttons are on the map. A tap on the
tiles opens the map full-screen. The prediction, when there is one, is the
dotted line to the landing cross.

**Spectrum** and **Ranges** — the band as a bar per bin. The first is the whole
band at 50 kHz, always; the second lets you pick a range from a table.

**Sweep** — a band sweep that keeps the best of every pass, not just the last.
Leave it running and it will catch a sonde on the pass when it is transmitting.
`Space` starts and stops it here.

**Waterfall** — that sweep with its history under it. The zoom key narrows to
±100 kHz around the peak.

**Hunter** — §7.

**Channel** — the tuned channel, and the sonde on it in detail.

**CH list** — every channel, each one on or off, with its country and site. The
`+` at the top right adds one by hand, with its type.

**Sondetype** — the five families, each on or off, and the dwell.

**Logfile** — what is on the card: sondes, frames, sizes. `R` starts and stops
logging.

**Upload** — MQTT and SondeHub: connected or not, how many sent, how many
queued, and why not if not.

**GPS** — your own position, satellites, HDOP, and the signal bars.

**Config** — the settings you change most, the device address, the uptime, the
loop duty and the memory.

**About** — version, hardware, and who to thank.

---

## 6. The receiver views

Tap the frequency panel on the Receiver page to go full-screen. There are nine
looks; `webui.receiver_color` chooses one, and the COLOUR key steps through
them.

| | |
|---|---|
| **blue** | the plain one — light blue |
| **yellow** | the amber of the MySondy app |
| **tactical** | dark with red text; keeps night vision |
| **icom** | a black ICOM front panel |
| **r9500** | the IC-R9500's deep blue |
| **ts890** | black, with an analogue meter |
| **rs** | an R&S signal analyser: four windows and side keys |
| **atak** | a map with a tool panel down the right |
| **d75** | a Kenwood TH-D75 — dual band while scanning, single band while decoding, and a station list page |

All of them show the frequency, the level and the sonde. The keys along the
bottom differ; on the TH-D75 they are HOME, SCAN, MUTE, INFO (LIVE while the
station list is up), DIAL and BACK.

**A long press on the frequency** opens the tuning screen in every full view.
`boot_receiver` makes the device come up in one of them instead of the menu.

---

## 7. Hunting a sonde

Once a sonde has been decoded and it has stopped climbing:

1. **Open Hunter** (`F`). The list shows what has been heard: serial,
   frequency, type, position, altitude and climb, newest first, paged.
2. **Tap the one you want.** The view switches to the compass: the arrow points
   at it, with the range and bearing, and the channel and mute keys under your
   thumb.
3. **Watch the descent.** A prediction — Tawhiri, or SondeHub's — appears on
   the map as soon as the sonde is falling.
4. **Walk in on the sound.** Turn the speaker on: the two-tone beep rises in
   pitch and quickens as you get closer (§9). Watching the screen while walking
   through a wood is how you trip over things.
5. **In the last hundred metres** the range figure matters more than the
   bearing. A sonde on the ground with its antenna in the grass is quiet; the
   last stretch is usually a slow circle.

The list survives a reboot — it is kept in flash — so a sonde heard yesterday
is still there tomorrow.

---

## 8. The web panel

With Wi-Fi up, the address is on the Config page.

| | |
|---|---|
| `/` | the dashboard: status, the sonde, the channel, controls |
| `/livemap.html` | the live map, the sonde list, the prediction, the Configuration dialogue |
| `/screen.html` | the device's screen, mirrored |

**Background or Web Mode.** Background serves pages while the device carries on
receiving. Web Mode — a long press on the globe — gives the panel the screen
too.

**Configuration** is nine tabs covering every editable setting. It sends only
what you changed, and most settings take effect at once; the dialogue says
which need a restart.

> **Set `webui.password` before putting the device on a network you do not
> control.** With it empty — the shipped default — anyone who can reach the
> port can change any setting and reboot the device.

`API_DESCRIPTION.md` has the routes if you want to script it.

---

## 9. Sound

Two things come out of the speaker, and each has its own switch.

**The frames.** Every decoded frame is played as what it is: a sonde sends
GFSK, and an FM receiver's discriminator follows the deviation, so a frame
sounds like its own bit stream — a rasp at half the family's bit rate. A DFM is
a low buzz around 1.25 kHz, an M10 a much higher one. You learn to tell them
apart, and you can hear a marginal signal breaking up before the screen says
so. `audio.output` switches the speaker on at boot.

**The signal-strength beep.** Between frames, a two-tone beep whose pitch rises
and whose rate quickens as the level comes up — a direction finder you listen
to rather than look at. `audio.signal_tone` turns it off on its own if you want
the frames only.

`audio.volume` is 0 to 10. The speaker is small; above 8 it mostly distorts.

---

## 10. The SD card

```
/logs/index.csv                     every sonde ever seen
/logs/latest.csv                    the current sonde's track
/logs/last_seen.txt
/logs/sondes/<serial>/track.csv     one folder per sonde
/logs/sondes/<serial>/summary.txt
/map/<z>/<x>/<y>.png                offline map tiles
```

Logging is on when `logging.sd_enabled` is true and a card is in; `R` on the
Logfile page switches it.

**Map tiles** are the ordinary slippy-map layout that every tile tool writes.
Download the area you hunt in at zoom 10–14 before you go out — there is no
mobile data in a field. `webui.map.sd_root` moves the folder if you want it
elsewhere.

Until the GPS has a fix the clock is 1970, and files written before then carry
that date.

---

## 11. Uploading

**MQTT to an OpenWX gateway** — `openwx.mqtt.*`: server, port, credentials,
topic prefix, client ID, TLS. Frames and a station status are published.

**SondeHub** — `sondehub.*`: telemetry in batches, and the station
re-registered on the listeners endpoint so you appear on the map. Fill in
`uploader_callsign`, the position and the antenna. `queue_mode` decides what
happens without a network: queue and send later, or write the same payloads to
the card.

Both need Wi-Fi, and both run on a task of their own so the radio keeps being
read while a server takes its time answering.

---

## 12. Every setting

`data/config.yaml`, on LittleFS. The file keeps its own comments and quoting
when the firmware rewrites it, so you can annotate it freely.

### station

| Key | Meaning |
|---|---|
| `callsign` | shown top left, and used by the uplinks |
| `lat` `lon` `alt` | your position — ranges and bearings are wrong without it |
| `receiver` `antenna` | free text, reported to SondeHub |
| `upload_position` `upload_interval` | stored; not acted on yet |

### decoders

| Key | Meaning |
|---|---|
| `rs41` `rs92` `dfm` `m10` `m20` | the families to listen for. **Each one costs another dwell per channel** |
| `dwell_ms` | how long one family listens on one channel (default 1400) |
| `scan_squelch_db` | skip a channel within this many dB of the noise floor without trying a decoder; 0 is off |
| `signal_lost_ms` | silence after which a locked sonde counts as lost |
| `resume_scan` | hand a channel back to the scan when its sonde goes quiet |
| `max_idle_time` | seconds of silence before a channel the scan found is given up (300) |
| `manual_idle_time` | the same for a channel you chose (1800) |
| `rx_boost` | the SX1262's boosted RX gain, or the power-saving one |
| `rs92_alt2d` | the altitude assumed for a 2D fix when only three satellites are heard |
| `rs92_rx_bandwidth` | RS92's receive bandwidth in Hz (12500) |

> **If the scan will not come back** after a sonde: either it is still
> transmitting from the ground — an RS41 runs for hours after landing, and
> every frame extends the hold — or `resume_scan` is off. The console prints
> `Giving up … after N s without a frame` when the timeout does fire.

### ephemeris — RS92 only

An RS92 sends the GPS pseudoranges it measures, not a position, so the receiver
has to know where the satellites were. The daily RINEX navigation file is
fetched over HTTPS when Wi-Fi comes up and unpacked into `/brdc`.

| Key | Meaning |
|---|---|
| `enabled` | fetch when RS92 is on and Wi-Fi is up |
| `url` | a printf template given three numbers, in this order and once each: `%04d` year, `%03d` day of the year, `%02d` two-digit year. Anything else — `%s`, a fourth number — is refused |
| `max_age_hours` | fetch again when the stored file is older (6) |

Without the file an RS92 still gives you a serial, a frame number and a time —
but no position.

### audio · display

`audio.output` speaker on at boot · `audio.signal_tone` the strength beep ·
`audio.volume` 0–10.

`display.brightness` · `display.keyboard` · `display.dim_enabled` ·
`display.dim_after_s` · `display.dim_level` · `display.homepage_style`
(`standard` · `icom` · `d75`).

### webui

| Key | Meaning |
|---|---|
| `port` | default 80 |
| `background` | serve pages while the device keeps receiving |
| `user` `password` | **set the password** on any network you do not control |
| `receiver_color` | which of the nine receiver views |
| `boot_receiver` | come up in a receiver view instead of the menu; `off` or a view name |
| `permanent_labels` | keep the sonde labels on the map |
| `sonde_retention_time` `sonde_stale_time` | how long a track is kept, and when it stops being live |
| `map.default_zoom` `map.tile_server` `map.sd_root` | the map |

### logging · bluetooth · openwx · sondehub · import_api

`logging.sd_enabled` and `logging.debug_radio` are acted on; `logging.level`
and `logging.raw_frames` are stored only.

`bluetooth.enabled` starts the MySondy Go service, which costs the Bluetooth
controller's RAM — leave it off if no phone is going to connect. `call` and
`name` are what the apps show.

`openwx.mqtt.*` and `sondehub.*` are §11. `openwx.http.*` and `import_api.*`
are stored but no client acts on them yet.

Secrets — `webui.password`, `openwx.mqtt.password`, `openwx.http.api_key` — are
never served to a browser. Wi-Fi credentials are not in this file at all.

---

## 13. When something is wrong

**Nothing is heard.**
Check the antenna first, then that the family is on (Config, `A`–`G`), then
that the country is right (`Y`), then the channel (`Z`/`X`). Open Spectrum or
Sweep: if there is no bump anywhere in the band, nothing is flying — sondes
usually go up around 00 and 12 UTC.

**Frames arrive but nothing decodes.**
Watch for the reject box: it names the reason. `frame good, serial not
established` on a DFM is normal for the first few frames — a DFM's identity
builds up over several. Otherwise the signal is probably marginal; the sound of
the frames tells you that faster than the screen.

**RS92 shows a serial and a time but no position.**
It has no ephemeris. Check `/api/hardware` or the web panel for the ephemeris
state and the age of the file, and that Wi-Fi has been up since RS92 was
switched on.

**The scan stops on a channel and stays.**
See the note in §12 under `decoders`.

**The screen feels slow, or a key does nothing.**
Look at the serial console for `Slow loop: N ms, most in <stage>` — it names
the part of the pass that took the time. If that line never appears the loop is
healthy and the problem is elsewhere.

**The web panel is slow or does not answer.**
Wi-Fi modem sleep is off unless BLE is on; if BLE is on and the panel is
sluggish, that is the trade. The device also stops serving while a spectrum
sweep has the radio.

**A setting from the browser does not stick.**
Most take effect at once. A few — the web port, BLE — need a restart, and the
dialogue says so.

**Flashing fails: "Write timeout" or "Chip sync error".**
Close every serial monitor, unplug and replug, check the port, and if it still
refuses, hold the trackball down while switching it on to force download mode.

**The device is on a network you do not control and you have not set a
password.** Anyone who can reach the port can change every setting and reboot
it. Set `webui.password`.

---

*Questions, or a sonde this cannot decode: DL2MF@darc.de.*
