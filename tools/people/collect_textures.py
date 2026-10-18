# Packs the MakeHuman (CC0) textures used by the crowd into one atlas for the
# runtime: skins (1024^2 cells) on top, hair / beards / eyes / brows / lashes
# (512^2 cells) below. Writes atlas.webp + atlas.json (cell rects in UV space,
# v measured from the bottom like the GL texture coordinates).
# Run with the system Python (PIL):  python collect_textures.py <out dir>

import json
import os
import sys
from PIL import Image

DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'blender-user', 'extensions', '.user', 'user_default', 'mpfb', 'data')
OUT = sys.argv[1] if len(sys.argv) > 1 else '.'
os.makedirs(OUT, exist_ok=True)

SKINS = {
    'middleage_caucasian_male': 'skins/middleage_caucasian_male/middleage_lightskinned_male_diffuse.png',
    'old_caucasian_male': 'skins/old_caucasian_male/old_lightskinned_male_diffuse.png',
    'middleage_caucasian_female': 'skins/middleage_caucasian_female/middleage_lightskinned_female_diffuse.png',
}
SMALL = {
    'eyes:brown': 'eyes/materials/brown_eye.png',
    'brows:eyebrow001': 'eyebrows/eyebrow001/eyebrow001.png',
    'lashes:eyelashes01': 'eyelashes/eyelashes01/eyelashes01.png',
    'hair:culturalibre_hair_01': 'hair/culturalibre_hair_01/diffuse_black.png',
    'hair:o4saken_long01': 'hair/o4saken_long01/o4saken_long01.png',
    'hair:culturalibre_hair_02': 'hair/culturalibre_hair_02/male02_diffuse_black.png',
    'hair:braid01': 'hair/braid01/braid01_diffuse.png',
    'hair:sonntag78_junglebook_hair': 'hair/sonntag78_junglebook_hair/Hairblackseamless2png.png',
    'hair:cortu_short_messy_hair': 'hair/cortu_short_messy_hair/short_messy_diff.png',
    'beard:rehmanpolanski_beard_viking': 'clothes/rehmanpolanski_beard_viking/BeardViking.png',
    'beard:grinsegold_beard_sigmund_wip': 'clothes/grinsegold_beard_sigmund_wip/Material_Diffuse_Color1_d.png',
    'beard:wdg_scruffy_beard': 'clothes/wdg_scruffy_beard/beard2_texture-SMUDGE2.png',
}

W, H = 3072, 2560
atlas = Image.new('RGBA', (W, H), (0, 0, 0, 0))
rects = {}


def put(key, path, x, y, size):
    im = Image.open(os.path.join(DATA, path)).convert('RGBA')
    if im.mode == 'RGBA' and key.startswith('skin:'):
        im.putalpha(255)
    im = im.resize((size, size), Image.LANCZOS)
    # bleed colour into fully transparent texels so mip levels do not darken edges
    if not key.startswith('skin:'):
        px = im.load()
        base = im.copy().convert('RGB').resize((1, 1), Image.LANCZOS).getpixel((0, 0))
        a = im.split()[3]
        rgb = Image.new('RGB', im.size, base)
        rgb.paste(im.convert('RGB'), (0, 0), a.point(lambda v: 255 if v > 8 else 0))
        im = Image.merge('RGBA', (*rgb.split(), a))
    atlas.paste(im, (x, y))
    # UV rect: u0, v0 (bottom), du, dv  (texture v grows upwards, image rows grow downwards)
    rects[key] = [x / W, 1 - (y + size) / H, size / W, size / H]


# skins: three 1024 cells across the top
for i, (k, p) in enumerate(SKINS.items()):
    put('skin:' + k, p, i * 1024, 0, 1024)
# small textures: 512 cells below (6 x 3)
cells = [(x * 512, 1024 + y * 512) for y in range(3) for x in range(6)]
for (k, p), (x, y) in zip(SMALL.items(), cells):
    put(k, p, x, y, 512)

atlas.save(os.path.join(OUT, 'people_atlas.webp'), 'WEBP', quality=88, method=6)
with open(os.path.join(OUT, 'people_atlas.json'), 'w') as f:
    json.dump(dict(size=[W, H], rects=rects), f, indent=1)
print('atlas', W, H, len(rects), 'cells ->', OUT)
