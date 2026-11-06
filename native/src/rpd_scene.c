#include "rpd_scene.h"

#include <emscripten/emscripten.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "rpd_shaders.h"
#include "rpd_markers.h"
#include "rpd_state.h"

#define RPD_VERSION 4u
#define RPD_HEADER_BASE 52

static sg_pipeline make_solid_pipeline(sg_shader shader) {
    sg_pipeline_desc pd;
    memset(&pd, 0, sizeof(pd));
    pd.shader = shader;
    pd.layout.buffers[0].stride = 16;
    pd.layout.attrs[0].format = SG_VERTEXFORMAT_FLOAT3;
    pd.layout.attrs[1].format = SG_VERTEXFORMAT_UBYTE4N;
    pd.primitive_type = SG_PRIMITIVETYPE_TRIANGLES;
    pd.index_type = SG_INDEXTYPE_UINT32;
    pd.cull_mode = SG_CULLMODE_NONE;
    pd.face_winding = SG_FACEWINDING_CCW;
    pd.sample_count = 1;
    pd.depth.compare = SG_COMPAREFUNC_LESS_EQUAL;
    pd.depth.write_enabled = true;
    pd.color_count = 3;
    pd.colors[0].pixel_format = SG_PIXELFORMAT_RGBA8;
    pd.colors[1].pixel_format = SG_PIXELFORMAT_RGBA8;
    pd.colors[2].pixel_format = SG_PIXELFORMAT_RGBA8;
    pd.label = "solid-pipeline";
    return sg_make_pipeline(&pd);
}

static sg_pipeline make_data_pipeline(sg_shader shader) {
    sg_pipeline_desc pd;
    memset(&pd, 0, sizeof(pd));
    pd.shader = shader;
    pd.layout.buffers[0].stride = 16;
    pd.layout.attrs[0].format = SG_VERTEXFORMAT_FLOAT3;
    pd.primitive_type = SG_PRIMITIVETYPE_TRIANGLES;
    pd.index_type = SG_INDEXTYPE_UINT32;
    pd.cull_mode = SG_CULLMODE_NONE;
    pd.face_winding = SG_FACEWINDING_CCW;
    pd.sample_count = 1;
    pd.depth.compare = SG_COMPAREFUNC_LESS_EQUAL;
    pd.depth.write_enabled = true;
    pd.color_count = 2;
    pd.colors[0].pixel_format = SG_PIXELFORMAT_RGBA8;
    pd.colors[1].pixel_format = SG_PIXELFORMAT_RGBA8;
    pd.label = "paper-data-pipeline";
    return sg_make_pipeline(&pd);
}

static sg_pipeline make_glass_pipeline(sg_shader shader) {
    sg_pipeline_desc pd;
    memset(&pd, 0, sizeof(pd));
    pd.shader = shader;
    pd.layout.buffers[0].stride = 16;
    pd.layout.attrs[0].format = SG_VERTEXFORMAT_FLOAT3;
    pd.layout.attrs[1].format = SG_VERTEXFORMAT_UBYTE4N;
    pd.primitive_type = SG_PRIMITIVETYPE_TRIANGLES;
    pd.index_type = SG_INDEXTYPE_UINT32;
    pd.cull_mode = SG_CULLMODE_NONE;
    pd.face_winding = SG_FACEWINDING_CCW;
    pd.sample_count = 1;
    pd.depth.compare = SG_COMPAREFUNC_LESS_EQUAL;
    pd.depth.write_enabled = false;
    pd.color_count = 3;
    pd.colors[0].pixel_format = SG_PIXELFORMAT_RGBA8;
    pd.colors[1].pixel_format = SG_PIXELFORMAT_RGBA8;
    pd.colors[2].pixel_format = SG_PIXELFORMAT_RGBA8;
    pd.colors[0].blend.enabled = true;
    pd.colors[0].blend.src_factor_rgb = SG_BLENDFACTOR_SRC_ALPHA;
    pd.colors[0].blend.dst_factor_rgb = SG_BLENDFACTOR_ONE_MINUS_SRC_ALPHA;
    pd.colors[0].blend.op_rgb = SG_BLENDOP_ADD;
    pd.colors[0].blend.src_factor_alpha = SG_BLENDFACTOR_ONE;
    pd.colors[0].blend.dst_factor_alpha = SG_BLENDFACTOR_ONE_MINUS_SRC_ALPHA;
    pd.colors[0].blend.op_alpha = SG_BLENDOP_ADD;
    pd.label = "glass-pipeline";
    return sg_make_pipeline(&pd);
}

