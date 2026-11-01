// LUAN AI VIDEO STUDIO desktop shell: one window for the React UI, and the local engine
// (luan/engine/server.mjs, Node) started in the background when it is not already running.
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, RunEvent};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const ENGINE_PORT: u16 = 4500;
// Local mode: the engine lives in the HyperFrames checkout on this machine. Override with
// LUAN_ENGINE_SCRIPT, or engine.json {"script": "..."} in the app's config folder.
const DEFAULT_ENGINE: &str = r"D:\CLAUDE CURSO WEBSITE LUAN\hyperfarems\hyperframes\luan\engine\server.mjs";

struct EngineState(Mutex<Option<Child>>);

#[derive(serde::Serialize)]
struct EngineInfo {
    script: String,
    script_exists: bool,
    node: Option<String>,
    running: bool,
    started_by_app: bool,
}

fn engine_up() -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], ENGINE_PORT));
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

fn find_node() -> Option<PathBuf> {
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let p = dir.join(exe);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    let std_path = PathBuf::from(r"C:\Program Files\nodejs\node.exe");
    std_path.is_file().then_some(std_path)
}

fn engine_script(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("LUAN_ENGINE_SCRIPT") {
        return PathBuf::from(p);
    }
    if let Ok(dir) = app.path().app_config_dir() {
        let cfg = dir.join("engine.json");
        if let Ok(text) = std::fs::read_to_string(cfg) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(s) = v.get("script").and_then(|s| s.as_str()) {
                    return PathBuf::from(s);
                }
            }
        }
    }
    PathBuf::from(DEFAULT_ENGINE)
}

fn start_engine(app: &tauri::AppHandle) -> Result<Option<Child>, String> {
    if engine_up() {
        return Ok(None);
    }
    let script = engine_script(app);
    if !script.is_file() {
        return Err(format!("Không tìm thấy engine: {}", script.display()));
    }
    let node = find_node().ok_or("Chưa cài Node.js (cần bản 22+)")?;
    let mut cmd = Command::new(node);
    cmd.arg(&script);
    if let Some(dir) = script.parent() {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let child = cmd.spawn().map_err(|e| format!("Không chạy được engine: {e}"))?;
    Ok(Some(child))
}

#[tauri::command]
fn engine_info(app: tauri::AppHandle, state: tauri::State<EngineState>) -> EngineInfo {
    let script = engine_script(&app);
    EngineInfo {
        script_exists: script.is_file(),
        script: script.display().to_string(),
        node: find_node().map(|p| p.display().to_string()),
        running: engine_up(),
        started_by_app: state.0.lock().map(|c| c.is_some()).unwrap_or(false),
    }
}

#[tauri::command]
fn restart_engine(app: tauri::AppHandle, state: tauri::State<EngineState>) -> Result<bool, String> {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        std::thread::sleep(Duration::from_millis(400));
        *guard = start_engine(&app)?;
    }
    Ok(true)
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(EngineState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![engine_info, restart_engine])
        .setup(|app| {
            let handle = app.handle().clone();
            match start_engine(&handle) {
                Ok(child) => {
                    if let Ok(mut guard) = app.state::<EngineState>().0.lock() {
                        *guard = child;
                    }
                }
                Err(e) => eprintln!("{e}"),
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("không khởi động được LUAN AI VIDEO STUDIO");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            // Stop the engine this app started; one started by someone else keeps running.
            if let Ok(mut guard) = handle.state::<EngineState>().0.lock() {
                if let Some(mut child) = guard.take() {
                    let _ = child.kill();
                }
            }
        }
    });
}
