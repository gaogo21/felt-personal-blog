#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
env_file=${FELT_ENV_FILE-runtime/dev.env}
if [ -n "$env_file" ] && [ -f "$env_file" ]; then
  case "$env_file" in /*) source_file="$env_file";; *) source_file="./$env_file";; esac
  set -a; . "$source_file"; set +a
fi
if command -v dotnet >/dev/null 2>&1; then runtime=dotnet
elif [ -x "$HOME/.codex/runtimes/felt-dotnet/dotnet" ]; then runtime="$HOME/.codex/runtimes/felt-dotnet/dotnet"
else echo 'Install .NET SDK 10, then run this command again.' >&2; exit 1; fi
exec "$runtime" run --project src/Blog.Web -- "$@"
