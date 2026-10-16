"""Генерує фірмові ресурси W3IR Browser з концепт-зображень у build/brand/.

Запуск: npm run icon   (потрібні Python 3, Pillow, numpy, scipy)

Вхід:   build/brand/concept-logo.jpg  — логотип із фоном
Вихід:  build/icon.png (256, значок застосунку й інсталятора), build/brand/icon-512.png,
        pages/brand-mark.png (знак із м'яким краєм), pages/brand-wordmark.png (вордмарк без фону),
        pages/brand-favicon.png, build/installerSidebar.bmp, build/installerHeader.bmp (NSIS).
"""
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
P = lambda *a: os.path.join(ROOT, *a)
INDIGO = (30, 27, 75)

src = Image.open(P('build', 'brand', 'concept-logo.jpg')).convert('RGB')

# --- квадрат із «оком» (без вордмарка внизу) ---
cx, cy, h = 560, 385, 285
square = src.crop((cx - h, cy - h, cx + h, cy + h)).resize((1024, 1024), Image.LANCZOS)


def rounded(img, size, radius):
    m = Image.new('L', (size * 4, size * 4), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size * 4 - 1, size * 4 - 1), radius=radius * 4, fill=255)
    out = img.resize((size, size), Image.LANCZOS).convert('RGBA')
    out.putalpha(m.resize((size, size), Image.LANCZOS))
    return out


icon = rounded(square, 512, 112)
icon.save(P('build', 'brand', 'icon-512.png'), optimize=True)
icon.resize((256, 256), Image.LANCZOS).save(P('build', 'icon.png'), optimize=True)
rounded(square, 64, 14).save(P('pages', 'brand-favicon.png'), optimize=True)

# --- знак із м'яким краєм (для темних фонів) ---
size = 512
mask = Image.new('L', (size, size), 0)
ImageDraw.Draw(mask).ellipse((16, 16, size - 16, size - 16), fill=255)
mark = square.resize((size, size), Image.LANCZOS).convert('RGBA')
mark.putalpha(mask.filter(ImageFilter.GaussianBlur(10)))
mark.save(P('pages', 'brand-mark.png'), optimize=True)

# --- вордмарк: вирізання з фону за яскравістю (срібло) і синім кольором («3») ---
crop = src.crop((350, 690, 800, 860)).resize((1350, 510), Image.LANCZOS)
a = np.asarray(crop).astype(float)
R, G, B = a[..., 0], a[..., 1], a[..., 2]
lum = 0.3 * R + 0.59 * G + 0.11 * B
PAD = 60  # відбиття країв, щоб фільтр фону не створював рамку біля меж зображення
padded = np.pad(lum, PAD, mode='edge')
bg = np.asarray(Image.fromarray(padded.astype('uint8')).filter(ImageFilter.MinFilter(41)).filter(ImageFilter.GaussianBlur(25))).astype(float)[PAD:-PAD, PAD:-PAD]
silver = np.clip((lum - bg - 35) / 55, 0, 1)
blue = np.clip(((B - R) - 70) / 50, 0, 1) * np.clip((B - 110) / 40, 0, 1)
alpha = np.maximum(silver, blue)
alpha[:10, :] = alpha[-10:, :] = 0
alpha[:, :10] = alpha[:, -10:] = 0
alpha = np.where(alpha < 0.08, 0, alpha)
lab, n = ndimage.label(alpha > 0.16)
sizes = ndimage.sum(np.ones_like(lab), lab, range(1, n + 1))
keep = ndimage.binary_dilation(np.isin(lab, [i + 1 for i, s in enumerate(sizes) if s > 1500]), iterations=6)
alpha = np.where(keep, alpha, 0)
word = Image.fromarray(np.dstack([a, alpha * 255]).astype('uint8'), 'RGBA')
word = word.crop(word.getchannel('A').point(lambda v: 255 if v > 40 else 0).getbbox())
word = word.resize((700, round(700 * word.height / word.width)), Image.LANCZOS)
word.save(P('pages', 'brand-wordmark.png'), optimize=True)


# --- зображення NSIS-інсталятора (24-бітний BMP) ---
def gradient(w, hgt):
    img = Image.new('RGB', (w, hgt), INDIGO)
    px = img.load()
    for y in range(hgt):
        t = y / max(1, hgt - 1)
        for x in range(w):
            u = (t * 0.8 + x / w * 0.2)
            px[x, y] = (int(30 + 40 * u), int(27 + 6 * u), int(75 + 55 * u))
    return img


side = gradient(164, 314)
mk = mark.resize((136, 136), Image.LANCZOS)
side.paste(mk, (14, 40), mk)
wm = word.resize((132, round(132 * word.height / word.width)), Image.LANCZOS)
side.paste(wm, (16, 190), wm)
side.save(P('build', 'installerSidebar.bmp'))
head = gradient(150, 57)
wm2 = word.resize((96, round(96 * word.height / word.width)), Image.LANCZOS)
head.paste(wm2, (27, (57 - wm2.height) // 2), wm2)
head.save(P('build', 'installerHeader.bmp'))
print('Готово')
