# set_role.ps1
# ============================================================================
# LOCAL TESTING HELPER (not part of the app).
#
# Change a user's role in the Railway database so you can test role-gated
# features without a second login. The app UI blocks changing your OWN role
# (anti self-lockout), so this does it at the DB level.
#
# Typical use: set your own account to Manager, refresh CannaQ to confirm the
# Re-open button is gone / Cancel still shows, then run again to set Admin back.
#
# Safety net: you are a bootstrap admin, so any Railway redeploy auto-restores
# your account to Admin at server boot regardless of what this sets.
# ============================================================================

$ErrorActionPreference = "Continue"

trap {
    Write-Host ""
    Write-Host "UNHANDLED ERROR:" -ForegroundColor Red
    Write-Host $_ -ForegroundColor Red
    Write-Host ""
    Write-Host "Press Enter to close..."
    [void](Read-Host)
    exit 1
}

function Write-Header($text) { Write-Host ""; Write-Host "==== $text ====" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "  [OK]   $text" -ForegroundColor Green }
function Write-Fail($text) { Write-Host "  [FAIL] $text" -ForegroundColor Red }
function Write-Info($text) { Write-Host "  $text" -ForegroundColor Gray }
function Pause-AndExit($code) { Write-Host ""; Write-Host "Press Enter to close..."; [void](Read-Host); exit $code }

Set-Location -Path $PSScriptRoot
Write-Header "Set user role - Railway Postgres (LOCAL TEST HELPER)"

$psqlExe = "C:\Program Files\PostgreSQL\17\bin\psql.exe"
if (-not (Test-Path $psqlExe)) {
    Write-Fail "psql 17 not found at $psqlExe"
    Pause-AndExit 1
}

# ---- Resolve DATABASE_URL ---------------------------------------------------
try {
    $vars = railway variables --service Postgres --json 2>$null | ConvertFrom-Json
} catch {
    Write-Fail "Failed to read Railway variables. Are you logged in? Try: railway login"
    Pause-AndExit 1
}
$dbUrl = if ($vars.DATABASE_PUBLIC_URL) { $vars.DATABASE_PUBLIC_URL } else { $vars.DATABASE_URL }
if (-not $dbUrl) { Write-Fail "No DATABASE_URL / DATABASE_PUBLIC_URL on the Postgres service."; Pause-AndExit 1 }
$env:PGSSLMODE = "require"
$env:PGCONNECT_TIMEOUT = "60"
Write-Ok "Connected to host: $(([Uri]$dbUrl).Host)"

# ---- Show current users -----------------------------------------------------
Write-Header "Current users"
& $psqlExe $dbUrl -c "SELECT id, email, role, active FROM users ORDER BY role, email;"
if ($LASTEXITCODE -ne 0) {
    Write-Fail "Could not query the database. Public proxy may be unreachable. Re-run (cold-start) or disable VPN."
    Pause-AndExit 1
}

# ---- Prompt for target ------------------------------------------------------
Write-Header "Change a role"
$defaultEmail = "jonschultz13@duck.com"
$email = Read-Host "Email to change (Enter for $defaultEmail)"
if ([string]::IsNullOrWhiteSpace($email)) { $email = $defaultEmail }

$allowed = @("Admin","Manager","Quality","Supervisor","Operator")
Write-Info "Allowed roles: $($allowed -join ', ')"
$roleInput = Read-Host "New role"
# Canonicalize to the EXACT casing the app expects. Role checks in the app are
# case-sensitive (Set.has("Quality")), so we must store "Quality", never
# "quality". Match the typed value case-insensitively, then use the canonical.
$role = $allowed | Where-Object { $_ -ieq $roleInput.Trim() } | Select-Object -First 1
if (-not $role) {
    Write-Fail "Invalid role '$roleInput'. Must be one of: $($allowed -join ', ')."
    Pause-AndExit 1
}
Write-Info "Using canonical role: $role"

# Escape single quotes for safe SQL string literals.
$emailSql = $email.Replace("'", "''")
$roleSql  = $role.Replace("'", "''")

# ---- Apply ------------------------------------------------------------------
Write-Header "Updating"
$updateSql = "UPDATE users SET role='$roleSql', updated_at=now() WHERE lower(email)=lower('$emailSql');"
$out = & $psqlExe $dbUrl -c $updateSql
Write-Info $out
if ($LASTEXITCODE -ne 0) { Write-Fail "Update failed."; Pause-AndExit 1 }
if ($out -match "UPDATE 0") {
    Write-Fail "No user matched email '$email'. Nothing changed."
    Pause-AndExit 1
}
Write-Ok "Set $email -> role '$role'."

# ---- Confirm ----------------------------------------------------------------
Write-Header "Verify"
& $psqlExe $dbUrl -c "SELECT id, email, role FROM users WHERE lower(email)=lower('$emailSql');"

Write-Host ""
Write-Host "Done. Refresh CannaQ (hard reload) to pick up the new role." -ForegroundColor Green
Write-Host "Run this again to set the role back to Admin when finished." -ForegroundColor Green

Pause-AndExit 0
