$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

if (-not (Get-Command supabase -ErrorAction SilentlyContinue)) {
  throw "Supabase CLI ne e instaliran. Instalirai go ot oficialnata dokumentaciya."
}

Write-Host "1/3: Database migration"
supabase db push

Write-Host "2/3: Deploy teacher-plan"
supabase functions deploy teacher-plan

Write-Host "3/3: Gotovo"
Write-Host "Dobavi OPENAI_API_KEY i OPENAI_MODEL kato Supabase secrets."
