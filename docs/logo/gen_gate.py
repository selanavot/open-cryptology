import os, subprocess, sys
OUT = "/Users/selanavot/Documents/open-cryptology/docs/logo/gate"
os.makedirs(OUT, exist_ok=True)
SCR = os.path.dirname(os.path.abspath(__file__))
INK, Y, AMBER = "#212529", "#FFC72C", "#B5410B"

def sq(x, y, s=6, one=True, col="INK"):
    if one: return f'<rect x="{x}" y="{y}" width="{s}" height="{s}" rx="{s*.18:.2f}" fill="{col}"/>'
    w = max(1.4, s*.26)
    return f'<rect x="{x+w/2:.2f}" y="{y+w/2:.2f}" width="{s-w:.2f}" height="{s-w:.2f}" rx="{s*.12:.2f}" fill="none" stroke="{col}" stroke-width="{w:.2f}"/>'

marks = {}

# A. XOR gate: a stream of bits goes in, runs through the body (knockouts), comes out the tip
marks["a-xor-gate"] = ("XOR gate, bits passing through",
  '<path d="M9 14Q14.5 23 14.5 32T9 50" fill="none" stroke="INK" stroke-width="4.2" stroke-linecap="round"/>'
  '<path d="M15.5 14H24Q38 14 50 32Q38 50 24 50H15.5Q21 41 21 32T15.5 14Z" fill="INK"/>'
  + sq(0, 28.5, 7, False) + sq(24, 28.5, 7, True, "BG") + sq(33, 28.5, 7, False, "BG") + sq(54, 28.5, 7))

# B. Double gate swung open, bits come toward you
marks["b-open-gate"] = ("Double gate swung open",
  '<rect x="3" y="6" width="8" height="54" rx="2" fill="INK"/><rect x="53" y="6" width="8" height="54" rx="2" fill="INK"/>'
  '<path d="M11 12L23 18V43L11 51Z" fill="INK"/><path d="M53 12L41 18V43L53 51Z" fill="INK"/>'
  + sq(30.5, 20, 3) + sq(29.5, 27, 5, False) + sq(28, 36, 8) + sq(26, 48, 12))

# C. Pixel gate: a Pi built from bit-cells, bits come out of the opening toward you
cells = [(c, 0) for c in range(8)] + [(c, r) for r in range(1, 7) for c in (1, 6)]
pix = "".join(f'<rect x="{c*8+.4}" y="{r*8+4.4}" width="7.2" height="7.2" rx="1.3" fill="INK"/>' for c, r in cells)
marks["c-pixel-gate"] = ("Gate built from bits",
  pix + sq(30.5, 16, 3) + sq(29.5, 23, 5, False) + sq(28, 32, 8) + sq(26, 44, 12))

def svg(body, bg=None, size=64, rx=14):
    b = body.replace("INK", INK).replace("BG", bg or "#FFFFFF")
    tile = f'<rect width="64" height="64" rx="{rx}" fill="{bg}"/>' if bg else ""
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="{size}" height="{size}">{tile}{b}</svg>'

def tile(body, size=64):  # mark inset on a yellow tile
    b = body.replace("INK", INK).replace("BG", Y)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="{size}" height="{size}">'
            f'<rect width="64" height="64" rx="14" fill="{Y}"/><g transform="translate(8 8) scale(.75)">{b}</g></svg>')

def lockup(body, bg):
    b = body.replace("INK", INK).replace("BG", bg)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 440 80" width="440" height="80">'
            f'<rect width="440" height="80" fill="{bg}"/><g transform="translate(14 10) scale(.94)">{b}</g>'
            f'<text x="92" y="52" font-family="Helvetica Neue, Arial, sans-serif" font-size="34" fill="{INK}">'
            f'<tspan>open</tspan><tspan font-weight="700" dx="9">cryptology</tspan></text></svg>')

for k, (name, body) in marks.items():
    open(f"{OUT}/{k}.svg","w").write(svg(body))
    open(f"{OUT}/{k}-tile.svg","w").write(tile(body))
    open(f"{OUT}/{k}-lockup.svg","w").write(lockup(body, Y))

rows = []
for r, (k, (name, body)) in enumerate(marks.items()):
    y = 20 + r*130
    rows.append(f'<text x="20" y="{y+14}" font-family="Helvetica" font-size="14" fill="#555">{chr(65+r)}. {name}</text>')
    rows.append(f'<g transform="translate(20 {y+24})">{tile(body, 88)}</g>')
    rows.append(f'<g transform="translate(130 {y+24})">{svg(body, "#FFFFFF", 88)}</g>')
    for i, s in enumerate((32, 16)):
        rows.append(f'<g transform="translate({240+i*44} {y+52})">{tile(body, s)}</g>')
    rows.append(f'<g transform="translate(320 {y+28})">{lockup(body, Y)}</g>')
sheet = f'<svg xmlns="http://www.w3.org/2000/svg" width="790" height="{20+len(marks)*130}"><rect width="100%" height="100%" fill="#f3f3f3"/>{"".join(rows)}</svg>'
open(f"{SCR}/sheet2.svg","w").write(sheet)
subprocess.run(["rsvg-convert","-z","1.5",f"{SCR}/sheet2.svg","-o",f"{SCR}/sheet2.png"],check=True)
