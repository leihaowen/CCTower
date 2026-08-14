#[cfg(target_os = "macos")]
use tauri::Emitter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_process::init())
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // 主窗口是 visible=false 的托盘常驻窗口。点 Dock / Finder / Launchpad 里的图标时,
    // macOS 只发 applicationShouldHandleReopen(即 RunEvent::Reopen),不会自己把隐藏的
    // 窗口显示出来——不接这个事件的话,用户点图标像是没反应,只能从托盘唤起。
    // 这里只转成前端事件,由 shell/app.js 走和托盘一样的唤起逻辑(按光标所在屏居中),
    // 免得 Rust 与 JS 两套定位规则各行其是。
    app.run(|_app_handle, _event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = _event {
            let _ = _app_handle.emit("ccw:reopen", ());
        }
    });
}
