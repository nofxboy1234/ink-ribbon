#include "rpd_item_render.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "rpd_sokol.h"
#include "rpd_items.h"
#include "rpd_shaders.h"

#define ITM1_HEADER_SIZE 32u
#define ITM1_DIRECTORY_SIZE 108u
#define ITM1_STRIDE 20
#define ITEM_VERTEX_STRIDE 32
#define ITEM_MIN_PIXEL_NDC 0.0032f
#define ITEM_MIN_SCALE 0.55f
#define ITEM_MAX_SCALE 1.6f

typedef struct {
    char id[24];
    int vertex_base;
    int vertex_count;
    int group_first;
    int group_count;
    float metres_per_unit;
} item_model_t;

typedef struct {
    int material;
    int first_index;
    int index_count;
} item_group_t;

typedef struct {
    char albedo[192];
} item_material_t;

static item_model_t *g_models;
static int g_model_count;
static item_group_t *g_groups;
static int g_group_count;
static item_material_t *g_materials;
static int g_material_count;
static int *g_item_model;          // registry item index -> model index or -1
static bool g_uploaded;

static sg_buffer g_vbuf;
static sg_buffer g_ibuf;
static sg_pipeline g_pip;
static sg_sampler g_sampler;
static sg_image g_textures[256];
static sg_view g_texture_views[256];
static int g_texture_count;
static int g_textured;
static float g_stats[6];
static int g_upload_error;

typedef struct {
    int material;
    int width;
    int height;
    uint8_t *rgba;
} pending_texture_t;

static uint8_t *g_pending_bin;
static size_t g_pending_size;
static pending_texture_t g_pending_textures[256];
static int g_pending_texture_count;

static float half_to_float(uint16_t h) {
    uint32_t sign = (h >> 15) & 1u;
    uint32_t exponent = (h >> 10) & 0x1fu;
    uint32_t mantissa = h & 0x3ffu;
    float value;
    if (exponent == 0) value = ldexpf((float)mantissa, -24);
    else if (exponent == 31) value = mantissa ? NAN : INFINITY;
    else value = ldexpf((float)(mantissa | 0x400u), (int)exponent - 25);
    return sign ? -value : value;
}

static uint32_t read_u32(const uint8_t *p) {
    uint32_t value;
    memcpy(&value, p, sizeof(value));
    return value;
}

static uint16_t read_u16(const uint8_t *p) {
    uint16_t value;
    memcpy(&value, p, sizeof(value));
    return value;
}

static float read_f32(const uint8_t *p) {
    float value;
    memcpy(&value, p, sizeof(value));
    return value;
}

static sg_pipeline make_pipeline(void) {
    sg_shader shader = sg_make_shader(item_shader_desc(sg_query_backend()));
    sg_pipeline_desc pd;
    memset(&pd, 0, sizeof(pd));
    pd.shader = shader;
    pd.layout.buffers[0].stride = ITEM_VERTEX_STRIDE;
    pd.layout.attrs[0].format = SG_VERTEXFORMAT_FLOAT3;
    pd.layout.attrs[1].format = SG_VERTEXFORMAT_FLOAT3;
    pd.layout.attrs[1].offset = 12;
    pd.layout.attrs[2].format = SG_VERTEXFORMAT_FLOAT2;
    pd.layout.attrs[2].offset = 24;
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
    pd.label = "item-pipeline";
    return sg_make_pipeline(&pd);
}

void item_render_create_pipelines(void) {
    g_pip = make_pipeline();
    g_sampler = sg_make_sampler(&(sg_sampler_desc){
        .min_filter = SG_FILTER_LINEAR,
        .mag_filter = SG_FILTER_LINEAR,
        .wrap_u = SG_WRAP_CLAMP_TO_EDGE,
        .wrap_v = SG_WRAP_CLAMP_TO_EDGE,
        .label = "item-sampler",
    });
}

