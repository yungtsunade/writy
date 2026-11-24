// Writy – Desktop-Hülle. Speichert jedes Dokument als .md-Datei im gewählten Ordner.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::DialogExt;

/// Fenster, die gerade noch speichern, bevor sie zugehen.
static CLOSING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

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
fn set_fullscreen(window: tauri::WebviewWindow, on: bool) -> Result<(), String> {
    window.set_fullscreen(on).map_err(err)
}

#[tauri::command]
fn read_doc(dir: String, name: String) -> Result<Option<Doc>, String> {
    let path = doc_path(&dir, &name)?;
    if !path.is_file() {
        return Ok(None);
    }
    let bytes = fs::read(&path).map_err(err)?;
    let modified = fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(Some(Doc { name, text: String::from_utf8_lossy(&bytes).into_owned(), modified }))
}

/// Öffnet eine Sticky Note als eigenes, rahmenloses Fenster.
#[tauri::command]
async fn open_sticky(
    app: tauri::AppHandle,
    sid: String,
    x: Option<f64>,
    y: Option<f64>,
    w: f64,
    h: f64,
    on_top: bool,
    reveal: Option<bool>,
) -> Result<(), String> {
    if !sid.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("ungültige Notiz".into());
    }
    let label = format!("sticky-{sid}");
    if let Some(win) = app.get_webview_window(&label) {
        if reveal.unwrap_or(true) {
            let _ = win.unminimize();
            let _ = win.show();
            let _ = win.set_focus();
        }
        return Ok(());
    }
    let mut b = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("Writy – Notiz")
        .inner_size(w.max(180.0), h.max(140.0))
        .min_inner_size(180.0, 140.0)
        .decorations(false)
        .resizable(true)
        .always_on_top(on_top)
        .initialization_script(&format!("window.__WRITY_STICKY = '{sid}';"));
    if let (Some(x), Some(y)) = (x, y) {
        b = b.position(x, y);
    }
    b.build().map_err(err)?;
    Ok(())
}

#[tauri::command]
fn set_on_top(window: tauri::WebviewWindow, on: bool) -> Result<(), String> {
    window.set_always_on_top(on).map_err(err)
}

/// Holt das Hauptfenster nach vorne – oder öffnet es neu, falls es geschlossen wurde.
#[tauri::command]
async fn show_main(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, "main", WebviewUrl::App("index.html".into()))
        .title("Writy")
        .inner_size(1200.0, 820.0)
        .min_inner_size(480.0, 520.0)
        .center()
        .build()
        .map_err(err)?;
    Ok(())
}

/// Schließt das aufrufende Fenster. Ist es das letzte, endet Writy.
#[tauri::command]
fn close_window(app: tauri::AppHandle, window: tauri::WebviewWindow) {
    let label = window.label().to_string();
    let others = app.webview_windows().keys().filter(|l| **l != label).count();
    if let Ok(mut c) = CLOSING.lock() {
        if let Some(set) = c.as_mut() {
            set.remove(&label);
        }
    }
    if others == 0 {
        app.exit(0);
    } else {
        let _ = window.destroy();
    }
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
            set_fullscreen,
            read_doc,
            open_sticky,
            set_on_top,
            show_main,
            close_window
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Erst speichern lassen, dann schließen. Notizen bleiben offen, wenn das Hauptfenster zugeht.
                let label = window.label().to_string();
                let first = {
                    let mut c = CLOSING.lock().unwrap();
                    c.get_or_insert_with(HashSet::new).insert(label.clone())
                };
                if first {
                    api.prevent_close();
                    let _ = window.emit("writy-close", label.clone());
                    let app = window.app_handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(2500));
                        let still = CLOSING.lock().map(|c| c.as_ref().map(|s| s.contains(&label)).unwrap_or(false)).unwrap_or(false);
                        if still {
                            if let Some(w) = app.get_webview_window(&label) {
                                let others = app.webview_windows().len().saturating_sub(1);
                                if let Ok(mut c) = CLOSING.lock() { if let Some(set) = c.as_mut() { set.remove(&label); } }
                                if others == 0 { app.exit(0); } else { let _ = w.destroy(); }
                            }
                        }
                    });
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Writy konnte nicht starten");
}
