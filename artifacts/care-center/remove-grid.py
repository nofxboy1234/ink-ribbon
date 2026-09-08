#!/usr/bin/env python3
"""Replace exterior background only; never filter or resample foreground pixels."""
from pathlib import Path
import shutil
from PIL import Image, ImageDraw, ImageFilter, ImageChops

ROOT = Path(__file__).resolve().parent
ARCHIVE = ROOT / 'originals'
ARCHIVE.mkdir(exist_ok=True)
FILES = ['care-center-full.png', 'basement.png', 'floor-1.png', 'floor-2.png', 'floor-3.png']
for name in FILES:
    if not (ARCHIVE / name).exists():
        shutil.copy2(ROOT / name, ARCHIVE / name)
source = Image.open(ARCHIVE / FILES[0]).convert('RGB')
assert source.size == (8192, 8192)
mask = Image.new('L', (1600,1600), 0)
draw = ImageDraw.Draw(mask)
scale = 1

# Room envelopes traced on a 1600px inspection view. Only the mask is scaled;
# the source image is always composited and exported at its native resolution.
polygons = [
    # Floor 3: west rooms and stairs; attic and medical supply room.
    [(505,34),(521,34),(521,125),(489,125),(489,147),(545,147),(545,153),(575,153),(575,162),(602,162),(602,134),(690,134),(690,160),(619,160),(619,186),(594,186),(594,198),(585,198),(585,245),(521,245),(521,234),(503,234),(503,241),(467,241),(467,147),(477,147),(477,103),(490,103),(490,85),(488,85),(488,65),(505,65)],
    [(621,206),(724,206),(724,248),(747,248),(747,262),(831,262),(831,207),(885,207),(885,187),(946,187),(946,215),(970,215),(970,166),(935,166),(935,119),(1035,119),(1035,183),(991,183),(991,284),(832,284),(832,277),(708,277),(708,264),(695,264),(695,283),(621,283)],
    # Floor 2: west wing.
    [(489,304),(522,304),(522,368),(577,368),(577,323),(650,323),(658,333),(657,369),(648,380),(661,385),(661,411),(691,411),(704,422),(704,448),(721,448),(721,477),(706,477),(706,568),(642,568),(642,478),(628,478),(628,526),(548,526),(548,554),(539,554),(539,624),(507,624),(507,563),(511,563),(511,527),(520,527),(520,448),(528,448),(528,423),(523,423),(523,391),(500,391),(500,367),(489,367)],
    # Floor 2: central hall, east rooms, south stair.
    [(734,448),(758,448),(758,469),(753,469),(753,496),(768,496),(768,540),(817,540),(817,469),(820,469),(820,448),(839,448),(839,470),(851,470),(851,529),(859,529),(859,427),(839,427),(839,407),(855,407),(855,394),(838,394),(838,367),(859,367),(859,372),(896,372),(896,421),(908,421),(908,371),(929,371),(929,367),(962,367),(962,423),(947,423),(947,433),(1033,433),(1033,445),(1070,445),(1070,422),(1115,422),(1115,365),(1084,365),(1084,314),(1131,314),(1131,512),(1035,512),(1035,459),(876,459),(876,565),(855,565),(855,558),(791,558),(791,574),(837,574),(837,587),(907,587),(907,691),(926,691),(926,704),(907,704),(907,718),(889,718),(889,608),(850,608),(850,613),(759,613),(759,579),(770,579),(770,561),(735,561)],
    # Floor 2: conference and research rooms.
    [(946,520),(975,520),(975,527),(1008,527),(1008,562),(1028,562),(1028,527),(1072,527),(1072,577),(1105,577),(1105,522),(1129,522),(1129,658),(1046,658),(1046,626),(1038,626),(1038,598),(991,598),(991,616),(953,616),(953,587),(947,587)],
    # Floor 1 west wing and garage.
    [(395,730),(443,730),(443,766),(481,766),(490,752),(490,714),(522,714),(522,737),(544,737),(544,754),(574,754),(575,735),(636,735),(636,730),(704,730),(704,823),(688,823),(688,848),(711,848),(718,857),(718,870),(710,870),(710,953),(685,953),(685,969),(630,969),(630,958),(606,958),(606,964),(590,964),(590,988),(577,988),(577,1009),(556,1009),(556,1062),(562,1062),(562,1105),(583,1105),(583,1144),(562,1144),(562,1187),(397,1187),(397,1145),(370,1145),(370,1106),(397,1106),(397,1062),(539,1062),(539,1034),(507,1034),(507,979),(518,979),(518,943),(545,943),(545,936),(517,936),(517,863),(514,863),(514,826),(545,826),(545,819),(519,819),(519,795),(545,795),(545,782),(443,782),(443,781),(395,781)],
    # Floor 1 courtyard and central hall.
    [(776,674),(802,674),(802,706),(850,706),(850,823),(842,823),(842,856),(837,856),(837,880),(841,891),(841,921),(864,921),(864,901),(901,901),(901,944),(872,944),(872,986),(880,986),(880,998),(912,998),(912,1017),(833,1017),(833,1024),(800,1024),(800,1049),(775,1049),(775,1030),(768,1030),(768,997),(757,997),(757,1010),(715,1010),(715,974),(702,974),(702,990),(703,1043),(665,1043),(665,1027),(647,1027),(647,993),(673,993),(673,979),(709,979),(709,944),(737,944),(737,924),(742,924),(742,881),(735,881),(735,864),(731,864),(731,820),(725,820),(725,706),(776,706)],
    # Floor 1 east wing.
    [(904,780),(1023,780),(1023,773),(1049,773),(1049,810),(1080,810),(1080,840),(1093,840),(1093,770),(1114,770),(1114,739),(1182,739),(1182,758),(1152,758),(1152,785),(1211,785),(1211,844),(1217,844),(1217,906),(1176,906),(1176,863),(1138,863),(1138,851),(1128,851),(1128,884),(1064,884),(1064,918),(1075,918),(1075,924),(1119,924),(1119,975),(1055,975),(1055,956),(1029,956),(1029,983),(992,983),(992,991),(962,991),(962,973),(919,973),(919,965),(910,965),(910,917),(904,917),(904,899),(889,899),(889,820),(904,820)],
    # Floor 1 rehabilitation wing.
    [(891,1015),(914,1015),(914,1061),(931,1061),(931,1051),(973,1051),(973,1060),(997,1060),(997,1038),(1069,1038),(1069,1058),(1077,1058),(1077,1042),(1127,1042),(1127,1087),(1113,1087),(1113,1132),(1076,1132),(1076,1153),(1040,1153),(1040,1172),(1023,1172),(1023,1182),(914,1182),(914,1115),(910,1115),(910,1099),(940,1099),(940,1139),(948,1139),(948,1111),(956,1111),(956,1087),(927,1087),(927,1076),(891,1076)],
    # Basement: all connected rooms, including the bottom passage.
    [(543,1229),(627,1229),(627,1252),(671,1252),(671,1248),(689,1248),(689,1257),(821,1257),(821,1278),(848,1278),(848,1264),(879,1264),(879,1260),(901,1260),(929,1272),(929,1281),(945,1294),(945,1307),(961,1319),(949,1328),(931,1320),(916,1307),(916,1332),(928,1332),(928,1368),(914,1368),(914,1397),(901,1397),(901,1438),(823,1438),(823,1387),(770,1387),(770,1438),(757,1438),(757,1459),(742,1476),(715,1485),(690,1485),(690,1533),(686,1533),(686,1571),(596,1571),(596,1558),(621,1558),(621,1533),(594,1533),(594,1527),(536,1527),(536,1537),(509,1537),(509,1527),(467,1527),(467,1493),(489,1493),(489,1478),(507,1478),(507,1396),(484,1396),(484,1378),(499,1378),(499,1304),(503,1304),(503,1267),(543,1267)],
]
for polygon in polygons:
    draw.polygon([(round(x*scale), round(y*scale)) for x,y in polygon], fill=255)

