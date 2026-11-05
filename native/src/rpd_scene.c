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

static sg_pipeline make_pipeline(sg_shader shader) {
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
    pd.depth.compare = SG_COMPAREFUNC_ALWAYS;
    pd.depth.write_enabled = false;
    pd.colors[0].blend.enabled = true;
    pd.colors[0].blend.src_factor_rgb = SG_BLENDFACTOR_SRC_ALPHA;
    pd.colors[0].blend.dst_factor_rgb = SG_BLENDFACTOR_ONE_MINUS_SRC_ALPHA;
    pd.colors[0].blend.op_rgb = SG_BLENDOP_ADD;
    pd.colors[0].blend.src_factor_alpha = SG_BLENDFACTOR_ONE;
    pd.colors[0].blend.dst_factor_alpha = SG_BLENDFACTOR_ONE_MINUS_SRC_ALPHA;
    pd.colors[0].blend.op_alpha = SG_BLENDOP_ADD;
    return sg_make_pipeline(&pd);
}

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
    pd.label = "solid-pipeline";
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
        (void)fl;
        const float ox = *(const float *)(p + off + 16);
        const float oy = *(const float *)(p + off + 20);
        const float oz = *(const float *)(p + off + 24);
        const float scale = *(const float *)(p + off + 28);
        off += 32;
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
    sg_shader_desc sd;
    memset(&sd, 0, sizeof(sd));
    sd.vertex_func.source = vs_source;
    sd.vertex_func.entry = "main";
    sd.fragment_func.source = fs_source;
    sd.fragment_func.entry = "main";
    sd.attrs[0].base_type = SG_SHADERATTRBASETYPE_FLOAT;
    sd.attrs[0].glsl_name = "position";
    sd.attrs[1].base_type = SG_SHADERATTRBASETYPE_FLOAT;
    sd.attrs[1].glsl_name = "color";
    sd.uniform_blocks[0].stage = SG_SHADERSTAGE_VERTEX;
    sd.uniform_blocks[0].size = sizeof(vs_params_t);
    sd.uniform_blocks[0].layout = SG_UNIFORMLAYOUT_STD140;
    sd.uniform_blocks[0].glsl_uniforms[0].type = SG_UNIFORMTYPE_MAT4;
    sd.uniform_blocks[0].glsl_uniforms[0].glsl_name = "u_view_proj";
    sd.uniform_blocks[1].stage = SG_SHADERSTAGE_FRAGMENT;
    sd.uniform_blocks[1].size = sizeof(fs_params_t);
    sd.uniform_blocks[1].layout = SG_UNIFORMLAYOUT_STD140;
    sd.uniform_blocks[1].glsl_uniforms[0].type = SG_UNIFORMTYPE_FLOAT4;
    sd.uniform_blocks[1].glsl_uniforms[0].glsl_name = "u_camera";
    sd.uniform_blocks[1].glsl_uniforms[1].type = SG_UNIFORMTYPE_FLOAT4;
    sd.uniform_blocks[1].glsl_uniforms[1].glsl_name = "u_fog";
    sd.uniform_blocks[1].glsl_uniforms[2].type = SG_UNIFORMTYPE_FLOAT4;
    sd.uniform_blocks[1].glsl_uniforms[2].glsl_name = "u_clip";
    sg_shader glass_shd = sg_make_shader(&sd);
    s->pip = make_pipeline(glass_shd);

    memset(&sd, 0, sizeof(sd));
    sd.vertex_func.source = vs_source;
    sd.vertex_func.entry = "main";
    sd.fragment_func.source = solid_fs_source;
    sd.fragment_func.entry = "main";
    sd.attrs[0].base_type = SG_SHADERATTRBASETYPE_FLOAT;
    sd.attrs[0].glsl_name = "position";
    sd.attrs[1].base_type = SG_SHADERATTRBASETYPE_FLOAT;
    sd.attrs[1].glsl_name = "color";
    sd.uniform_blocks[0].stage = SG_SHADERSTAGE_VERTEX;
    sd.uniform_blocks[0].size = sizeof(vs_params_t);
    sd.uniform_blocks[0].layout = SG_UNIFORMLAYOUT_STD140;
    sd.uniform_blocks[0].glsl_uniforms[0].type = SG_UNIFORMTYPE_MAT4;
    sd.uniform_blocks[0].glsl_uniforms[0].glsl_name = "u_view_proj";
    sd.uniform_blocks[1].stage = SG_SHADERSTAGE_FRAGMENT;
    sd.uniform_blocks[1].size = sizeof(fs_params_t);
    sd.uniform_blocks[1].layout = SG_UNIFORMLAYOUT_STD140;
    sd.uniform_blocks[1].glsl_uniforms[0].type = SG_UNIFORMTYPE_FLOAT4;
    sd.uniform_blocks[1].glsl_uniforms[0].glsl_name = "u_camera";
    sd.uniform_blocks[1].glsl_uniforms[1].type = SG_UNIFORMTYPE_FLOAT4;
    sd.uniform_blocks[1].glsl_uniforms[1].glsl_name = "u_fog";
    sd.uniform_blocks[1].glsl_uniforms[2].type = SG_UNIFORMTYPE_FLOAT4;
    sd.uniform_blocks[1].glsl_uniforms[2].glsl_name = "u_clip";
    sg_shader solid_shd = sg_make_shader(&sd);
    s->solid_pip = make_solid_pipeline(solid_shd);

    memset(&sd, 0, sizeof(sd));
    sd.vertex_func.source = marker_vs_source;
    sd.vertex_func.entry = "main";
    sd.fragment_func.source = marker_fs_source;
    sd.fragment_func.entry = "main";
    sd.attrs[0].base_type = SG_SHADERATTRBASETYPE_FLOAT;
    sd.attrs[0].glsl_name = "position";
    sd.attrs[1].base_type = SG_SHADERATTRBASETYPE_FLOAT;
    sd.attrs[1].glsl_name = "normal";
    sd.uniform_blocks[0].stage = SG_SHADERSTAGE_VERTEX;
    sd.uniform_blocks[0].size = sizeof(marker_vs_params_t);
    sd.uniform_blocks[0].layout = SG_UNIFORMLAYOUT_STD140;
    sd.uniform_blocks[0].glsl_uniforms[0].type = SG_UNIFORMTYPE_MAT4;
    sd.uniform_blocks[0].glsl_uniforms[0].glsl_name = "u_view_proj";
    sd.uniform_blocks[0].glsl_uniforms[1].type = SG_UNIFORMTYPE_MAT4;
    sd.uniform_blocks[0].glsl_uniforms[1].glsl_name = "u_model";
    sd.uniform_blocks[1].stage = SG_SHADERSTAGE_FRAGMENT;
    sd.uniform_blocks[1].size = sizeof(marker_fs_params_t);
    sd.uniform_blocks[1].layout = SG_UNIFORMLAYOUT_STD140;
    sd.uniform_blocks[1].glsl_uniforms[0].type = SG_UNIFORMTYPE_FLOAT4;
    sd.uniform_blocks[1].glsl_uniforms[0].glsl_name = "u_camera";
    sd.uniform_blocks[1].glsl_uniforms[1].type = SG_UNIFORMTYPE_FLOAT4;
    sd.uniform_blocks[1].glsl_uniforms[1].glsl_name = "u_color";
    sg_shader marker_shd = sg_make_shader(&sd);
    s->marker_pip = make_marker_pipeline(marker_shd);
}

