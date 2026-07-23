from __future__ import annotations

import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "social"
OUTPUT = OUT_DIR / "flipper-fap-studio-tiktok.mp4"
COVER = OUT_DIR / "flipper-fap-studio-tiktok-cover.png"

W, H = 1080, 1920
FPS = 30
ORANGE = "#ff8c1a"
ORANGE_RED = "#ff5a36"
INK = "#090b0f"
PANEL = "#11151b"
PANEL_2 = "#171c24"
WHITE = "#f7f8fa"
MUTED = "#aab2bf"
BLUE = "#1689d8"

FONT_REGULAR = Path(r"C:\Windows\Fonts\segoeui.ttf")
FONT_BOLD = Path(r"C:\Windows\Fonts\segoeuib.ttf")
FONT_MONO = Path(r"C:\Windows\Fonts\consolab.ttf")


def font(size: int, bold: bool = False, mono: bool = False) -> ImageFont.FreeTypeFont:
    path = FONT_MONO if mono else (FONT_BOLD if bold else FONT_REGULAR)
    return ImageFont.truetype(str(path), size=size)


def add_glow(canvas: Image.Image, center: tuple[int, int], color: str = ORANGE) -> None:
    glow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(glow)
    x, y = center
    d.ellipse((x - 520, y - 520, x + 520, y + 520), fill=(*ImageColor(color), 50))
    glow = glow.filter(ImageFilter.GaussianBlur(180))
    canvas.alpha_composite(glow)


def ImageColor(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))


def background(glow_center: tuple[int, int] = (850, 420)) -> Image.Image:
    canvas = Image.new("RGBA", (W, H), INK)
    add_glow(canvas, glow_center)
    d = ImageDraw.Draw(canvas, "RGBA")
    for x in range(0, W + 1, 60):
        d.line((x, 0, x, H), fill=(255, 140, 26, 15), width=1)
    for y in range(0, H + 1, 60):
        d.line((0, y, W, y), fill=(255, 140, 26, 15), width=1)
    d.line((72, 82, W - 72, 82), fill=(255, 255, 255, 26), width=2)
    return canvas


def rounded_mask(size: tuple[int, int], radius: int) -> Image.Image:
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius, fill=255)
    return mask


def paste_card(
    canvas: Image.Image,
    source: Image.Image,
    box: tuple[int, int, int, int],
    *,
    radius: int = 30,
    border: str = "#343b46",
    border_width: int = 3,
    focus: tuple[float, float] = (0.5, 0.5),
) -> None:
    x1, y1, x2, y2 = box
    size = (x2 - x1, y2 - y1)
    fitted = ImageOps.fit(source.convert("RGB"), size, method=Image.Resampling.LANCZOS, centering=focus)
    mask = rounded_mask(size, radius)

    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle((x1 + 4, y1 + 18, x2 + 4, y2 + 18), radius, fill=(0, 0, 0, 190))
    shadow = shadow.filter(ImageFilter.GaussianBlur(24))
    canvas.alpha_composite(shadow)
    canvas.paste(fitted, (x1, y1), mask)
    ImageDraw.Draw(canvas).rounded_rectangle(box, radius, outline=border, width=border_width)


