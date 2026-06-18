#!/bin/sh
# Entry point for distributable docker image
# This script does some setup required for bootstrapping the container
# and then runs whatever is passed as arguments to this script.
# If the CMD directive is specified in the Dockerfile, those commands
# are passed to this script. This can be overridden by the user in the
# `docker run`
set -e

echo "Running docker-entry.sh"

# If Azure Workload Identity env vars are present, fetch a Redis Entra token
# and inject it as RI_REDIS_PASSWORD1 for the pre-configured AMR connection.
if [ -n "$AZURE_FEDERATED_TOKEN_FILE" ] && [ -n "$AZURE_CLIENT_ID" ] && [ -n "$AZURE_TENANT_ID" ]; then
  echo "Azure Workload Identity detected — fetching Redis Entra token..."
  RI_REDIS_PASSWORD1=$(node -e "
const fs = require('fs');
const federatedToken = fs.readFileSync(process.env.AZURE_FEDERATED_TOKEN_FILE, 'utf8').trim();
const params = new URLSearchParams({
  grant_type: 'client_credentials',
  client_id: process.env.AZURE_CLIENT_ID,
  client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
  client_assertion: federatedToken,
  scope: 'https://redis.azure.com/.default',
});
fetch('https://login.microsoftonline.com/' + process.env.AZURE_TENANT_ID + '/oauth2/v2.0/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: params.toString(),
})
  .then(r => r.json())
  .then(j => {
    if (j.error) { process.stderr.write(j.error + ': ' + j.error_description + '\n'); process.exit(1); }
    process.stdout.write(j.access_token);
  })
  .catch(e => { process.stderr.write(e.message + '\n'); process.exit(1); });
")
  export RI_REDIS_PASSWORD1
  echo "Redis Entra token acquired (valid ~1h)"
fi

# Run the application's entry script with the exec command so it catches SIGTERM properly
exec "$@"
