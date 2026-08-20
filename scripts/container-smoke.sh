#!/bin/sh
set -eu

image=${SLAB_DOCS_SMOKE_IMAGE:-slab-docs:smoke}
port=${SLAB_DOCS_SMOKE_PORT:-39680}
suffix=${GITHUB_RUN_ID:-local}-$$
container=slab-docs-smoke-$suffix
volume=slab-docs-smoke-data-$suffix
temporary_directory=$(mktemp -d)
secret_file=$temporary_directory/docs-api-key
api_key=testing-only-docs-api-key-0123456789abcdef

cleanup() {
  docker rm --force "$container" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  rm -rf "$temporary_directory"
}
trap cleanup EXIT HUP INT TERM

printf '%s\n' "$api_key" > "$secret_file"
chmod 444 "$secret_file"
docker volume create "$volume" >/dev/null

common_args="--volume $volume:/data --mount type=bind,src=$secret_file,dst=/run/secrets/docs-api-key,readonly"

# shellcheck disable=SC2086
docker run --rm $common_args "$image" node dist/db/migrate.js >/dev/null

# shellcheck disable=SC2086
docker run --detach \
  --name "$container" \
  --publish "127.0.0.1:${port}:6980" \
  $common_args \
  --env DOCS_API_KEY_FILE=/run/secrets/docs-api-key \
  --env SKIP_MIGRATIONS=true \
  "$image" >/dev/null

curl --retry 30 --retry-delay 1 --retry-all-errors -fsS \
  "http://127.0.0.1:${port}/ready" >/dev/null
curl -fsS \
  -H "X-API-Key: $api_key" \
  -H 'Content-Type: application/json' \
  --data '{"title":"Persistent smoke document","body":"Survives container replacement"}' \
  "http://127.0.0.1:${port}/api/documents" >/dev/null
node scripts/mcp-smoke.mjs "http://127.0.0.1:${port}" "$api_key" persistent-smoke-document

test "$(docker exec "$container" sh -c "awk '/^Uid:/{print \$2}' /proc/1/status")" = "1000"
test "$(docker exec "$container" stat -c '%a' /data)" = "700"
test "$(docker exec "$container" stat -c '%a' /data/slab-docs.db)" = "600"
if docker exec "$container" sh -c 'command -v npm >/dev/null 2>&1 || command -v yarn >/dev/null 2>&1 || command -v corepack >/dev/null 2>&1'; then
  echo "The production image must not include package-manager CLIs." >&2
  exit 1
fi
if docker inspect "$container" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -F "$api_key" >/dev/null; then
  echo "The Docs API key must not be stored in container environment metadata." >&2
  exit 1
fi

docker restart "$container" >/dev/null
curl --retry 30 --retry-delay 1 --retry-all-errors -fsS \
  "http://127.0.0.1:${port}/ready" >/dev/null
node scripts/mcp-smoke.mjs "http://127.0.0.1:${port}" "$api_key" persistent-smoke-document

echo "Slab Docs container smoke passed."
