# Links the new WhatsApp number (+212608131488 / OpenWA session bot3) to the
# active "biorien" seller in the CORRECT project (psnrabnwlqqlwezjfunp).
#
# It reads SUPABASE_URL + service key from api/.env, so it always hits the
# same project the bot uses — no Supabase dashboard / project-picker involved.
#
# Run it:
#   powershell -ExecutionPolicy Bypass -File "C:\Users\lenovo\Desktop\leadecombot\api\link_number.ps1"

$envFile = "C:\Users\lenovo\Desktop\leadecombot\api\.env"
$cfg = @{}
Get-Content $envFile | ForEach-Object {
  if ($_ -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') {
    $cfg[$matches[1]] = $matches[2].Trim().Trim('"').Trim("'")
  }
}
$url = $cfg['SUPABASE_URL']
$key = $cfg['SUPABASE_SERVICE_KEY']; if (-not $key) { $key = $cfg['SUPABASE_SERVICE_ROLE_KEY'] }

Write-Host "Target project URL :" $url
if (-not $url -or -not $key) { Write-Host "ERROR: missing SUPABASE_URL or service key in .env"; exit 1 }

$h = @{
  apikey        = $key
  Authorization = "Bearer $key"
  'Content-Type'= 'application/json'
  Prefer        = 'resolution=merge-duplicates,return=representation'
}
$now  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$body = @{
  seller_id    = "1c468a81-a1a3-4bf0-a9d7-fd8f69edaea7"   # biorien (active, MA)
  phone        = "212608131488"                            # the new number
  jid          = "0dbe1da9-b968-433f-a657-251849069da3"    # OpenWA session bototo (current live UUID)
  status       = "connected"
  paired_at    = $now
  last_seen_at = $now
} | ConvertTo-Json

try {
  $res = Invoke-RestMethod -Uri "$url/rest/v1/seller_whatsapp_sessions?on_conflict=seller_id,phone" `
                           -Method Post -Headers $h -Body $body
  Write-Host "`n=== LINKED OK ===" -ForegroundColor Green
  $res | ForEach-Object { Write-Host ("  phone=" + $_.phone + " | jid=" + $_.jid + " | status=" + $_.status) }
} catch {
  Write-Host "`nwrite failed:" $_.Exception.Message -ForegroundColor Red
  if ($_.ErrorDetails) { Write-Host $_.ErrorDetails.Message }
  exit 1
}

Write-Host "`n=== all numbers for biorien now ==="
$ws = Invoke-RestMethod -Uri "$url/rest/v1/seller_whatsapp_sessions?seller_id=eq.1c468a81-a1a3-4bf0-a9d7-fd8f69edaea7&select=phone,jid,status&order=paired_at.desc" `
                        -Headers @{ apikey=$key; Authorization="Bearer $key" }
$ws | ForEach-Object { Write-Host ("  phone=" + $_.phone + " | jid=" + $_.jid + " | status=" + $_.status) }
