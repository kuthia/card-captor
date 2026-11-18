//! Private desktop IPC v13. The outbound vocabulary deliberately has no task-writing methods.
use super::core::{Engine, IngestError, MAX_TASKS};
use super::{Preferences, Service};
use serde_json::{json, Value};
use std::{collections::HashMap, path::PathBuf, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::watch,
};

pub const MAX_FRAME: usize = 8 * 1024 * 1024;
const STREAM_VERSION: u64 = 13;

enum Outbound<'a> {
    Initialize,
    Discover(&'a str),
    Follow {
        id: &'a str,
        owner: &'a str,
        following: bool,
    },
    DeclineDiscovery(&'a str),
}
impl Outbound<'_> {
    fn value(&self, client: &str, request: &str) -> Value {
        match self {
            Self::Initialize => {
                json!({"type":"request","requestId":request,"sourceClientId":"initializing-client","version":0,"method":"initialize","params":{"clientType":"card-captor-observer"}})
            }
            Self::Discover(id) => {
                json!({"type":"request","requestId":request,"sourceClientId":client,"version":1,"method":"thread-owner-discovery","params":{"hostId":"local","conversationId":id},"timeoutMs":4000})
            }
            Self::Follow {
                id,
                owner,
                following,
            } => {
                json!({"type":"broadcast","method":"thread-stream-following-changed","sourceClientId":client,"targetClientIds":[owner],"version":1,"params":{"hostId":"local","conversationId":id,"following":following}})
            }
            Self::DeclineDiscovery(id) => {
                json!({"type":"client-discovery-response","requestId":id,"response":{"canHandle":false}})
            }
        }
    }
}

pub async fn read_frame<R: AsyncRead + Unpin>(stream: &mut R) -> Result<Value, String> {
    let length = stream
        .read_u32_le()
        .await
        .map_err(|_| "Codex 연결이 끊겼어요.")? as usize;
    if length == 0 || length > MAX_FRAME {
        return Err(
            "Codex 응답 크기가 관측 한도를 넘었어요. 큰 대화는 현재 지원하지 않아요.".into(),
        );
    }
    let mut data = vec![0; length];
    stream
        .read_exact(&mut data)
        .await
        .map_err(|_| "Codex 응답을 끝까지 읽지 못했어요.")?;
    serde_json::from_slice(&data).map_err(|_| "Codex 응답 형식이 달라 관측을 중지했어요.".into())
}
async fn send<W: AsyncWrite + Unpin>(stream: &mut W, message: Value) -> Result<(), String> {
    let data = serde_json::to_vec(&message).map_err(|_| "관측 연결을 준비하지 못했어요.")?;
    tokio::time::timeout(Duration::from_secs(3), async {
        stream.write_u32_le(data.len() as u32).await?;
        stream.write_all(&data).await
    })
    .await
    .map_err(|_| "Codex 관측 연결이 응답하지 않아요.".to_string())?
    .map_err(|_| "Codex 관측 요청을 전달하지 못했어요.".into())
}

pub fn socket_candidates() -> Vec<PathBuf> {
    let mut paths = vec![];
    if let Some(base) = std::env::var_os("CODEX_HOME") {
        paths.push(PathBuf::from(base).join("ipc/ipc.sock"));
    }
    if let Some(base) = std::env::var_os("HOME") {
        paths.push(PathBuf::from(base).join(".codex/ipc/ipc.sock"));
    }
    #[cfg(unix)]
    {
        let uid = unsafe { libc::geteuid() };
        paths.push(std::env::temp_dir().join(format!("codex-ipc/ipc-{uid}.sock")));
        if uid == 0 {
            paths.push(std::env::temp_dir().join("codex-ipc/ipc.sock"));
        }
    }
    paths.dedup();
    paths
}

