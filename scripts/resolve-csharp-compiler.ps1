function Resolve-CSharpCompiler {
  $pathCompiler = Get-Command "csc.exe" -ErrorAction SilentlyContinue
  if ($pathCompiler) {
    return $pathCompiler.Source
  }

  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (Test-Path -LiteralPath $vswhere) {
    $installationPath = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -property installationPath |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
      Select-Object -First 1
    if ($installationPath) {
      $roslynCompiler = Join-Path $installationPath "MSBuild\Current\Bin\Roslyn\csc.exe"
      if (Test-Path -LiteralPath $roslynCompiler) {
        return $roslynCompiler
      }
    }
  }

  $frameworkCompilers = @(
    (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
    (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
  )
  foreach ($compiler in $frameworkCompilers) {
    if (Test-Path -LiteralPath $compiler) {
      return $compiler
    }
  }

  throw "C# compiler not found in PATH, Visual Studio Roslyn, or .NET Framework."
}