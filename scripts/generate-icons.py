"""生成扩展图标（需要 Pillow）：python scripts/generate-icons.py"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

SIZE = 512
image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)

# 橙色圆角底，采用与界面一致的下载主色。
for y in range(SIZE):
    ratio = y / (SIZE - 1)
    r = int(255 + (240 - 255) * ratio)
    g = int(122 + (68 - 122) * ratio)
    b = int(69 + (36 - 69) * ratio)
    draw.line([(0, y), (SIZE, y)], fill=(r, g, b, 255))
mask = Image.new("L", (SIZE, SIZE), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), radius=132, fill=255)
image.putalpha(mask)

draw = ImageDraw.Draw(image)
# 播放三角（暗示视频）
draw.polygon(
    [(160, 155), (160, 305), (272, 230)],
    fill=(255, 255, 255, 242),
)
# 下载箭头
stroke = 34
cx = 328
draw.line([(cx, 136), (cx, 294)], fill=(255, 255, 255, 255), width=stroke)
draw.line([(cx - 69, 229), (cx, 298), (cx + 69, 229)], fill=(255, 255, 255, 255), width=stroke, joint="curve")
# 下载托盘
draw.rounded_rectangle((176, 358, 430, 400), radius=18, fill=(255, 255, 255, 238))

for size in (16, 32, 48, 128):
    resized = image.resize((size, size), Image.Resampling.LANCZOS)
    resized.save(OUT / f"icon{size}.png", optimize=True)

print(f"Icons written to {OUT}")
