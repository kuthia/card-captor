mod model;
mod notion;
mod storage;

use model::{
    AppConfig, CardStatusEditor, CardSummary, FeedSnapshot, SetupStatus, StatusUpdateResult,
};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Emitter, Manager, State};

struct AppState {
    store: Mutex<storage::Store>,
    path: PathBuf,
    revision: AtomicU64,
    refreshing: AtomicBool,
    // Account changes, reads, and writes share one gate; no stale read can undo a write.
    operation: tokio::sync::Mutex<()>,
    load_error: Mutex<Option<String>>,
    measurement: Option<MeasurementState>,
}

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
enum MeasurementState {
    Idle,
    Moving,
    Cards,
}

fn parse_measurement_args(enabled: bool, args: &[String]) -> Option<MeasurementState> {
    if !enabled {
        return None;
    }
    let mut values = args
        .windows(2)
        .filter(|pair| pair[0] == "--measurement-state");
    let value = values.next()?;
    if values.next().is_some() {
        return None;
    }
    match value[1].as_str() {
        "idle" => Some(MeasurementState::Idle),
        "moving" => Some(MeasurementState::Moving),
        "cards" => Some(MeasurementState::Cards),
        _ => None,
    }
}

fn measurement_startup_script(state: MeasurementState) -> String {
    let config = serde_json::json!({ "version": 1, "state": state, "cardCount": 20 });
    format!("Object.defineProperty(window, '__CARD_CAPTOR_MEASUREMENT__', {{ value: {config}, writable: false, configurable: false }});")
}

fn reject_measurement(state: &AppState) -> Result<(), String> {
    if state.measurement.is_some() {
        return Err("측정 모드에서는 연결 저장소와 외부 동작을 사용하지 않습니다.".into());
    }
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct MeasurementEvent {
    mode: String,
    renderer: String,
    visible: bool,
    #[serde(rename = "pointerPollMs")]
    pointer_poll_ms: Option<u16>,
}

#[tauri::command]
fn measurement_event(
    event: MeasurementEvent,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let Some(phase) = state.measurement else {
        return Err("측정 모드가 아닙니다.".into());
    };
    if !["idle", "walk", "dragging", "browsing", "suspended"].contains(&event.mode.as_str())
        || !["initializing", "webgl", "svg-fallback", "context-lost"]
            .contains(&event.renderer.as_str())
    {
        return Err("측정 상태가 올바르지 않습니다.".into());
    }
    if event
        .pointer_poll_ms
        .is_some_and(|value| value != 50 && value != 250)
    {
        return Err("측정 커서 감시 주기가 올바르지 않습니다.".into());
    }
    let Some(path) = std::env::var_os("CARD_CAPTOR_MEASUREMENT_LOG") else {
        return Ok(());
    };
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|_| "측정 상태 로그를 열 수 없습니다.".to_string())?;
    let entry = serde_json::json!({
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "pid": std::process::id(),
        "state": phase,
        "mode": event.mode,
        "renderer": event.renderer,
        "visible": event.visible,
        "syntheticCardCount": 20,
        "pointerPollMs": event.pointer_poll_ms,
    });
    writeln!(file, "{entry}").map_err(|_| "측정 상태 로그를 쓸 수 없습니다.".into())
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "로컬 저장소 작업을 완료하지 못했습니다.".to_string())?
}

fn setup_status(state: &AppState) -> Result<SetupStatus, String> {
    let has_token = storage::get_token()?.is_some();
    let store = state.store.lock().map_err(|_| "설정을 읽을 수 없습니다.")?;
    Ok(SetupStatus {
        config: store.config.clone(),
        has_token,
        snapshot: store.snapshot.clone(),
    })
}

#[tauri::command]
async fn get_setup(state: State<'_, Arc<AppState>>) -> Result<SetupStatus, String> {
    reject_measurement(&state)?;
    let state = state.inner().clone();
    blocking(move || {
        if let Some(error) = state
            .load_error
            .lock()
            .map_err(|_| "설정을 읽을 수 없습니다.")?
            .clone()
        {
            return Err(error);
        }
        setup_status(&state)
    })
    .await
}

