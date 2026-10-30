# bootstrap-config.sh — Repo-specific 1Password template mappings
#
# Each entry: "template_path:output_path"
# Templates contain op:// references resolved by `op inject`.
# Templates are committed to git; generated output files are gitignored.
#
# Example:
#   1. Create .env.tpl with op:// references.
#   2. Add ".env.tpl:.env.local" below.
#   3. Run ./scripts/bootstrap.sh --force.

INJECT_FILES=(
  # Item "fiveacross env" (Private vault), one section per output file.
  ".env.tpl:.env.local"
  ".env.fiveacross.tpl:.env.fiveacross"
  ".env.gaycruisebingo.tpl:.env.gaycruisebingo"
  "functions/.env.local.tpl:functions/.env.local"
  "functions/.env.fiveacross.tpl:functions/.env.fiveacross"
  "functions/.env.gaycruisebingo.tpl:functions/.env.gaycruisebingo"
)
