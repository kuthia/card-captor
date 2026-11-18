pub mod core;
pub mod protocol;

use core::{Activity, Engine};
pub use core::{Preferences, Snapshot};
use std::{
    io::Write,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

pub struct Service {
    view: Mutex<Snapshot>,
    pub(crate) preferences: tokio::sync::watch::Sender<Preferences>,
    path: PathBuf,
    app: Option<tauri::AppHandle>,
    last_sound: Mutex<Option<Instant>>,
    isolated: bool,
}

impl Service {
    pub fn new(path: PathBuf, app: Option<tauri::AppHandle>, isolated: bool) -> Arc<Self> {
        let loaded = if isolated {
            Ok(Preferences {
                enabled: false,
                notifications: false,
                sound: false,
            })
        } else {
            match std::fs::read(&path) {
                Ok(data) => serde_json::from_slice(&data).map_err(|_| {
                    "Codex 알림 설정을 읽지 못했어요. 설정을 다시 저장해 주세요.".to_string()
                }),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Preferences::default()),
                Err(_) => Err("Codex 알림 설정 파일에 접근하지 못했어요.".into()),
            }
        };
        let warning = loaded.as_ref().err().cloned();
        let preferences = loaded.unwrap_or(Preferences {
            enabled: false,
            notifications: false,
            sound: false,
        });
        let (tx, _) = tokio::sync::watch::channel(preferences.clone());
        Arc::new(Self {
            view: Mutex::new(Snapshot {
                preferences,
                delivery_warning: warning,
                ..Snapshot::default()
            }),
            preferences: tx,
            path,
            app,
            last_sound: Mutex::new(None),
            isolated,
        })
    }
    fn save_preferences(&self, preferences: Preferences) -> Result<Snapshot, String> {
        if self.isolated {
            return Err("측정 모드에서는 Codex 설정을 변경하지 않습니다.".into());
        }
        let mut view = self
            .view
            .lock()
            .map_err(|_| "Codex 설정을 저장하지 못했어요.")?;
        let parent = self
            .path
            .parent()
            .ok_or("Codex 설정 경로를 확인하지 못했어요.")?;
        std::fs::create_dir_all(parent).map_err(|_| "Codex 설정 폴더를 만들지 못했어요.")?;
        let mut file = tempfile::NamedTempFile::new_in(parent)
            .map_err(|_| "Codex 설정을 저장하지 못했어요.")?;
        let data = serde_json::to_vec_pretty(&preferences)
            .map_err(|_| "Codex 설정을 준비하지 못했어요.")?;
        file.write_all(&data)
            .and_then(|_| file.as_file().sync_all())
            .map_err(|_| "Codex 설정을 저장하지 못했어요.")?;
        file.persist(&self.path)
            .map_err(|_| "Codex 설정 파일을 교체하지 못했어요.")?;
        self.preferences.send_replace(preferences.clone());
        view.preferences = preferences;
        view.revision += 1;
        view.delivery_warning = None;
        if !view.preferences.enabled {
            view.connection = "disabled".into();
            for task in &mut view.tasks {
                task.stale = true;
            }
        }
        Ok(view.clone())
    }
    pub fn snapshot(&self) -> Result<Snapshot, String> {
        self.view
            .lock()
            .map(|s| s.clone())
            .map_err(|_| "Codex 피드를 읽지 못했어요.".into())
    }
    pub fn publish(
        &self,
        engine: &Engine,
        connection: &str,
        detail: &str,
        alert: Option<Activity>,
    ) {
        let preferences = self.preferences.borrow().clone();
        let warning = alert
            .as_ref()
            .and_then(|item| self.deliver(item, &preferences).err());
        let snapshot = {
            let Ok(mut view) = self.view.lock() else {
                return;
            };
            view.revision += 1;
            view.connection = connection.into();
            view.detail = detail.into();
            view.preferences = self.preferences.borrow().clone();
            view.tasks = engine.tasks.clone();
            view.activities = engine.activities.clone();
            if let Some(item) = alert {
                view.alert = Some(item);
            }
            if let Some(message) = warning {
                view.delivery_warning = Some(message);
            }
            view.clone()
        };
        if let Some(app) = &self.app {
            let _ = app.emit("codex-feed", snapshot);
        }
    }
    fn deliver(&self, item: &Activity, prefs: &Preferences) -> Result<(), String> {
        if self.isolated || self.app.is_none() || !prefs.enabled {
            return Ok(());
        }
        let mut warning = None;
        if prefs.notifications {
            if let Some(app) = &self.app {
                if app
                    .notification()
                    .builder()
                    .title(format!("Codex · {}", item.phase.label()))
                    .body(&item.title)
                    .show()
                    .is_err()
                {
                    warning = Some(
                        "OS 알림을 표시하지 못했어요. 시스템 알림 설정을 확인해 주세요."
                            .to_string(),
                    );
                }
            }
        }
        if prefs.sound {
            let mut last = self
                .last_sound
                .lock()
                .map_err(|_| "알림 사운드를 준비하지 못했어요.")?;
            if last.is_none_or(|at| at.elapsed() >= Duration::from_secs(2)) {
                *last = Some(Instant::now());
                #[cfg(unix)]
                {
                    let path = self.path.with_file_name("codex-chime.wav");
                    if std::fs::write(&path, include_bytes!("../../assets/codex-chime.wav"))
                        .is_err()
                    {
                        warning = Some("알림 사운드를 준비하지 못했어요.".into());
                    } else {
                        // Fixed binary and a bundled local asset; no shell or Codex-provided arguments.
                        let player = if cfg!(target_os = "macos") {
                            "/usr/bin/afplay"
                        } else {
                            "/usr/bin/paplay"
                        };
                        match std::process::Command::new(player).arg(&path).spawn() {
                            Ok(mut child) => {
                                std::thread::spawn(move || {
                                    let _ = child.wait();
                                });
                            }
                            Err(_) => warning = Some("알림 사운드를 재생하지 못했어요.".into()),
                        }
                    }
                }
                #[cfg(not(unix))]
                {
                    if !prefs.notifications {
                        warning = Some("이 플랫폼의 사운드는 OS 알림과 함께 사용해 주세요.".into());
                    }
                }
            }
        }
        warning.map_or(Ok(()), Err)
    }
}

