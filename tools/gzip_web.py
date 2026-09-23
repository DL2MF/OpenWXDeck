"""Pre-compress the web panel's files before the filesystem image is built.

The web server prefers <file>.gz when the browser accepts gzip, which makes
livemap.js a quarter of its size and keeps the device's loop free while it
is sent. The .gz copies are made here, from the files in data/, every time
`pio run -t buildfs` or `-t uploadfs` runs - so they can never be older than
the file they stand for. They are not kept in git (see .gitignore).
"""

import gzip
import os

Import("env")  # noqa: F821 - provided by PlatformIO

COMPRESSED = (".js", ".css", ".html")


def compress_web_files(*_args, **_kwargs):
    data_dir = os.path.join(env.subst("$PROJECT_DIR"), "data")  # noqa: F821

    if not os.path.isdir(data_dir):
        return

    for name in sorted(os.listdir(data_dir)):
        source = os.path.join(data_dir, name)

        if not name.endswith(COMPRESSED) or not os.path.isfile(source):
            continue

        target = source + ".gz"

        if os.path.exists(target) and os.path.getmtime(target) >= os.path.getmtime(source):
            continue

        with open(source, "rb") as handle:
            content = handle.read()

        # mtime=0: the same input gives the same .gz, byte for byte.
        with open(target, "wb") as handle:
            handle.write(gzip.compress(content, compresslevel=9, mtime=0))

        print("gzip_web: %s -> %s (%d -> %d bytes)"
              % (name, name + ".gz", len(content), os.path.getsize(target)))


# Before the filesystem image is made, whichever command makes it.
if any(target in ("buildfs", "uploadfs", "uploadfsota")
       for target in COMMAND_LINE_TARGETS):  # noqa: F821
    compress_web_files()