static bool upload_textures_white(int count) {
    static const uint8_t white[4] = { 255, 255, 255, 255 };
    g_texture_count = count;
    g_textured = 0;
    for (int i = 0; i < count && i < 256; i++) {
        g_textures[i] = sg_make_image(&(sg_image_desc){
            .width = 1,
            .height = 1,
            .pixel_format = SG_PIXELFORMAT_RGBA8,
            .data = { .ptr = white, .size = sizeof(white) },
            .label = "item-texture-fallback",
        });
        g_texture_views[i] = sg_make_view(&(sg_view_desc){
            .texture = { .image = g_textures[i] },
            .label = "item-texture-fallback-view",
        });
    }
    return true;
}

static void apply_texture(int material, const uint8_t *rgba, int width, int height) {
    if (!rgba || width <= 0 || height <= 0) return;
    if (material < 0 || material >= g_texture_count || material >= 256) return;
    if (g_textures[material].id != SG_INVALID_ID) sg_destroy_image(g_textures[material]);
    if (g_texture_views[material].id != SG_INVALID_ID) sg_destroy_view(g_texture_views[material]);
    g_textures[material] = sg_make_image(&(sg_image_desc){
        .width = width,
        .height = height,
        .pixel_format = SG_PIXELFORMAT_RGBA8,
        .data = { .ptr = rgba, .size = (size_t)width * (size_t)height * 4 },
        .label = "item-albedo",
    });
    g_texture_views[material] = sg_make_view(&(sg_view_desc){
        .texture = { .image = g_textures[material] },
        .label = "item-albedo-view",
    });
    g_textured++;
}

void item_render_texture(int material, const uint8_t *rgba, int width, int height) {
    if (!rgba || width <= 0 || height <= 0) return;
    if (g_uploaded && sg_isvalid()) {
        apply_texture(material, rgba, width, height);
        return;
    }
    if (g_pending_texture_count >= 256) return;
    size_t size = (size_t)width * (size_t)height * 4;
    uint8_t *copy = (uint8_t *)malloc(size);
    if (!copy) return;
    memcpy(copy, rgba, size);
    g_pending_textures[g_pending_texture_count].material = material;
    g_pending_textures[g_pending_texture_count].width = width;
    g_pending_textures[g_pending_texture_count].height = height;
    g_pending_textures[g_pending_texture_count].rgba = copy;
    g_pending_texture_count++;
}

int item_render_material_count(void) {
    return g_material_count;
}

const char *item_render_material_albedo(int material) {
    if (material < 0 || material >= g_material_count) return "";
    return g_materials[material].albedo;
}

int item_render_model_count(void) {
    return g_model_count;
}

static int find_model(const char *id) {
    for (int i = 0; i < g_model_count; i++) {
        if (strncmp(g_models[i].id, id, 24) == 0) return i;
    }
    return -1;
}

