import math
import os
import random
import traceback

from krita import Krita
from PyQt6.QtCore import QPointF, QRectF, Qt
from PyQt6.QtGui import (
    QBrush,
    QColor,
    QFont,
    QFontDatabase,
    QFontMetricsF,
    QImage,
    QLinearGradient,
    QPainter,
    QPainterPath,
    QPainterPathStroker,
    QPen,
    QRadialGradient,
)


HERE = os.path.dirname(os.path.abspath(__file__))
FONT_PATH = os.path.normpath(os.path.join(HERE, "..", "fonts", "RobotoCondensed-Bold.ttf"))
LOG_PATH = os.path.join(HERE, "build.log")

MAP_MIN_X = -388.0
MAP_MAX_X = 388.0
MAP_MIN_Y = -118.0
MAP_MAX_Y = 278.0
MAP_SCALE = 3

FILL = QColor(22, 39, 49, 255)
EDGE_DARK = QColor(43, 43, 40, 235)
EDGE_LIGHT = QColor(91, 90, 84, 245)
LABEL = QColor(217, 214, 200, 242)
GOLD_TOP = QColor(240, 210, 144, 255)
GOLD_BOTTOM = QColor(200, 169, 108, 255)
GOLD_DARK = QColor(104, 88, 57, 255)

_log = []


def log(message):
    _log.append(message)


def image(width, height):
    img = QImage(width, height, QImage.Format.Format_ARGB32)
    img.fill(QColor(0, 0, 0, 0))
    return img


def painter(img):
    p = QPainter(img)
    p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
    p.setRenderHint(QPainter.RenderHint.TextAntialiasing, True)
    return p


def save_doc(name, img):
    app = Krita.instance()
    doc = app.createDocument(img.width(), img.height(), name, "RGBA", "U8", "", 72.0)
    layer = doc.createNode(name, "paintlayer")
    root = doc.rootNode()
    for child in root.childNodes():
        child.remove()
    root.addChildNode(layer, None)
    data = bytes(img.constBits().asstring(img.sizeInBytes()))
    layer.setPixelData(data, 0, 0, img.width(), img.height())
    doc.saveAs(os.path.join(HERE, name + ".kra"))
    doc.setModified(False)
    doc.close()
    log("%s %dx%d" % (name, img.width(), img.height()))


def map_points():
    pts = [(-120.0, 250.0), (120.0, 250.0), (120.0, 90.0), (360.0, 90.0), (360.0, -48.0)]
    for i in range(1, 13):
        a = -i * (math.pi * 0.5) / 12.0
        pts.append((328.0 + 32.0 * math.cos(a), -58.0 + 32.0 * math.sin(a)))
    pts.append((-328.0, -90.0))
    for i in range(1, 13):
        a = -math.pi * 0.5 - i * (math.pi * 0.5) / 12.0
        pts.append((-328.0 + 32.0 * math.cos(a), -58.0 + 32.0 * math.sin(a)))
    pts.append((-360.0, 90.0))
    pts.append((-120.0, 90.0))
    return pts


def map_px(x):
    return (x - MAP_MIN_X) * MAP_SCALE


def map_py(y):
    return (MAP_MAX_Y - y) * MAP_SCALE


def make_map_path():
    pts = map_points()
    path = QPainterPath()
    path.moveTo(map_px(pts[0][0]), map_py(pts[0][1]))
    for x, y in pts[1:]:
        path.lineTo(map_px(x), map_py(y))
    path.closeSubpath()
    return path


def noise_image(size=256, seed=17):
    rng = random.Random(seed)
    img = image(size, size)
    for y in range(size):
        for x in range(size):
            v = rng.randrange(72, 210)
            a = rng.randrange(0, 30)
            img.setPixelColor(x, y, QColor(v, v, v, a))
    return img