void scene_render(scene_t *s, const camera_t *cam, float scene_radius, bool glass_style) {
    float eye[3], aim[3];
    camera_eye(cam, eye);
    memcpy(aim, cam->target, sizeof(aim));
    float camera_distance = cam->distance;
    float fog_start = camera_distance - scene_radius * 0.55f;
    float fog_end = camera_distance + scene_radius * 1.15f;
    float up[3] = { 0.0f, 1.0f, 0.0f };
    mat4 proj = mat4_perspective(0.62f, (float)sapp_width() / (float)sapp_height(), 0.2f, 1600.0f);
    mat4 view = mat4_look_at(eye, aim, up);
    vs_params_t vs = { .view_proj = mat4_mul(proj, view) };
    fs_params_t fs = { 0 };
    fs.camera[0] = eye[0]; fs.camera[1] = eye[1]; fs.camera[2] = eye[2]; fs.camera[3] = fog_start;
    fs.fog[0] = fog_end;
    sg_apply_pipeline(glass_style ? s->pip : s->solid_pip);
    sg_apply_bindings(&(sg_bindings){
        .vertex_buffers[0] = s->vbuf,
        .index_buffer = s->tri_ibuf,
    });
    sg_apply_uniforms(0, &(sg_range){ &vs, sizeof(vs) });
    sg_apply_uniforms(1, &(sg_range){ &fs, sizeof(fs) });
    sg_draw(0, s->triangle_count * 3, 1);
    markers_render(s, vs.view_proj, eye);
}

void scene_render_matrix(scene_t *s, mat4 view_proj, const float eye[3], bool clip, float clip_min, float clip_max) {
    vs_params_t vs = { .view_proj = view_proj };
    fs_params_t fs = { 0 };
    fs.camera[0] = eye[0]; fs.camera[1] = eye[1]; fs.camera[2] = eye[2]; fs.camera[3] = 1000.0f;
    fs.fog[0] = 2000.0f;
    fs.clip[0] = clip_min;
    fs.clip[1] = clip_max;
    fs.clip[2] = clip ? 1.0f : 0.0f;
    sg_apply_pipeline(s->solid_pip);
    sg_apply_bindings(&(sg_bindings){
        .vertex_buffers[0] = s->vbuf,
        .index_buffer = s->tri_ibuf,
    });
    sg_apply_uniforms(0, &(sg_range){ &vs, sizeof(vs) });
    sg_apply_uniforms(1, &(sg_range){ &fs, sizeof(fs) });
    sg_draw(0, s->triangle_count * 3, 1);
    markers_render(s, view_proj, eye);
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

