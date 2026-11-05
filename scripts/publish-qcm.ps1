[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Path,

  [switch]$CreateCatalogIfMissing
)

$ErrorActionPreference = 'Stop'

$script:SupabaseUrl = $env:SUPABASE_URL
$script:SupabaseSecretKey = $env:SUPABASE_SECRET_KEY

if ([string]::IsNullOrWhiteSpace($script:SupabaseUrl)) { throw 'SUPABASE_URL is not set in this PowerShell session.' }
if ([string]::IsNullOrWhiteSpace($script:SupabaseSecretKey) -or $script:SupabaseSecretKey -notlike 'sb_secret_*') {
  throw 'Set SUPABASE_SECRET_KEY to a Supabase secret key (sb_secret_...). Do not use the publishable key here.'
}
$script:SupabaseUrl = $script:SupabaseUrl.TrimEnd('/')

$script:Headers = @{
  apikey = $script:SupabaseSecretKey
  Accept = 'application/json'
  'Content-Type' = 'application/json'
  Prefer = 'return=representation'
}

function Invoke-SupabaseRest {
  param([Parameter(Mandatory = $true)][string]$Table, [string]$Query = '', [string]$Method = 'GET', [object]$Body)
  $uri = "$script:SupabaseUrl/rest/v1/$Table"
  if ($Query) { $uri += "?$Query" }
  $arguments = @{ Uri = $uri; Method = $Method; Headers = $script:Headers }
  if ($null -ne $Body) { $arguments.Body = ConvertTo-Json -InputObject $Body -Depth 32 -Compress }
  Invoke-RestMethod @arguments
}

function ConvertTo-FilterValue {
  param([Parameter(Mandatory = $true)][string]$Value)
  [uri]::EscapeDataString("eq.$Value")
}

function Get-ExactSubject {
  param([Parameter(Mandatory = $true)][string]$Name, [switch]$Create, [object]$SubjectData)
  $filter = ConvertTo-FilterValue $Name
  $rows = @(Invoke-SupabaseRest -Table 'subject' -Query "select=id,name,icon,sort_order&name=$filter")
  if ($rows.Count -gt 1) { throw "Duplicate subject names exist in Supabase: $Name" }
  if ($rows.Count -eq 1) { return $rows[0] }
  if (-not $Create) { throw "Subject '$Name' is not in public.subject. Seed the catalog or pass -CreateCatalogIfMissing." }
  $payload = @{ name = $Name }
  foreach ($field in @('description','icon','sort_order')) {
    if ($SubjectData -and $SubjectData.Contains($field) -and $null -ne $SubjectData[$field]) { $payload[$field] = $SubjectData[$field] }
  }
  $created = @(Invoke-SupabaseRest -Table 'subject' -Method 'POST' -Body $payload)
  if ($created.Count -ne 1) { throw "Could not create subject '$Name'." }
  $created[0]
}

function Get-ExactLesson {
  param([Parameter(Mandatory = $true)][long]$SubjectId, [Parameter(Mandatory = $true)][string]$Title, [switch]$Create, [object]$LessonData)
  $titleFilter = ConvertTo-FilterValue $Title
  $rows = @(Invoke-SupabaseRest -Table 'lessons' -Query "select=id,subject_id,title,sort_order&subject_id=eq.$SubjectId&title=$titleFilter")
  if ($rows.Count -gt 1) { throw "Duplicate lesson titles exist under subject '$Title'." }
  if ($rows.Count -eq 1) { return $rows[0] }
  if (-not $Create) { throw "Lesson '$Title' is not in public.lessons. Seed the catalog or pass -CreateCatalogIfMissing." }
  $payload = @{ subject_id = $SubjectId; title = $Title }
  foreach ($field in @('description','sort_order')) {
    if ($LessonData -and $LessonData.Contains($field) -and $null -ne $LessonData[$field]) { $payload[$field] = $LessonData[$field] }
  }
  $created = @(Invoke-SupabaseRest -Table 'lessons' -Method 'POST' -Body $payload)
  if ($created.Count -ne 1) { throw "Could not create lesson '$Title'." }
  $created[0]
}

