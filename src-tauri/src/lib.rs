// Rust backend for Snake 2.0: owns persistent stats/settings and writes them
// to the OS app-data directory. The frontend talks to it via `invoke(...)`.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

const SAVE_FILE: &str = "game_state.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GameSettings {
    sound_enabled: bool,
    theme: String,
    difficulty: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GameState {
    high_score: u32,
    games_played: u32,
    total_score: u32,
    settings: GameSettings,
}

impl Default for GameState {
    fn default() -> Self {
        Self {
            high_score: 0,
            games_played: 0,
            total_score: 0,
            settings: GameSettings {
                sound_enabled: true,
                theme: "classic".to_string(),
                difficulty: "medium".to_string(),
            },
        }
    }
}

struct AppState {
    game_state: Mutex<GameState>,
}

/// e.g. %APPDATA%\com.snake2.game\game_state.json on Windows
fn save_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(SAVE_FILE))
}

fn write_state(app: &AppHandle, state: &GameState) -> Result<(), String> {
    let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    fs::write(save_path(app)?, json).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_high_score(state: State<AppState>) -> Result<u32, String> {
    let game_state = state.game_state.lock().map_err(|e| e.to_string())?;
    Ok(game_state.high_score)
}

#[tauri::command]
fn update_high_score(score: u32, state: State<AppState>) -> Result<bool, String> {
    let mut game_state = state.game_state.lock().map_err(|e| e.to_string())?;

    let is_new_high_score = score > game_state.high_score;
    if is_new_high_score {
        game_state.high_score = score;
    }
    game_state.games_played += 1;
    game_state.total_score += score;

    Ok(is_new_high_score)
}

#[tauri::command]
fn get_game_stats(state: State<AppState>) -> Result<GameState, String> {
    let game_state = state.game_state.lock().map_err(|e| e.to_string())?;
    Ok(game_state.clone())
}

#[tauri::command]
fn update_settings(settings: GameSettings, state: State<AppState>) -> Result<(), String> {
    let mut game_state = state.game_state.lock().map_err(|e| e.to_string())?;
    game_state.settings = settings;
    Ok(())
}

#[tauri::command]
fn reset_stats(state: State<AppState>) -> Result<(), String> {
    let mut game_state = state.game_state.lock().map_err(|e| e.to_string())?;
    *game_state = GameState::default();
    Ok(())
}

#[tauri::command]
fn save_game_state(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    let game_state = state.game_state.lock().map_err(|e| e.to_string())?;
    write_state(&app, &game_state)
}

#[tauri::command]
fn load_game_state(app: AppHandle, state: State<AppState>) -> Result<GameState, String> {
    let path = save_path(&app)?;
    let mut game_state = state.game_state.lock().map_err(|e| e.to_string())?;

    if path.exists() {
        let json = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        // A corrupt save shouldn't brick the game: fall back to defaults.
        *game_state = serde_json::from_str(&json).unwrap_or_default();
    }
    Ok(game_state.clone())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            game_state: Mutex::new(GameState::default()),
        })
        .invoke_handler(tauri::generate_handler![
            get_high_score,
            update_high_score,
            get_game_stats,
            update_settings,
            reset_stats,
            save_game_state,
            load_game_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
