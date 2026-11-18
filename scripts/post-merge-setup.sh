#!/usr/bin/env bash
set -euo pipefail

# Post-merge reconciliation must be safe to rerun and must never wait for input.
export CI=1

pnpm install --frozen-lockfile --ignore-scripts
npm run db:migrate
npm run build