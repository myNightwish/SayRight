#!/usr/bin/env python3
# 纯标准库栅格化 Nuance 图标：圆角矩形 + 紫→品红对角渐变 + 白色 "N"。
# 输出 RGBA PNG。无第三方依赖，渲染结果稳定（不走浏览器截图）。
import struct, zlib, math, sys

def lerp(a, b, t): return a + (b - a) * t

# 4x 超采样抗锯齿后缩到目标尺寸
def render(size):
    SS = 4
    W = H = size * SS
    R = W * 0.25           # 圆角半径
    pad = W * 0.047        # 边距
    x0, y0, x1, y1 = pad, pad, W - pad, H - pad
    # 渐变端点（对角）
    v = (124, 92, 255)     # #7c5cff
    a = (196, 75, 255)     # #c44bff

    # "N" 三段折线：左竖、对角、右竖（坐标按 0..W 归一）
    sx0, sy_top, sy_bot = 0.3125 * W, 0.3125 * H, 0.703 * H
    lx, rx = 0.3125 * W, 0.6875 * W
    stroke = 0.078 * W     # 线宽
    hs = stroke / 2

    def dist_seg(px, py, ax, ay, bx, by):
        dx, dy = bx - ax, by - ay
        l2 = dx*dx + dy*dy
        t = 0 if l2 == 0 else max(0, min(1, ((px-ax)*dx + (py-ay)*dy)/l2))
        cx, cy = ax + t*dx, ay + t*dy
        return math.hypot(px-cx, py-cy)

    segs = [(lx, sy_bot, lx, sy_top),       # 左竖
            (lx, sy_top, rx, sy_bot),        # 对角
            (rx, sy_bot, rx, sy_top)]        # 右竖

    buf = bytearray(W * H * 4)
    for y in range(H):
        for x in range(W):
            o = (y * W + x) * 4
            # 圆角矩形内部判定
            inside = True
            if not (x0 <= x <= x1 and y0 <= y <= y1):
                inside = False
            else:
                # 角部圆角
                for (cx, cy) in [(x0+R, y0+R), (x1-R, y0+R), (x0+R, y1-R), (x1-R, y1-R)]:
                    if ((x < x0+R and y < y0+R and cx == x0+R and cy == y0+R) or
                        (x > x1-R and y < y0+R and cx == x1-R and cy == y0+R) or
                        (x < x0+R and y > y1-R and cx == x0+R and cy == y1-R) or
                        (x > x1-R and y > y1-R and cx == x1-R and cy == y1-R)):
                        if math.hypot(x-cx, y-cy) > R:
                            inside = False
            if not inside:
                continue
            # 渐变色（对角 t）
            t = ((x + y) / (W + H))
            r = int(lerp(v[0], a[0], t)); g = int(lerp(v[1], a[1], t)); b = int(lerp(v[2], a[2], t))
            # 顶部高光
            sheen = max(0, 0.28 * (1 - y / (H*0.55)))
            r = min(255, int(r + (255-r)*sheen)); g = min(255, int(g + (255-g)*sheen)); b = min(255, int(b + (255-b)*sheen))
            # 白色 N
            dmin = min(dist_seg(x, y, *s) for s in segs)
            if dmin <= hs:
                r = g = b = 255
            buf[o:o+4] = bytes((r, g, b, 255))

    # 缩小 SS 倍（盒式平均），输出 size×size
    out = bytearray(size * size * 4)
    for y in range(size):
        for x in range(size):
            ar = ag = ab = aa = 0
            for dy in range(SS):
                for dx in range(SS):
                    o = ((y*SS+dy) * W + (x*SS+dx)) * 4
                    ar += buf[o]; ag += buf[o+1]; ab += buf[o+2]; aa += buf[o+3]
            n = SS*SS
            oo = (y*size + x) * 4
            out[oo:oo+4] = bytes((ar//n, ag//n, ab//n, aa//n))
    return out, size

def write_png(path, rgba, size):
    def chunk(typ, data):
        c = struct.pack(">I", len(data)) + typ + data
        return c + struct.pack(">I", zlib.crc32(typ + data) & 0xffffffff)
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)
        raw += rgba[y*stride:(y+1)*stride]
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    open(path, "wb").write(png)

for s in (16, 32, 48, 128):
    rgba, size = render(s)
    write_png(f"icon{s}.png", rgba, size)
    print(f"icon{s}.png written")
