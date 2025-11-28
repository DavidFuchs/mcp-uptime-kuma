#!/bin/sh
set -e

# If the first argument is "get-jwt", run the get-jwt script
if [ "$1" = "get-jwt" ]; then
    shift
    exec node dist/get-jwt.js "$@"
fi

# Otherwise, run the main application with all arguments
exec node dist/index.js "$@"
