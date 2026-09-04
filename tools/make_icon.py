"""Gera o icone do app (installer/sabor.ico) a partir de codigo.

Sem dependencia de navegador nem de arte externa: o build inteiro roda offline
e o icone sai sempre igual. Requer Pillow (requirements-build.txt).
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT_ICO = ROOT / "installer" / "sabor.ico"
OUT_PNG = ROOT / "installer" / "sabor.png"

SS = 8            # supersampling: desenha grande e reduz, para bordas suaves
BOX = 256
GRAD_A = (255, 138, 61)    # laranja
GRAD_B = (255, 77, 109)    # rosa


def bezier(p0, p1, p2, p3, steps=60):
    """Amostra uma cubica de Bezier."""
    pts = []
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        x = u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0]
        y = u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]
        pts.append((x, y))
    return pts


def bubble_mask(size: int, scale: float, ox: float, oy: float) -> Image.Image:
    """Balão de fala arredondado com um rabinho, numa caixa 100x100 depois
    transformada — o formato mais genérico de mascote de app de conversa.

    De propósito NÃO é a silhueta de nenhum app especifico: a parte que cada
    marca registra é o contorno exato (cantos, proporção, o "olho" caracte-
    ristico de cada uma), não a ideia de "balão com rabinho e carinha", que é
    de uso comum. Trocar por essa forma é so pra ficar mais obviamente "um
    app de chamada" do que a chama era; a arte em si é toda nossa."""
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    x0, y0, x1, y1 = 6, 6, 94, 76
    box = [x0 * scale + ox, y0 * scale + oy, x1 * scale + ox, y1 * scale + oy]
    d.rounded_rectangle(box, radius=22 * scale, fill=255)
    tail = [
        (30 * scale + ox, 75 * scale + oy),
        (23 * scale + ox, 97 * scale + oy),
        (53 * scale + ox, 78 * scale + oy),
    ]
    d.polygon(tail, fill=255)
    return mask


def face_points(scale: float, ox: float, oy: float):
    """Dois olhos e um sorriso, no mesmo espaco 100x100 do balão — e o que dá
    uma cara própria ao mascote, em vez de só um ícone. Desenhado do zero,
    sem nenhuma relação com o logo de nenhum outro app."""
    eyes = [(35, 36, 4.6), (65, 36, 4.6)]  # cx, cy, raio
    mouth = bezier((36, 52), (43, 63), (57, 63), (64, 52), steps=30)
    xf = lambda x, y: (x * scale + ox, y * scale + oy)
    eye_boxes = [
        (xf(cx - r, cy - r), xf(cx + r, cy + r)) for cx, cy, r in eyes
    ]
    return eye_boxes, [xf(x, y) for x, y in mouth]


def build() -> Image.Image:
    size = BOX * SS
    radius = int(56 * SS)

    # fundo em gradiente diagonal
    grad = Image.new("RGB", (size, size))
    px = grad.load()
    for y in range(size):
        for x in range(0, size, 4):  # passo 4: o gradiente e suave, nao precisa por pixel
            t = (x + y) / (2 * size - 2)
            c = (
                round(GRAD_A[0] + (GRAD_B[0] - GRAD_A[0]) * t),
                round(GRAD_A[1] + (GRAD_B[1] - GRAD_A[1]) * t),
                round(GRAD_A[2] + (GRAD_B[2] - GRAD_A[2]) * t),
            )
            for dx in range(4):
                if x + dx < size:
                    px[x + dx, y] = c

    # mascara de canto arredondado
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)

    card = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    card.paste(grad, (0, 0), mask)

    # balão branco centralizado
    bubble_box = size * 0.62
    scale = bubble_box / 100
    ox = (size - bubble_box) / 2
    oy = (size - bubble_box) / 2 - size * 0.01

    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    layer.paste((255, 255, 255, 255), (0, 0), bubble_mask(size, scale, ox, oy))

    # sombra sutil sob o balão para dar profundidade
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shadow.paste((120, 20, 40, 70), (0, 0), bubble_mask(size, scale, ox, oy + size * 0.012))
    shadow = shadow.filter(ImageFilter.GaussianBlur(size * 0.012))

    card.alpha_composite(shadow)
    card.alpha_composite(layer)

    # rosto: dois olhos e um sorriso por cima do balão branco, num tom quente
    # escuro — e o que da personalidade ao icone sem copiar mascote de ninguem
    face_color = (150, 40, 40, 255)
    eye_boxes, mouth = face_points(scale, ox, oy)
    face = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    fd = ImageDraw.Draw(face)
    for box in eye_boxes:
        fd.ellipse(box, fill=face_color)
    fd.line(mouth, fill=face_color, width=max(2, int(bubble_box * 0.05)), joint="curve")
    card.alpha_composite(face)

    return card.resize((BOX, BOX), Image.LANCZOS)


def main() -> int:
    OUT_ICO.parent.mkdir(parents=True, exist_ok=True)
    icon = build()
    icon.save(OUT_PNG)
    icon.save(OUT_ICO, sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])
    print(f"[icone] {OUT_ICO}  ({OUT_ICO.stat().st_size / 1024:.1f} KB)")
    print(f"[icone] {OUT_PNG}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
