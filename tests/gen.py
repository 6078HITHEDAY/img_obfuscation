import os, json, random, sys
from PIL import Image

# 生成交叉验证用的原始像素与 PNG
sizes = [(1, 1), (3, 7), (64, 48), (100, 100), (517, 301), (257, 1), (1, 257)]
outdir = sys.argv[1] if len(sys.argv) > 1 else 'in'
os.makedirs(outdir, exist_ok=True)
random.seed(42)
for w, h in sizes:
    n = w * h
    data = bytearray(os.urandom(n * 4))
    for i in range(n):
        data[i * 4 + 3] = 255
    name = f"{w}x{h}"
    open(os.path.join(outdir, name + ".raw"), "wb").write(data)
    json.dump({"w": w, "h": h, "raw": name + ".raw"}, open(os.path.join(outdir, name + ".json"), "w"))
    Image.frombytes("RGBA", (w, h), bytes(data)).save(os.path.join(outdir, name + ".png"))

# 带透明通道 + JPEG 各一张
w, h = 200, 150
img = Image.new("RGBA", (w, h))
px = img.load()
for y in range(h):
    for x in range(w):
        px[x, y] = (x * 255 // w, y * 255 // h, (x + y) % 256, (x * 7) % 256)
img.save(os.path.join(outdir, "alpha.png"))
img.convert("RGB").save(os.path.join(outdir, "photo.jpg"), quality=88)
print("generated", len(sizes) + 2, "fixtures in", outdir)
