use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};

pub const MAX_TASKS: usize = 12;
pub const MAX_FEED: usize = 40;
const MAX_SEEN: usize = 512;
const MAX_STATE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Preferences {
    pub enabled: bool,
    pub notifications: bool,
    pub sound: bool,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            enabled: true,
            notifications: true,
            sound: true,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Running,
    NeedsInput,
    Ready,
    Blocked,
    Interrupted,
    Idle,
}
impl Phase {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Running => "작업 중",
            Self::NeedsInput => "확인이 필요해요",
            Self::Ready => "작업을 마쳤어요",
            Self::Blocked => "작업에 문제가 생겼어요",
            Self::Interrupted => "작업이 중단됐어요",
            Self::Idle => "대기 중",
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    pub phase: Phase,
    pub turn_id: Option<String>,
    pub summary: String,
    pub stale: bool,
    pub updated_at: String,
    #[serde(skip)]
    pub request_key: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub id: String,
    pub thread_id: String,
    pub title: String,
    pub phase: Phase,
    pub message: String,
    pub at: String,
    pub unread: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub revision: u64,
    pub connection: String,
    pub detail: String,
    pub preferences: Preferences,
    pub tasks: Vec<Task>,
    pub activities: Vec<Activity>,
    pub alert: Option<Activity>,
    pub delivery_warning: Option<String>,
}
impl Default for Snapshot {
    fn default() -> Self {
        Self {
            revision: 0,
            connection: "connecting".into(),
            detail: "Codex 앱을 찾고 있어요.".into(),
            preferences: Preferences::default(),
            tasks: vec![],
            activities: vec![],
            alert: None,
            delivery_warning: None,
        }
    }
}

struct Baseline {
    revision: u64,
    state: Value,
}
#[derive(Default)]
pub struct Engine {
    pub tasks: Vec<Task>,
    pub activities: Vec<Activity>,
    raw: HashMap<String, Baseline>,
    seen: HashSet<String>,
    seen_order: VecDeque<String>,
    sequence: u64,
}
#[derive(Debug, PartialEq)]
pub enum IngestError {
    Invalid,
    RevisionGap,
    Capacity,
}

impl Engine {
    pub fn reconnect(&mut self) {
        self.raw.clear();
        for task in &mut self.tasks {
            task.stale = true;
        }
    }
    pub fn forget(&mut self, id: &str) {
        self.raw.remove(id);
        if let Some(task) = self.tasks.iter_mut().find(|t| t.id == id) {
            task.stale = true;
        }
    }
    fn remember(&mut self, key: String) -> bool {
        if !self.seen.insert(key.clone()) {
            return false;
        }
        self.seen_order.push_back(key);
        while self.seen_order.len() > MAX_SEEN {
            if let Some(old) = self.seen_order.pop_front() {
                self.seen.remove(&old);
            }
        }
        true
    }
    /// Returns an alert only for an observed transition, never for an initial/resync snapshot.
    pub fn ingest(&mut self, id: &str, change: &Value) -> Result<Option<Activity>, IngestError> {
        let revision = change["revision"].as_u64().ok_or(IngestError::Invalid)?;
        let baseline = !self.raw.contains_key(id);
        if baseline && !self.tasks.iter().any(|t| t.id == id) && self.tasks.len() >= MAX_TASKS {
            return Err(IngestError::Capacity);
        }
        let state = match change["type"].as_str() {
            Some("snapshot") => {
                if self.raw.get(id).is_some_and(|old| revision <= old.revision) {
                    return Ok(None);
                }
                let state = change
                    .get("conversationState")
                    .filter(|s| s.is_object())
                    .ok_or(IngestError::Invalid)?;
                if state["id"].as_str().is_some_and(|value| value != id) {
                    return Err(IngestError::Invalid);
                }
                state.clone()
            }
            Some("patches") => {
                let old = self.raw.get(id).ok_or(IngestError::RevisionGap)?;
                if revision <= old.revision {
                    return Ok(None);
                }
                if change["baseRevision"].as_u64() != Some(old.revision) {
                    self.forget(id);
                    return Err(IngestError::RevisionGap);
                }
                let patches = normalize_patches(&change["patches"])?;
                let mut state = old.state.clone();
                if json_patch::patch(&mut state, &patches).is_err() {
                    self.forget(id);
                    return Err(IngestError::RevisionGap);
                }
                state
            }
            _ => return Err(IngestError::Invalid),
        };
        // Frames are bounded separately; patches must not grow retained state without limit.
        if !state_fits(&state) {
            self.forget(id);
            return Err(IngestError::Capacity);
        }
        let task = project(id, &state);
        let old = self.tasks.iter().find(|t| t.id == id).cloned();
        self.raw.insert(id.into(), Baseline { revision, state });
        let transition = old.as_ref().is_none_or(|old| {
            old.phase != task.phase
                || old.turn_id != task.turn_id
                || (task.phase == Phase::NeedsInput && old.request_key != task.request_key)
        });
        let key = format!(
            "{}:{:?}:{:?}:{}",
            id,
            task.turn_id,
            task.phase,
            if task.phase == Phase::NeedsInput {
                &task.request_key
            } else {
                ""
            }
        );
        let unseen = self.remember(key);
        let alerting = !baseline
            && transition
            && unseen
            && matches!(
                task.phase,
                Phase::NeedsInput | Phase::Ready | Phase::Blocked
            );
        self.tasks.retain(|t| t.id != id);
        self.tasks.insert(0, task.clone());
        if transition && (baseline && old.is_none() || !baseline && unseen) {
            self.sequence += 1;
            let item = Activity {
                id: format!("activity-{}", self.sequence),
                thread_id: id.into(),
                title: task.title,
                phase: task.phase.clone(),
                message: if baseline {
                    "관측을 시작했어요".into()
                } else {
                    task.phase.label().into()
                },
                at: task.updated_at,
                unread: alerting,
            };
            self.activities.insert(0, item.clone());
            self.activities.truncate(MAX_FEED);
            if alerting {
                return Ok(Some(item));
            }
        }
        Ok(None)
    }
}

