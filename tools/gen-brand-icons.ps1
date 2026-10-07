Add-Type -AssemblyName System.Drawing

# ------------------------------------------------------------------
# Generate brand icon assets from the supplied logo artwork.
#
# The supplied logo is a single square illustration (1280x1280). Per
# instruction, the WHOLE artwork is used at every size - no cropping.
# Earlier revisions used a cropped head for the small sizes; that has
# been dropped deliberately, so do not reintroduce a crop here.
# ------------------------------------------------------------------

$src   = (Resolve-Path 'frontend/public/brand-logo.jpg').Path
$pub   = (Resolve-Path 'frontend/public').Path
$image = [System.Drawing.Image]::FromFile($src)
Write-Host ("Source: {0}x{1}" -f $image.Width, $image.Height)

function New-Icon {
  param([int]$Size, [string]$Name)

  $bmp = New-Object System.Drawing.Bitmap $Size, $Size
  $g   = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  # The artwork sits on white, so white is the correct backdrop.
  $g.Clear([System.Drawing.Color]::White)

  $dest = New-Object System.Drawing.Rectangle 0, 0, $Size, $Size
  $g.DrawImage($image, $dest)
  $g.Dispose()

  $out = Join-Path $pub $Name
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()

  Write-Host ("  OK  {0}  {1}x{1}  {2} KB" -f $Name, $Size, [math]::Round((Get-Item $out).Length / 1KB, 1))
}

Write-Host "Generating icon assets (full artwork):"
New-Icon -Size 32  -Name 'favicon-32.png'
New-Icon -Size 48  -Name 'favicon-48.png'
New-Icon -Size 180 -Name 'apple-touch-icon.png'
New-Icon -Size 192 -Name 'icon-192.png'
New-Icon -Size 256 -Name 'brand-mark.png'

# Social / link preview: the same artwork, centred on a wide white canvas.
$ogW = 1200; $ogH = 630; $side = 560
$og = New-Object System.Drawing.Bitmap $ogW, $ogH
$go = [System.Drawing.Graphics]::FromImage($og)
$go.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$go.Clear([System.Drawing.Color]::White)
$go.DrawImage($image, (New-Object System.Drawing.Rectangle ([int](($ogW - $side) / 2)), 35, $side, $side))
$go.Dispose()
$ogPath = Join-Path $pub 'og-cover.png'
$og.Save($ogPath, [System.Drawing.Imaging.ImageFormat]::Png)
$og.Dispose()
Write-Host ("  OK  og-cover.png  {0}x{1}  {2} KB" -f $ogW, $ogH, [math]::Round((Get-Item $ogPath).Length / 1KB, 1))

$image.Dispose()
Write-Host "Done." -ForegroundColor Green
