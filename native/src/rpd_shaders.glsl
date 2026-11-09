@vs solid_vs
layout(binding=0) uniform solid_vs_params {
    mat4 u_view_proj;
};
layout(location=0) in vec3 position;
layout(location=1) in vec4 color;
out vec3 v_world;
out vec3 v_color;
void main() {
    v_world = position;
    v_color = color.rgb;
    gl_Position = u_view_proj * vec4(position, 1.0);
}
@end

@fs solid_fs
precision highp float;
layout(binding=1) uniform solid_fs_params {
    vec4 u_camera;
    vec4 u_fog;
    vec4 u_clip;
    vec4 u_style;
};
in vec3 v_world;
in vec3 v_color;
layout(location = 0) out vec4 frag_color;
layout(location = 1) out vec4 frag_normal;
layout(location = 2) out vec4 frag_depth;
void main() {
    if (u_clip.z > 0.5 && (v_world.y < u_clip.x || v_world.y > u_clip.y)) discard;
    vec3 n = normalize(cross(dFdx(v_world), dFdy(v_world)));
    vec3 view = normalize(u_camera.xyz - v_world);
    if (dot(n, view) < 0.0) n = -n;
    float dist = length(u_camera.xyz - v_world);
    if (u_style.x > 0.5) {
        float key = max(dot(n, normalize(vec3(0.42, 0.82, 0.38))), 0.0);
        float fill = max(dot(n, normalize(vec3(-0.55, 0.35, -0.65))), 0.0);
        float hemi = 0.5 + 0.5 * n.y;
        float near = 1.0 - smoothstep(u_camera.w, u_fog.x, dist);
        float fres = pow(1.0 - max(dot(n, view), 0.0), 2.0);
        float light = 0.55 + 0.35 * key + 0.10 * hemi;
        vec3 glass = vec3(0.95, 0.96, 0.97) * light;
        float alpha = (0.30 + 0.35 * fres) * (0.45 + 0.55 * near);
        frag_color = vec4(glass, alpha);
        frag_normal = vec4(n * 0.5 + 0.5, 0.25);
        frag_depth = vec4(0.0, 0.0, 0.0, 0.25);
        return;
    }
    float key = max(dot(n, normalize(vec3(0.36, 0.88, 0.30))), 0.0);
    float fill = max(dot(n, normalize(vec3(-0.55, 0.32, -0.62))), 0.0);
    float hemi = 0.5 + 0.5 * n.y;
    float shade = 0.80 + 0.14 * key + 0.04 * fill + 0.02 * hemi;
    frag_color = vec4(v_color * shade, 1.0);
    frag_normal = vec4(n * 0.5 + 0.5, 1.0);
    float scaled = clamp(dist, 0.0, 500.0) * (65535.0 / 500.0);
    float hi = floor(scaled / 256.0);
    float lo = scaled - hi * 256.0;
    frag_depth = vec4(hi / 255.0, lo / 255.0, 0.0, 1.0);
}
@end

@fs data_fs
precision highp float;
layout(binding=2) uniform data_fs_params {
    vec4 u_camera;
    vec4 u_clip;
};
in vec3 v_world;
in vec3 v_color;
layout(location = 0) out vec4 frag_normal;
layout(location = 1) out vec4 frag_depth;
void main() {
    if (u_clip.z > 0.5 && (v_world.y < u_clip.x || v_world.y > u_clip.y)) discard;
    vec3 n = normalize(cross(dFdx(v_world), dFdy(v_world)));
    vec3 view = normalize(u_camera.xyz - v_world);
    if (dot(n, view) < 0.0) n = -n;
    frag_normal = vec4(n * 0.5 + 0.5, 1.0);
    float scaled = clamp(length(u_camera.xyz - v_world), 0.0, 500.0) * (65535.0 / 500.0);
    float hi = floor(scaled / 256.0);
    float lo = scaled - hi * 256.0;
    frag_depth = vec4(hi / 255.0, lo / 255.0, 0.0, 1.0);
}
@end

