const std = @import("std");
const Build = std.Build;
const sokol = @import("sokol");

pub fn build(b: *Build) !void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const dep_sokol = b.dependency("sokol", .{
        .target = target,
        .optimize = optimize,
    });

    // add install-emsdk step for WASM builds
    const emsdk = dep_sokol.builder.dependency("emsdk", .{});
    const emsdk_install_step = sokol.emSdkInstallStep(b, emsdk, .{});
    b.step("install-emsdk", "Install Emscripten SDK").dependOn(emsdk_install_step);

    // compile the cube shader
    const shd_step = try sokol.shdc.createSourceFile(b, .{
        .shdc_dep = b.dependency("shdc", .{}),
        .input = "examples/shaders/cube.glsl",
        .output = "src/shaders/cube.glsl.zig",
        .slang = .{
            .glsl300es = true,
            .glsl410 = true,
            .metal_macos = true,
            .hlsl5 = true,
            .wgsl = true,
            .spirv_vk = true,
        },
        .reflection = true,
    });

    const mod = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{
            .{ .name = "sokol", .module = dep_sokol.module("sokol") },
        },
    });

    if (target.result.cpu.arch.isWasm()) {
        try buildWeb(b, .{ .mod = mod, .dep_sokol = dep_sokol, .shd_step = shd_step });
    } else {
        try buildNative(b, .{ .mod = mod, .shd_step = shd_step });
    }
}

const Options = struct {
    mod: *Build.Module,
    dep_sokol: ?*Build.Dependency = null,
    shd_step: ?*Build.Step = null,
};

fn buildNative(b: *Build, opts: Options) !void {
    const exe = b.addExecutable(.{
        .name = "cube",
        .root_module = opts.mod,
    });
    if (opts.shd_step) |shd_step| {
        exe.step.dependOn(shd_step);
    }
    b.installArtifact(exe);

    const run = b.addRunArtifact(exe);
    b.step("run", "Run cube").dependOn(&run.step);
}

fn buildWeb(b: *Build, opts: Options) !void {
    const lib = b.addLibrary(.{
        .name = "cube",
        .root_module = opts.mod,
    });
    if (opts.shd_step) |shd_step| {
        lib.step.dependOn(shd_step);
    }

    const emsdk = opts.dep_sokol.?.builder.dependency("emsdk", .{});
    const link_step = try sokol.emLinkStep(b, .{
        .lib_main = lib,
        .target = opts.mod.resolved_target.?,
        .optimize = opts.mod.optimize.?,
        .emsdk = emsdk,
        .use_webgl2 = true,
        .use_emmalloc = true,
        .use_filesystem = false,
        .shell_file_path = b.path("shell.html"),
    });

    b.getInstallStep().dependOn(&link_step.step);

    const run = sokol.emRunStep(b, .{ .name = "cube", .emsdk = emsdk });
    run.step.dependOn(&link_step.step);
    b.step("run", "Run cube").dependOn(&run.step);
}