function Get-ChoiceMap {
  param([Parameter(Mandatory = $true)]$Options)
  $letters = @('A','B','C','D','E')
  if ($Options -is [System.Collections.IDictionary]) {
    $mode = if ($Options.mode -eq 'multiple' -or $Options.multiple -eq $true) { 'multiple' } else { 'single' }
    $source = if ($Options.choices -is [System.Collections.IDictionary]) { $Options.choices } else { $Options }
    $choices = @{}
    foreach ($letter in $letters) {
      if (-not $source.Contains($letter) -or $source[$letter] -isnot [string]) { throw "Options must provide a string for each letter A–E." }
      $choices[$letter] = $source[$letter]
    }
  } elseif ($Options -is [array] -or $Options -is [System.Collections.IList]) {
    $items = @($Options)
    if ($items.Count -ne 5 -or $items | Where-Object { $_ -isnot [string] }) { throw 'Options must be five strings in A–E order.' }
    $mode = 'single'
    $choices = @{}
    for ($i = 0; $i -lt 5; $i++) { $choices[$letters[$i]] = $items[$i] }
  } else {
    throw 'Options must be an A–E object or a five-item array.'
  }
  @{ mode = $mode; choices = $choices }
}

function Get-CorrectLetters {
  param([Parameter(Mandatory = $true)]$Question)
  $value = $Question.correct_options
  if ($null -eq $value -and $Question.correct_option) { $value = @($Question.correct_option) }
  if ($null -eq $value -and $null -ne $Question.answer) { $value = @($Question.answer) }
  if ($value -is [string] -or $value -is [int] -or $value -is [long]) { $value = @($value) }
  $letters = @('A','B','C','D','E')
  $result = @(
    foreach ($item in @($value)) {
      $letter = "$item".Trim().ToUpperInvariant()
      if ($letter -notin $letters) { throw "Invalid correct option '$item'; provide a letter from A to E." }
      $letter
    }
  ) | Sort-Object -Unique
  if ($result.Count -lt 1 -or $result.Count -gt 5) { throw 'Each question needs one or more correct options.' }
  $result
}

