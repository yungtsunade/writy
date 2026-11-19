// Writy – Desktop-Hülle. Speichert jedes Dokument als .md-Datei im gewählten Ordner.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, UNIX_EPOCH};
use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_dialog::DialogExt;

static CLOSING: AtomicBool = AtomicBool::new(false);

#[derive(Serialize)]
struct Doc {
    name: String,
    text: String,
    modified: u64,
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Nur einfache Dateinamen mit .md-Endung, keine Pfade.
fn doc_path(dir: &str, name: &str) -> Result<PathBuf, String> {
    let ok = !name.is_empty()
        && !name.contains('/')
        && !name.contains('\\')
        && name != "."
        && name != ".."
        && name.to_lowercase().ends_with(".md");
    if !ok {
        return Err(format!("Ungültiger Dateiname: {name}"));
    }
    Ok(Path::new(dir).join(name))
}

#[tauri::command]
fn default_dir(app: tauri::AppHandle) -> Result<String, String> {
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(err)?;
    let dir = base.join("Writy");
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
fn list_docs(dir: String) -> Result<Vec<Doc>, String> {
    fs::create_dir_all(&dir).map_err(err)?;
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(err)? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        let is_md = path
            .extension()
            .map(|e| e.to_string_lossy().eq_ignore_ascii_case("md"))
            .unwrap_or(false);
        if !path.is_file() || !is_md {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let bytes = match fs::read(&path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(Doc { name, text, modified });
    }
    Ok(out)
}

#[tauri::command]
fn write_doc(dir: String, name: String, text: String) -> Result<(), String> {
    fs::create_dir_all(&dir).map_err(err)?;
    let path = doc_path(&dir, &name)?;
    // erst in eine Zwischendatei schreiben, dann ersetzen – so geht nie ein halber Text verloren
    let tmp = Path::new(&dir).join(format!(".{name}.writy-tmp"));
    if fs::write(&tmp, &text).is_ok() && fs::rename(&tmp, &path).is_ok() {
        return Ok(());
    }
    let _ = fs::remove_file(&tmp);
    fs::write(&path, &text).map_err(err)
}

#[tauri::command]
fn rename_doc(dir: String, from: String, to: String) -> Result<(), String> {
    let a = doc_path(&dir, &from)?;
    let b = doc_path(&dir, &to)?;
    if !a.exists() {
        return Ok(());
    }
    // gleiche Datei mit anderer Groß-/Kleinschreibung ist unter Windows erlaubt
    if b.exists() && from.to_lowercase() != to.to_lowercase() {
        return Err(format!("„{to}“ gibt es schon"));
    }
    fs::rename(a, b).map_err(err)
}

#[tauri::command]
fn delete_doc(dir: String, name: String) -> Result<(), String> {
    let path = doc_path(&dir, &name)?;
    if !path.exists() {
        return Ok(());
    }
    trash::delete(&path).map_err(|e| format!("Papierkorb nicht erreichbar: {e}"))
}

#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .set_title("Ordner für deine Texte wählen")
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
async fn save_as(app: tauri::AppHandle, name: String, text: String) -> Result<bool, String> {
    let is_txt = name.to_lowercase().ends_with(".txt");
    let dialog = app.dialog().file().set_file_name(&name);
    let dialog = if is_txt {
        dialog.add_filter("Text", &["txt"])
    } else {
        dialog.add_filter("Markdown", &["md"])
    };
    match dialog.blocking_save_file() {
        Some(fp) => {
            let path = fp.into_path().map_err(err)?;
            fs::write(path, text).map_err(err)?;
            Ok(true)
        }
        None => Ok(false),
    }
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            default_dir,
            list_docs,
            write_doc,
            rename_doc,
            delete_doc,
            pick_folder,
            save_as,
            quit_app
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Beim ersten Schließen: Oberfläche speichern lassen, dann beenden.
                if !CLOSING.swap(true, Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.emit("writy-close", ());
                    let app = window.app_handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(2500));
                        app.exit(0);
                    });
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Writy konnte nicht starten");
}
