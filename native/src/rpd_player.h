#pragma once

/* Claire's body as the marker draws it. */
#define RPD_PLAYER_RADIUS 0.425f
#define RPD_PLAYER_HEIGHT 1.7f

/* The route keeps this much clear of the rendered paper walls. The paper plan
 * narrows to 0.62 m at some doorways, so the body cannot keep the full marker
 * radius there; 0.25 m is what the old game navigation used. */
#define RPD_ROUTE_RADIUS 0.25f
