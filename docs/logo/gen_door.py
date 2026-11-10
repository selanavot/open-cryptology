import os, subprocess
OUT = "/Users/selanavot/Documents/open-cryptology/docs/logo/door"
os.makedirs(OUT, exist_ok=True)
SCR = os.path.dirname(os.path.abspath(__file__))
INK, Y, PAPER = "#212529", "#FFC72C", "#FFF6D6"
DOOR, DOOR_EDGE = "#4A5058", "#6C757D"

# opening and leaves (64x64)
OX0, OX1, OY0, OY1 = 23, 41, 13, 44
LEFT  = f"M{OX0} {OY0}L13 9.5V48.5L{OX0} {OY1}Z"
RIGHT = f"M{OX1} {OY0}L51 9.5V48.5L{OX1} {OY1}Z"

def defs(uid):
    return (f'<defs><clipPath id="t{uid}"><rect width="64" height="64" rx="14"/></clipPath>'
            f'<linearGradient id="g{uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{Y}"/><stop offset="1" stop-color="{PAPER}"/></linearGradient>'
            f'<linearGradient id="s{uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{Y}" stop-opacity=".95"/><stop offset="1" stop-color="{Y}" stop-opacity=".15"/></linearGradient></defs>')

def bits_spill(col):
    # rows of bits on the floor, growing toward the viewer, inside the light trapezoid
    rows = [(46.3, 2.2, 5), (49.4, 2.9, 5), (53.3, 3.7, 5), (58.2, 4.7, 5)]
    pat = ["10110", "01101", "11010", "10011"]
    out = []
    for (y, s, n), p in zip(rows, pat):
        t = (y - OY1) / (64 - OY1)
        x0, x1 = OX0 - 1 - 8*t, OX1 + 1 + 8*t - 0
        gap = (x1 - x0 - n*s) / (n - 1)
        for i in range(n):
            x = x0 + i*(s + gap)
            if p[i] == "1": out.append(f'<rect x="{x:.2f}" y="{y:.2f}" width="{s}" height="{s}" rx="{s*.2:.2f}" fill="{col}"/>')
            else:
                w = max(.8, s*.24)
                out.append(f'<rect x="{x+w/2:.2f}" y="{y+w/2:.2f}" width="{s-w:.2f}" height="{s-w:.2f}" rx="{s*.15:.2f}" fill="none" stroke="{col}" stroke-width="{w:.2f}"/>')
    return "".join(out)

def door(uid, spill="solid", panels=True, bg=INK):
    def leaf_pt(hx, fx, u, v):
        ty = OY0 + (9.5-OY0)*u; by = OY1 + (48.5-OY1)*u
        return (hx + (fx-hx)*u, ty + (by-ty)*v)
    def panel(hx, fx, u0, u1, v0, v1):
        pts = [leaf_pt(hx, fx, u0, v0), leaf_pt(hx, fx, u1, v0), leaf_pt(hx, fx, u1, v1), leaf_pt(hx, fx, u0, v1)]
        return "M" + "L".join(f"{x:.2f} {y:.2f}" for x, y in pts) + "Z"
    p = "".join(f'<path d="{panel(h, f, .22, .78, a, b)}" fill="{DOOR_EDGE}"/>'
                for h, f in ((OX0, 13), (OX1, 51)) for a, b in ((.1, .44), (.54, .9))) if panels else ""
    floor = {
      "solid": f'<path d="M{OX0} {OY1}H{OX1}L52 64H12Z" fill="url(#s{uid})"/>',
      "bits":  bits_spill(Y),
      "none":  "",
    }[spill]
    return (defs(uid) + f'<g clip-path="url(#t{uid})"><rect width="64" height="64" fill="{bg}"/>'
            f'<rect x="{OX0}" y="{OY0}" width="{OX1-OX0}" height="{OY1-OY0}" fill="url(#g{uid})"/>'
            + floor +
            f'<path d="{LEFT}" fill="{DOOR}"/><path d="{RIGHT}" fill="{DOOR}"/>' + p +
            f'<path d="M{OX0} {OY0}V{OY1}M{OX1} {OY0}V{OY1}" stroke="{PAPER}" stroke-width=".9" opacity=".9"/></g>')

# flat silhouette for use directly on the yellow navbar (no tile): ink frame + doors, light = background
def flat(col=INK):
    return (f'<path d="M{OX0-3} {OY1+1}V{OY0-3}H{OX1+3}V{OY1+1}" fill="none" stroke="{col}" stroke-width="3" stroke-linejoin="round"/>'
            f'<path d="M{OX0-1} {OY0}L11 8V50L{OX0-1} {OY1}Z" fill="{col}"/><path d="M{OX1+1} {OY0}L53 8V50L{OX1+1} {OY1}Z" fill="{col}"/>'
            + bits_spill(col).replace("46.5", "47.5"))

variants = {
  "a-door-light": ("Open doors, light spilling out", lambda u: door(u, "solid")),
  "b-door-bits":  ("Open doors, the light is bits", lambda u: door(u, "bits")),
  "c-door-flat":  ("Flat silhouette for the yellow bar", lambda u: flat()),
}

def svg(inner, size, bg=None):
    t = f'<rect width="64" height="64" fill="{bg}"/>' if bg else ""
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="{size}" height="{size}">{t}{inner}</svg>'

def lockup(inner, bg=Y):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 440 80" width="440" height="80"><rect width="440" height="80" fill="{bg}"/>'
            f'<g transform="translate(12 8)">{inner}</g>'
            f'<text x="90" y="52" font-family="Helvetica Neue, Arial, sans-serif" font-size="34" fill="{INK}">'
            f'<tspan>open</tspan><tspan font-weight="700" dx="9">cryptology</tspan></text></svg>')

uid = 0
def nid():
    global uid; uid += 1; return uid
for k, (name, f) in variants.items():
    open(f"{OUT}/{k}.svg","w").write(svg(f(nid()), 64))
    open(f"{OUT}/{k}-lockup.svg","w").write(lockup(f(nid())))

rows = []
for r, (k, (name, f)) in enumerate(variants.items()):
    y = 20 + r*150
    rows.append(f'<text x="20" y="{y+14}" font-family="Helvetica" font-size="14" fill="#555">{chr(65+r)}. {name}</text>')
    rows.append(f'<g transform="translate(20 {y+24})">{svg(f(nid()), 110, Y if k.endswith("flat") else None)}</g>')
    rows.append(f'<g transform="translate(140 {y+24})"><rect width="110" height="110" fill="#fff"/>{svg(f(nid()), 110)}</g>')
    for i, s in enumerate((32, 16)):
        rows.append(f'<g transform="translate({262+i*44} {y+64})">{svg(f(nid()), s, Y if k.endswith("flat") else None)}</g>')
    rows.append(f'<g transform="translate(340 {y+40})">{lockup(f(nid()))}</g>')
sheet = f'<svg xmlns="http://www.w3.org/2000/svg" width="800" height="{20+len(variants)*150}"><rect width="100%" height="100%" fill="#f3f3f3"/>{"".join(rows)}</svg>'
open(f"{SCR}/sheet3.svg","w").write(sheet)
subprocess.run(["rsvg-convert","-z","1.5",f"{SCR}/sheet3.svg","-o",f"{SCR}/sheet3.png"],check=True)
subprocess.run(["rsvg-convert","-w","512",f"{OUT}/b-door-bits.svg","-o",f"{SCR}/b-big.png"],check=True)