def build_map():
    w = int((MAP_MAX_X - MAP_MIN_X) * MAP_SCALE)
    h = int((MAP_MAX_Y - MAP_MIN_Y) * MAP_SCALE)
    img = image(w, h)
    p = painter(img)
    path = make_map_path()

    p.setBrush(Qt.BrushStyle.NoBrush)
    for width, alpha in ((230, 10), (170, 12), (120, 14), (80, 16), (52, 18)):
        p.setPen(QPen(QColor(8, 17, 23, alpha), width, Qt.PenStyle.SolidLine,
                      Qt.PenCapStyle.RoundCap, Qt.PenJoinStyle.RoundJoin))
        p.drawPath(path)

    p.setPen(Qt.PenStyle.NoPen)
    p.setBrush(FILL)
    p.drawPath(path)

    p.save()
    p.setClipPath(path)
    p.setBrush(Qt.BrushStyle.NoBrush)
    for width, alpha in ((190, 8), (150, 9), (112, 11), (82, 13), (56, 16), (32, 20)):
        p.setPen(QPen(QColor(2, 6, 8, alpha), width, Qt.PenStyle.SolidLine,
                      Qt.PenCapStyle.RoundCap, Qt.PenJoinStyle.RoundJoin))
        p.drawPath(path)
    p.restore()

    p.save()
    p.setClipPath(path)
    p.setOpacity(0.055)
    p.setBrush(QBrush(noise_image()))
    p.setPen(Qt.PenStyle.NoPen)
    p.drawRect(img.rect())
    p.restore()

    p.setBrush(Qt.BrushStyle.NoBrush)
    p.setPen(QPen(EDGE_DARK, 13.0, Qt.PenStyle.SolidLine,
                  Qt.PenCapStyle.RoundCap, Qt.PenJoinStyle.RoundJoin))
    p.drawPath(path)
    p.setPen(QPen(EDGE_LIGHT, 7.0, Qt.PenStyle.SolidLine,
                  Qt.PenCapStyle.RoundCap, Qt.PenJoinStyle.RoundJoin))
    p.drawPath(path)

    font_id = QFontDatabase.addApplicationFont(FONT_PATH)
    family = QFontDatabase.applicationFontFamilies(font_id)[0] if font_id >= 0 else "Sans Serif"
    font = QFont(family)
    font.setPixelSize(56)
    font.setWeight(QFont.Weight.Bold)
    p.setFont(font)
    fm = QFontMetricsF(font)
    text = "Entrance"
    tw = fm.horizontalAdvance(text)
    th = fm.height()
    cx = map_px(0.0)
    cy = map_py(46.0)
    rect = QRectF(cx - tw * 0.5, cy - th * 0.5, tw, th)
    p.setPen(QColor(0, 0, 0, 140))
    p.drawText(rect.translated(1.5, 2.0), Qt.AlignmentFlag.AlignCenter, text)
    p.setPen(LABEL)
    p.drawText(rect, Qt.AlignmentFlag.AlignCenter, text)

    p.end()
    save_doc("map", img)


def build_door(name, top, bottom, border, highlight, art_w, art_h):
    scale = 4
    w_world, h_world = 80.0, 22.0
    w = int(w_world * scale)
    h = int(h_world * scale)
    img = image(w, h)
    p = painter(img)
    cx, cy = w * 0.5, h * 0.5
    aw, ah = art_w * scale, art_h * scale
    rect = QRectF(cx - aw * 0.5, cy - ah * 0.5, aw, ah)

    p.setPen(Qt.PenStyle.NoPen)
    p.setBrush(QColor(0, 0, 0, 100))
    p.drawRoundedRect(rect.translated(0, 4), 2, 2)

    grad = QLinearGradient(0, rect.top(), 0, rect.bottom())
    grad.setColorAt(0.0, top)
    grad.setColorAt(1.0, bottom)
    p.setBrush(QBrush(grad))
    p.setPen(QPen(border, 3.0))
    p.drawRoundedRect(rect, 2, 2)

    p.setPen(QPen(highlight, 2.0))
    p.drawLine(QPointF(rect.left() + 8, rect.top() + 5),
               QPointF(rect.right() - 8, rect.top() + 5))
    p.end()
    save_doc(name, img)


def arrow_canvas(x, y):
    return (88.0 + x * 4.0, 72.0 - y * 4.0)


def make_arrow_path(offset_y=0.0):
    points = [(-13.0, -10.0), (0.0, 10.5), (13.0, -10.0), (0.0, 0.5)]
    path = QPainterPath()
    x, y = arrow_canvas(*points[0])
    path.moveTo(x, y + offset_y)
    for px, py in points[1:]:
        x, y = arrow_canvas(px, py)
        path.lineTo(x, y + offset_y)
    path.closeSubpath()
    return path


