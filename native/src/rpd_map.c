#include "rpd_map.h"

#include <emscripten/emscripten.h>
#include <math.h>
#include <string.h>

#include "rpd_shaders.h"
#include "rpd_state.h"

void map_create_pipeline(map_t *m) {
    sg_shader_desc sd;
    memset(&sd, 0, sizeof(sd));
    sd.vertex_func.source = map_vs_source;
    sd.vertex_func.entry = "main";
    sd.fragment_func.source = map_fs_source;
    sd.fragment_func.entry = "main";
    sd.attrs[0].base_type = SG_SHADERATTRBASETYPE_FLOAT;
    sd.attrs[0].glsl_name = "position";
    sd.attrs[1].base_type = SG_SHADERATTRBASETYPE_FLOAT;
    sd.attrs[1].glsl_name = "color";
    sd.uniform_blocks[0].stage = SG_SHADERSTAGE_VERTEX;
    sd.uniform_blocks[0].size = sizeof(map_params_t);
    sd.uniform_blocks[0].layout = SG_UNIFORMLAYOUT_STD140;
    sd.uniform_blocks[0].glsl_uniforms[0].type = SG_UNIFORMTYPE_FLOAT4;
    sd.uniform_blocks[0].glsl_uniforms[0].glsl_name = "u_camera";
    sd.uniform_blocks[0].glsl_uniforms[1].type = SG_UNIFORMTYPE_FLOAT4;
    sd.uniform_blocks[0].glsl_uniforms[1].glsl_name = "u_viewport";
    sg_shader map_shd = sg_make_shader(&sd);
    m->pip = sg_make_pipeline(&(sg_pipeline_desc){
        .shader = map_shd,
        .layout = {
            .buffers[0].stride = 24,
            .attrs[0].format = SG_VERTEXFORMAT_FLOAT2,
            .attrs[1].format = SG_VERTEXFORMAT_FLOAT4,
        },
        .primitive_type = SG_PRIMITIVETYPE_TRIANGLES,
        .sample_count = sapp_sample_count(),
        .depth.compare = SG_COMPAREFUNC_ALWAYS,
        .depth.write_enabled = false,
        .colors[0].blend.enabled = true,
        .colors[0].blend.src_factor_rgb = SG_BLENDFACTOR_SRC_ALPHA,
        .colors[0].blend.dst_factor_rgb = SG_BLENDFACTOR_ONE_MINUS_SRC_ALPHA,
        .colors[0].blend.op_rgb = SG_BLENDOP_ADD,
        .colors[0].blend.src_factor_alpha = SG_BLENDFACTOR_ONE,
        .colors[0].blend.dst_factor_alpha = SG_BLENDFACTOR_ONE_MINUS_SRC_ALPHA,
        .colors[0].blend.op_alpha = SG_BLENDOP_ADD,
        .label = "map-pipeline",
    });
}

