Add-Type -AssemblyName System.Drawing

# ------------------------------------------------------------------
# Generate brand icon assets from the supplied logo artwork.
#
# The supplied logo is a full illustration (laptop + dashboard + mascot)
# on a white background, 1280x1280. A full illustration is illegible at
# 32px, so the SMALL assets are the mascot head; the FULL artwork is kept
# for large surfaces (login page, social preview).
#
# Geometry was measured, not guessed: a saturation scan of the source
# found the coloured head at x 109..264, y 389..529, i.e. centre
# (186.5, 459). The white ring around it adds roughly 12px.
#
# A wider crop also pulls in the laptop's teal body and UI panel
# (confirmed by rendering a 4-radius comparison sheet and looking at it:
# r=62 and r=68 are clean, r=72 onward show the laptop's dock bar).
# r=62 is used because the head fills the frame best at 32px.
# ------------------------------------------------------------------

$src   = (Resolve-Path 'frontend/public/brand-logo.jpg').Path
$pub   = (Resolve-Path 'frontend/public').Path
$image = [System.Drawing.Image]::FromFile($src)
Write-Host ("Source: {0}x{1}" -f $image.Width, $image.Height)

$headR = 62      # radius of the head silhouette
$cropSize = $headR * 2
$cropX = 124     # centre 186
$cropY = 398     # centre 460
$crop = New-Object System.Drawing.Rectangle $cropX, $cropY, $cropSize, $cropSize

function New-Icon {
  param([int]$Size, [string]$Name)

  $bmp = New-Object System.Drawing.Bitmap $Size, $Size
  $g   = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.Clear([System.Drawing.Color]::White)

  # Leave a small margin so the head does not touch the canvas edge.
  $inset = [int]($Size * 0.92)
  $off   = [int](($Size - $inset) / 2)

  # Circular mask: keeps the round head, discards everything around it.
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddEllipse($off, $off, $inset, $inset)
  $g.SetClip($path)

  $dest = New-Object System.Drawing.Rectangle $off, $off, $inset, $inset
  $g.DrawImage($image, $dest, $crop, [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose()
  $path.Dispose()

  $out = Join-Path $pub $Name
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()

  Write-Host ("  OK  {0}  {1}x{1}  {2} KB" -f $Name, $Size, [math]::Round((Get-Item $out).Length / 1KB, 1))
}

Write-Host "Generating icon assets:"
New-Icon -Size 32  -Name 'favicon-32.png'
New-Icon -Size 48  -Name 'favicon-48.png'
New-Icon -Size 180 -Name 'apple-touch-icon.png'
New-Icon -Size 192 -Name 'icon-192.png'
New-Icon -Size 256 -Name 'brand-mark.png'

# Social / link preview: the full artwork, centred on a wide white canvas.
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
