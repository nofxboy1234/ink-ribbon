# Care Center map

Source page: https://www.polygon.com/map/resident-evil-requiem-re9-interactive-maps/

Original image: https://static0.gamerantimages.com/wordpress/wp-content/uploads/mapimages/Care_Center-8192.png

Downloaded on 2026-09-08. `originals/care-center-full.png` is the original 8192 × 8192 PNG, saved unchanged. Original floor crops are also retained in `originals/`. The viewer's interactive markers are not part of this image; built-in labels, door markings, and dashed connections remain.

`care-center-full.png` and the four floor images have their exterior background replaced with solid RGB (24, 24, 24). `foreground-mask.png` records protected regions in white. Room interiors, labels, and connections are copied directly from the original, without resampling, enhancement, or AI reconstruction. A conservative border around the foreground avoids clipping anti-aliased edges; the original textures inside protected regions remain.

The mask explicitly clears exterior pockets enclosed by dashed connections and empty spaces between basement passages and other rooms. Detail detection is limited to the vicinity of traced foreground, so isolated grid specks are not mistaken for room features. Brightened inspection previews are used only for checking; saved maps retain their original foreground brightness.

Run `/usr/bin/python3 artifacts/care-center/remove-grid.py` from the project root to reproduce the edit (requires Pillow). The script checks that every protected foreground pixel is unchanged and every crop exactly matches its region in the cleaned full map.

The floor images are lossless rectangular crops without resizing, enhancement, or reconstruction. Coordinates below are in source pixels, measured from the upper-left corner.

| Image | X | Y | Width | Height |
| --- | ---: | ---: | ---: | ---: |
| floor-3.png | 1600 | 0 | 4750 | 1536 |
| floor-2.png | 1600 | 1500 | 4750 | 2240 |
| floor-1.png | 1600 | 3420 | 4750 | 2730 |
| basement.png | 1600 | 6200 | 4750 | 1992 |

All crops use the same horizontal bounds and retain floor labels. Vertical bounds preserve each floor's rooms and stairs. Floor 1 and Floor 2 overlap because their stair connections occupy the same vertical band; small portions of adjacent connections remain. Consult the full image for continuous connections between floors.

Map artwork belongs to its respective rights holders; downloading it does not grant a new license.
