"""
Prepare the hero carousel images.

The originals are 512x279 — Google Stitch's native output size, and the ceiling on real
detail available. Two things follow:

1. Upscaling cannot invent detail, but *how* it is upscaled matters. Lanczos resampling
   followed by a restrained unsharp mask reads markedly sharper than the browser's own
   bilinear scaling, which is what happens if a 512px image is dropped into a 520px slot
   on a 2x display. We ship both a 1x and a 2x file so retina screens get the resampled
   version and everyone else gets the pristine original size.

2. The burned-in CCTV overlay text is the worst part of the frame to enlarge — it is thin,
   aliased, and already illegible at native size. It is cropped away and redrawn as live
   text in CSS, which stays crisp at any pixel density.

The visitor photo carries a competitor's brand name on the back wall. It is blurred out
with a feathered mask rather than a hard rectangle, so it reads as depth-of-field rather
than as a redaction.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

SRC = Path(
    r"C:\Users\datae\AppData\Local\Temp\claude\c--projects-watchmyGate"
    r"\4db09d52-64a2-4999-96e4-711a14d7d791\scratchpad\src-img"
)
OUT = Path(r"C:\projects\watchmyGate\apps\web-admin\public\hero")
OUT.mkdir(parents=True, exist_ok=True)

# 16:9 at 2x. The slide frame is ~520 CSS px wide, so 1024 covers a 2x display exactly.
TARGET_W, TARGET_H = 1024, 576


def cover(img: Image.Image, w: int, h: int) -> Image.Image:
    """Scale to fill w x h, cropping the overflow — CSS `object-fit: cover`."""
    src_ratio = img.width / img.height
    dst_ratio = w / h
    if src_ratio > dst_ratio:
        new_h = h
        new_w = round(h * src_ratio)
    else:
        new_w = w
        new_h = round(w / src_ratio)
    img = img.resize((new_w, new_h), Image.LANCZOS)
    left = (new_w - w) // 2
    top = (new_h - h) // 2
    return img.crop((left, top, left + w, top + h))


def blur_region(img: Image.Image, box, radius: int = 14, feather: int = 22) -> Image.Image:
    """Blur one area with a soft edge, so it looks like shallow focus, not a censor bar."""
    blurred = img.filter(ImageFilter.GaussianBlur(radius))
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, radius=18, fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(feather))
    out = img.copy()
    out.paste(blurred, (0, 0), mask)
    return out


def finish(img: Image.Image, name: str) -> None:
    """Resample to 2x, sharpen, and write both densities as WebP."""
    big = cover(img, TARGET_W, TARGET_H)
    # Restrained: enough to recover the edge definition Lanczos softens, not enough to
    # halo. Percent is low and threshold non-zero so flat sky and tarmac stay clean.
    big = big.filter(ImageFilter.UnsharpMask(radius=1.6, percent=105, threshold=3))
    big.save(OUT / f"{name}@2x.webp", "WEBP", quality=92, method=6)

    small = cover(img, TARGET_W // 2, TARGET_H // 2)
    small = small.filter(ImageFilter.UnsharpMask(radius=1.0, percent=70, threshold=3))
    small.save(OUT / f"{name}.webp", "WEBP", quality=90, method=6)

    print(f"{name:14s} {big.size[0]}x{big.size[1]} + {small.size[0]}x{small.size[1]}")


# --- 1. Visitor pre-authorisation at the concierge desk -----------------------
visitor = Image.open(SRC / "img3.jpg").convert("RGB")
# The back wall carries another product's name in large letters. Softened out.
visitor = blur_region(visitor, (322, 8, 512, 108), radius=16, feather=24)
# The same name again in the tablet's own header bar. Smaller radius and tighter feather
# so it reads as screen glare rather than a patch.
visitor = blur_region(visitor, (198, 56, 268, 74), radius=5, feather=6)
finish(visitor, "visitor-desk")

# --- 2. Main entrance camera --------------------------------------------------
lpr = Image.open(SRC / "img9.jpg").convert("RGB")
# Top 20px is burned-in OSD text; redrawn live in CSS.
lpr = lpr.crop((0, 20, lpr.width, lpr.height))
finish(lpr, "gate-entry")

# --- 3. Exit camera -----------------------------------------------------------
exit_cam = Image.open(SRC / "img10.jpg").convert("RGB")
exit_cam = exit_cam.crop((0, 16, exit_cam.width, exit_cam.height))
finish(exit_cam, "gate-exit")

for f in sorted(OUT.iterdir()):
    print(f"  {f.name:24s} {f.stat().st_size // 1024:4d} KB")
