[CmdletBinding()]
param(
  [string]$Path = (Join-Path $PSScriptRoot '..\supabase\catalog.json')
)

$ErrorActionPreference = 'Stop'
$supabaseUrl = $env:SUPABASE_URL
$secretKey = $env:SUPABASE_SECRET_KEY
if ([string]::IsNullOrWhiteSpace($supabaseUrl)) { throw 'SUPABASE_URL is not set in this PowerShell session.' }
if ([string]::IsNullOrWhiteSpace($secretKey) -or $secretKey -notlike 'sb_secret_*') { throw 'SUPABASE_SECRET_KEY must be a Supabase secret key (sb_secret_...).' }
$supabaseUrl = $supabaseUrl.TrimEnd('/')
$headers = @{ apikey = $secretKey; Accept = 'application/json'; 'Content-Type' = 'application/json'; Prefer = 'return=representation' }
$catalog = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable

function Invoke-Api([string]$table, [string]$query = '', [string]$method = 'GET', [object]$body = $null) {
  $uri = "$supabaseUrl/rest/v1/$table"
  if ($query) { $uri += "?$query" }
  $request = @{ Uri = $uri; Method = $method; Headers = $headers }
  if ($null -ne $body) { $request.Body = ConvertTo-Json -InputObject $body -Depth 24 -Compress }
  Invoke-RestMethod @request
}

function Filter([string]$value) { [uri]::EscapeDataString("eq.$value") }

$subjectIds = @{}
$createdSubjects = 0
foreach ($subject in $catalog.subjects) {
  $name = [string]$subject.name
  $rows = @(Invoke-Api 'subject' "select=id,name&name=$(Filter $name)")
  if ($rows.Count -gt 1) { throw "Duplicate subject '$name' found; no catalog row was added." }
  if ($rows.Count -eq 0) {
    $body = @{ name = $name; icon = [string]$subject.icon; sort_order = [int]$subject.sort_order }
    $rows = @(Invoke-Api 'subject' '' 'POST' $body)
    $createdSubjects++
  }
  if ($rows.Count -ne 1) { throw "Could not resolve subject '$name'." }
  $subjectIds[$name] = [long]$rows[0].id
}

$createdLessons = 0
$verifiedLessons = 0
foreach ($lesson in $catalog.lessons) {
  $subjectName = [string]$lesson.subject
  if (-not $subjectIds.ContainsKey($subjectName)) { throw "Catalog subject '$subjectName' is missing." }
  $subjectId = $subjectIds[$subjectName]
  $title = [string]$lesson.title
  $rows = @(Invoke-Api 'lessons' "select=id,subject_id,title&subject_id=eq.$subjectId&title=$(Filter $title)")
  if ($rows.Count -gt 1) { throw "Duplicate lesson '$title' found under '$subjectName'." }
  if ($rows.Count -eq 0) {
    $body = @{ subject_id = $subjectId; title = $title; sort_order = [int]$lesson.sort_order }
    $rows = @(Invoke-Api 'lessons' '' 'POST' $body)
    $createdLessons++
  }
  if ($rows.Count -ne 1 -or [long]$rows[0].subject_id -ne $subjectId) { throw "Could not verify lesson '$title'." }
  $verifiedLessons++
}

[pscustomobject]@{
  SubjectsCreated = $createdSubjects
  LessonsCreated = $createdLessons
  LessonsVerified = $verifiedLessons
  TablesCreated = 0
  QcmRowsChanged = 0
} | Format-List
