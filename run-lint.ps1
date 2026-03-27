# run-dev.ps1

# Node portable
$NodePortable = "D:\Software\node-v24.11.0-win-x64\node-v24.11.0-win-x64"

# Thêm Node portable vào PATH
$env:PATH = "$NodePortable;$env:PATH"

Write-Host "Node version: $(node -v)"
Write-Host "Starting Redmine MCP Server (dev mode with auto-reload)..."

# Chuyển vào thư mục project
$ProjectPath = "D:\quangnv\Code\SUB_SERVICE\mcp-server"
Set-Location $ProjectPath

# Chạy dev server React
Write-Host "Starting React dev server..."
& "$NodePortable\npm.cmd" run lint