# Exterior courtyards/voids inside otherwise connected room envelopes.
# Keep a margin inside each wall; the detail mask also protects its pixels.
voids = [
    [(534,1401),(555,1401),(555,1324),(614,1324),(614,1372),(685,1372),(685,1397),(687,1401),(687,1428),(661,1428),(661,1455),(655,1455),(655,1506),(627,1506),(627,1490),(608,1490),(608,1471),(585,1471),(585,1451),(534,1451)],
    [(640,1299),(686,1299),(686,1323),(706,1323),(706,1328),(686,1328),(686,1354),(640,1354)],
    [(960,802),(972,802),(972,852),(965,852),(965,897),(894,897),(894,850),(901,850),(901,891),(957,891),(957,850),(960,850)],
    [(1031,903),(1057,903),(1057,890),(1119,890),(1119,918),(1053,918),(1053,950),(1031,950)],
    [(591,824),(625,824),(625,811),(648,811),(648,827),(669,827),(669,843),(656,843),(656,849),(628,849),(628,835),(591,835)],
]
for polygon in voids:
    draw.polygon(polygon, fill=0)

# Faint basement passage and narrow Floor 1 corridor bordering the voids.
for polygon in [
    [(580,1456),(643,1456),(643,1508),(625,1508),(625,1476),(580,1476)],
    [(601,961),(618,961),(618,970),(690,970),(690,962),(711,962),(711,987),(601,987)],
]:
    draw.polygon(polygon, fill=255)

