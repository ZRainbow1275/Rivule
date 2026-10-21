#requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$appRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$wrangler = Join-Path $appRoot 'node_modules/wrangler/bin/wrangler.js'
$config = Join-Path $appRoot 'wrangler.jsonc'
$workerName = 'rivule-bridge'
$publicOrigin = 'https://rivule-bridge.hybridrevis.workers.dev'

if (-not (Test-Path -LiteralPath $wrangler -PathType Leaf)) {
    throw '请先在 app-bridge 目录运行 npm ci。'
}
if (-not (Test-Path -LiteralPath $config -PathType Leaf)) {
    throw '未找到 wrangler.jsonc。'
}
$node = (Get-Command node -CommandType Application -ErrorAction Stop).Source

Write-Host '将为 rivule-bridge 更新三个 Worker Secrets。输入均隐藏，不创建凭据文件。'
Write-Host "Google 授权回调必须为：$publicOrigin/auth/google/callback"
Write-Host '请先确认当前 Wrangler 已登录正确的 Cloudflare 账户。'
$idSecure = $null
$secretSecure = $null
$invitesSecure = $null
$process = $null

try {
    $idSecure = Read-Host 'Google Client ID' -AsSecureString
    $secretSecure = Read-Host 'Google Client Secret' -AsSecureString
    $invitesSecure = Read-Host '首批受邀邮箱，逗号分隔（包含你的 Google 邮箱）' -AsSecureString
    $clientId = [System.Net.NetworkCredential]::new('', $idSecure).Password.Trim()
    $clientSecret = [System.Net.NetworkCredential]::new('', $secretSecure).Password.Trim()
    $invitesText = [System.Net.NetworkCredential]::new('', $invitesSecure).Password

    if ($clientId -notmatch '^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$') {
        throw 'Google Client ID 格式无效，请复制 Web application 客户端的 Client ID。'
    }
    if ([string]::IsNullOrWhiteSpace($clientSecret) -or $clientSecret.Contains("`n") -or $clientSecret.Contains("`r")) {
        throw 'Google Client Secret 不能为空或包含换行。'
    }
    $invited = @($invitesText.Split(',') | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ } | Select-Object -Unique)
    if ($invited.Count -lt 1 -or $invited.Count -gt 200) {
        throw '请输入 1 至 200 个受邀邮箱。'
    }
    foreach ($email in $invited) {
        $parsed = [System.Net.Mail.MailAddress]::new($email)
        if ($parsed.Address -cne $email -or $email.Length -gt 254 -or $email -match '[\r\n\s]') {
            throw '受邀名单包含无效邮箱，请只输入邮箱地址。'
        }
    }
    $inviteJson = ConvertTo-Json -InputObject $invited -Compress
    $payload = [ordered]@{
        GOOGLE_CLIENT_ID = $clientId
        GOOGLE_CLIENT_SECRET = $clientSecret
        INVITED_EMAILS = $inviteJson
    } | ConvertTo-Json -Compress

    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $node
    $start.WorkingDirectory = $appRoot
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.EnvironmentVariables['WRANGLER_LOG'] = 'warn'
    $start.EnvironmentVariables['WRANGLER_SEND_METRICS'] = 'false'
    $start.Arguments = '"{0}" secret bulk --config "{1}" --name {2}' -f $wrangler, $config, $workerName
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $start
    [void]$process.Start()
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($payload)
    $process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $process.StandardInput.BaseStream.Flush()
    $process.StandardInput.Close()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
        throw "Wrangler 上传失败（退出码 $($process.ExitCode)）。请检查账户和 Worker 权限后重试。"
    }

    $status = Invoke-RestMethod -Method Get -Uri "$publicOrigin/auth/status" -TimeoutSec 20
    if (-not $status.googleConfigured -or $status.setupRequired) {
        throw 'Secrets 已上传，但认证服务仍未配置完成；请检查已部署版本和认证存储绑定。'
    }
    Write-Host "配置已写入。请打开 $publicOrigin/，用受邀 Google 邮箱完成首次登录。"
}
finally {
    $clientId = $null
    $clientSecret = $null
    $invitesText = $null
    $invited = $null
    $inviteJson = $null
    $payload = $null
    if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    if ($idSecure) { $idSecure.Dispose() }
    if ($secretSecure) { $secretSecure.Dispose() }
    if ($invitesSecure) { $invitesSecure.Dispose() }
    if ($process) { $process.Dispose() }
}
