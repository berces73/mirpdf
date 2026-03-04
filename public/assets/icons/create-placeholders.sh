#!/bin/bash

# Bu script basit placeholder görseller oluşturur
# ImageMagick gerektirir: sudo apt install imagemagick

echo "Placeholder görseller oluşturuluyor..."

# OG Image (1200x630)
convert -size 1200x630 xc:'#6366f1' \
  -font Arial-Bold -pointsize 72 -fill white \
  -gravity center -annotate +0-50 'PDF Platform' \
  -pointsize 36 -annotate +0+50 'Güvenli PDF Araçları' \
  og-image.jpg 2>/dev/null || echo "ImageMagick yüklü değil, manuel oluşturun"

# Icon 192x192
convert -size 192x192 xc:'#6366f1' \
  -font Arial-Bold -pointsize 120 -fill white \
  -gravity center -annotate +0+0 'P' \
  icon-192.png 2>/dev/null

# Icon 512x512
convert -size 512x512 xc:'#6366f1' \
  -font Arial-Bold -pointsize 320 -fill white \
  -gravity center -annotate +0+0 'P' \
  icon-512.png 2>/dev/null

echo "✅ Placeholders oluşturuldu (eğer ImageMagick yüklüyse)"
echo "Gerçek görselleri Canva/Figma ile oluşturup buraya koyun!"
