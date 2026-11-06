#include "rpd_target.h"

#include "rpd_overlay.h"

#include <string.h>

#include "rpd_shaders.h"

void target_destroy(target_t *t) {
    if (t->color.id != SG_INVALID_ID) sg_destroy_image(t->color);
    if (t->normal.id != SG_INVALID_ID) sg_destroy_image(t->normal);
    if (t->linear.id != SG_INVALID_ID) sg_destroy_image(t->linear);
    if (t->depth.id != SG_INVALID_ID) sg_destroy_image(t->depth);
    if (t->color_att.id != SG_INVALID_ID) sg_destroy_view(t->color_att);
    if (t->normal_att.id != SG_INVALID_ID) sg_destroy_view(t->normal_att);
    if (t->linear_att.id != SG_INVALID_ID) sg_destroy_view(t->linear_att);
    if (t->depth_att.id != SG_INVALID_ID) sg_destroy_view(t->depth_att);
    if (t->tex_view.id != SG_INVALID_ID) sg_destroy_view(t->tex_view);
    if (t->normal_tex_view.id != SG_INVALID_ID) sg_destroy_view(t->normal_tex_view);
    if (t->linear_tex_view.id != SG_INVALID_ID) sg_destroy_view(t->linear_tex_view);
    if (t->sampler.id != SG_INVALID_ID) sg_destroy_sampler(t->sampler);
    sg_buffer quad = t->quad;
    sg_pipeline pip = t->pip;
    memset(t, 0, sizeof(*t));
    t->quad = quad;
    t->pip = pip;
}

void target_create(target_t *t, int width, int height) {
    target_destroy(t);
    if (width < 1) width = 1;
    if (height < 1) height = 1;
    t->width = width;
    t->height = height;
    t->color = sg_make_image(&(sg_image_desc){
        .usage = { .color_attachment = true },
        .width = width, .height = height,
        .pixel_format = SG_PIXELFORMAT_RGBA8,
        .sample_count = 1,
        .label = "rpd-color-target",
    });
    t->normal = sg_make_image(&(sg_image_desc){
        .usage = { .color_attachment = true },
        .width = width, .height = height,
        .pixel_format = SG_PIXELFORMAT_RGBA8,
        .sample_count = 1,
        .label = "rpd-normal-target",
    });
    t->linear = sg_make_image(&(sg_image_desc){
        .usage = { .color_attachment = true },
        .width = width, .height = height,
        .pixel_format = SG_PIXELFORMAT_RGBA8,
        .sample_count = 1,
        .label = "rpd-linear-depth-target",
    });
    t->depth = sg_make_image(&(sg_image_desc){
        .usage = { .depth_stencil_attachment = true },
        .width = width, .height = height,
        .pixel_format = SG_PIXELFORMAT_DEPTH,
        .sample_count = 1,
        .label = "rpd-depth-target",
    });
    t->color_att = sg_make_view(&(sg_view_desc){
        .color_attachment = { .image = t->color },
        .label = "rpd-color-attachment",
    });
    t->normal_att = sg_make_view(&(sg_view_desc){
        .color_attachment = { .image = t->normal },
        .label = "rpd-normal-attachment",
    });
    t->linear_att = sg_make_view(&(sg_view_desc){
        .color_attachment = { .image = t->linear },
        .label = "rpd-linear-depth-attachment",
    });
    t->depth_att = sg_make_view(&(sg_view_desc){
        .depth_stencil_attachment = { .image = t->depth },
        .label = "rpd-depth-attachment",
    });
    t->tex_view = sg_make_view(&(sg_view_desc){
        .texture = { .image = t->color },
        .label = "rpd-color-texture",
    });
    t->normal_tex_view = sg_make_view(&(sg_view_desc){
        .texture = { .image = t->normal },
        .label = "rpd-normal-texture",
    });
    t->linear_tex_view = sg_make_view(&(sg_view_desc){
        .texture = { .image = t->linear },
        .label = "rpd-linear-depth-texture",
    });
    t->sampler = sg_make_sampler(&(sg_sampler_desc){
        .min_filter = SG_FILTER_LINEAR,
        .mag_filter = SG_FILTER_LINEAR,
        .wrap_u = SG_WRAP_CLAMP_TO_EDGE,
        .wrap_v = SG_WRAP_CLAMP_TO_EDGE,
        .label = "rpd-composite-sampler",
    });
    t->pass = (sg_pass){
        .action.colors[0] = {
            .load_action = SG_LOADACTION_CLEAR,
            .clear_value = { 0.962f, 0.952f, 0.921f, 1.0f },
        },
        .action.colors[1] = {
            .load_action = SG_LOADACTION_CLEAR,
            .clear_value = { 0.0f, 0.0f, 0.0f, 0.0f },
        },
        .action.colors[2] = {
            .load_action = SG_LOADACTION_CLEAR,
            .clear_value = { 0.0f, 0.0f, 0.0f, 0.0f },
        },
        .action.depth = {
            .load_action = SG_LOADACTION_CLEAR,
            .clear_value = 1.0f,
        },
        .attachments.colors[0] = t->color_att,
        .attachments.colors[1] = t->normal_att,
        .attachments.colors[2] = t->linear_att,
        .attachments.depth_stencil = t->depth_att,
        .label = "rpd-offscreen-pass",
    };
    t->data_pass = (sg_pass){
        .action.colors[0] = {
            .load_action = SG_LOADACTION_CLEAR,
            .clear_value = { 0.0f, 0.0f, 0.0f, 0.0f },
        },
        .action.colors[1] = {
            .load_action = SG_LOADACTION_CLEAR,
            .clear_value = { 0.0f, 0.0f, 0.0f, 0.0f },
        },
        .action.depth = {
            .load_action = SG_LOADACTION_LOAD,
        },
        .attachments.colors[0] = t->normal_att,
        .attachments.colors[1] = t->linear_att,
        .attachments.depth_stencil = t->depth_att,
        .label = "rpd-paper-data-pass",
    };
    t->dirty = false;
}

void target_create_composite(target_t *t) {
    const float quad[] = { -1.0f, -1.0f, 3.0f, -1.0f, -1.0f, 3.0f };
    t->quad = sg_make_buffer(&(sg_buffer_desc){
        .data = { .ptr = quad, .size = sizeof(quad) },
        .label = "fullscreen-quad",
    });
    sg_shader shd = sg_make_shader(composite_shader_desc(sg_query_backend()));
    t->pip = sg_make_pipeline(&(sg_pipeline_desc){
        .shader = shd,
        .layout = {
            .buffers[0].stride = 8,
            .attrs[0].format = SG_VERTEXFORMAT_FLOAT2,
        },
        .primitive_type = SG_PRIMITIVETYPE_TRIANGLES,
        .sample_count = sapp_sample_count(),
        .depth.compare = SG_COMPAREFUNC_ALWAYS,
        .depth.write_enabled = false,
        .label = "composite-pipeline",
    });
}

void target_composite(target_t *t, const sg_pass_action *action) {
    sg_begin_pass(&(sg_pass){
        .action = *action,
        .swapchain = sglue_swapchain(),
    });
    sg_apply_pipeline(t->pip);
    sg_apply_bindings(&(sg_bindings){
        .vertex_buffers[0] = t->quad,
        .views[0] = t->tex_view,
        .views[1] = t->normal_tex_view,
        .views[2] = t->linear_tex_view,
        .samplers[0] = t->sampler,
        .samplers[1] = t->sampler,
        .samplers[2] = t->sampler,
    });
    sg_draw(0, 3, 1);
    overlay_draw();
    sg_end_pass();
}