#[tauri::command]
pub fn get_codex_feed(service: State<'_, Arc<Service>>) -> Result<Snapshot, String> {
    service.snapshot()
}

#[tauri::command]
pub fn set_codex_preferences(
    preferences: Preferences,
    service: State<'_, Arc<Service>>,
) -> Result<Snapshot, String> {
    service.save_preferences(preferences)
}

#[tauri::command]
pub fn open_codex_thread(id: String, service: State<'_, Arc<Service>>) -> Result<(), String> {
    if service.isolated {
        return Err("측정 모드에서는 외부 앱을 열지 않습니다.".into());
    }
    let uri = codex_thread_uri(&service.snapshot()?, &id)?;
    open::that(uri).map_err(|_| "Codex 앱에서 대화를 열지 못했어요.".into())
}

fn codex_thread_uri(snapshot: &Snapshot, id: &str) -> Result<String, String> {
    let id = uuid::Uuid::parse_str(id)
        .map_err(|_| "올바른 Codex 대화가 아닙니다.")?
        .to_string();
    if !snapshot.tasks.iter().any(|task| task.id == id)
        && !snapshot.activities.iter().any(|item| item.thread_id == id)
    {
        return Err("피드에서 관측한 대화만 열 수 있어요.".into());
    }
    Ok(format!("codex://threads/{id}"))
}

#[tauri::command]
pub fn test_codex_alert(service: State<'_, Arc<Service>>) -> Result<(), String> {
    if service.isolated {
        return Err("측정 모드에서는 알림을 재생하지 않습니다.".into());
    }
    let item = Activity {
        id: "test".into(),
        thread_id: String::new(),
        title: "Card Captor 알림 테스트".into(),
        phase: core::Phase::Ready,
        message: "알림 연결을 확인했어요".into(),
        at: chrono::Utc::now().to_rfc3339(),
        unread: false,
    };
    service.deliver(&item, &service.preferences.borrow())
}

pub fn start(app: &tauri::AppHandle, path: PathBuf, isolated: bool) {
    let service = Service::new(path, Some(app.clone()), isolated);
    app.manage(service.clone());
    if !isolated {
        tauri::async_runtime::spawn(protocol::observe(service));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn feed_activity_opens_its_observed_thread_uri_even_after_task_eviction() {
        let id = "a3f1b2c4-5678-4def-abcd-1234567890ab";
        let mut view = Snapshot::default();
        assert!(codex_thread_uri(&view, id).is_err());
        view.activities.push(Activity {
            id: "activity-1".into(),
            thread_id: id.into(),
            title: "관측한 작업".into(),
            phase: core::Phase::Ready,
            message: "완료".into(),
            at: String::new(),
            unread: false,
        });
        assert_eq!(
            codex_thread_uri(&view, id).unwrap(),
            format!("codex://threads/{id}")
        );
        assert!(codex_thread_uri(&view, "https://example.com").is_err());
        assert!(
            codex_thread_uri(&view, "a3f1b2c4-5678-4def-abcd-1234567890ab?prompt=hello").is_err()
        );
    }
    #[test]
    fn preferences_survive_restart_and_failed_writes_preserve_the_previous_state() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("codex.json");
        let service = Service::new(path.clone(), None, false);
        let preferences = Preferences {
            enabled: false,
            notifications: false,
            sound: true,
        };
        service.save_preferences(preferences.clone()).unwrap();
        assert_eq!(
            Service::new(path.clone(), None, false)
                .snapshot()
                .unwrap()
                .preferences,
            preferences
        );
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(service.save_preferences(Preferences::default()).is_err());
        assert_eq!(*service.preferences.borrow(), preferences);
        assert_eq!(service.snapshot().unwrap().preferences, preferences);
    }
    #[test]
    fn corrupt_settings_fail_closed_and_measurement_never_changes_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("codex.json");
        std::fs::write(&path, b"broken").unwrap();
        let service = Service::new(path.clone(), None, false);
        let view = service.snapshot().unwrap();
        assert!(!view.preferences.enabled);
        assert!(view.delivery_warning.is_some());
        let isolated = Service::new(path.clone(), None, true);
        assert!(isolated.save_preferences(Preferences::default()).is_err());
        assert_eq!(std::fs::read(path).unwrap(), b"broken");
    }
}
