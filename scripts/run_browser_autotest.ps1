$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$out = "$env:TEMP\autotest_dom.html"
$userDir = "$env:TEMP\chr_autotest_" + (Get-Random)

Write-Host "Launching Chrome headless with WebGL SwiftShader..."
& $chrome --headless=new --disable-gpu-sandbox --enable-unsafe-swiftshader --use-angle=swiftshader --no-first-run --user-data-dir="$userDir" --virtual-time-budget=120000 --run-all-compositor-stages-before-draw --dump-dom "http://localhost:8000/?autotest=1" | Out-File -Encoding utf8 $out

if (Test-Path $out) {
    $html = Get-Content $out -Raw
    Write-Host ("DOM captured: " + $html.Length + " bytes")
    $m = [regex]::Match($html, '<pre id="autotestResult"[^>]*>(.*?)</pre>', 'Singleline')
    if ($m.Success) {
        $json = [System.Net.WebUtility]::HtmlDecode($m.Groups[1].Value)
        $json | Out-File -Encoding utf8 "$env:TEMP\autotest.json"
        $results = $json | ConvertFrom-Json
        Write-Host "======================================================================"
        Write-Host "IN-BROWSER REAL-ENGINE VERIFICATION RESULTS"
        Write-Host "======================================================================"
        $passCount = 0
        $totalCount = 0
        foreach ($r in $results) {
            $totalCount++
            if ($r.status -eq "PASS") { $passCount++ }
            Write-Host ("{0,-11} {1,-28} {2,-5} {3}" -f $r.scenario, $r.checkId, $r.status, $r.details)
        }
        Write-Host "======================================================================"
        Write-Host "SUMMARY: $passCount / $totalCount CHECKS PASSED IN HEADLESS CHROME"
        Write-Host "======================================================================"
    } else {
        Write-Host "autotestResult element not found in DOM yet."
        $title = [regex]::Match($html, '<title>(.*?)</title>').Groups[1].Value
        Write-Host "Page Title: $title"
    }
} else {
    Write-Host "Failed to produce $out"
}
