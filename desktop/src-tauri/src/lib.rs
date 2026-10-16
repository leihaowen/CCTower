use tauri::{Emitter, Manager};

#[tauri::command]
fn read_mac_clipboard() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/usr/bin/pbpaste").output().map_err(|e| e.to_string())?;
        if !output.status.success() { return Err("无法读取剪贴板".into()); }
        String::from_utf8(output.stdout).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    { Err("请使用浏览器剪贴板或手动粘贴".into()) }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![read_mac_clipboard])
        .setup(|app| {
            tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .on_download(|webview, event| {
                    match event {
                        tauri::webview::DownloadEvent::Requested { destination, .. } => {
                            let Ok(downloads) = webview.app_handle().path().download_dir() else { return false; };
                            let Some(name) = destination.file_name() else { return false; };
                            let mut target = downloads.join(name);
                            if target.exists() {
                                let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
                                target = downloads.join(format!("{}-{}", stamp, name.to_string_lossy()));
                            }
                            *destination = target;
                        }
                        tauri::webview::DownloadEvent::Finished { path, success, .. } => {
                            let _ = webview.emit("ccw:download", serde_json::json!({ "path": path, "success": success }));
                        }
                        _ => ()
                    }
                    true
                })
                .build()?;
            Ok(())
        })
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