static bool upload_now(const uint8_t *data, size_t size) {
    g_upload_error = 1;
    if (!data || size < ITM1_HEADER_SIZE) return false;
    if (memcmp(data, "ITM1", 4) != 0) return false;
    uint32_t version = read_u32(data + 4);
    if (version != 1) return false;
    uint32_t model_count = read_u32(data + 8);
    uint32_t material_count = read_u32(data + 12);
    uint32_t directory_offset = read_u32(data + 16);
    uint32_t material_offset = read_u32(data + 20);
    uint32_t string_offset = read_u32(data + 24);
    uint32_t string_size = read_u32(data + 28);
    g_upload_error = 2;
    if (model_count == 0 || model_count > 512 || material_count > 256) return false;
    if ((size_t)directory_offset + (size_t)model_count * ITM1_DIRECTORY_SIZE > size) return false;
    if ((size_t)string_offset + string_size > size) return false;

    g_upload_error = 3;
    g_models = (item_model_t *)calloc(model_count, sizeof(item_model_t));
    g_materials = (item_material_t *)calloc(material_count, sizeof(item_material_t));
    if (!g_models || !g_materials) return false;
    g_model_count = (int)model_count;
    g_material_count = (int)material_count;

    const char *strings = (const char *)(data + string_offset);
    for (uint32_t m = 0; m < material_count; m++) {
        const uint8_t *record = data + material_offset + (size_t)m * 32;
        uint32_t name_offset = read_u32(record);
        if (name_offset > 0 && name_offset < string_size) {
            const char *albedo = strings + name_offset;
            size_t length = strnlen(albedo, string_size - name_offset);
            if (length >= sizeof(g_materials[m].albedo)) length = sizeof(g_materials[m].albedo) - 1;
            memcpy(g_materials[m].albedo, albedo, length);
            g_materials[m].albedo[length] = 0;
        }
    }

    size_t vertex_total = 0;
    size_t index_total = 0;
    size_t group_total = 0;
    for (uint32_t m = 0; m < model_count; m++) {
        const uint8_t *entry = data + directory_offset + (size_t)m * ITM1_DIRECTORY_SIZE;
        uint32_t vertex_count = read_u32(entry + 28);
        uint32_t index_count = read_u32(entry + 36);
        uint32_t primitive_count = read_u32(entry + 44);
        vertex_total += vertex_count;
        index_total += index_count;
        group_total += primitive_count;
    }
    g_upload_error = 4;
    if (vertex_total > 4000000 || index_total > 4000000) return false;

    float *vertices = (float *)malloc(vertex_total * 8 * sizeof(float));
    uint32_t *indices = (uint32_t *)malloc(index_total * sizeof(uint32_t));
    g_groups = (item_group_t *)calloc(group_total, sizeof(item_group_t));
    g_item_model = (int *)calloc((size_t)items_registry_count(), sizeof(int));
    if (!vertices || !indices || !g_groups || !g_item_model) {
        free(vertices); free(indices);
        return false;
    }

    size_t vertex_base = 0;
    size_t index_base = 0;
    int group_cursor = 0;
    for (uint32_t m = 0; m < model_count; m++) {
        const uint8_t *entry = data + directory_offset + (size_t)m * ITM1_DIRECTORY_SIZE;
        memcpy(g_models[m].id, entry, 24);
        g_models[m].id[23] = 0;
        uint32_t vertex_offset = read_u32(entry + 24);
        uint32_t vertex_count = read_u32(entry + 28);
        uint32_t index_offset = read_u32(entry + 32);
        uint32_t index_count = read_u32(entry + 36);
        uint32_t primitive_offset = read_u32(entry + 40);
        uint32_t primitive_count = read_u32(entry + 44);
        uint16_t index_size = read_u16(entry + 48);
        float origin[3] = { read_f32(entry + 52), read_f32(entry + 56), read_f32(entry + 60) };
        float quant_scale = read_f32(entry + 64);
        g_models[m].metres_per_unit = read_f32(entry + 92);
        g_models[m].vertex_base = (int)vertex_base;
        g_models[m].vertex_count = (int)vertex_count;
        g_models[m].group_first = group_cursor;

        if ((size_t)vertex_offset + (size_t)vertex_count * ITM1_STRIDE > size) goto fail;
        if ((size_t)index_offset + (size_t)index_count * index_size > size) goto fail;
        if ((size_t)primitive_offset + (size_t)primitive_count * 16 > size) goto fail;

        for (uint32_t v = 0; v < vertex_count; v++) {
            const uint8_t *src = data + vertex_offset + (size_t)v * ITM1_STRIDE;
            float *dst = vertices + (vertex_base + v) * 8;
            dst[0] = origin[0] + (float)read_u16(src + 0) * quant_scale;
            dst[1] = origin[1] + (float)read_u16(src + 2) * quant_scale;
            dst[2] = origin[2] + (float)read_u16(src + 4) * quant_scale;
            dst[3] = (float)(int16_t)read_u16(src + 6) / 32767.0f;
            dst[4] = (float)(int16_t)read_u16(src + 8) / 32767.0f;
            dst[5] = (float)(int16_t)read_u16(src + 10) / 32767.0f;
            dst[6] = half_to_float(read_u16(src + 14));
            dst[7] = half_to_float(read_u16(src + 16));
        }

        // Merge primitives that share a material so each item draws one call
        // per material. Two passes keep each material's range contiguous.
        int unique[256];
        int unique_count = 0;
        for (uint32_t p = 0; p < primitive_count; p++) {
            int material = (int)read_u32(data + primitive_offset + (size_t)p * 16 + 8);
            int found = 0;
            for (int g = 0; g < unique_count; g++) {
                if (unique[g] == material) { found = 1; break; }
            }
            if (!found) {
                if (unique_count >= 256) goto fail;
                unique[unique_count++] = material;
            }
        }
        for (int g = 0; g < unique_count; g++) {
            item_group_t *group = &g_groups[group_cursor++];
            group->material = unique[g];
            group->first_index = (int)index_base;
            group->index_count = 0;
            for (uint32_t p = 0; p < primitive_count; p++) {
                const uint8_t *record = data + primitive_offset + (size_t)p * 16;
                uint32_t start = read_u32(record + 0);
                uint32_t count = read_u32(record + 4);
                if ((int)read_u32(record + 8) != unique[g]) continue;
                for (uint32_t i = 0; i < count && start + i < index_count; i++) {
                    uint32_t local = index_size == 4
                        ? read_u32(data + index_offset + (size_t)(start + i) * 4)
                        : read_u16(data + index_offset + (size_t)(start + i) * 2);
                    indices[index_base++] = local;
                    group->index_count++;
                }
            }
        }
        g_models[m].group_count = unique_count;
        vertex_base += vertex_count;
    }

    g_group_count = group_cursor;
    g_vbuf = sg_make_buffer(&(sg_buffer_desc){
        .size = vertex_base * 8 * sizeof(float),
        .data = { .ptr = vertices, .size = vertex_base * 8 * sizeof(float) },
        .label = "item-vertices",
    });
    g_ibuf = sg_make_buffer(&(sg_buffer_desc){
        .usage = { .index_buffer = true },
        .size = index_base * sizeof(uint32_t),
        .data = { .ptr = indices, .size = index_base * sizeof(uint32_t) },
        .label = "item-indices",
    });
    free(vertices);
    free(indices);
    g_upload_error = 6;
    if (sg_query_buffer_state(g_vbuf) != SG_RESOURCESTATE_VALID ||
        sg_query_buffer_state(g_ibuf) != SG_RESOURCESTATE_VALID) return false;
    g_upload_error = 7;
    if (!upload_textures_white((int)material_count)) return false;

    for (int i = 0; i < items_registry_count(); i++) {
        const rpd_item_def_t *def = items_def(i);
        g_item_model[i] = (def && def->model) ? find_model(def->model) : -1;
    }
    g_uploaded = true;
    g_upload_error = 0;
    return true;
fail:
    free(vertices);
    free(indices);
    return false;
}