# Floor headings are part of the room artwork. Dashed inter-floor routes are
# deliberately excluded: the game map draws a clean grid beneath the rooms,
# and the reference view does not show the source-image arrow routes.
for box in [(336,133,425,159),(336,480,425,506),(336,903,425,930),(336,1402,451,1430), (767,509,810,520), (912,986,946,1015)]:
    draw.rectangle(tuple(round(v*scale) for v in box), fill=255)

# Supplement the hand-traced room envelopes with every high-contrast or
# non-grey detail, including subtle colored anti-aliasing at room boundaries.
# Inspected empty exterior regions have luminance <= 50; this is an additive
# safety net, never a threshold applied to the contents of a protected room.
r, g, b = source.split()
chroma = ImageChops.lighter(ImageChops.difference(r,g), ImageChops.difference(g,b)).point(lambda value: 255 if value else 0)
details = ImageChops.lighter(source.convert('L').point(lambda value: 255 if value > 50 else 0), chroma)
# Source compression also leaves a few colored grid specks far from rooms.
# Only use the additive detail safeguard near traced foreground envelopes.
detail_neighborhood = mask.filter(ImageFilter.MaxFilter(31)).resize(source.size, Image.Resampling.NEAREST)
details = ImageChops.multiply(details, detail_neighborhood)
detail_preview = details.resize(mask.size, Image.Resampling.BILINEAR).point(lambda value: 255 if value else 0)
mask = ImageChops.lighter(mask, detail_preview)
# Close small outline gaps, and preserve interiors enclosed by foreground.
mask = mask.filter(ImageFilter.MaxFilter(7)).filter(ImageFilter.MinFilter(7))
exterior = mask.copy()
background_seeds = [
    (0,0), (470,80), (550,345), (580,435), (950,480),
    (700,650), (535,690), (1000,700), (1170,1100), (1000,1210),
    (715,780), (855,850), (600,820), (965,830), (1040,905),
    (600,1420), (650,1330), (720,1410), (630,1545),
]
for seed in background_seeds:
    if exterior.getpixel(seed) == 0:
        ImageDraw.floodfill(exterior, seed, 128)
