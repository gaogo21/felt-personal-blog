#!/bin/sh
set -eu
# Initialization and restore commands do not start a worker or need scanner signatures.
if [ "$#" -eq 0 ] && ! find /var/lib/clamav -maxdepth 1 \( -name '*.cvd' -o -name '*.cld' \) | grep -q .; then
  freshclam --stdout --user=app --datadir=/var/lib/clamav
fi
exec dotnet Blog.Web.dll "$@"
