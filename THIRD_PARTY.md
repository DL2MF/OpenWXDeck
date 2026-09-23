# Third-party components

OpenWXDeck includes or depends on a small number of third-party components.

## Upstream

OpenWXDeck is derived from SondeDeck, Copyright (C) 2026 A-NET,
GPL-3.0-or-later. Its copyright notice is kept in `LICENSE`.

This file is a practical summary only. The licence files bundled with each component are the authoritative licence terms.

## Vendored components

### rs1729_rs41_fec

Path:

```text
lib/rs1729_rs41_fec/
```

Purpose:

- RS41 FEC/BCH support
- Wrapper around upstream RS41 FEC code

Licence information:

```text
lib/rs1729_rs41_fec/LICENSE
lib/rs1729_rs41_fec/src/README.md
```

The RS41 FEC component is GPL-licensed. OpenWXDeck is therefore distributed under **GPL-3.0-or-later**.

### TFT_eSPI

Path:

```text
lib/TFT_eSPI/
```

Purpose:

- ST7789 display support
- TFT drawing primitives
- Text and simple UI rendering

Licence information:

```text
lib/TFT_eSPI/license.txt
```

### TinyGPSPlus

Path:

```text
lib/TinyGPSPlus/
```

Purpose:

- Parsing local GPS NMEA data from the T-Deck Plus GPS module

Licence / metadata information:

```text
lib/TinyGPSPlus/library.properties
```

If publishing a formal long-term release, consider adding the upstream TinyGPSPlus licence file into the vendored library folder if it is not already present.

## Web assets

### LiveMap marker images

Path:

```text
data/balloon.png
data/chute.png
```

Purpose:

- Ascending / descending radiosonde markers on the LiveMap

These two images are taken from the `rdz_ttgo_sonde` firmware (OpenWXTTGO
fork) so that a sonde is drawn the same way on both receivers. The copy of
`rdz_ttgo_sonde` used here carries no top-level `LICENSE` file; its sources
declare `GPL-2.0+`, which is compatible with OpenWXDeck's GPL-3.0-or-later.
Confirm the upstream terms for the images specifically before publishing a
binary release.

### Leaflet

The LiveMap loads Leaflet 1.9.4 and OpenStreetMap tiles from the public CDN at
run time. Neither is bundled in `data/`; the page falls back to a sidebar-only
view when there is no internet connection.

### DFM decoder

Path:

```text
src/decoders/dfm_decoder.h
src/decoders/dfm_decoder.cpp
```

Purpose:

- Decoding Graw DFM-06 / DFM-09 / DFM-17 frames

Ported from `src/DFM.cpp` in rdz_ttgo_sonde / OpenWXTTGO:

```text
Copyright (C) 2019 Hansi Reiser, dl9rdz
SPDX-License-Identifier: GPL-2.0+
```

which is itself derived from rs1729's DFM work and from oe5dxl's serial search
in dxlAPRS `sondeudp.c`. `GPL-2.0+` permits redistribution under GPL-3.0, which
is what OpenWXDeck is released under.

### M10 / M20 decoder

Path:

```text
src/decoders/m10m20_decoder.h
src/decoders/m10m20_decoder.cpp
```

Purpose:

- Decoding Meteomodem M10 and M20 frames

Ported from `src/M10M20.cpp` in rdz_ttgo_sonde / OpenWXTTGO
(`Copyright (C) 2019 Hansi Reiser, dl9rdz`, `GPL-2.0+`). Its frame repair
follows oe5dxl's dxlAPRS `sondeudp.c`. `GPL-2.0+` permits redistribution
under GPL-3.0.

## PlatformIO dependencies

### Semtech SX126x driver

Purpose:

- SX1262 low-level radio driver

This dependency is pulled by PlatformIO during build and is not committed under `lib/` in the OpenWXDeck source tree.

Licence information is provided by the dependency package pulled by PlatformIO.

## External services

### SondeHub

OpenWXDeck can query SondeHub predictions in read-only mode by sonde serial.

The handheld does not upload telemetry, listener position, chase-car position, or recovery reports.

OpenWXDeck is not affiliated with or endorsed by SondeHub.

## RS41-GO decoder (src/decoders/rs41go_*)

Ported from OpenWXTTGO / rdzTTGOsonde `RS41.cpp` (Hansi Reiser, DL9RDZ,
GPL-2.0+), with geodesy and Reed-Solomon wrapper from dxlAPRS (Christian
Rabler, OE5DXL, GPL-2.0+), the general Reed-Solomon decoder by Phil Karn,
KA9Q (LGPL) and PTU calibration from ra-firmware (einergehtnochrein).