bool item_render_upload(const uint8_t *data, size_t size) {
    if (!data || size < ITM1_HEADER_SIZE) return false;
    if (g_uploaded) return true;
    if (sg_isvalid()) return upload_now(data, size);
    free(g_pending_bin);
    g_pending_bin = (uint8_t *)malloc(size);
    if (!g_pending_bin) return false;
    memcpy(g_pending_bin, data, size);
    g_pending_size = size;
    return true;
}

void item_render_tick(void) {
    if (!g_uploaded && g_pending_bin && sg_isvalid()) {
        uint8_t *data = g_pending_bin;
        size_t size = g_pending_size;
        g_pending_bin = NULL;
        g_pending_size = 0;
        upload_now(data, size);
        free(data);
    }
    if (!g_uploaded) return;
    for (int i = 0; i < g_pending_texture_count; i++) {
        apply_texture(g_pending_textures[i].material, g_pending_textures[i].rgba,
                      g_pending_textures[i].width, g_pending_textures[i].height);
        free(g_pending_textures[i].rgba);
    }
    g_pending_texture_count = 0;
}

static mat4 item_model_matrix(const item_t *item, const item_model_t *model) {
    float scale = model->metres_per_unit;
    if (!(scale > 0.0f)) scale = ITEM_MIN_SCALE;
    if (scale < ITEM_MIN_SCALE) scale = ITEM_MIN_SCALE;
    if (scale > ITEM_MAX_SCALE) scale = ITEM_MAX_SCALE;
    mat4 out = { 0 };
    out.m[0] = scale;
    out.m[5] = scale;
    out.m[10] = scale;
    out.m[12] = item->def->x;
    out.m[13] = item->def->y;
    out.m[14] = item->def->z;
    out.m[15] = 1.0f;
    return out;
}