def text_center(
    d: ImageDraw.ImageDraw,
    y: int,
    text: str,
    size: int,
    *,
    fill: str = WHITE,
    bold: bool = True,
    spacing: int = 4,
) -> None:
    d.multiline_text(
        (W // 2, y),
        text,
        font=font(size, bold=bold),
        fill=fill,
        anchor="ma",
        align="center",
        spacing=spacing,
    )


def pill(
    d: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    text: str,
    *,
    size: int = 27,
    fill: str = PANEL_2,
    outline: str = "#3b424d",
    text_fill: str = WHITE,
    pad_x: int = 23,
    height: int = 54,
) -> tuple[int, int, int, int]:
    f = font(size, bold=True)
    bbox = d.textbbox((0, 0), text, font=f)
    width = bbox[2] - bbox[0] + 2 * pad_x
    x, y = xy
    rect = (x, y, x + width, y + height)
    d.rounded_rectangle(rect, height // 2, fill=fill, outline=outline, width=2)
    d.text((x + width // 2, y + height // 2 - 1), text, font=f, fill=text_fill, anchor="mm")
    return rect


def section_label(d: ImageDraw.ImageDraw, text: str, number: str) -> None:
    pill(d, (72, 120), number, size=23, fill=ORANGE, outline=ORANGE, text_fill=INK, pad_x=18, height=48)
    d.text((154, 144), text, font=font(25, bold=True), fill=MUTED, anchor="lm")


def footer(d: ImageDraw.ImageDraw, text: str = "FLIPPER FAP STUDIO  •  FREE VS CODE EXTENSION") -> None:
    d.line((72, 1742, W - 72, 1742), fill="#303742", width=2)
    d.text((W // 2, 1788), text, font=font(25, bold=True), fill=MUTED, anchor="mm")


def load_image(relative: str) -> Image.Image:
    return Image.open(ROOT / relative).convert("RGBA")


def hook_slide() -> Image.Image:
    canvas = background((540, 690))
    d = ImageDraw.Draw(canvas)
    section_label(d, "BUILD • LAUNCH • TEST", "NEW")

    logo = load_image("media/fap-studio-color-icon.png").crop((55, 55, 1199, 1199))
    paste_card(canvas, logo, (320, 300, 760, 740), radius=64, border="#4d5663", border_width=3)

    text_center(d, 845, "BUILD FLIPPER ZERO APPS", 56)
    text_center(d, 930, "WITHOUT THE\nCOMMAND LINE", 68, fill=ORANGE, spacing=0)
    text_center(d, 1115, "Meet Flipper FAP Studio", 38, fill=WHITE, bold=False)
    text_center(d, 1172, "A GUI-first VS Code extension for .fap development", 29, fill=MUTED, bold=False)

    labels = ["DESIGN", "BUILD", "LAUNCH", "DEBUG"]
    widths = []
    for label in labels:
        f = font(24, bold=True)
        bb = d.textbbox((0, 0), label, font=f)
        widths.append(bb[2] - bb[0] + 42)
    total = sum(widths) + 18 * (len(labels) - 1)
    x = (W - total) // 2
    for label, width in zip(labels, widths):
        d.rounded_rectangle((x, 1305, x + width, 1361), 28, fill=PANEL_2, outline="#3a424e", width=2)
        d.text((x + width // 2, 1333), label, font=font(24, bold=True), fill=WHITE, anchor="mm")
        x += width + 18

    d.rounded_rectangle((150, 1480, W - 150, 1585), 52, fill=ORANGE)
    d.text((W // 2, 1531), "FREE ON THE VS CODE MARKETPLACE", font=font(31, bold=True), fill=INK, anchor="mm")
    footer(d, "FLIPPER FAP STUDIO  •  BY COOLSHRIMP")
    return canvas


def designer_slide() -> Image.Image:
    canvas = background((900, 620))
    d = ImageDraw.Draw(canvas)
    section_label(d, "VISUAL UI DESIGNER", "01")
    text_center(d, 214, "DESIGN 128 × 64 UIs", 58)
    text_center(d, 290, "VISUALLY", 66, fill=ORANGE)
    text_center(d, 382, "Drag, drop, draw—and keep the code in sync.", 31, fill=MUTED, bold=False)

    shot = load_image("screenshots/ScreenshotUiDesigner.png")
    paste_card(canvas, shot, (70, 472, 1010, 1102), radius=32, border="#5c6470")

    tag_y = 1165
    tags = ["CANVAS ↔ CODE", "IMPORT IMAGES", "MULTI-SCREEN"]
    tag_widths = [292, 292, 292]
    x = 72
    for label, width in zip(tags, tag_widths):
        d.rounded_rectangle((x, tag_y, x + width, tag_y + 72), 22, fill=PANEL_2, outline="#3a424e", width=2)
        d.ellipse((x + 18, tag_y + 25, x + 38, tag_y + 45), fill=ORANGE)
        d.text((x + 52, tag_y + 36), label, font=font(22, bold=True), fill=WHITE, anchor="lm")
        x += width + 30

    d.rounded_rectangle((72, 1295, W - 72, 1538), 28, fill="#0d1015", outline="#343b46", width=2)
    d.text((112, 1340), "DRAW", font=font(25, bold=True), fill=ORANGE, anchor="lm")
    d.text((112, 1391), "Text • shapes • icons • freehand pixels", font=font(31), fill=WHITE, anchor="lm")
    d.text((112, 1455), "GENERATE", font=font(25, bold=True), fill=ORANGE, anchor="lm")
    d.text((112, 1506), "Screen code—or a complete app", font=font(31), fill=WHITE, anchor="lm")
    footer(d)
    return canvas


def generate_slide() -> Image.Image:
    canvas = background((820, 650))
    d = ImageDraw.Draw(canvas)
    section_label(d, "CODE GENERATION", "02")
    text_center(d, 214, "GENERATE A COMPLETE", 56)
    text_center(d, 290, "BUILDABLE APP", 66, fill=ORANGE)
    text_center(d, 380, "Your design and C code stay side by side.", 31, fill=MUTED, bold=False)

    full = load_image("screenshots/ScreenshotUiDashboard.png")
    crop = full.crop((945, 32, 2540, 1220))
    paste_card(canvas, crop, (70, 468, 1010, 1168), radius=32, border="#5c6470", focus=(0.56, 0.44))

    features = [
        ("FULL main.c", "Draw + input callbacks"),
        ("application.fam", "Ready-to-build scaffold"),
        ("uFBT READY", "Create, build, and run"),
    ]
    y = 1228
    for title, detail in features:
        d.rounded_rectangle((72, y, W - 72, y + 88), 24, fill=PANEL_2, outline="#343b46", width=2)
        d.rounded_rectangle((94, y + 21, 128, y + 67), 11, fill=ORANGE)
        d.text((154, y + 29), title, font=font(27, bold=True), fill=WHITE, anchor="la")
        d.text((W - 102, y + 45), detail, font=font(25), fill=MUTED, anchor="rm")
        y += 106
    footer(d)
    return canvas


def build_slide() -> Image.Image:
    canvas = background((280, 880))
    d = ImageDraw.Draw(canvas)
    section_label(d, "ONE-CLICK WORKFLOW", "03")
    text_center(d, 214, "BUILD + LAUNCH", 66, fill=ORANGE)
    text_center(d, 302, "IN ONE CLICK", 58)
    text_center(d, 388, "The USB connection hands itself over automatically.", 29, fill=MUTED, bold=False)

    sidebar = load_image("screenshots/ScreenshotSidebar.png").crop((0, 0, 315, 660))
    sd = ImageDraw.Draw(sidebar)
    sd.rounded_rectangle((12, 130, 303, 205), 12, outline=ORANGE, width=5)
    paste_card(canvas, sidebar, (258, 460, 822, 1620), radius=32, border=ORANGE, border_width=4, focus=(0.5, 0.0))

    d.rounded_rectangle((72, 1518, 392, 1598), 40, fill=ORANGE)
    d.text((232, 1558), "ONE USB CABLE", font=font(25, bold=True), fill=INK, anchor="mm")
    d.rounded_rectangle((688, 1518, 1008, 1598), 40, fill=PANEL_2, outline="#444c58", width=2)
    d.text((848, 1558), "NO PORT JUGGLING", font=font(24, bold=True), fill=WHITE, anchor="mm")

    text_center(d, 1660, "OEM • RogueMaster • Momentum • Unleashed", 26, fill=MUTED, bold=False)
    footer(d)
    return canvas


def live_slide() -> Image.Image:
    canvas = background((820, 660))
    d = ImageDraw.Draw(canvas)
    section_label(d, "DEVICE TOOLS", "04")
    text_center(d, 214, "MIRROR • CONTROL • LOG", 55)
    text_center(d, 292, "OVER ONE USB CABLE", 58, fill=ORANGE)
    text_center(d, 382, "Drive the real Flipper without leaving VS Code.", 31, fill=MUTED, bold=False)

    shot = load_image("screenshots/ScreenshotLivePopout.png")
    paste_card(canvas, shot, (70, 468, 1010, 1124), radius=32, border="#5c6470", focus=(0.5, 0.46))

    features = [
        ("LIVE SCREEN", "Real-time USB mirror"),
        ("D-PAD + KEYS", "Click or use the keyboard"),
        ("DEVICE LOGS", "RPC and debug output"),
    ]
    y = 1190
    for i, (title, detail) in enumerate(features):
        d.rounded_rectangle((72, y, W - 72, y + 104), 24, fill=PANEL_2, outline="#353d49", width=2)
        d.text((104, y + 32), f"0{i + 1}", font=font(22, bold=True, mono=True), fill=ORANGE, anchor="la")
        d.text((182, y + 31), title, font=font(28, bold=True), fill=WHITE, anchor="la")
        d.text((W - 102, y + 53), detail, font=font(25), fill=MUTED, anchor="rm")
        y += 120

    text_center(d, 1600, "Save screenshots • reset the device • browse files", 29, fill=WHITE, bold=False)
    footer(d)
    return canvas


def end_slide() -> Image.Image:
    canvas = background((540, 660))
    d = ImageDraw.Draw(canvas)
    section_label(d, "FREE • OPEN SOURCE", "GET")

    logo = load_image("media/fap-studio-color-icon.png").crop((55, 55, 1199, 1199))
    paste_card(canvas, logo, (340, 300, 740, 700), radius=58, border="#4d5663")

    text_center(d, 805, "FLIPPER", 76)
    text_center(d, 900, "FAP STUDIO", 82, fill=ORANGE)
    text_center(d, 1018, "Design → Build → Launch → Test", 36, fill=WHITE, bold=False)
    text_center(d, 1072, "All inside VS Code.", 32, fill=MUTED, bold=False)

    d.rounded_rectangle((130, 1198, W - 130, 1320), 61, fill=ORANGE)
    d.text((W // 2, 1258), "SEARCH ON THE MARKETPLACE", font=font(34, bold=True), fill=INK, anchor="mm")
    d.text((W // 2, 1395), "coolshrimp.flipper-fap-studio", font=font(28, mono=True), fill=WHITE, anchor="mm")

    d.rounded_rectangle((236, 1495, W - 236, 1571), 38, fill=PANEL_2, outline="#3e4652", width=2)
    d.text((W // 2, 1533), "BUILT FOR THE FLIPPER COMMUNITY", font=font(24, bold=True), fill=MUTED, anchor="mm")
    footer(d, "FREE ON THE VS CODE MARKETPLACE")
    return canvas


def find_ffmpeg() -> Path:
    candidates = [
        os.environ.get("FFMPEG_BINARY"),
        shutil.which("ffmpeg"),
        r"C:\Program Files\CBD\CHITUBOX_Basic\Resources\DependentSoftware\recordOrShot\ffmpeg.exe",
        r"C:\Program Files\Lian-Li\L-Connect 3\x64\ffmpeg.exe",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return Path(candidate)
    raise FileNotFoundError("FFmpeg was not found. Set FFMPEG_BINARY to an ffmpeg.exe path.")


def make_original_audio(path: Path, duration: float, scene_starts: list[float]) -> None:
    sample_rate = 48_000
    total = int(duration * sample_rate)
    roots = [55.00, 65.41, 73.42, 49.00]
    arp = [220.00, 261.63, 329.63, 392.00, 329.63, 261.63, 220.00, 196.00]
    left = bytearray()
    right = bytearray()
    noise = 0x1234ABCD

    for n in range(total):
        t = n / sample_rate
        root = roots[int(t / 2.0) % len(roots)]

        # Low, restrained synth pad.
        pad = 0.040 * math.sin(2 * math.pi * root * t)
        pad += 0.018 * math.sin(2 * math.pi * root * 1.5 * t + 0.4)

        # Soft half-second kick pulse.
        beat = t % 0.5
        kick = 0.0
        if beat < 0.18:
            kick_freq = 54 + 72 * math.exp(-20 * beat)
            kick = 0.18 * math.sin(2 * math.pi * kick_freq * beat) * math.exp(-18 * beat)

        # Quiet quarter-note digital pluck.
        step = int(t / 0.25)
        phase = t % 0.25
        pluck = 0.035 * math.sin(2 * math.pi * arp[step % len(arp)] * phase) * math.exp(-11 * phase)

        # Deterministic, very light hi-hat noise.
        noise = (1664525 * noise + 1013904223) & 0xFFFFFFFF
        hat_phase = (t + 0.125) % 0.25
        hat = 0.0
        if hat_phase < 0.035:
            white = ((noise >> 8) / 0xFFFFFF) * 2.0 - 1.0
            hat = 0.022 * white * math.exp(-85 * hat_phase)

        # Short transition chimes at each new scene.
        chime = 0.0
        for start in scene_starts[1:]:
            dt = t - start
            if 0 <= dt < 0.42:
                chime += 0.055 * math.sin(2 * math.pi * (660 * dt + 170 * dt * dt)) * math.exp(-7 * dt)

        fade = min(1.0, t / 0.35, max(0.0, (duration - t) / 0.65))
        center = (pad + kick + hat + chime) * fade
        pan = -0.22 if step % 2 == 0 else 0.22
        l = center + pluck * (1.0 - pan)
        r = center + pluck * (1.0 + pan)
        l = max(-0.98, min(0.98, l))
        r = max(-0.98, min(0.98, r))
        left.extend(struct.pack("<h", int(l * 32767)))
        right.extend(struct.pack("<h", int(r * 32767)))

    interleaved = bytearray(total * 4)
    for i in range(total):
        interleaved[i * 4 : i * 4 + 2] = left[i * 2 : i * 2 + 2]
        interleaved[i * 4 + 2 : i * 4 + 4] = right[i * 2 : i * 2 + 2]

    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(interleaved)


def render_video(slides: list[Image.Image]) -> None:
    ffmpeg = find_ffmpeg()
    durations = [2.30, 3.10, 2.60, 2.40, 3.00, 3.00]
    transition = 0.28
    starts = [0.0]
    for i in range(1, len(durations)):
        starts.append(starts[-1] + durations[i - 1] - transition)
    total_duration = starts[-1] + durations[-1]

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="fap-tiktok-") as tmp_name:
        tmp = Path(tmp_name)
        slide_paths: list[Path] = []
        for i, slide in enumerate(slides):
            path = tmp / f"scene-{i + 1:02d}.png"
            slide.convert("RGB").save(path, quality=96)
            slide_paths.append(path)

        audio_path = tmp / "original-tech-bed.wav"
        print("Generating original soundtrack…", flush=True)
        make_original_audio(audio_path, total_duration, starts)

        args = [str(ffmpeg), "-y", "-hide_banner"]
        for path, duration in zip(slide_paths, durations):
            args += ["-loop", "1", "-framerate", str(FPS), "-t", f"{duration:.3f}", "-i", str(path)]
        audio_index = len(slide_paths)
        args += ["-i", str(audio_path)]

        filters: list[str] = []
        for i in range(len(slide_paths)):
            speed = 0.00019 + i * 0.000012
            filters.append(
                f"[{i}:v]scale={W}:{H},"
                f"zoompan=z='min(zoom+{speed:.6f},1.022)':"
                f"x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':"
                f"d=1:s={W}x{H}:fps={FPS},"
                "setsar=1,settb=AVTB,setpts=PTS-STARTPTS,format=yuv420p"
                f"[v{i}]"
            )

        previous = "v0"
        for i in range(1, len(slide_paths)):
            out = f"x{i}"
            filters.append(
                f"[{previous}][v{i}]xfade=transition=fade:duration={transition:.3f}:"
                f"offset={starts[i]:.3f}[{out}]"
            )
            previous = out

        args += [
            "-filter_complex",
            ";".join(filters),
            "-map",
            f"[{previous}]",
            "-map",
            f"{audio_index}:a:0",
            "-t",
            f"{total_duration:.3f}",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "18",
            "-profile:v",
            "high",
            "-level:v",
            "4.1",
            "-pix_fmt",
            "yuv420p",
            "-r",
            str(FPS),
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-ar",
            "48000",
            "-movflags",
            "+faststart",
            str(OUTPUT),
        ]

        print(f"Encoding {total_duration:.1f}s vertical MP4 with {ffmpeg}…", flush=True)
        subprocess.run(args, check=True)


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print("Composing TikTok storyboard…", flush=True)
    slides = [
        hook_slide(),
        designer_slide(),
        generate_slide(),
        build_slide(),
        live_slide(),
        end_slide(),
    ]
    slides[0].convert("RGB").save(COVER, quality=96)
    render_video(slides)
    print(f"Created: {OUTPUT}", flush=True)
    print(f"Cover:   {COVER}", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as exc:
        print(f"FFmpeg failed with exit code {exc.returncode}.", file=sys.stderr)
        raise
