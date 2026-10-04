$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$workDir = "C:\Users\saksh\OneDrive\Desktop\SIH_AEROSAR"
$artifactDir = "C:\Users\saksh\.gemini\antigravity\brain\257bb128-2159-43e9-b583-7859ae881039"
$scrWork = "$workDir\screenshots"
$scrArt = "$artifactDir\screenshots"

if (!(Test-Path $scrWork)) { New-Item -ItemType Directory -Force -Path $scrWork | Out-Null }
if (!(Test-Path $scrArt)) { New-Item -ItemType Directory -Force -Path $scrArt | Out-Null }

$scenarios = @(
    @{ name = "earthquake"; tab = 0 },
    @{ name = "floods"; tab = 1 },
    @{ name = "wildfire"; tab = 2 },
    @{ name = "volcano"; tab = 4 },
    @{ name = "tsunami"; tab = 5 },
    @{ name = "landslide"; tab = 6 }
)

$phases = @("start", "mid", "coverage", "nonetwork")

foreach ($sc in $scenarios) {
    foreach ($ph in $phases) {
        $outFile = "$scrWork\$($sc.name)_$ph.png"
        $artFile = "$scrArt\$($sc.name)_$ph.png"
        $userDir = "$env:TEMP\chr_scr_" + (Get-Random)
        $domFile = "$env:TEMP\dom_" + (Get-Random) + ".html"
        $url = "http://localhost:8000/?tab=$($sc.tab)&phase=$ph"
        
        Write-Host "Capturing $($sc.name) ($ph)..."
        & $chrome --headless=new --disable-gpu-sandbox --enable-unsafe-swiftshader --use-angle=swiftshader --no-first-run --user-data-dir="$userDir" --run-all-compositor-stages-before-draw --virtual-time-budget=20000 --dump-dom "$url" 2>$null | Out-File -Encoding utf8 $domFile
        
        if (Test-Path $domFile) {
            $html = Get-Content $domFile -Raw
            $m = [regex]::Match($html, '<pre id="screenshotData"[^>]*>(.*?)</pre>', 'Singleline')
            if ($m.Success) {
                $raw = $m.Groups[1].Value.Trim()
                $base64 = $raw -replace '^data:image\/png;base64,', ''
                try {
                    $bytes = [System.Convert]::FromBase64String($base64)
                    [System.IO.File]::WriteAllBytes($outFile, $bytes)
                    [System.IO.File]::WriteAllBytes($artFile, $bytes)
                    Write-Host "  -> Successfully saved: $($sc.name)_$ph.png ($($bytes.Length) bytes)"
                } catch {
                    Write-Host "  -> Base64 decode error: $_"
                }
            } else {
                Write-Host "  -> screenshotData element not found in DOM (DOM length: $($html.Length))"
            }
            Remove-Item -Force $domFile -ErrorAction SilentlyContinue
        } else {
            Write-Host "  -> DOM dump failed"
        }
        Remove-Item -Recurse -Force $userDir -ErrorAction SilentlyContinue
    }
}

Write-Host "Screenshot capture routine completed."
