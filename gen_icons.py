"""
Genererer Læringslupa-ikon i tre storleikar: 16, 48, 128 px.
Køyr: python3 gen_icons.py
"""
import struct, zlib, math, os

OUT_DIR = os.path.join(os.path.dirname(__file__), 'icons')

def write_png(filename, w, h, pixels):
    def chunk(t, d):
        c = zlib.crc32(t + d) & 0xffffffff
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', c)
    raw = b''.join(b'\x00' + bytes([v for px in row for v in px]) for row in pixels)
    data = (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9))
            + chunk(b'IEND', b''))
    with open(filename, 'wb') as f:
        f.write(data)

def in_rrect(x, y, x0, y0, x1, y1, r):
    """Er (x,y) inni eit avrunda rektangel?"""
    if x < x0 or y < y0 or x > x1 or y > y1:
        return False
    if x < x0 + r and y < y0 + r:
        return math.hypot(x - x0 - r, y - y0 - r) <= r
    if x > x1 - r and y < y0 + r:
        return math.hypot(x - x1 + r, y - y0 - r) <= r
    if x < x0 + r and y > y1 - r:
        return math.hypot(x - x0 - r, y - y1 + r) <= r
    if x > x1 - r and y > y1 - r:
        return math.hypot(x - x1 + r, y - y1 + r) <= r
    return True

def dist_to_segment(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    l2 = dx*dx + dy*dy
    if l2 == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax)*dx + (py - ay)*dy) / l2))
    return math.hypot(px - (ax + t*dx), py - (ay + t*dy))

def draw_icon(size):
    SS = 4          # supersampling
    W = H = size * SS
    s = W / 128.0   # skaleringsfaktor

    # Fargar — variant 4: Djupblå + gull
    BG      = [13,  43,  94,  255]   # #0d2b5e djup navy
    WHITE   = [255, 215, 64,  255]   # #ffd740 gull
    LENS_BG = [255, 215, 64,  24 ]   # gull med låg opacity (linsefyll)
    TRANSP  = [0,   0,   0,   0]

    # Geometri (normalisert til 128px-koordinatar, skalert med s)
    pad   = 6  * s
    cr    = 18 * s   # hjørneradius bakgrunn

    lcx   = 53 * s   # linsemidtpunkt
    lcy   = 51 * s
    r_out = 33 * s   # ytre linseradius
    r_in  = 22 * s   # indre linseradius (holet)

    # Handtak: frå linsekant til nedre høgre
    angle  = math.radians(42)
    hx1 = lcx + r_out * math.cos(angle)
    hy1 = lcy + r_out * math.sin(angle)
    hx2 = 103 * s
    hy2 = 101 * s
    hr  = 7.5 * s    # handtak-halvbreidde

    # Bygg piksel-array (RGBA)
    rows = [[list(TRANSP) for _ in range(W)] for _ in range(H)]

    for y in range(H):
        for x in range(W):
            # 1. Bakgrunn
            if in_rrect(x, y, pad, pad, W - pad, H - pad, cr):
                rows[y][x] = list(BG)
            else:
                continue  # utanfor — behaldt transparent

            # 2. Handtak
            if dist_to_segment(x, y, hx1, hy1, hx2, hy2) < hr:
                rows[y][x] = list(WHITE)

            # 3. Linse
            d = math.hypot(x - lcx, y - lcy)
            if d <= r_out:
                rows[y][x] = list(LENS_BG) if d <= r_in else list(WHITE)

    # Nedsampel (4x → 1x, gir kantutvashing)
    result = []
    for y in range(size):
        row = []
        for x in range(size):
            r = g = b = a = 0
            for sy in range(SS):
                for sx in range(SS):
                    p = rows[y*SS + sy][x*SS + sx]
                    r += p[0]; g += p[1]; b += p[2]; a += p[3]
            n = SS * SS
            row.append([r//n, g//n, b//n, a//n])
        result.append(row)
    return result

os.makedirs(OUT_DIR, exist_ok=True)
for sz in [16, 48, 128]:
    pixels = draw_icon(sz)
    path = os.path.join(OUT_DIR, f'icon{sz}.png')
    write_png(path, sz, sz, pixels)
    print(f'  ✓  icon{sz}.png')

print('Ferdig — last inn utvidelsen på nytt i chrome://extensions')