interiors = exterior.point(lambda value: 0 if value == 128 else 255)
mask = ImageChops.lighter(mask, interiors).filter(ImageFilter.MaxFilter(5))
mask = mask.resize(source.size, Image.Resampling.NEAREST)
mask = ImageChops.lighter(mask, details)

# The source artwork also contains the inter-floor navigation routes. They
# are intentionally not part of a room: remove their centerlines and arrow
# heads after the detail-safety pass so they cannot be reintroduced by the
# high-contrast safeguard above.
source_scale = source.width / 1600
arrow_exclusions = Image.new('L', source.size, 0)
arrow_draw = ImageDraw.Draw(arrow_exclusions)
arrow_heads = Image.new('L', source.size, 0)
head_draw = ImageDraw.Draw(arrow_heads)
arrow_paths = [
    [(514, 28), (514, 19), (456, 19), (456, 263), (511, 263), (511, 296)],
    [(535, 324), (570, 324), (570, 726), (531, 726)],
    [(552, 601), (564, 601), (564, 654), (480, 654), (480, 1029), (502, 1029)],
    [(1130, 521), (1140, 521), (1140, 740)],
    [(933, 697), (943, 697), (943, 738), (886, 738), (886, 1105), (906, 1105)],
    [(1139, 853), (1139, 995), (1111, 995), (1111, 981)],
    [(929, 1026), (929, 1096)],
    [(929, 1187), (929, 1257)],
    [(1198, 918), (1198, 1319), (970, 1319)],
    [(930, 1339), (930, 1357)],
]
for path in arrow_paths:
    arrow_draw.line(
        [(round(x * source_scale), round(y * source_scale)) for x, y in path],
        fill=255,
        width=round(13 * source_scale),
        joint='curve',
    )
for box in [
    (503, 16, 521, 32),
    (528, 314, 548, 335),
    (543, 591, 562, 613),
    (1124, 513, 1143, 530),
    (926, 688, 947, 708),
    (917, 1018, 940, 1041),
    (963, 1307, 986, 1333),
]:
    rect = tuple(round(v * source_scale) for v in box)
    arrow_draw.rectangle(rect, fill=255)
    head_draw.rectangle(rect, fill=255)
# Inpaint the route pixels from their immediate map surroundings rather than
# clearing a whole corridor (some routes cross room artwork). Doing the small
# median pass at inspection resolution removes the bright dashed strokes and
# arrowheads while retaining the room walls and floor texture beneath them.
source_small = source.resize((1600, 1600), Image.Resampling.LANCZOS)
repaired_small = source_small.filter(ImageFilter.MedianFilter(15))
repaired = repaired_small.resize(source.size, Image.Resampling.LANCZOS)
route_pixels = ImageChops.multiply(
    arrow_exclusions,
    source.convert('L').point(lambda value: 255 if value > 70 else 0),
)
source = Image.composite(repaired, source, route_pixels)
mask = ImageChops.subtract(mask, arrow_heads)
output = Image.composite(source, Image.new('RGB', source.size, (24,24,24)), mask)
assert ImageChops.multiply(ImageChops.difference(source, output), mask.convert('RGB')).getbbox() is None
output.save(ROOT / 'care-center-full.png')
mask.save(ROOT / 'foreground-mask.png')
for name, box in {
    'floor-3.png': (1600,0,6350,1536),
    'floor-2.png': (1600,1500,6350,3740),
    'floor-1.png': (1600,3420,6350,6150),
    'basement.png': (1600,6200,6350,8192),
}.items():
    crop = output.crop(box)
    crop.save(ROOT / name)
    assert ImageChops.difference(Image.open(ROOT / name), crop).getbbox() is None
preview = output.copy()
preview.thumbnail((1600,1600))
preview.save('/tmp/care-center-clean-preview.png')
print('Saved five maps; all masked foreground pixels are unchanged; crops match master exactly.')
