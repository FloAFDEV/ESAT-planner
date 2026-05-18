#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <bom_input_file> <db_connection_url_without_password>"
  echo "Example:"
  echo "  PGPASSWORD='***' $0 data/bom.txt 'postgresql://postgres@db.xxx.supabase.co:5432/postgres?sslmode=require'"
  exit 1
fi

INPUT_FILE="$1"
DB_URL="$2"
SQL_FILE="/tmp/import_bom_$(date +%s).sql"

if [[ ! -f "$INPUT_FILE" ]]; then
  echo "Input file not found: $INPUT_FILE"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required"
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "psql is required"
  exit 1
fi

node scripts/import-bom-tsv.mjs "$INPUT_FILE" > "$SQL_FILE"
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$SQL_FILE"

echo "Import completed. SQL used: $SQL_FILE"
