import os, subprocess
OUT = "/Users/selanavot/Documents/open-cryptology/docs/logo/concepts"
SCR = os.path.dirname(__file__)
INK, Y, AMBER = "#212529", "#FFC72C", "#E8891A"

# Each mark: 64x64 viewBox, drawn in ink; 'Y' placeholder = knockout colour (background).
KEYHOLE = lambda cx, cy, s=1: (f'<circle cx="{cx}" cy="{cy}" r="{4.6*s}" fill="BG"/>'
    f'<path d="M{cx-2.6*s} {cy+2*s} L{cx-3.8*s} {cy+11*s} H{cx+3.8*s} L{cx+2.6*s} {cy+2*s} Z" fill="BG"/>')

marks = {
 "1-open-lock": ("Open padlock",
   f'<path d="M42 30V17a10 10 0 0 0-20 0v3" fill="none" stroke="INK" stroke-width="6" stroke-linecap="round"/>'
   f'<rect x="12" y="28" width="40" height="30" rx="7" fill="INK"/>' + KEYHOLE(32, 39)),
 "2-keyhole-page": ("Paper with a keyhole",
   f'<path d="M15 6h22l14 14v34a4 4 0 0 1-4 4H15a4 4 0 0 1-4-4V10a4 4 0 0 1 4-4z" fill="INK"/>'
   f'<path d="M36.5 5v11.5a4 4 0 0 0 4 4H52" fill="none" stroke="BG" stroke-width="3"/>' + KEYHOLE(31, 31, 1.15)),
 "3-open-key": ("Key with an open bow",
   f'<path d="M27.4 23.6A12 12 0 1 0 27.4 40.4" fill="none" stroke="INK" stroke-width="6.5" stroke-linecap="round"/>'
   f'<path d="M24 32H56" stroke="INK" stroke-width="6.5" stroke-linecap="round"/>'
   f'<path d="M45 32v10M53 32v7" stroke="INK" stroke-width="6.5" stroke-linecap="round"/>'),
 "4-braces": ("Keyhole in braces",
   f'<path d="M18 10c-6 0-8 3-8 8v8c0 4-2 6-5 6 3 0 5 2 5 6v8c0 5 2 8 8 8M46 10c6 0 8 3 8 8v8c0 4 2 6 5 6-3 0-5 2-5 6v8c0 5-2 8-8 8" fill="none" stroke="INK" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>'
   f'<circle cx="32" cy="27" r="7" fill="INK"/><path d="M28 30L26 44H38L36 30Z" fill="INK"/>'),
 "5-cipher-wheel": ("Open cipher wheel",
   "".join(
     f'<rect x="30.5" y="3" width="3" height="{9 if i%3==0 else 6}" rx="1.5" fill="INK" transform="rotate({i*15} 32 32)"/>'
     for i in range(24) if i not in (1,2)) +
   f'<circle cx="32" cy="32" r="15" fill="INK"/>' + KEYHOLE(32, 28, 1.05)),
}

def svg(body, bg=None, size=64, rx=14):
    b = body.replace("INK", INK).replace("BG", bg or "#FEFEFE")
    tile = f'<rect width="64" height="64" rx="{rx}" fill="{bg}"/>' if bg else ""
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="{size}" height="{size}">{tile}{b}</svg>'

def lockup(body, bg):
    b = body.replace("INK", INK).replace("BG", bg)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 440 80" width="440" height="80">'
            f'<rect width="440" height="80" fill="{bg}"/>'
            f'<g transform="translate(12 8)">{b}</g>'
            f'<text x="88" y="52" font-family="Helvetica Neue, Arial, sans-serif" font-size="34" fill="{INK}">'
            f'<tspan font-weight="400">open</tspan><tspan font-weight="700" dx="9">cryptology</tspan></text></svg>')

for k, (name, body) in marks.items():
    open(f"{OUT}/{k}.svg","w").write(svg(body, None, 64).replace('fill="#FEFEFE"','fill="#FFFFFF"'))
    open(f"{OUT}/{k}-tile.svg","w").write(svg(body, Y, 64))
    open(f"{OUT}/{k}-lockup.svg","w").write(lockup(body, Y))

# contact sheet
rows = []
for r, (k, (name, body)) in enumerate(marks.items()):
    y = 20 + r*130
    rows.append(f'<text x="20" y="{y+14}" font-family="Helvetica" font-size="14" fill="#555">{r+1}. {name}</text>')
    rows.append(f'<g transform="translate(20 {y+24})">{svg(body, Y, 88)}</g>')
    rows.append(f'<g transform="translate(130 {y+24})">{svg(body, "#FFFFFF", 88).replace("<svg ", "<svg ")}</g>')
    for i, s in enumerate((32, 16)):
        rows.append(f'<g transform="translate({240+i*44} {y+52})">{svg(body, Y, s, 14)}</g>')
    rows.append(f'<g transform="translate(320 {y+28})">{lockup(body, Y)}</g>')
sheet = f'<svg xmlns="http://www.w3.org/2000/svg" width="790" height="{20+len(marks)*130}"><rect width="100%" height="100%" fill="#f3f3f3"/>{"".join(rows)}</svg>'
open(f"{SCR}/sheet.svg","w").write(sheet)
subprocess.run(["rsvg-convert","-z","1.5",f"{SCR}/sheet.svg","-o",f"{SCR}/sheet.png"],check=True)
