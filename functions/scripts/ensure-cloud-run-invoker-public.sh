#!/usr/bin/env bash
# Gen2 Firebase Functions are Cloud Run services. Callable URLs must allow unauthenticated
# invoke at the IAM layer (Firebase ID token is validated inside the function). If a service
# was created without public invoker, Cloud Run logs: "The request was not authenticated".
#
# Run after `gcloud auth login` (or with CI service account). Safe to re-run; duplicate bindings are ignored.
# Override: GCLOUD_PROJECT, FUNCTIONS_REGION

set -euo pipefail
REGION="${FUNCTIONS_REGION:-us-central1}"
PROJECT="${GCLOUD_PROJECT:-${GOOGLE_CLOUD_PROJECT:-iptv-playlist-manipulator}}"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "[ensure-cloud-run-invoker-public] gcloud not found — skipping IAM (rely on invoker: public in function code)."
  exit 0
fi

# Cloud Run service ids match export names lowercased (Firebase convention).
SERVICES=(
  upsertsource
  deletesource
  createplaylist
  updateplaylist
  refreshplaylist
  getdiffsummary
  getplaylisteditordata
  getplaylisteditorchannelids
  bulkexcludebynamesforchannelids
  publicplaylist
  scheduledplaylistrefresh
  deleteplaylist
  rotateplaylisttoken
)

echo "[ensure-cloud-run-invoker-public] project=$PROJECT region=$REGION"

for svc in "${SERVICES[@]}"; do
  if ! gcloud run services describe "$svc" --region="$REGION" --project="$PROJECT" &>/dev/null; then
    continue
  fi
  if gcloud run services add-iam-policy-binding "$svc" \
    --region="$REGION" --project="$PROJECT" \
    --member="allUsers" \
    --role="roles/run.invoker" \
    --quiet 2>/dev/null; then
    echo "[ensure-cloud-run-invoker-public] granted roles/run.invoker to allUsers on $svc"
  else
    echo "[ensure-cloud-run-invoker-public] $svc: binding unchanged or already present"
  fi
done

echo "[ensure-cloud-run-invoker-public] done"