static sg_pipeline make_marker_pipeline(sg_shader shader) {
    sg_pipeline_desc pd;
    memset(&pd, 0, sizeof(pd));
    pd.shader = shader;
    pd.layout.buffers[0].stride = 24;
    pd.layout.attrs[0].format = SG_VERTEXFORMAT_FLOAT3;
    pd.layout.attrs[1].format = SG_VERTEXFORMAT_FLOAT3;
    pd.primitive_type = SG_PRIMITIVETYPE_TRIANGLES;
    pd.index_type = SG_INDEXTYPE_UINT32;
    pd.cull_mode = SG_CULLMODE_NONE;
    pd.face_winding = SG_FACEWINDING_CCW;
    pd.sample_count = 1;
    pd.depth.compare = SG_COMPAREFUNC_LESS_EQUAL;
    pd.depth.write_enabled = true;
    pd.color_count = 3;
    pd.colors[0].pixel_format = SG_PIXELFORMAT_RGBA8;
    pd.colors[1].pixel_format = SG_PIXELFORMAT_RGBA8;
    pd.colors[2].pixel_format = SG_PIXELFORMAT_RGBA8;
    pd.label = "marker-pipeline";
    return sg_make_pipeline(&pd);
}

bool scene_upload(scene_t *s) {
    if (!s->data || s->size < RPD_HEADER_BASE) return false;
    const uint8_t *p = s->data;
    if (memcmp(p, "RPDW", 4) != 0) return false;
    if (*(const uint32_t *)(p + 4) != RPD_VERSION) return false;
    uint32_t chunk_count = *(const uint32_t *)(p + 8);
    uint32_t total_v = *(const uint32_t *)(p + 12);
    uint32_t total_t = *(const uint32_t *)(p + 16);
    uint32_t floor_count = *(const uint32_t *)(p + 20);
    if (floor_count < 1 || floor_count > 8 || total_v == 0 || total_t == 0) return false;
    s->floor_count = (int)floor_count;
    for (int i = 0; i < MAX_SCENE_FLOORS; i++) {
        s->floors[i].first_index = 0;
        s->floors[i].index_count = 0;
    }
    uint8_t floor_seen[MAX_SCENE_FLOORS] = { 0 };
    const float *hb = (const float *)(p + 28);
    s->bounds.min[0] = hb[0]; s->bounds.min[1] = hb[1]; s->bounds.min[2] = hb[2];
    s->bounds.max[0] = hb[3]; s->bounds.max[1] = hb[4]; s->bounds.max[2] = hb[5];

    size_t vbytes = (size_t)total_v * 16;
    size_t ibytes = (size_t)total_t * 3 * sizeof(uint32_t);
    uint8_t *vbuf = (uint8_t *)malloc(vbytes);
    uint32_t *ibuf = (uint32_t *)malloc(ibytes);
    if (!vbuf || !ibuf) { free(vbuf); free(ibuf); return false; }

    size_t off = RPD_HEADER_BASE + (size_t)floor_count * 16;
    size_t vbase = 0;
    size_t ibase = 0;
    for (uint32_t c = 0; c < chunk_count; c++) {
        if (off + 32 > s->size) goto fail;
        const uint32_t nv = *(const uint32_t *)(p + off + 0);
        const uint32_t ni = *(const uint32_t *)(p + off + 4);
        const uint32_t fl = *(const uint32_t *)(p + off + 8);
        const float ox = *(const float *)(p + off + 16);
        const float oy = *(const float *)(p + off + 20);
        const float oz = *(const float *)(p + off + 24);
        const float scale = *(const float *)(p + off + 28);
        off += 32;
        if (fl >= floor_count) goto fail;
        if (vbase + nv > total_v || ibase + ni > (size_t)total_t * 3) goto fail;
        if (off + (size_t)nv * 6 + (size_t)nv * 3 + (size_t)ni * 2 > s->size) goto fail;
        const uint16_t *q = (const uint16_t *)(p + off);
        off += (size_t)nv * 6;
        const uint8_t *col = p + off;
        off += (size_t)nv * 3;
        const uint16_t *idx = (const uint16_t *)(p + off);
        off += (size_t)ni * 2;
        for (uint32_t i = 0; i < nv; i++) {
            float x = ox + (float)q[i * 3 + 0] * scale;
            float y = oy + (float)q[i * 3 + 1] * scale;
            float z = oz + (float)q[i * 3 + 2] * scale;
            uint8_t *v = vbuf + (vbase + i) * 16;
            memcpy(v, &x, 4); memcpy(v + 4, &y, 4); memcpy(v + 8, &z, 4);
            v[12] = col[i * 3 + 0];
            v[13] = col[i * 3 + 1];
            v[14] = col[i * 3 + 2];
            v[15] = 255;
        }
        for (uint32_t i = 0; i < ni; i++) ibuf[ibase + i] = (uint32_t)(vbase + idx[i]);
        if (!floor_seen[fl]) {
            s->floors[fl].first_index = (int)ibase;
            floor_seen[fl] = 1;
        }
        s->floors[fl].index_count += (int)ni;
        vbase += nv;
        ibase += ni;
        off = (off + 3) & ~(size_t)3;
    }
    if (vbase != total_v || ibase != (size_t)total_t * 3) goto fail;

    s->vertex_count = (int)total_v;
    s->triangle_count = (int)total_t;
    s->vbuf = sg_make_buffer(&(sg_buffer_desc){
        .size = vbytes,
        .data = { .ptr = vbuf, .size = vbytes },
        .label = "rpd-vertices",
    });
    s->tri_ibuf = sg_make_buffer(&(sg_buffer_desc){
        .usage = { .index_buffer = true },
        .size = ibytes,
        .data = { .ptr = ibuf, .size = ibytes },
        .label = "rpd-triangles",
    });
    free(vbuf);
    free(ibuf);
    if (sg_query_buffer_state(s->vbuf) != SG_RESOURCESTATE_VALID ||
        sg_query_buffer_state(s->tri_ibuf) != SG_RESOURCESTATE_VALID) return false;
    markers_create(s);
    s->gpu_ready = true;
    s->loaded = true;
    return true;
fail:
    free(vbuf);
    free(ibuf);
    return false;
}


