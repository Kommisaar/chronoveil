use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    // 不用 tauri-build 自带的 bin-only app manifest：它经 embed-resource 只链进 bin
    // 目标，测试二进制（含 lib 单元测试）不带 manifest，而 tauri 默认特性
    // common-controls-v6 经 muda 引入 TaskDialogIndirect（comctl32 v6-only 导出）→
    // 无 manifest 的进程把 comctl32 解析到 v5，测试进程启动即
    // STATUS_ENTRYPOINT_NOT_FOUND（TASK-005：cargo test 必须可跑）。
    // 这里改为「不带 tauri-build manifest + 本脚本给所有目标统一嵌同一 manifest」。
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest()),
    )
    .expect("tauri-build 失败");

    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());

        // 与 tauri-build/src/windows-app-manifest.xml 一致：Common-Controls v6 依赖。
        let manifest_xml = out_dir.join("app.manifest");
        fs::write(
            &manifest_xml,
            r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>
"#,
        )
        .unwrap();

        // RC 指令：资源 ID 1（CREATEPROCESS_MANIFEST_RESOURCE_ID），类型 24（RT_MANIFEST）。
        let rc = out_dir.join("app_manifest.rc");
        fs::write(
            &rc,
            format!("1 24 \"{}\"", to_rc_path(&manifest_xml)),
        )
        .unwrap();

        // 链接进本包所有目标（bin / lib / 测试），保证 manifest 全局唯一且处处存在。
        // Failed（环境可编译却失败）即构建失败：缺 manifest 的测试二进制在
        // Windows 上无法启动；NotWindows / NotAttempted 由库自行容忍。
        if let Err(e) = embed_resource::compile_for_everything(&rc, embed_resource::NONE).manifest_required() {
            panic!("编译 Windows manifest 资源失败：{e:?}");
        }
    }
}

/// RC 字符串用正斜杠，避免转义问题（rc.exe 接受正斜杠路径）。
fn to_rc_path(p: &Path) -> String {
    p.display().to_string().replace('\\', "/")
}