void map_render(map_t *m, scene_t *s) {
    mat4 map_view_proj;
    float map_eye[3] = { 0.0f, 0.0f, 0.0f };
    bool map_scene_ready = false;
    if (s->loaded && s->gpu_ready) {
        float floor_y = m->camera[3];
        float scale = m->camera[2];
        float vw = m->viewport[0];
        float vh = m->viewport[1];
        if (scale > 0.01f && vw > 1.0f && vh > 1.0f) {
            float half_w = vw / (2.0f * scale);
            float half_h = vh / (2.0f * scale);
            float eye[3] = { m->camera[0], floor_y + 40.0f, m->camera[1] };
            float aim[3] = { m->camera[0], floor_y, m->camera[1] };
            float up[3] = { 0.0f, 0.0f, -1.0f };
            mat4 proj = mat4_ortho(-half_w, half_w, -half_h, half_h, 0.1f, 80.0f);
            mat4 view = mat4_look_at(eye, aim, up);
            vs_params_t vs = { .view_proj = mat4_mul(proj, view) };
            map_view_proj = vs.view_proj;
            memcpy(map_eye, eye, sizeof(map_eye));
            map_scene_ready = true;
            fs_params_t fs = { 0 };
            fs.camera[0] = eye[0]; fs.camera[1] = eye[1]; fs.camera[2] = eye[2]; fs.camera[3] = 1000.0f;
            fs.fog[0] = 2000.0f;
            fs.clip[0] = floor_y - 0.3f;
            fs.clip[1] = floor_y + 4.9f;
            fs.clip[2] = 1.0f;
            sg_apply_pipeline(s->pip);
            sg_apply_bindings(&(sg_bindings){
                .vertex_buffers[0] = s->vbuf,
                .index_buffer = s->tri_ibuf,
            });
            sg_apply_uniforms(0, &(sg_range){ &vs, sizeof(vs) });
            sg_apply_uniforms(1, &(sg_range){ &fs, sizeof(fs) });
            sg_draw(0, s->triangle_count * 3, 1);
        }
    }
    if (m->vertex_count > 0) {
        map_params_t mp = { 0 };
        memcpy(mp.camera, m->camera, sizeof(mp.camera));
        memcpy(mp.viewport, m->viewport, sizeof(mp.viewport));
        sg_apply_pipeline(m->pip);
        sg_apply_bindings(&(sg_bindings){
            .vertex_buffers[0] = m->vbuf,
        });
        sg_apply_uniforms(0, &(sg_range){ &mp, sizeof(mp) });
        sg_draw(0, m->vertex_count, 1);
    }
    if (map_scene_ready && scene_marker_count() > 0 && fabsf(scene_marker(0)->y - m->camera[3]) < 2.5f) {
        const marker_t *mk = scene_marker(0);
        if (mk->shape >= 0 && mk->shape < MARKER_SHAPE_COUNT &&
            s->marker_index_count[mk->shape] > 0) {
            marker_vs_params_t mv = { map_view_proj, marker_model(mk) };
            marker_fs_params_t mf = { 0 };
            mf.camera[0] = map_eye[0];
            mf.camera[1] = map_eye[1];
            mf.camera[2] = map_eye[2];
            mf.color[0] = mk->r;
            mf.color[1] = mk->g;
            mf.color[2] = mk->b;
            mf.color[3] = 1.0f;
            sg_apply_pipeline(s->marker_pip);
            sg_apply_bindings(&(sg_bindings){
                .vertex_buffers[0] = s->marker_vbuf[mk->shape],
                .index_buffer = s->marker_ibuf[mk->shape],
            });
            sg_apply_uniforms(0, &(sg_range){ &mv, sizeof(mv) });
            sg_apply_uniforms(1, &(sg_range){ &mf, sizeof(mf) });
            sg_draw(0, s->marker_index_count[mk->shape], 1);
        }
    }
}

EMSCRIPTEN_KEEPALIVE int rpd_map_set_data(const float *data, int vertex_count) {
    if (!data || vertex_count <= 0) {
        g_rpd.map.vertex_count = 0;
        return 0;
    }
    if (g_rpd.map.vbuf.id != SG_INVALID_ID) sg_destroy_buffer(g_rpd.map.vbuf);
    g_rpd.map.vbuf = sg_make_buffer(&(sg_buffer_desc){
        .data = { .ptr = data, .size = (size_t)vertex_count * 24 },
        .label = "map-vertices",
    });
    g_rpd.map.vertex_count = vertex_count;
    return 0;
}

EMSCRIPTEN_KEEPALIVE void rpd_map_set_camera(float cx, float cz, float scale, float vw, float vh, float floor_y) {
    g_rpd.map.camera[0] = cx;
    g_rpd.map.camera[1] = cz;
    g_rpd.map.camera[2] = scale;
    g_rpd.map.camera[3] = floor_y;
    g_rpd.map.viewport[0] = vw;
    g_rpd.map.viewport[1] = vh;
    g_rpd.map.viewport[2] = 0.0f;
    g_rpd.map.viewport[3] = 0.0f;
}
