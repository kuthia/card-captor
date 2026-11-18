//! Read-only diagnostic using exactly the production observer. No app handle => no notifications/sound.
use card_captor_lib::codex::{protocol, Service};

#[tokio::main]
async fn main() {
    let dir = tempfile::tempdir().expect("isolated preferences");
    let service = Service::new(dir.path().join("codex.json"), None, false);
    let worker = tokio::spawn(protocol::observe(service.clone()));
    tokio::time::sleep(std::time::Duration::from_secs(12)).await;
    let view = service.snapshot().expect("snapshot");
    println!(
        "{}",
        serde_json::json!({"connection":view.connection,"detail":view.detail,"tasks":view.tasks.iter().map(|t|serde_json::json!({"phase":t.phase,"hasTurn":t.turn_id.is_some(),"hasSummary":!t.summary.is_empty(),"stale":t.stale})).collect::<Vec<_>>(),"activities":view.activities.len(),"alert":view.alert.is_some()})
    );
    worker.abort();
}