#[tauri::command]
async fn save_setup(
    mut config: AppConfig,
    token: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<SetupStatus, String> {
    reject_measurement(&state)?;
    let _operation = state.operation.lock().await;
    if !config.view_id.trim().is_empty() {
        config.view_id = model::normalize_view_id(&config.view_id)?;
    } else {
        config.view_id.clear();
    }
    if !(30..=3600).contains(&config.refresh_seconds) {
        return Err("새로고침 주기는 30초에서 3600초 사이로 설정해주세요.".into());
    }
    let token = token.map(|value| value.trim().to_string());
    if token.as_ref().is_some_and(|value| value.is_empty()) {
        return Err("Notion 토큰을 입력해주세요.".into());
    }
    let state = state.inner().clone();
    blocking(move || {
        let old_token = if token.is_some() {
            storage::get_token()?
        } else {
            None
        };
        let mut store = state
            .store
            .lock()
            .map_err(|_| "설정을 저장할 수 없습니다.")?;
        let clear_snapshot = store.config.view_id != config.view_id || token.is_some();
        let next = storage::Store {
            config,
            snapshot: if clear_snapshot {
                None
            } else {
                store.snapshot.clone()
            },
        };
        if let Some(value) = token.as_deref() {
            storage::set_token(value)?;
        }
        if let Err(error) = next.save(&state.path) {
            if token.is_some() {
                let rollback = match old_token {
                    Some(value) => storage::set_token(&value),
                    None => storage::delete_token(),
                };
                if rollback.is_err() {
                    return Err(
                        "설정 저장과 자격 증명 복구에 실패했습니다. 연결 설정을 다시 저장해주세요."
                            .into(),
                    );
                }
            }
            return Err(error);
        }
        *store = next;
        state.revision.fetch_add(1, Ordering::AcqRel);
        *state
            .load_error
            .lock()
            .map_err(|_| "설정을 저장할 수 없습니다.")? = None;
        drop(store);
        setup_status(&state)
    })
    .await
}

struct RefreshGuard(Arc<AppState>);
impl Drop for RefreshGuard {
    fn drop(&mut self) {
        self.0.refreshing.store(false, Ordering::Release);
    }
}

#[tauri::command]
async fn refresh_feed(state: State<'_, Arc<AppState>>) -> Result<FeedSnapshot, String> {
    reject_measurement(&state)?;
    let state = state.inner().clone();
    if state
        .refreshing
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("카드를 새로고침하고 있습니다.".into());
    }
    let _guard = RefreshGuard(state.clone());
    let _operation = state.operation.lock().await;
    let revision = state.revision.load(Ordering::Acquire);
    let view_id = state
        .store
        .lock()
        .map_err(|_| "설정을 읽을 수 없습니다.")?
        .config
        .view_id
        .clone();
    if view_id.is_empty() {
        return Err("먼저 Notion 뷰를 연결해주세요.".into());
    }
    let token = blocking(storage::get_token)
        .await?
        .ok_or("Notion 토큰을 먼저 저장해주세요.")?;
    let mut snapshot = notion::fetch_feed(&view_id, &token).await?;
    let state_copy = state.clone();
    blocking(move || {
        let mut store = state_copy
            .store
            .lock()
            .map_err(|_| "카드를 저장할 수 없습니다.")?;
        if state_copy.revision.load(Ordering::Acquire) != revision {
            return Err("연결 설정이 변경되었습니다. 다시 새로고침해주세요.".into());
        }
        store.snapshot = Some(snapshot.clone());
        if store.save(&state_copy.path).is_err() {
            let message =
                "로컬 캐시를 저장하지 못했습니다. 현재 카드는 앱 종료 전까지 볼 수 있습니다.";
            snapshot.warning = Some(match snapshot.warning {
                Some(ref warning) => format!("{warning} {message}"),
                None => message.into(),
            });
            store.snapshot = Some(snapshot.clone());
        }
        Ok(snapshot)
    })
    .await
}

#[tauri::command]
async fn disconnect(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    reject_measurement(&state)?;
    let _operation = state.operation.lock().await;
    let state = state.inner().clone();
    blocking(move || {
        let mut store = state
            .store
            .lock()
            .map_err(|_| "연결을 해제할 수 없습니다.")?;
        let next = storage::Store {
            config: AppConfig::default(),
            snapshot: None,
        };
        // Keep the configured account recoverable if the OS credential store rejects deletion.
        storage::delete_token()?;
        *store = next;
        state.revision.fetch_add(1, Ordering::AcqRel);
        store.save(&state.path)?;
        Ok(())
    })
    .await
}

fn current_card(state: &AppState, id: &str) -> Result<CardSummary, String> {
    state
        .store
        .lock()
        .map_err(|_| "카드를 읽을 수 없습니다.")?
        .snapshot
        .as_ref()
        .and_then(|snapshot| snapshot.cards.iter().find(|card| card.id == id))
        .cloned()
        .ok_or_else(|| "현재 목록에 없는 카드입니다. 새로고침해 주세요.".into())
}