@vs marker_vs
layout(binding=0) uniform marker_vs_params {
    mat4 u_view_proj;
    mat4 u_model;
};
layout(location=0) in vec3 position;
layout(location=1) in vec3 normal;
out vec3 v_world;
out vec3 v_normal;
void main() {
    vec4 world = u_model * vec4(position, 1.0);
    v_world = world.xyz;
    v_normal = mat3(u_model) * normal;
    gl_Position = u_view_proj * world;
}
@end

@fs marker_fs
precision highp float;
layout(binding=1) uniform marker_fs_params {
    vec4 u_camera;
    vec4 u_color;
};
in vec3 v_world;
in vec3 v_normal;
layout(location = 0) out vec4 frag_color;
layout(location = 1) out vec4 frag_normal;
layout(location = 2) out vec4 frag_depth;
void main() {
    float spec_power = 16.0;
    float ambient_intensity = 0.25;
    vec3 l = vec3(0.0, 1.0, 0.0);
    vec3 n = normalize(v_normal);
    float n_dot_l = dot(n, l);
    float lum = dot(u_color.rgb, vec3(0.299, 0.587, 0.114));
    vec3 base = clamp(mix(vec3(lum), u_color.rgb, 1.7), 0.0, 1.0);
    vec3 orb;
    if (n_dot_l > 0.0) {
        vec3 v = normalize(u_camera.xyz - v_world);
        vec3 r = reflect(-l, n);
        float spec_intensity = pow(max(dot(r, v), 0.0), spec_power) * n_dot_l;
        orb = vec3(spec_intensity) + (n_dot_l + ambient_intensity) * base;
    } else {
        orb = base * ambient_intensity;
    }
    frag_color = vec4(pow(clamp(orb, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
    frag_normal = vec4(0.5, 0.5, 0.5, 0.5);
    frag_depth = vec4(0.0, 0.0, 0.0, 0.5);
}
@end


@vs composite_vs
layout(location=0) in vec2 position;
out vec2 v_uv;
void main() {
    v_uv = position * 0.5 + 0.5;
    gl_Position = vec4(position, 0.0, 1.0);
}
@end

@fs composite_fs
precision highp float;
layout(binding=0) uniform texture2D u_tex;
layout(binding=0) uniform sampler u_tex_smp;
layout(binding=1) uniform texture2D u_normal;
layout(binding=1) uniform sampler u_normal_smp;
layout(binding=2) uniform texture2D u_depth;
layout(binding=2) uniform sampler u_depth_smp;
in vec2 v_uv;
out vec4 frag_color;
void main() {
    vec2 texel = 1.0 / vec2(textureSize(sampler2D(u_tex, u_tex_smp), 0));
    vec3 c = texture(sampler2D(u_tex, u_tex_smp), v_uv).rgb;
    vec4 nC = texture(sampler2D(u_normal, u_normal_smp), v_uv);
    vec4 dC = texture(sampler2D(u_depth, u_depth_smp), v_uv);
    bool marker = abs(nC.a - 0.5) < 0.2;
    vec3 cL = texture(sampler2D(u_tex, u_tex_smp), v_uv - vec2(texel.x, 0.0)).rgb;
    vec3 cR = texture(sampler2D(u_tex, u_tex_smp), v_uv + vec2(texel.x, 0.0)).rgb;
    vec3 cU = texture(sampler2D(u_tex, u_tex_smp), v_uv - vec2(0.0, texel.y)).rgb;
    vec3 cD = texture(sampler2D(u_tex, u_tex_smp), v_uv + vec2(0.0, texel.y)).rgb;
    vec4 nL = texture(sampler2D(u_normal, u_normal_smp), v_uv - vec2(texel.x, 0.0));
    vec4 nR = texture(sampler2D(u_normal, u_normal_smp), v_uv + vec2(texel.x, 0.0));
    vec4 nU = texture(sampler2D(u_normal, u_normal_smp), v_uv - vec2(0.0, texel.y));
    vec4 nD = texture(sampler2D(u_normal, u_normal_smp), v_uv + vec2(0.0, texel.y));
    vec4 dL = texture(sampler2D(u_depth, u_depth_smp), v_uv - vec2(texel.x, 0.0));
    vec4 dR = texture(sampler2D(u_depth, u_depth_smp), v_uv + vec2(texel.x, 0.0));
    vec4 dU = texture(sampler2D(u_depth, u_depth_smp), v_uv - vec2(0.0, texel.y));
    vec4 dD = texture(sampler2D(u_depth, u_depth_smp), v_uv + vec2(0.0, texel.y));
    vec4 nUL = texture(sampler2D(u_normal, u_normal_smp), v_uv + texel * vec2(-1.0, -1.0));
    vec4 nUL2 = texture(sampler2D(u_normal, u_normal_smp), v_uv + texel * vec2(-2.0, -2.0));
    vec4 nUR2 = texture(sampler2D(u_normal, u_normal_smp), v_uv + texel * vec2( 2.0, -2.0));
    vec4 nDL2 = texture(sampler2D(u_normal, u_normal_smp), v_uv + texel * vec2(-2.0,  2.0));
    vec4 nDR2 = texture(sampler2D(u_normal, u_normal_smp), v_uv + texel * vec2( 2.0,  2.0));
    vec4 nL2 = texture(sampler2D(u_normal, u_normal_smp), v_uv + texel * vec2(-2.0, 0.0));
    vec4 nR2 = texture(sampler2D(u_normal, u_normal_smp), v_uv + texel * vec2( 2.0, 0.0));
    vec4 nU2 = texture(sampler2D(u_normal, u_normal_smp), v_uv + texel * vec2( 0.0, -2.0));
    vec4 nD2 = texture(sampler2D(u_normal, u_normal_smp), v_uv + texel * vec2( 0.0,  2.0));
    vec4 nUR = texture(sampler2D(u_normal, u_normal_smp), v_uv + texel * vec2( 1.0, -1.0));
    vec4 nDL = texture(sampler2D(u_normal, u_normal_smp), v_uv + texel * vec2(-1.0,  1.0));
    vec4 nDR = texture(sampler2D(u_normal, u_normal_smp), v_uv + texel * vec2( 1.0,  1.0));
    if (abs(nL.a - 0.5) < 0.2) { nL = nC; cL = c; dL = dC; }
    if (abs(nR.a - 0.5) < 0.2) { nR = nC; cR = c; dR = dC; }
    if (abs(nU.a - 0.5) < 0.2) { nU = nC; cU = c; dU = dC; }
    if (abs(nD.a - 0.5) < 0.2) { nD = nC; cD = c; dD = dC; }
    if (abs(nUL.a - 0.5) < 0.2) nUL = nC;
    if (abs(nUR.a - 0.5) < 0.2) nUR = nC;
    if (abs(nDL.a - 0.5) < 0.2) nDL = nC;
    if (abs(nDR.a - 0.5) < 0.2) nDR = nC;
    if (abs(nUL2.a - 0.5) < 0.2) nUL2 = nC;
    if (abs(nUR2.a - 0.5) < 0.2) nUR2 = nC;
    if (abs(nDL2.a - 0.5) < 0.2) nDL2 = nC;
    if (abs(nDR2.a - 0.5) < 0.2) nDR2 = nC;
    if (abs(nL2.a - 0.5) < 0.2) nL2 = nC;
    if (abs(nR2.a - 0.5) < 0.2) nR2 = nC;
    if (abs(nU2.a - 0.5) < 0.2) nU2 = nC;
    if (abs(nD2.a - 0.5) < 0.2) nD2 = nC;
    bool glass = abs(nC.a - 0.25) < 0.05 || abs(nL.a - 0.25) < 0.05 ||
                 abs(nR.a - 0.25) < 0.05 || abs(nU.a - 0.25) < 0.05 ||
                 abs(nD.a - 0.25) < 0.05 || abs(nUL.a - 0.25) < 0.05 ||
                 abs(nUR.a - 0.25) < 0.05 || abs(nDL.a - 0.25) < 0.05 ||
                 abs(nDR.a - 0.25) < 0.05 || abs(nUL2.a - 0.25) < 0.05 ||
                 abs(nUR2.a - 0.25) < 0.05 || abs(nDL2.a - 0.25) < 0.05 ||
                 abs(nDR2.a - 0.25) < 0.05 || abs(nL2.a - 0.25) < 0.05 ||
                 abs(nR2.a - 0.25) < 0.05 || abs(nU2.a - 0.25) < 0.05 ||
                 abs(nD2.a - 0.25) < 0.05;
    vec3 dx = cR - cL;
    vec3 dy = cD - cU;
    float colorEdge = smoothstep(0.14, 0.5, length(dx) + length(dy));
    vec3 nc = normalize(nC.xyz * 2.0 - 1.0);
    vec3 nl = normalize(nL.xyz * 2.0 - 1.0);
    vec3 nr = normalize(nR.xyz * 2.0 - 1.0);
    vec3 nu = normalize(nU.xyz * 2.0 - 1.0);
    vec3 nd = normalize(nD.xyz * 2.0 - 1.0);
    float normalEdge = smoothstep(0.18, 0.5, max(max(1.0 - dot(nc, nl), 1.0 - dot(nc, nr)), max(1.0 - dot(nc, nu), 1.0 - dot(nc, nd))));
    float zC = (dC.r * 255.0 * 256.0 + dC.g * 255.0) * (500.0 / 65535.0);
    float zL = (dL.r * 255.0 * 256.0 + dL.g * 255.0) * (500.0 / 65535.0);
    float zR = (dR.r * 255.0 * 256.0 + dR.g * 255.0) * (500.0 / 65535.0);
    float zU = (dU.r * 255.0 * 256.0 + dU.g * 255.0) * (500.0 / 65535.0);
    float zD = (dD.r * 255.0 * 256.0 + dD.g * 255.0) * (500.0 / 65535.0);
    bool scene = nC.a > 0.75 && nL.a > 0.75 && nR.a > 0.75 && nU.a > 0.75 && nD.a > 0.75;
    float depthEdge = 0.0;
    if (scene) {
        float dl = abs(2.0 * zC - zL - zR);
        float dv = abs(2.0 * zC - zU - zD);
        depthEdge = smoothstep(0.12, 0.5, max(dl, dv));
    }
    float edge = (marker || glass) ? 0.0 : max(max(colorEdge, normalEdge), depthEdge);
    if (nC.a < 0.05) edge = 0.0;
    vec2 q = v_uv - 0.5;
    float vig = smoothstep(1.05, 0.15, length(q));
    float grain = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
    vec3 col = c * (0.982 + 0.018 * vig) + grain * 0.0035;
    col = mix(col, vec3(0.085, 0.082, 0.078), edge * 0.92);
    frag_color = vec4(col, 1.0);
}
@end

@vs overlay_vs
layout(binding=0) uniform u_view {
    vec4 viewport;
} view;
layout(location=0) in vec2 pos;
layout(location=1) in vec4 color;
out vec4 v_color;
void main() {
    gl_Position = vec4(pos.x / view.viewport.x * 2.0 - 1.0, 1.0 - pos.y / view.viewport.y * 2.0, 0.0, 1.0);
    v_color = color;
}
@end

@fs overlay_fs
precision highp float;
in vec4 v_color;
out vec4 frag_color;
void main() {
    frag_color = v_color;
}
@end

@program solid solid_vs solid_fs
@program data solid_vs data_fs
@program marker marker_vs marker_fs
@program composite composite_vs composite_fs
@program overlay overlay_vs overlay_fs
