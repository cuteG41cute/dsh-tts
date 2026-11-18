# install.ps1 — dsh-tts 一键安装（Windows）
# 做两件事：① 复制包到 ~/.dsh/profiles/web/node_modules/dsh-tts
#           ② 在 ~/.dsh/profiles/web/cordis.patch.yml 追加接线块（幂等）
$ErrorActionPreference = "Stop"

$pkgName = "dsh-tts"
$src = $PSScriptRoot
$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\web"
$nodeDir = Join-Path $profileDir ("node_modules\" + $pkgName)
$patchFile = Join-Path $profileDir "cordis.patch.yml"

if (-not (Test-Path $profileDir)) {
    Write-Host ("未找到 profile 目录: " + $profileDir) -ForegroundColor Red
    Write-Host "先启动一次 dsh web 让它生成 profile，再运行本脚本。" -ForegroundColor Red
    exit 1
}

# ① 复制包
New-Item -ItemType Directory -Force (Join-Path $nodeDir "lib") | Out-Null
Copy-Item (Join-Path $src "package.json") $nodeDir -Force
Copy-Item (Join-Path $src "lib\index.js") (Join-Path $nodeDir "lib") -Force
Copy-Item (Join-Path $src "lib\client.js") (Join-Path $nodeDir "lib") -Force
Write-Host ("OK 包已复制到 " + $nodeDir)

# ② 接线（幂等：已有 dsh-tts 条目就跳过）
$blockLines = @(
    "",
    "# ── installed-by: dsh-tts ──",
    "- insert:",
    ("    - id: " + $pkgName),
    ("      name: '" + $pkgName + "'")
)

$needAppend = $true
if (Test-Path $patchFile) {
    $patch = Get-Content $patchFile -Raw
    if ($patch -match '(?m)^\s*-\s+id:\s*dsh-tts\s*$') {
        Write-Host "• cordis.patch.yml 已有 dsh-tts 条目，跳过"
        $needAppend = $false
    }
} else {
    $header = "# Your patch layer for this dsh profile (array of - insert: entries)."
    Set-Content -Path $patchFile -Value $header -Encoding UTF8
}

if ($needAppend) {
    $block = [string]::Join([Environment]::NewLine, $blockLines) + [Environment]::NewLine
    Add-Content -Path $patchFile -Value $block -Encoding UTF8
    Write-Host "OK cordis.patch.yml 已追加接线块"
}

Write-Host ""
Write-Host "完成。请重启一次 harness（关掉窗口重新打开）让宿主半部加载。" -ForegroundColor Green
Write-Host "然后点会话头部「朗读」芯片配置 TTS 端点。"
