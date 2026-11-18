import math, sys, json, os

def sign(x):
    return 1 if x > 0 else (-1 if x < 0 else 0)

def curve(w, h):
    out = []
    def gen(x, y, ax, ay, bx, by):
        W = abs(ax + ay); H = abs(bx + by)
        dax, day, dbx, dby = sign(ax), sign(ay), sign(bx), sign(by)
        if H == 1:
            for _ in range(W):
                out.append((x, y)); x += dax; y += day
            return
        if W == 1:
            for _ in range(H):
                out.append((x, y)); x += dbx; y += dby
            return
        ax2, ay2, bx2, by2 = ax // 2, ay // 2, bx // 2, by // 2
        w2, h2 = abs(ax2 + ay2), abs(bx2 + by2)
        if 2 * W > 3 * H:
            if (w2 % 2) and W > 2:
                ax2 += dax; ay2 += day
            gen(x, y, ax2, ay2, bx, by)
            gen(x + ax2, y + ay2, ax - ax2, ay - ay2, bx, by)
        else:
            if (h2 % 2) and H > 2:
                bx2 += dbx; by2 += dby
            gen(x, y, bx2, by2, ax2, ay2)
            gen(x + bx2, y + by2, ax, ay, bx - bx2, by - by2)
            gen(x + (ax - dax) + (bx2 - dbx), y + (ay - day) + (by2 - dby),
                -bx2, -by2, -(ax - ax2), -(ay - ay2))
    if w >= h:
        gen(0, 0, w, 0, 0, h)
    else:
        gen(0, 0, 0, h, w, 0)
    assert len(out) == w * h, (len(out), w, h)
    return out

def offset_of(n):
    return int(math.floor((math.sqrt(5) - 1) / 2 * n + 0.5))

def power_map(m, steps):
    n = len(m)
    final = list(range(n))
    cur = m
    while steps > 0:
        if steps & 1:
            final = [cur[final[i]] for i in range(n)]
        steps >>= 1
        if steps:
            cur = [cur[cur[i]] for i in range(n)]
    return final

def parse_pw(pw):
    if pw == '':
        pw = '0000'
    assert len(pw) == 4 and pw.isdigit(), pw
    return max(1, int(pw[:2])), int(pw[2]), int(pw[3])

def tomato(pix, w, h, pw, direction):
    step, pc, pr = parse_pw(pw)
    if direction == 'decrypt':
        if pc or pr:
            cw, ch = w - pc, h - pr
            out = bytearray(cw * ch * 4)
            for y in range(ch):
                out[y*cw*4:(y+1)*cw*4] = pix[y*w*4:(y*w+cw)*4]
            pix, w, h = out, cw, ch
    n = w * h
    c = curve(w, h)
    off = offset_of(n)
    m = [0] * n
    for i in range(n):
        ox, oy = c[i]
        nx, ny = c[(i + off) % n]
        src = (oy * w + ox)
        dst = (ny * w + nx)
        if direction == 'decrypt':
            m[src] = dst
        else:
            m[dst] = src
    m = power_map(m, step)
    out = bytearray(n * 4)
    for j in range(n):
        out[j*4:(j+1)*4] = pix[m[j]*4:(m[j]+1)*4]
    if direction == 'encrypt' and (pc or pr):
        nw, nh = w + pc, h + pr
        pad = bytearray(nw * nh * 4)
        for y in range(h):
            pad[y*nw*4:y*nw*4 + w*4] = out[y*w*4:(y+1)*w*4]
            for x in range(w, nw):
                pad[(y*nw+x)*4:(y*nw+x)*4+4] = out[(y*w+w-1)*4:(y*w+w)*4]
        last = pad[(h-1)*nw*4:h*nw*4]
        for y in range(h, nh):
            pad[y*nw*4:(y+1)*nw*4] = last
        out, w, h = pad, nw, nh
    return out, w, h

if __name__ == '__main__':
    indir, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    report = {}
    for name in sorted(os.listdir(indir)):
        if not name.endswith('.json'):
            continue
        meta = json.load(open(os.path.join(indir, name)))
        w, h = meta['w'], meta['h']
        pix = open(os.path.join(indir, meta['raw']), 'rb').read()
        for pw in ('0000', '1234'):
            enc, ew, eh = tomato(pix, w, h, pw, 'encrypt')
            dec, dw, dh = tomato(enc, ew, eh, pw, 'decrypt')
            assert bytes(dec) == bytes(pix), ('reference roundtrip failed', name, pw)
            base = name[:-5] + '.' + pw
            open(os.path.join(outdir, base + '.enc.raw'), 'wb').write(enc)
            report[base + '.enc.raw'] = [ew, eh, len(enc)]
    json.dump(report, open(os.path.join(outdir, 'report.json'), 'w'), indent=1)
    print('reference ok:', len(report), 'files')