/// File names only, bounded by date and count. Ownership discovery never loads/resumes these threads.
fn recent_thread_ids() -> Vec<String> {
    let mut roots = vec![];
    if let Some(base) = std::env::var_os("CODEX_HOME") {
        roots.push(PathBuf::from(base).join("sessions"));
    }
    if let Some(base) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(base).join(".codex/sessions"));
    }
    let mut files = vec![];
    for root in roots {
        for days in 0..14 {
            let date = chrono::Utc::now().date_naive() - chrono::Duration::days(days);
            let path = root.join(date.format("%Y/%m/%d").to_string());
            let Ok(entries) = std::fs::read_dir(path) else {
                continue;
            };
            for entry in entries.take(512).flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let Some(stem) = name.strip_suffix(".jsonl") else {
                    continue;
                };
                let Some(id) = stem.get(stem.len().saturating_sub(36)..) else {
                    continue;
                };
                if uuid::Uuid::parse_str(id).is_err() {
                    continue;
                }
                if let Ok(metadata) = entry.metadata() {
                    if let Ok(at) = metadata.modified() {
                        files.push((at, id.to_owned()));
                    }
                }
            }
        }
    }
    files.sort_unstable_by(|a, b| b.0.cmp(&a.0));
    let mut ids = vec![];
    for (_, id) in files {
        if !ids.contains(&id) {
            ids.push(id);
        }
        if ids.len() >= 32 {
            break;
        }
    }
    ids
}
#[cfg(unix)]
fn validate_socket(path: &std::path::Path) -> bool {
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    let uid = unsafe { libc::geteuid() };
    let Ok(socket) = std::fs::symlink_metadata(path) else {
        return false;
    };
    let Some(parent) = path.parent() else {
        return false;
    };
    let Ok(directory) = std::fs::metadata(parent) else {
        return false;
    };
    socket.file_type().is_socket()
        && socket.uid() == uid
        && directory.is_dir()
        && directory.uid() == uid
        && directory.mode() & 0o022 == 0
}

pub async fn observe(service: std::sync::Arc<Service>) {
    let mut preferences = service.preferences.subscribe();
    let mut engine = Engine::default();
    let mut delay = 1;
    loop {
        if !preferences.borrow().enabled {
            engine.reconnect();
            service.publish(&engine, "disabled", "Codex 관측을 껐어요.", None);
            if preferences.changed().await.is_err() {
                return;
            }
            continue;
        }
        engine.reconnect();
        service.publish(&engine, "connecting", "Codex 앱을 찾고 있어요.", None);
        #[cfg(unix)]
        let outcome = {
            let mut stream = None;
            for path in socket_candidates() {
                if !validate_socket(&path) {
                    continue;
                }
                if let Ok(Ok(candidate)) = tokio::time::timeout(
                    Duration::from_secs(2),
                    tokio::net::UnixStream::connect(&path),
                )
                .await
                {
                    if candidate
                        .peer_cred()
                        .is_ok_and(|p| p.uid() == unsafe { libc::geteuid() })
                    {
                        stream = Some(candidate);
                        break;
                    }
                }
            }
            match stream {
                Some(stream) => {
                    let seeds = tokio::task::spawn_blocking(recent_thread_ids)
                        .await
                        .unwrap_or_default();
                    session(stream, &mut engine, &service, &mut preferences, seeds).await
                }
                None => Err("Codex 앱 연결을 기다리고 있어요. 앱에서 대화를 열어 주세요.".into()),
            }
        };
        #[cfg(not(unix))]
        let outcome: Result<(), String> =
            Err("이 버전의 Codex 관측은 macOS·Linux에서 지원해요.".into());
        engine.reconnect();
        if !preferences.borrow().enabled {
            delay = 1;
            continue;
        }
        if service
            .snapshot()
            .is_ok_and(|view| view.connection == "connected")
        {
            delay = 1;
        }
        if let Err(message) = outcome {
            service.publish(&engine, "disconnected", &message, None);
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(delay)) => {},
            changed = preferences.changed() => { if changed.is_err() { return; } }
        }
        delay = (delay * 2).min(30);
    }
}