void scene_create_pipelines(scene_t *s) {
    sg_shader solid = sg_make_shader(solid_shader_desc(sg_query_backend()));
    s->solid_pip = make_solid_pipeline(solid);
    s->paper_data_pip = make_data_pipeline(sg_make_shader(data_shader_desc(sg_query_backend())));
    s->glass_pip = make_glass_pipeline(solid);
    s->marker_pip = make_marker_pipeline(sg_make_shader(marker_shader_desc(sg_query_backend())));
}

static void draw_scene_range(scene_t *s, sg_pipeline pip,
                             const solid_vs_params_t *vs, const solid_fs_params_t *fs,
                             int first, int count) {
    if (count <= 0) return;
    sg_apply_pipeline(pip);
    sg_apply_bindings(&(sg_bindings){
        .vertex_buffers[0] = s->vbuf,
        .index_buffer = s->tri_ibuf,
    });
    sg_apply_uniforms(UB_solid_vs_params, &(sg_range){ vs, sizeof(*vs) });
    sg_apply_uniforms(UB_solid_fs_params, &(sg_range){ fs, sizeof(*fs) });
    sg_draw(first, count, 1);
}

void scene_render_floors(scene_t *s, mat4 view_proj, const float eye[3],
                         float camera_distance, float scene_radius, int paper_floor,
                         bool clip, float clip_min, float clip_max, float marker_floor) {
    solid_vs_params_t vs;
    memcpy(vs.u_view_proj, view_proj.m, sizeof(vs.u_view_proj));
    solid_fs_params_t fs = { 0 };
    fs.u_camera[0] = eye[0]; fs.u_camera[1] = eye[1]; fs.u_camera[2] = eye[2];
    fs.u_camera[3] = camera_distance - 0.55f * scene_radius;
    fs.u_fog[0] = camera_distance + 1.15f * scene_radius;
    fs.u_clip[0] = clip_min;
    fs.u_clip[1] = clip_max;
    fs.u_clip[2] = clip ? 1.0f : 0.0f;
    fs.u_style[0] = 0.0f;

    if (paper_floor >= 0 && paper_floor < s->floor_count) {
        draw_scene_range(s, s->solid_pip, &vs, &fs,
                         s->floors[paper_floor].first_index,
                         s->floors[paper_floor].index_count);
    }
    if (!clip) {
        fs.u_style[0] = 1.0f;
        for (int i = 0; i < s->floor_count; i++) {
            if (i == paper_floor) continue;
            draw_scene_range(s, s->glass_pip, &vs, &fs,
                             s->floors[i].first_index,
                             s->floors[i].index_count);
        }
    }
    markers_render(s, view_proj, eye, marker_floor);
}

void scene_render_paper_data(scene_t *s, mat4 view_proj, const float eye[3],
                             int paper_floor, bool clip, float clip_min, float clip_max) {
    if (!s->gpu_ready || paper_floor < 0 || paper_floor >= s->floor_count) return;
    solid_vs_params_t vs;
    memcpy(vs.u_view_proj, view_proj.m, sizeof(vs.u_view_proj));
    data_fs_params_t fs = { 0 };
    fs.u_camera[0] = eye[0]; fs.u_camera[1] = eye[1]; fs.u_camera[2] = eye[2];
    fs.u_clip[0] = clip_min;
    fs.u_clip[1] = clip_max;
    fs.u_clip[2] = clip ? 1.0f : 0.0f;
    sg_apply_pipeline(s->paper_data_pip);
    sg_apply_bindings(&(sg_bindings){
        .vertex_buffers[0] = s->vbuf,
        .index_buffer = s->tri_ibuf,
    });
    sg_apply_uniforms(UB_solid_vs_params, &(sg_range){ &vs, sizeof(vs) });
    sg_apply_uniforms(UB_data_fs_params, &(sg_range){ &fs, sizeof(fs) });
    sg_draw(s->floors[paper_floor].first_index, s->floors[paper_floor].index_count, 1);
}

int scene_floor_count(void) {
    return g_rpd.scene.floor_count;
}

EMSCRIPTEN_KEEPALIVE int rpd_load_scene(const uint8_t *data, int size) {
    if (!data || size <= 0) return -1;
    if (g_rpd.scene.data) free(g_rpd.scene.data);
    g_rpd.scene.data = (uint8_t *)malloc((size_t)size);
    if (!g_rpd.scene.data) return -1;
    memcpy(g_rpd.scene.data, data, (size_t)size);
    g_rpd.scene.size = (size_t)size;
    g_rpd.scene.loaded = false;
    g_rpd.scene.pending = true;
    return 0;
}