fn normalize_patches(value: &Value) -> Result<json_patch::Patch, IngestError> {
    let mut value = value.as_array().ok_or(IngestError::Invalid)?.clone();
    if value.len() > 4096 {
        return Err(IngestError::Invalid);
    }
    for patch in &mut value {
        // Desktop Immer streams use these operations. Reject copy to prevent amplification.
        if !matches!(patch["op"].as_str(), Some("add" | "replace" | "remove")) {
            return Err(IngestError::Invalid);
        }
        for field in ["path", "from"] {
            if let Some(parts) = patch.get(field).and_then(Value::as_array) {
                let mut pointer = String::new();
                for part in parts {
                    let part = match part {
                        Value::String(s) => s.clone(),
                        Value::Number(n) => n.to_string(),
                        _ => return Err(IngestError::Invalid),
                    };
                    pointer.push('/');
                    pointer.push_str(&part.replace('~', "~0").replace('/', "~1"));
                }
                patch[field] = json!(pointer);
            }
        }
    }
    serde_json::from_value(Value::Array(value)).map_err(|_| IngestError::Invalid)
}

fn state_fits(state: &Value) -> bool {
    struct Limit(usize);
    impl std::io::Write for Limit {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self
                .0
                .checked_add(bytes.len())
                .filter(|n| *n <= MAX_STATE_BYTES)
                .ok_or_else(|| std::io::Error::other("state limit"))?;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    serde_json::to_writer(Limit(0), state).is_ok()
}

fn latest_turn(state: &Value) -> Option<&Value> {
    let valid =
        |v: &&Value| v.get("turnId").or_else(|| v.get("id")).is_some() && v["status"].is_string();
    if state["turnHistory"]["kind"] == "canonical" {
        let history = &state["turnHistory"]["history"];
        let tail = history["islands"].as_array()?.last()?;
        // A loaded historical page is not evidence of the current turn's completion.
        if tail["newerBoundary"]["status"] != "exhausted" {
            return None;
        }
        return tail["entries"]
            .as_array()?
            .iter()
            .rev()
            .filter_map(|entry| history["entitiesByKey"].get(entry["value"].as_str()?))
            .find(valid);
    }
    state["turns"].as_array()?.iter().rev().find(valid)
}
pub fn clip(value: &str, count: usize) -> String {
    value
        .chars()
        .map(|c| if c.is_whitespace() { ' ' } else { c })
        .filter(|c| !c.is_control())
        .take(count)
        .collect()
}
fn project(id: &str, state: &Value) -> Task {
    let turn = latest_turn(state);
    let runtime = &state["threadRuntimeStatus"];
    let waiting = runtime["activeFlags"].as_array().is_some_and(|flags| {
        flags
            .iter()
            .any(|v| matches!(v.as_str(), Some("waitingOnApproval" | "waitingOnUserInput")))
    });
    let phase = if runtime["type"] == "systemError" {
        Phase::Blocked
    } else if waiting {
        Phase::NeedsInput
    } else if runtime["type"] == "active" || turn.is_some_and(|t| t["status"] == "inProgress") {
        Phase::Running
    } else if turn.is_some_and(|t| t["status"] == "failed") {
        Phase::Blocked
    } else if turn.is_some_and(|t| t["status"] == "completed") {
        Phase::Ready
    } else if turn.is_some_and(|t| t["status"] == "interrupted") {
        Phase::Interrupted
    } else {
        Phase::Idle
    };
    let summary = turn
        .filter(|t| phase != Phase::Running || t["status"] == "inProgress")
        .and_then(|t| t["items"].as_array())
        .into_iter()
        .flatten()
        .rev()
        .find_map(|item| {
            if matches!(
                item["type"].as_str(),
                Some("agentMessage" | "assistantMessage")
            ) {
                item["text"].as_str().filter(|text| !text.trim().is_empty())
            } else {
                None
            }
        })
        .map(|s| clip(s, 160))
        .unwrap_or_default();
    let requests = &state["requests"];
    let request_key = match requests {
        Value::Object(m) => m.keys().take(16).cloned().collect::<Vec<_>>().join(","),
        Value::Array(v) => v
            .iter()
            .take(16)
            .filter_map(|v| v.get("requestId").or_else(|| v.get("id")))
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join(","),
        _ => String::new(),
    };
    Task {
        id: id.into(),
        title: clip(
            state["title"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or("Codex 작업"),
            90,
        ),
        phase,
        turn_id: turn
            .and_then(|t| t.get("turnId").or_else(|| t.get("id")))
            .and_then(Value::as_str)
            .map(str::to_owned),
        summary,
        stale: false,
        updated_at: chrono::Utc::now().to_rfc3339(),
        request_key,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn snapshot(rev: u64, status: &str, runtime: &str) -> Value {
        json!({"type":"snapshot","revision":rev,"conversationState":{"id":"one","title":"테스트 작업","threadRuntimeStatus":{"type":runtime},"turns":[{"id":"turn-1","status":status,"items":[]}]}})
    }
    #[test]
    fn initial_and_reconnected_completions_are_silent_and_duplicates_stay_silent() {
        let mut e = Engine::default();
        assert!(e
            .ingest("one", &snapshot(1, "completed", "idle"))
            .unwrap()
            .is_none());
        e.reconnect();
        assert!(e
            .ingest("one", &snapshot(2, "completed", "idle"))
            .unwrap()
            .is_none());
        e.ingest("one", &snapshot(3, "inProgress", "active"))
            .unwrap();
        assert!(e
            .ingest("one", &snapshot(4, "completed", "idle"))
            .unwrap()
            .is_none());
    }
    #[test]
    fn running_to_completed_alerts_once_and_idle_is_not_completion() {
        let mut e = Engine::default();
        e.ingest("one", &snapshot(1, "inProgress", "active"))
            .unwrap();
        let mut idle = snapshot(2, "inProgress", "idle");
        idle["conversationState"]["turns"] = json!([]);
        assert!(e.ingest("one", &idle).unwrap().is_none());
        assert_eq!(e.tasks[0].phase, Phase::Idle);
        assert_eq!(
            e.ingest("one", &snapshot(3, "completed", "idle"))
                .unwrap()
                .unwrap()
                .phase,
            Phase::Ready
        );
        assert!(e
            .ingest("one", &snapshot(4, "completed", "idle"))
            .unwrap()
            .is_none());
        // Runtime activation can arrive before the next turn replaces an old failed turn.
        assert!(e
            .ingest("one", &snapshot(5, "failed", "active"))
            .unwrap()
            .is_none());
        assert_eq!(e.tasks[0].phase, Phase::Running);
    }
    #[test]
    fn patches_support_immer_paths_and_revision_gaps_require_a_silent_baseline() {
        let mut e = Engine::default();
        e.ingest("one", &snapshot(1, "inProgress", "active"))
            .unwrap();
        let p = json!({"type":"patches","baseRevision":1,"revision":2,"patches":[{"op":"replace","path":["turns",0,"status"],"value":"completed"},{"op":"replace","path":["threadRuntimeStatus","type"],"value":"idle"}]});
        assert!(e.ingest("one", &p).unwrap().is_some());
        assert_eq!(
            e.ingest(
                "one",
                &json!({"type":"patches","baseRevision":4,"revision":5,"patches":[]})
            ),
            Err(IngestError::RevisionGap)
        );
        assert!(e
            .ingest("one", &snapshot(6, "failed", "systemError"))
            .unwrap()
            .is_none());
    }
    #[test]
    fn each_pending_request_can_alert_but_repeated_flags_do_not() {
        let mut e = Engine::default();
        e.ingest("one", &snapshot(1, "inProgress", "active"))
            .unwrap();
        let mut waiting = snapshot(2, "inProgress", "active");
        waiting["conversationState"]["threadRuntimeStatus"]["activeFlags"] =
            json!(["waitingOnApproval"]);
        waiting["conversationState"]["requests"] = json!({"request-a":{}});
        assert_eq!(
            e.ingest("one", &waiting).unwrap().unwrap().phase,
            Phase::NeedsInput
        );
        waiting["revision"] = json!(3);
        assert!(e.ingest("one", &waiting).unwrap().is_none());
        waiting["revision"] = json!(4);
        waiting["conversationState"]["requests"] = json!({"request-b":{}});
        assert!(e.ingest("one", &waiting).unwrap().is_some());
    }
    #[test]
    fn canonical_turn_history_and_summary_are_normalized_without_tool_arguments() {
        let mut e = Engine::default();
        let mut s = snapshot(1, "completed", "idle");
        s["conversationState"]["turns"] = json!([]);
        s["conversationState"]["turnHistory"] = json!({"kind":"canonical","history":{"islands":[{"newerBoundary":{"status":"exhausted"},"entries":[{"value":"turn-1"}]}],"entitiesByKey":{"turn-1":{"turnId":"turn-1","status":"completed","items":[{"type":"commandExecution","command":"private command"},{"type":"agentMessage","text":"작업 완료"}]}}}});
        e.ingest("one", &s).unwrap();
        assert_eq!(e.tasks[0].phase, Phase::Ready);
        assert_eq!(e.tasks[0].summary, "작업 완료");
        assert!(!serde_json::to_string(&e.tasks)
            .unwrap()
            .contains("private command"));
        s["revision"] = json!(2);
        s["conversationState"]["turnHistory"]["history"]["islands"][0]["newerBoundary"]["status"] =
            json!("available");
        assert!(e.ingest("one", &s).unwrap().is_none());
        assert_eq!(e.tasks[0].phase, Phase::Idle);
    }
    #[test]
    fn streaming_assistant_content_updates_without_creating_an_alert() {
        let mut e = Engine::default();
        e.ingest("one", &snapshot(1, "inProgress", "active"))
            .unwrap();
        let patch = json!({"type":"patches","baseRevision":1,"revision":2,"patches":[{"op":"add","path":"/turns/0/items/0","value":{"type":"agentMessage","text":"테스트\n실행 중"}}]});
        assert!(e.ingest("one", &patch).unwrap().is_none());
        assert_eq!(e.tasks[0].summary, "테스트 실행 중");
        assert_eq!(e.activities.len(), 1);
        let patch = json!({"type":"patches","baseRevision":2,"revision":3,"patches":[{"op":"replace","path":"/turns/0/items/0/text","value":"테스트 결과를 확인 중"}]});
        assert!(e.ingest("one", &patch).unwrap().is_none());
        assert_eq!(e.tasks[0].summary, "테스트 결과를 확인 중");
    }
    #[test]
    fn new_turn_completion_alerts_even_when_previous_turn_was_completed() {
        let mut e = Engine::default();
        e.ingest("one", &snapshot(1, "completed", "idle")).unwrap();
        let mut next = snapshot(2, "completed", "idle");
        next["conversationState"]["turns"][0]["id"] = json!("turn-2");
        assert_eq!(e.ingest("one", &next).unwrap().unwrap().phase, Phase::Ready);
    }
    #[test]
    fn patch_growth_is_bounded_and_unsafe_copy_is_rejected() {
        let mut e = Engine::default();
        e.ingest("one", &snapshot(1, "inProgress", "active"))
            .unwrap();
        assert_eq!(e.ingest("one", &json!({"type":"patches","baseRevision":1,"revision":2,"patches":[{"op":"copy","path":"/copy","from":""}]})), Err(IngestError::Invalid));
        let large = "x".repeat(MAX_STATE_BYTES / 2);
        e.ingest("one", &json!({"type":"patches","baseRevision":1,"revision":2,"patches":[{"op":"add","path":"/a","value":large}]})).unwrap();
        assert_eq!(e.ingest("one", &json!({"type":"patches","baseRevision":2,"revision":3,"patches":[{"op":"add","path":"/b","value":large}]})), Err(IngestError::Capacity));
        assert!(e.raw.is_empty());
        assert!(e.tasks[0].stale);
    }
}
