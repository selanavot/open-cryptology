# Simplified door marks, drawn on a 32-unit grid so edges land on whole pixels at 16/32/64.
import os, subprocess
OUT = "/Users/selanavot/Documents/open-cryptology/docs/logo/simple"
os.makedirs(OUT, exist_ok=True)
SCR = os.path.dirname(os.path.abspath(__file__))
INK, Y, PALE, AMBER = "#212529", "#FFC72C", "#FFF3C4", "#E8891A"
T = lambda c: f'<rect width="32" height="32" rx="7" fill="{c}"/>'

marks = {
  # A: lit doorway on an ink tile; doors are the yellow leaves, the opening is pale light
  "a-lit-doorway": ("Lit doorway, three tones",
    T(INK) +
    f'<path d="M13 8H19V22H13Z" fill="{PALE}"/>'
    f'<path d="M13 8L8 6V25L13 22Z" fill="{Y}"/><path d="M19 8L24 6V25L19 22Z" fill="{Y}"/>'),
  # A2: wider, brighter opening; leaves a touch slimmer so the light reads at 16px
  "a2-lit-doorway-wide": ("Lit doorway, wider light",
    T(INK) +
    f'<path d="M12 8H20V23H12Z" fill="#FFFFFF"/>'
    f'<path d="M12 8L7 6V26L12 23Z" fill="{Y}"/><path d="M20 8L25 6V26L20 23Z" fill="{Y}"/>'),
  # A3: A2 with a pale floor-light wedge continuing the opening to the tile edge
  "a3-lit-doorway-floor": ("Lit doorway, light on the floor",
    T(INK) +
    f'<path d="M12 23H20L23 32H9Z" fill="{PALE}" opacity=".9"/>'
    f'<path d="M12 7H20V23H12Z" fill="#FFFFFF"/>'
    f'<path d="M12 7L7 5V25L12 23Z" fill="{Y}"/><path d="M20 7L25 5V25L20 23Z" fill="{Y}"/>'),
}

def svg(body, size): return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="{size}" height="{size}">{body}</svg>'
for k, (n, b) in marks.items(): open(f"{OUT}/{k}.svg", "w").write(svg(b, 32).replace(' width="32" height="32">', '>', 1))

def nav(body, bg=Y, h=56):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="330" height="{h}"><rect width="330" height="{h}" fill="{bg}"/>'
            f'<g transform="translate(14 {(h-36)/2})">{svg(body, 36)}</g>'
            f'<text x="62" y="{h/2+9}" font-family="-apple-system, Helvetica Neue, Arial" font-size="25" fill="{INK}">Open Cryptology</text></svg>')

rows = []
for r, (k, (n, b)) in enumerate(marks.items()):
    y = 16 + r*120
    rows.append(f'<text x="16" y="{y+12}" font-family="Helvetica" font-size="13" fill="#555">{chr(65+r)}. {n}</text>')
    rows.append(f'<g transform="translate(16 {y+22})">{svg(b, 80)}</g>')
    x = 112
    for s in (48, 32, 24, 16):
        rows.append(f'<g transform="translate({x} {y+22+80-s})">{svg(b, s)}</g>'); x += s + 14
    # browser-tab mock at real 16px
    rows.append(f'<g transform="translate({x+6} {y+70})"><rect width="150" height="32" rx="6" fill="#dee2e6"/><g transform="translate(10 8)">{svg(b,16)}</g>'
                f'<text x="34" y="21" font-family="Helvetica" font-size="12" fill="#333">Open Cryptology</text></g>')
    rows.append(f'<g transform="translate(520 {y+46})">{nav(b)}</g>')
W, H = 870, 16 + len(marks)*120
open(f"{SCR}/sheet4.svg","w").write(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}"><rect width="100%" height="100%" fill="#f8f9fa"/>{"".join(rows)}</svg>')
subprocess.run(["rsvg-convert","-z","1",f"{SCR}/sheet4.svg","-o",f"{SCR}/sheet4.png"],check=True)
subprocess.run(["rsvg-convert","-z","2",f"{SCR}/sheet4.svg","-o",f"{SCR}/sheet4@2x.png"],check=True)