#[tauri::command]
async fn get_card_status(
    id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<CardStatusEditor, String> {
    reject_measurement(&state)?;
    let _operation = state.operation.lock().await;
    current_card(&state, &id)?;
    let token = blocking(storage::get_token)
        .await?
        .ok_or("Notion 토큰을 먼저 저장해 주세요.")?;
    notion::fetch_card_status(&id, &token).await
}

#[tauri::command]
async fn update_card_status(
    id: String,
    field_id: String,
    option_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<StatusUpdateResult, String> {
    reject_measurement(&state)?;
    let _operation = state.operation.lock().await;
    current_card(&state, &id)?;
    let token = blocking(storage::get_token)
        .await?
        .ok_or("Notion 토큰을 먼저 저장해 주세요.")?;
    let card = notion::update_card_status(&id, &field_id, &option_id, &token).await?;
    // The remote write is confirmed. Local cache errors must not turn success into a retry.
    let state_copy = state.inner().clone();
    let result_card = card.clone();
    let cached = blocking(move || {
        let mut store = state_copy
            .store
            .lock()
            .map_err(|_| "상태는 변경했지만 로컬 카드에 반영하지 못했습니다. 새로고침해 주세요.")?;
        if let Some(snapshot) = store.snapshot.as_mut() {
            if let Some(previous) = snapshot.cards.iter_mut().find(|item| item.id == card.id) {
                *previous = card;
            }
        }
        state_copy.revision.fetch_add(1, Ordering::AcqRel);
        store.save(&state_copy.path).map_err(|_| {
            "상태는 변경했지만 로컬 캐시를 저장하지 못했습니다. 새로고침해 주세요.".to_string()
        })
    })
    .await;
    Ok(StatusUpdateResult {
        card: result_card,
        warning: cached.err(),
    })
}

fn allowed_notion_url(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && (host == "notion.so"
            || host.ends_with(".notion.so")
            || host == "notion.com"
            || host.ends_with(".notion.com")
            || host == "notion.site"
            || host.ends_with(".notion.site"))
}

#[tauri::command]
async fn open_card(id: String, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    reject_measurement(&state)?;
    let url = state
        .store
        .lock()
        .map_err(|_| "카드를 열 수 없습니다.")?
        .snapshot
        .as_ref()
        .and_then(|snapshot| snapshot.cards.iter().find(|card| card.id == id))
        .map(|card| card.url.clone())
        .ok_or("현재 목록에 없는 카드입니다. 새로고침해주세요.")?;
    if !allowed_notion_url(&url) {
        return Err("허용된 Notion 원본 링크가 아닙니다.".into());
    }
    blocking(move || {
        open::that(url).map_err(|_| "기본 브라우저에서 카드를 열지 못했습니다.".into())
    })
    .await
}

#[tauri::command]
fn set_panel_open(
    open: bool,
    window: tauri::WebviewWindow,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    window
        .set_focusable(open)
        .map_err(|_| "카드 패널의 입력 상태를 변경하지 못했습니다.")?;
    if open && state.measurement.is_none() {
        window
            .set_focus()
            .map_err(|_| "카드 패널을 선택하지 못했습니다.")?;
    }
    Ok(())
}

fn fit_primary_monitor(app: &tauri::AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        if let Some(monitor) = app.primary_monitor()? {
            let area = monitor.work_area();
            window.set_position(area.position)?;
            window.set_size(area.size)?;
        }
    }
    Ok(())
}

fn local_navigation(url: &url::Url) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https")
            && (url.host_str() == Some("tauri.localhost")
                || (cfg!(debug_assertions)
                    && url.host_str() == Some("127.0.0.1")
                    && url.port() == Some(1420))))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let _ = app.emit("toggle-deck", ());
        }))
        .invoke_handler(tauri::generate_handler![
            get_setup,
            save_setup,
            refresh_feed,
            disconnect,
            open_card,
            get_card_status,
            update_card_status,
            set_panel_open,
            measurement_event,
        ])
        .setup(|app| {
            let measurement = parse_measurement_args(
                cfg!(feature = "measurement"),
                &std::env::args().collect::<Vec<_>>(),
            );
            let path = app.path().app_data_dir()?.join("config.json");
            let (store, load_error) = if measurement.is_some() {
                (storage::Store::default(), None)
            } else {
                match storage::Store::load(&path) {
                    Ok(store) => (store, None),
                    Err(error) => (
                        storage::Store {
                            config: AppConfig::default(),
                            snapshot: None,
                        },
                        Some(error),
                    ),
                }
            };
            app.manage(Arc::new(AppState {
                store: Mutex::new(store),
                path,
                revision: AtomicU64::new(0),
                refreshing: AtomicBool::new(false),
                operation: tokio::sync::Mutex::new(()),
                load_error: Mutex::new(load_error),
                measurement,
            }));
            let builder = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Card Captor")
            .inner_size(800.0, 600.0)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .focused(false)
            .focusable(false)
            .visible_on_all_workspaces(true)
            .on_navigation(local_navigation);
            let builder = if let Some(state) = measurement {
                builder.initialization_script(measurement_startup_script(state))
            } else {
                builder
            };
            let window = builder.build()?;
            // JS opts individual hit regions into input only after initialization.
            window.set_ignore_cursor_events(true)?;
            fit_primary_monitor(app.handle())?;
            let show = tauri::menu::MenuItem::with_id(
                app,
                "cards",
                "카드 열기 / 닫기",
                true,
                None::<&str>,
            )?;
            let roam = tauri::menu::MenuItem::with_id(
                app,
                "roam",
                "이동 시작 / 멈춤",
                true,
                None::<&str>,
            )?;
            let reset = tauri::menu::MenuItem::with_id(
                app,
                "reset",
                "화면 위치 초기화",
                true,
                None::<&str>,
            )?;
            let quit = tauri::menu::MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(app, &[&show, &roam, &reset, &quit])?;
            tauri::tray::TrayIconBuilder::with_id("card-captor")
                .icon(app.default_window_icon().cloned().unwrap_or_else(|| {
                    tauri::image::Image::new_owned(vec![232u8; 32 * 32 * 4], 32, 32)
                }))
                .tooltip("Card Captor")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "cards" => {
                        let _ = app.emit("toggle-deck", ());
                    }
                    "roam" => {
                        let _ = app.emit("toggle-roaming", ());
                    }
                    "reset" => {
                        let _ = fit_primary_monitor(app);
                        let _ = app.emit("reset-position", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Card Captor를 시작하지 못했습니다.");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_access_is_limited_to_the_current_feed_and_disabled_in_measurement() {
        let dir = tempfile::tempdir().unwrap();
        let card = CardSummary {
            id: "current-card".into(),
            source: "notion".into(),
            title: "업무".into(),
            url: "https://www.notion.so/current-card".into(),
            status: Some("대기".into()),
            status_color: None,
            due_at: None,
        };
        let mut state = AppState {
            store: Mutex::new(storage::Store {
                config: AppConfig::default(),
                snapshot: Some(FeedSnapshot {
                    cards: vec![card.clone()],
                    refreshed_at: "2026-11-17T00:00:00Z".into(),
                    has_more: false,
                    warning: None,
                }),
            }),
            path: dir.path().join("config.json"),
            revision: AtomicU64::new(0),
            refreshing: AtomicBool::new(false),
            operation: tokio::sync::Mutex::new(()),
            load_error: Mutex::new(None),
            measurement: None,
        };
        assert_eq!(current_card(&state, "current-card").unwrap(), card);
        assert!(current_card(&state, "arbitrary-page-id").is_err());
        state.store.lock().unwrap().snapshot = None;
        assert!(current_card(&state, "current-card").is_err());
        state.measurement = Some(MeasurementState::Cards);
        assert!(reject_measurement(&state).is_err());
    }

    #[test]
    fn measurement_requires_the_feature_gate_and_explicit_valid_state() {
        let args = vec![
            "card-captor".into(),
            "--measurement-state".into(),
            "idle".into(),
        ];
        assert_eq!(parse_measurement_args(false, &args), None);
        assert_eq!(
            parse_measurement_args(true, &args),
            Some(MeasurementState::Idle)
        );
        for state in ["moving", "cards"] {
            let args = vec![
                "card-captor".into(),
                "--measurement-state".into(),
                state.into(),
            ];
            assert!(parse_measurement_args(true, &args).is_some());
        }
        for args in [
            vec!["card-captor".into()],
            vec!["--measurement-state".into(), "invalid".into()],
            vec![
                "--measurement-state".into(),
                "idle".into(),
                "--measurement-state".into(),
                "cards".into(),
            ],
        ] {
            assert_eq!(parse_measurement_args(true, &args), None);
        }
    }

    #[test]
    fn measurement_injection_has_only_a_fixed_fixture_schema() {
        let script = measurement_startup_script(MeasurementState::Cards);
        assert!(script.contains("\"state\":\"cards\""));
        assert!(script.contains("\"cardCount\":20"));
        assert!(!script.contains("token"));
        assert!(!script.contains("fetch"));
    }

    #[test]
    fn source_links_cannot_launch_arbitrary_protocols_or_hosts() {
        assert!(allowed_notion_url("https://www.notion.so/workspace/page"));
        assert!(allowed_notion_url("https://workspace.notion.site/page"));
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "https://notion.so.evil.test/page",
            "https://evil.test/notion.so",
            "https://user:secret@notion.so/page",
        ] {
            assert!(!allowed_notion_url(url), "{url}");
        }
    }

    #[test]
    fn webview_navigation_stays_on_the_app_origin() {
        assert!(local_navigation(
            &url::Url::parse("tauri://localhost/index.html").unwrap()
        ));
        assert!(local_navigation(
            &url::Url::parse("http://tauri.localhost/index.html").unwrap()
        ));
        assert!(!local_navigation(
            &url::Url::parse("https://www.notion.so/").unwrap()
        ));
        assert!(!local_navigation(
            &url::Url::parse("https://evil.test/").unwrap()
        ));
    }
}