function Publish-QcmFile {
  param([Parameter(Mandatory = $true)][string]$File)
  $document = Get-Content -LiteralPath $File -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
  if ([string]::IsNullOrWhiteSpace($document.subject.name) -or [string]::IsNullOrWhiteSpace($document.lesson.title)) {
    throw "Each file must specify subject.name and lesson.title: $File"
  }
  $items = @($document.questions)
  if ($items.Count -lt 1) { throw "No questions found in $File" }

  $subject = Get-ExactSubject -Name $document.subject.name -Create:$CreateCatalogIfMissing -SubjectData $document.subject
  $lesson = Get-ExactLesson -SubjectId ([long]$subject.id) -Title $document.lesson.title -Create:$CreateCatalogIfMissing -LessonData $document.lesson
  if ([long]$lesson.subject_id -ne [long]$subject.id) { throw "Lesson '$($lesson.title)' belongs to another subject." }

  $inserted = 0
  $repaired = 0
  $skipped = 0
  $verifiedIds = [System.Collections.Generic.List[long]]::new()
  foreach ($item in $items) {
    if ([string]::IsNullOrWhiteSpace($item.question) -or [string]::IsNullOrWhiteSpace($item.explanation)) {
      throw "Each item must include question and explanation text. Nothing is changed for this item."
    }
    $choices = Get-ChoiceMap -Options $item.options
    $correct = @(Get-CorrectLetters -Question $item)
    if ($choices.mode -eq 'single' -and $correct.Count -ne 1) { throw "A single-answer question must have exactly one correct option: $($item.question)" }
    if ($choices.mode -eq 'multiple' -and $correct.Count -lt 2) { throw "A multiple-answer question must have at least two correct options: $($item.question)" }
    if (@($correct | Where-Object { -not $choices.choices.ContainsKey($_) }).Count -gt 0) { throw "A correct option has no matching choice: $($item.question)" }

    $questionFilter = ConvertTo-FilterValue ([string]$item.question)
    $existing = @(Invoke-SupabaseRest -Table 'questions' -Query "select=id,question&subject_id=eq.$($subject.id)&lesson_id=eq.$($lesson.id)&question=$questionFilter")
    if ($existing.Count -gt 1) { throw "More than one matching question already exists; no duplicate was added: $($item.question)" }
    if ($existing.Count -eq 1) {
      $questionId = [long]$existing[0].id
      $answerRows = @(Invoke-SupabaseRest -Table 'questions_answers' -Query "select=id,question_id&question_id=eq.$questionId")
      if ($answerRows.Count -gt 1) { throw "Multiple answer rows exist for question id $questionId." }
      if ($answerRows.Count -eq 0) {
        $answerBody = @{ question_id = $questionId; correct_options = $correct; explanation = [string]$item.explanation }
        $null = Invoke-SupabaseRest -Table 'questions_answers' -Method 'POST' -Body $answerBody
        $repaired++
      } else {
        $skipped++
      }
      $verifiedIds.Add($questionId)
      continue
    }

    $questionBody = @{
      subject_id = [long]$subject.id
      lesson_id = [long]$lesson.id
      subject = [string]$subject.name
      lesson = [string]$lesson.title
      question = [string]$item.question
      options = $choices
    }
    $createdQuestion = @(Invoke-SupabaseRest -Table 'questions' -Method 'POST' -Body $questionBody)
    if ($createdQuestion.Count -ne 1 -or $null -eq $createdQuestion[0].id) { throw 'The question insert returned no id; rerun after checking the Supabase table.' }
    $questionId = [long]$createdQuestion[0].id
    try {
      $answerBody = @{ question_id = $questionId; correct_options = $correct; explanation = [string]$item.explanation }
      $null = Invoke-SupabaseRest -Table 'questions_answers' -Method 'POST' -Body $answerBody
    } catch {
      throw "Question $questionId was stored, but its correction failed. Rerunning this file will repair the missing answer row. Details: $($_.Exception.Message)"
    }
    $verifiedIds.Add($questionId)
    $inserted++
  }

  $verified = 0
  foreach ($id in $verifiedIds) {
    $q = @(Invoke-SupabaseRest -Table 'questions' -Query "select=id&subject_id=eq.$($subject.id)&lesson_id=eq.$($lesson.id)&id=eq.$id")
    $a = @(Invoke-SupabaseRest -Table 'questions_answers' -Query "select=id&question_id=eq.$id")
    if ($q.Count -eq 1 -and $a.Count -eq 1) { $verified++ }
  }
  if ($verified -ne $verifiedIds.Count) { throw "Verification failed: $verified of $($verifiedIds.Count) submitted questions have exactly one answer row." }

  [pscustomobject]@{
    File = [IO.Path]::GetFileName($File)
    Subject = [string]$subject.name
    Lesson = [string]$lesson.title
    Submitted = $items.Count
    Added = $inserted
    RepairedMissingAnswers = $repaired
    SkippedDuplicates = $skipped
    Verified = $verified
  }
}

$resolved = (Resolve-Path -LiteralPath $Path).Path
$files = if ((Get-Item -LiteralPath $resolved).PSIsContainer) {
  @(Get-ChildItem -LiteralPath $resolved -Filter '*.json' -File | Sort-Object Name | ForEach-Object { $_.FullName })
} else { @($resolved) }
if ($files.Count -lt 1) { throw "No QCM JSON files found at $Path" }

$results = foreach ($file in $files) { Publish-QcmFile -File $file }
$results | Format-Table -AutoSize
$results | Measure-Object -Property Submitted -Sum | ForEach-Object { "Total submitted: $($_.Sum)" }
$results | Measure-Object -Property Added -Sum | ForEach-Object { "Total added: $($_.Sum)" }
$results | Measure-Object -Property RepairedMissingAnswers -Sum | ForEach-Object { "Missing corrections repaired: $($_.Sum)" }
$results | Measure-Object -Property SkippedDuplicates -Sum | ForEach-Object { "Duplicates skipped: $($_.Sum)" }
$results | Measure-Object -Property Verified -Sum | ForEach-Object { "Rows verified: $($_.Sum)" }
