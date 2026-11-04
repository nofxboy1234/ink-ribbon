"""Source-space lattice and floor levels shared by the RPD samplers.

Positions are metres with Y up. The samplers walk a 1 m lattice over X/Z and
label each surface with the nearest floor level.
"""

from __future__ import annotations

STEP = 1.0
HALF = 0.5
X_RANGE = (-42.0, 46.0)
Z_RANGE = (-30.0, 22.0)

FLOORS = ((0, "1F", 0.0), (1, "2F", 5.2), (2, "3F", 10.4))


def floor_of(y: float) -> int:
    return min(range(len(FLOORS)), key=lambda index: (abs(FLOORS[index][2] - y), index))