pub async fn session<S: AsyncRead + AsyncWrite + Unpin>(
    stream: S,
    engine: &mut Engine,
    service: &Service,
    preferences: &mut watch::Receiver<Preferences>,
    seeds: Vec<String>,
) -> Result<(), String> {
    let (mut reader, mut writer) = tokio::io::split(stream);
    send(&mut writer, Outbound::Initialize.value("", "initialize")).await?;
    let first = tokio::time::timeout(Duration::from_secs(5), read_frame(&mut reader))
        .await
        .map_err(|_| "Codex 앱이 초기화 요청에 응답하지 않아요.")??;
    // Other clients can broadcast before the initialize response.
    let mut initial = vec![first];
    let client = loop {
        if initial
            .last()
            .is_some_and(|v| v["method"] == "initialize" && v["resultType"] == "success")
        {
            break initial.last().unwrap()["result"]["clientId"]
                .as_str()
                .ok_or("Codex 연결 ID를 확인하지 못했어요.")?
                .to_owned();
        }
        if initial.len() >= 32 {
            return Err("Codex 초기화 응답을 확인하지 못했어요.".into());
        }
        initial.push(
            tokio::time::timeout(Duration::from_secs(5), read_frame(&mut reader))
                .await
                .map_err(|_| "Codex 연결 시간이 초과됐어요.")??,
        );
    };
    service.publish(
        engine,
        "connected",
        "Codex 앱에서 열린 로컬 작업을 따라가요.",
        None,
    );
    let mut owners: HashMap<String, String> = HashMap::new();
    let mut pending: HashMap<String, String> = HashMap::new();
    let mut counter = 0u64;
    for id in seeds {
        counter += 1;
        let request = format!("{client}-{counter}");
        pending.insert(request.clone(), id.clone());
        send(
            &mut writer,
            Outbound::Discover(&id).value(&client, &request),
        )
        .await?;
    }
    let mut dirty = false;
    let mut flush = tokio::time::interval(Duration::from_millis(250));
    let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
    heartbeat.tick().await;
    // Canceling read_exact in select can lose a partial frame; keep the reader in its own task-free future.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Result<Value, String>>(8);
    let reading = async move {
        for value in initial {
            if tx.send(Ok(value)).await.is_err() {
                return;
            }
        }
        loop {
            let value = read_frame(&mut reader).await;
            let failed = value.is_err();
            if tx.send(value).await.is_err() {
                return;
            }
            if failed {
                break;
            }
        }
        drop(tx);
        std::future::pending::<()>().await;
    };
    tokio::pin!(reading);
    loop {
        let message = tokio::select! {
            _ = &mut reading => { return Err("Codex 연결이 끊겼어요.".into()); },
            changed = preferences.changed() => {
                if changed.is_err() || !preferences.borrow().enabled {
                    for (id, owner) in &owners { let _ = send(&mut writer, Outbound::Follow { id, owner, following: false }.value(&client, "")).await; }
                    return Ok(());
                }
                continue;
            },
            _ = flush.tick() => {
                if dirty { service.publish(engine,"connected","Codex 앱에서 열린 로컬 작업을 따라가요.",None); dirty = false; }
                continue;
            },
            _ = heartbeat.tick() => {
                // Probe ownership only; never resume a thread or load its entire history.
                pending.clear();
                for id in engine.tasks.iter().map(|t| &t.id) {
                    counter += 1; let request = format!("{client}-{counter}");
                    pending.insert(request.clone(),id.clone());
                    send(&mut writer,Outbound::Discover(id).value(&client,&request)).await?;
                }
                continue;
            },
            result = rx.recv() => result.ok_or("Codex 연결이 끊겼어요.")??,
        };
        if message["type"] == "client-discovery-request" {
            if let Some(id) = message["requestId"].as_str() {
                send(
                    &mut writer,
                    Outbound::DeclineDiscovery(id).value(&client, ""),
                )
                .await?;
            }
            continue;
        }
        if message["type"] == "response" {
            if let Some(id) = message["requestId"]
                .as_str()
                .and_then(|id| pending.remove(id))
            {
                if message["resultType"] == "success" {
                    if let Some(owner) = message["handledByClientId"].as_str() {
                        if owners.get(&id).is_none_or(|old| old != owner) {
                            if !engine.tasks.iter().any(|t| t.id == id) && owners.len() >= MAX_TASKS
                            {
                                continue;
                            }
                            engine.forget(&id);
                            send(
                                &mut writer,
                                Outbound::Follow {
                                    id: &id,
                                    owner,
                                    following: true,
                                }
                                .value(&client, ""),
                            )
                            .await?;
                            owners.insert(id, owner.into());
                        }
                    }
                } else {
                    owners.remove(&id);
                    engine.forget(&id);
                    if let Some(task) = engine.tasks.iter_mut().find(|t| t.id == id) {
                        task.stale = true;
                        dirty = true;
                    }
                }
            }
            continue;
        }
        let params = &message["params"];
        if message["type"] != "broadcast" || params["hostId"] != "local" {
            continue;
        }
        let Some(id) = params["conversationId"]
            .as_str()
            .filter(|s| uuid::Uuid::parse_str(s).is_ok())
        else {
            continue;
        };
        match message["method"].as_str() {
            Some("thread-stream-following-changed")
                if message["version"] == 1 && params["following"] == true =>
            {
                if !owners.contains_key(id)
                    && !engine.tasks.iter().any(|t| t.id == id)
                    && engine.tasks.len() + pending.len() >= MAX_TASKS
                {
                    if let Some(index) = engine.tasks.iter().rposition(|t| {
                        t.stale
                            || matches!(
                                t.phase,
                                super::core::Phase::Idle
                                    | super::core::Phase::Ready
                                    | super::core::Phase::Interrupted
                            )
                    }) {
                        let removed = engine.tasks.remove(index);
                        engine.forget(&removed.id);
                        if let Some(owner) = owners.remove(&removed.id) {
                            send(
                                &mut writer,
                                Outbound::Follow {
                                    id: &removed.id,
                                    owner: &owner,
                                    following: false,
                                }
                                .value(&client, ""),
                            )
                            .await?;
                        }
                        dirty = true;
                    }
                }
                if !owners.contains_key(id)
                    && !pending.values().any(|v| v == id)
                    && pending.len() < 64
                    && (engine.tasks.iter().any(|t| t.id == id) || owners.len() < MAX_TASKS)
                {
                    counter += 1;
                    let request = format!("{client}-{counter}");
                    pending.insert(request.clone(), id.into());
                    send(&mut writer, Outbound::Discover(id).value(&client, &request)).await?;
                }
            }
            Some("thread-stream-state-changed")
                if owners.get(id).is_some_and(|owner| {
                    message["sourceClientId"].as_str() == Some(owner.as_str())
                }) =>
            {
                if message["version"].as_u64() != Some(STREAM_VERSION) {
                    return Err(
                        "Codex 앱의 통신 버전이 달라요. Card Captor 업데이트가 필요해요.".into(),
                    );
                }
                match engine.ingest(id, &params["change"]) {
                    Ok(alert) => {
                        dirty = true;
                        if let Some(alert) = alert {
                            service.publish(
                                engine,
                                "connected",
                                "Codex 앱에서 열린 로컬 작업을 따라가요.",
                                Some(alert),
                            );
                            dirty = false;
                        }
                    }
                    Err(IngestError::RevisionGap | IngestError::Invalid) => {
                        engine.forget(id);
                        dirty = true;
                        if let Some(owner) = owners.get(id) {
                            send(
                                &mut writer,
                                Outbound::Follow {
                                    id,
                                    owner,
                                    following: false,
                                }
                                .value(&client, ""),
                            )
                            .await?;
                            send(
                                &mut writer,
                                Outbound::Follow {
                                    id,
                                    owner,
                                    following: true,
                                }
                                .value(&client, ""),
                            )
                            .await?;
                        }
                    }
                    Err(IngestError::Capacity) => {
                        if let Some(owner) = owners.remove(id) {
                            send(
                                &mut writer,
                                Outbound::Follow {
                                    id,
                                    owner: &owner,
                                    following: false,
                                }
                                .value(&client, ""),
                            )
                            .await?;
                        }
                        service.publish(
                            engine,
                            "connected",
                            "큰 대화의 관측 한도를 넘었어요. 다른 열린 작업은 계속 따라가요.",
                            None,
                        );
                    }
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn real_session_transport_subscribes_updates_and_unsubscribes_without_writing_tasks() {
        let dir = tempfile::tempdir().unwrap();
        let service = Service::new(dir.path().join("codex.json"), None, false);
        let (client, mut server) = tokio::io::duplex(32768);
        let mut prefs = service.preferences.subscribe();
        let id = "a3f1b2c4-5678-4def-abcd-1234567890ab";
        let runner = async {
            let mut engine = Engine::default();
            session(client, &mut engine, &service, &mut prefs, vec![])
                .await
                .unwrap();
            engine
        };
        let fake = async {
            assert_eq!(
                read_frame(&mut server).await.unwrap()["method"],
                "initialize"
            );
            send(&mut server,json!({"type":"response","method":"initialize","resultType":"success","result":{"clientId":"test-client"}})).await.unwrap();
            send(&mut server,json!({"type":"broadcast","version":1,"method":"thread-stream-following-changed","sourceClientId":"owner","params":{"hostId":"local","conversationId":id,"following":true}})).await.unwrap();
            // Initial discovery is bounded, so unrelated recent local file names can also appear.
            loop {
                let request = read_frame(&mut server).await.unwrap();
                assert_eq!(request["method"], "thread-owner-discovery");
                let target = request["params"]["conversationId"] == id;
                let reply = if target {
                    json!({"type":"response","requestId":request["requestId"],"method":"thread-owner-discovery","resultType":"success","handledByClientId":"owner","result":{}})
                } else {
                    json!({"type":"response","requestId":request["requestId"],"resultType":"error","error":"no-client-found"})
                };
                send(&mut server, reply).await.unwrap();
                if target {
                    break;
                }
            }
            let follow = loop {
                let request = read_frame(&mut server).await.unwrap();
                if request["method"] == "thread-stream-following-changed" {
                    break request;
                }
                send(&mut server,json!({"type":"response","requestId":request["requestId"],"resultType":"error","error":"no-client-found"})).await.unwrap();
            };
            assert_eq!(follow["params"]["following"], true);
            send(&mut server,json!({"type":"broadcast","version":13,"sourceClientId":"owner","method":"thread-stream-state-changed","params":{"hostId":"local","conversationId":id,"change":{"type":"snapshot","revision":1,"conversationState":{"id":id,"title":"합성 작업","threadRuntimeStatus":{"type":"active"},"turns":[{"id":"turn-one","status":"inProgress"}]}}}})).await.unwrap();
            send(&mut server,json!({"type":"broadcast","version":13,"sourceClientId":"owner","method":"thread-stream-state-changed","params":{"hostId":"local","conversationId":id,"change":{"type":"patches","baseRevision":1,"revision":2,"patches":[{"op":"replace","path":"/threadRuntimeStatus/type","value":"idle"},{"op":"replace","path":"/turns/0/status","value":"completed"}]}}})).await.unwrap();
            // A discovery roundtrip proves that both earlier inbound frames were processed.
            send(
                &mut server,
                json!({"type":"client-discovery-request","requestId":"barrier"}),
            )
            .await
            .unwrap();
            let reply = read_frame(&mut server).await.unwrap();
            assert_eq!(reply["response"]["canHandle"], false);
            assert!(service.snapshot().unwrap().alert.is_some());
            service.preferences.send_modify(|p| p.enabled = false);
            let follow = read_frame(&mut server).await.unwrap();
            assert_eq!(follow["params"]["following"], false);
        };
        let (engine, ()) =
            tokio::time::timeout(Duration::from_secs(5), async { tokio::join!(runner, fake) })
                .await
                .unwrap();
        assert_eq!(engine.tasks[0].phase, super::super::core::Phase::Ready);
        assert_eq!(engine.activities.len(), 2);
        assert!(!dir.path().join("codex.json").exists());
    }
    #[tokio::test]
    async fn fragmented_frames_and_oversized_frames_are_bounded() {
        let (mut writer, mut reader) = tokio::io::duplex(8);
        let writing = async move {
            let data = br#"{"type":"broadcast"}"#;
            writer.write_u32_le(data.len() as u32).await.unwrap();
            for byte in data {
                writer.write_all(&[*byte]).await.unwrap();
            }
        };
        let ((), value) = tokio::join!(writing, read_frame(&mut reader));
        assert_eq!(value.unwrap()["type"], "broadcast");
        let (mut writer, mut reader) = tokio::io::duplex(8);
        writer.write_u32_le((MAX_FRAME + 1) as u32).await.unwrap();
        assert!(read_frame(&mut reader).await.is_err());
    }
    #[test]
    fn outbound_vocabulary_has_no_work_or_approval_mutations() {
        for v in [
            Outbound::Initialize,
            Outbound::Discover("thread"),
            Outbound::Follow {
                id: "thread",
                owner: "owner",
                following: true,
            },
            Outbound::DeclineDiscovery("request"),
        ] {
            let value = v.value("client", "request");
            assert!(!value.to_string().contains("start-turn"));
            assert!(!value.to_string().contains("approval-decision"));
            assert!(matches!(
                value["method"].as_str(),
                None | Some(
                    "initialize" | "thread-owner-discovery" | "thread-stream-following-changed"
                )
            ));
        }
    }
    #[cfg(unix)]
    #[test]
    fn unsafe_or_non_socket_candidates_are_rejected() {
        use std::os::unix::{fs::PermissionsExt, net::UnixListener};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ipc.sock");
        std::fs::write(&path, "file").unwrap();
        assert!(!validate_socket(&path));
        std::fs::remove_file(&path).unwrap();
        let _listener = UnixListener::bind(&path).unwrap();
        assert!(validate_socket(&path));
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(!validate_socket(&path));
    }
}
