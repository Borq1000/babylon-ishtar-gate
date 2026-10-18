#!/bin/bash
# usage: ./run.sh scripts/xxx.py [-- args]  (from the work folder, see README.md)
HERE="$(cd "$(dirname "$0")" && pwd)"
export BLENDER_USER_RESOURCES="$(cygpath -w "$HERE/blender-user" 2>/dev/null || echo "$HERE/blender-user")"
"/c/Program Files/Blender Foundation/Blender 5.2/blender.exe" -b --factory-startup --python "$@" 2>&1 | grep -v "^\[INFO\|^\[DEBUG"
