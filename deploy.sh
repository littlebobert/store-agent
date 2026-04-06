#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

TAG="$(date +%Y%m%d-%H%M%S)"

az acr build --registry kotoba --image "store-agent/api:${TAG}" --file apps/api/Dockerfile .
az acr build --registry kotoba --image "store-agent/worker:${TAG}" --file apps/worker/Dockerfile .

az deployment group create \
  --name store-agent \
  --resource-group kotoba-api \
  --template-file infra/bicep/main.bicep \
  --parameters @infra/bicep/main.parameters.json \
  --parameters "apiImage=store-agent/api:${TAG}" "workerImage=store-agent/worker:${TAG}"