def build_arrow():
    img = image(176, 144)
    p = painter(img)
    path = make_arrow_path()
    p.setPen(Qt.PenStyle.NoPen)
    p.setBrush(QColor(0, 0, 0, 85))
    p.drawPath(make_arrow_path(3.0))

    grad = QLinearGradient(0, 30, 0, 112)
    grad.setColorAt(0.0, GOLD_TOP)
    grad.setColorAt(1.0, GOLD_BOTTOM)
    p.setBrush(QBrush(grad))
    p.setPen(QPen(GOLD_DARK, 4.0, Qt.PenStyle.SolidLine,
                  Qt.PenCapStyle.RoundCap, Qt.PenJoinStyle.MiterJoin))
    p.drawPath(path)

    p.save()
    p.setClipPath(path)
    highlight = QPainterPath()
    x, y = arrow_canvas(-13.0, -10.0)
    highlight.moveTo(x, y)
    x, y = arrow_canvas(0.0, 10.5)
    highlight.lineTo(x, y)
    x, y = arrow_canvas(13.0, -10.0)
    highlight.lineTo(x, y)
    p.setBrush(Qt.BrushStyle.NoBrush)
    p.setPen(QPen(QColor(247, 239, 210, 110), 2.4, Qt.PenStyle.SolidLine,
                  Qt.PenCapStyle.RoundCap, Qt.PenJoinStyle.MiterJoin))
    p.drawPath(highlight)
    p.restore()
    p.end()
    save_doc("player_arrow", img)


def build_glow():
    img = image(256, 256)
    p = painter(img)
    grad = QRadialGradient(128, 128, 128)
    grad.setColorAt(0.0, QColor(240, 205, 130, 230))
    grad.setColorAt(0.18, QColor(232, 198, 126, 190))
    grad.setColorAt(0.42, QColor(222, 185, 112, 120))
    grad.setColorAt(0.68, QColor(210, 172, 98, 48))
    grad.setColorAt(0.88, QColor(205, 168, 94, 10))
    grad.setColorAt(1.0, QColor(205, 168, 94, 0))
    p.setPen(Qt.PenStyle.NoPen)
    p.setBrush(QBrush(grad))
    p.drawEllipse(QRectF(0, 0, 256, 256))
    p.end()
    save_doc("player_glow", img)


def build_cursor():
    img = image(128, 128)
    p = painter(img)
    c = QPointF(64, 64)
    p.setPen(Qt.PenStyle.NoPen)
    p.setBrush(QColor(0, 0, 0, 40))
    p.drawEllipse(c + QPointF(0, 2), 55, 55)
    p.setBrush(QColor(4, 7, 10, 150))
    p.drawEllipse(c, 51, 51)
    p.setBrush(Qt.BrushStyle.NoBrush)
    p.setPen(QPen(QColor(200, 195, 178, 225), 5.5))
    p.drawEllipse(c, 50, 50)
    p.setPen(QPen(QColor(235, 230, 214, 45), 1.6))
    p.drawEllipse(c, 45.5, 45.5)
    p.end()
    save_doc("cursor_ring", img)


def build_tooltip():
    img = image(1000, 120)
    p = painter(img)
    rect = QRectF(2, 2, 996, 116)
    p.setPen(Qt.PenStyle.NoPen)
    p.setBrush(QColor(0, 0, 0, 80))
    p.drawRoundedRect(rect.translated(0, 4), 10, 10)
    p.setBrush(QColor(4, 7, 10, 225))
    p.setPen(QPen(QColor(190, 184, 166, 155), 4.0))
    p.drawRoundedRect(rect, 8, 8)
    p.end()
    save_doc("tooltip", img)


def build_legend():
    for name, color in (("legend_searching", QColor(122, 31, 31, 255)),
                        ("legend_complete", QColor(40, 75, 92, 255))):
        img = image(48, 48)
        p = painter(img)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(color)
        p.drawRect(0, 0, 48, 48)
        p.end()
        save_doc(name, img)


def __main__(*args):
    try:
        build_map()
        build_door("door_service", QColor(202, 199, 192), QColor(170, 167, 160),
                   QColor(94, 92, 86), QColor(238, 235, 226, 150), 58.0, 10.0)
        build_door("door_locked", QColor(122, 30, 30), QColor(88, 16, 16),
                   QColor(50, 9, 9), QColor(162, 52, 52, 90), 58.0, 12.0)
        build_door("door_locked_hover", QColor(142, 38, 38), QColor(104, 22, 22),
                   QColor(62, 12, 12), QColor(184, 68, 68, 110), 58.0, 12.0)
        build_arrow()
        build_glow()
        build_cursor()
        build_tooltip()
        build_legend()
        log("done")
    except Exception:
        log(traceback.format_exc())
    with open(LOG_PATH, "w") as f:
        f.write("\n".join(_log) + "\n")