void item_render_models(mat4 view_proj, const float eye[3], bool ortho, int floor,
                        bool clip, float clip_min, float clip_max) {
    g_stats[0] = (float)g_model_count;
    g_stats[1] = (float)g_material_count;
    g_stats[2] = (float)g_textured;
    g_stats[3] = 0.0f;
    g_stats[4] = 0.0f;
    g_stats[5] = g_uploaded ? 1.0f : 0.0f;
    if (!g_uploaded) return;
    sg_apply_pipeline(g_pip);
    item_fs_params_t fs = { 0 };
    fs.u_camera[0] = eye[0]; fs.u_camera[1] = eye[1]; fs.u_camera[2] = eye[2];
    fs.u_clip[0] = clip_min;
    fs.u_clip[1] = clip_max;
    fs.u_clip[2] = clip ? 1.0f : 0.0f;
    sg_apply_uniforms(UB_item_fs_params, &(sg_range){ &fs, sizeof(fs) });
    for (int i = 0; i < items_registry_count(); i++) {
        const item_t *item = items_get(i);
        if (!item || item->state != ITEM_PRESENT) continue;
        int model_index = g_item_model[i];
        if (model_index < 0) continue;
        if (item->def->floor != floor && ortho) continue;
        const item_model_t *model = &g_models[model_index];
        if (model->group_count <= 0) continue;
        if (!ortho) {
            // A model smaller than roughly two pixels is not worth a draw.
            // The overview camera culls the whole registry this way, while a
            // close orbit still shows every instance on the floor.
            float cx = view_proj.m[0] * item->def->x + view_proj.m[4] * item->def->y +
                       view_proj.m[8] * item->def->z + view_proj.m[12];
            float cy = view_proj.m[1] * item->def->x + view_proj.m[5] * item->def->y +
                       view_proj.m[9] * item->def->z + view_proj.m[13];
            float cw = view_proj.m[3] * item->def->x + view_proj.m[7] * item->def->y +
                       view_proj.m[11] * item->def->z + view_proj.m[15];
            if (cw < 0.01f) continue;
            float scale = model->metres_per_unit;
            if (scale < ITEM_MIN_SCALE) scale = ITEM_MIN_SCALE;
            if (scale > ITEM_MAX_SCALE) scale = ITEM_MAX_SCALE;
            float radius = 0.5f * scale * fabsf(view_proj.m[5]) / cw;
            if (radius < ITEM_MIN_PIXEL_NDC) continue;
            if (fabsf(cx / cw) > 1.0f + radius || fabsf(cy / cw) > 1.0f + radius) continue;
        }
        g_stats[3] += 1.0f;
        item_vs_params_t vs;
        mat4 model_matrix = item_model_matrix(item, model);
        memcpy(vs.u_view_proj, view_proj.m, sizeof(vs.u_view_proj));
        memcpy(vs.u_model, model_matrix.m, sizeof(vs.u_model));
        sg_apply_uniforms(UB_item_vs_params, &(sg_range){ &vs, sizeof(vs) });
        for (int g = 0; g < model->group_count; g++) {
            const item_group_t *group = &g_groups[model->group_first + g];
            if (group->index_count <= 0) continue;
            int material = group->material;
            if (material < 0 || material >= g_texture_count) continue;
            sg_apply_bindings(&(sg_bindings){
                .vertex_buffers[0] = g_vbuf,
                .vertex_buffer_offsets[0] = model->vertex_base * ITEM_VERTEX_STRIDE,
                .index_buffer = g_ibuf,
                .index_buffer_offset = group->first_index * (int)sizeof(uint32_t),
                .views[0] = g_texture_views[material],
                .samplers[0] = g_sampler,
            });
            sg_draw(0, group->index_count, 1);
            g_stats[4] += 1.0f;
        }
    }
}

int item_render_last_error(void) {
    return g_upload_error;
}

void item_render_stats(float *out) {
    if (!out) return;
    for (int i = 0; i < 6; i++) out[i] = g_stats[i];
}
