use serde::{Deserialize, Serialize};
use url::Url;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CharacterBackend {
    #[default]
    Robot,
    Rive,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    pub view_id: String,
    pub refresh_seconds: u32,
    pub roaming_enabled: bool,
    pub character_backend: CharacterBackend,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            view_id: String::new(),
            refresh_seconds: 60,
            roaming_enabled: true,
            character_backend: CharacterBackend::Robot,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CardSummary {
    pub id: String,
    pub source: String,
    pub title: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FeedSnapshot {
    pub cards: Vec<CardSummary>,
    pub refreshed_at: String,
    pub has_more: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatusOption {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CardStatusField {
    pub id: String,
    pub name: String,
    pub current_option_id: Option<String>,
    pub options: Vec<StatusOption>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CardStatusEditor {
    pub card_id: String,
    pub fields: Vec<CardStatusField>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusUpdateResult {
    pub card: CardSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupStatus {
    pub config: AppConfig,
    pub has_token: bool,
    pub snapshot: Option<FeedSnapshot>,
}

/// Accept an explicit view ID or a Notion URL containing its `v` query parameter.
/// A page/database URL without `v` is deliberately not guessed to be a view ID.
pub fn normalize_view_id(input: &str) -> Result<String, String> {
    let value = input.trim();
    if let Ok(id) = Uuid::parse_str(value) {
        return Ok(id.hyphenated().to_string());
    }
    let link =
        Url::parse(value).map_err(|_| "Notion 뷰 ID 또는 뷰 링크를 입력해 주세요.".to_string())?;
    if !matches!(link.scheme(), "https" | "http" | "notion")
        || !link.host_str().is_some_and(is_notion_host)
        || !link.username().is_empty()
        || link.password().is_some()
    {
        return Err("Notion 뷰 링크만 연결할 수 있습니다.".into());
    }
    let mut ids = link.query_pairs().filter(|(key, _)| key == "v");
    let (_, view_id) = ids.next().ok_or_else(|| {
        "뷰 링크의 v 값이 없습니다. Notion에서 뷰 링크를 복사해 주세요.".to_string()
    })?;
    if ids.next().is_some() {
        return Err("뷰 ID가 여러 개 포함된 링크입니다. 뷰 링크를 다시 복사해 주세요.".into());
    }
    Uuid::parse_str(&view_id)
        .map(|id| id.hyphenated().to_string())
        .map_err(|_| "올바른 Notion 뷰 ID가 아닙니다.".to_string())
}

pub(crate) fn is_notion_host(host: &str) -> bool {
    ["notion.so", "notion.com", "notion.site"]
        .iter()
        .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "a3f1b2c4-5678-4def-abcd-1234567890ab";

    #[test]
    fn recognizes_id_and_saved_view_link_without_guessing_page_ids() {
        assert_eq!(
            normalize_view_id(" A3F1B2C456784DEFABCD1234567890AB ").unwrap(),
            ID
        );
        assert_eq!(
            normalize_view_id(&format!("https://app.notion.com/p/another-id?v={ID}&pvs=4"))
                .unwrap(),
            ID
        );
        assert!(normalize_view_id(&format!("https://www.notion.so/{ID}")).is_err());
        assert!(normalize_view_id(&format!("https://notion.so.evil.test/?v={ID}")).is_err());
        assert!(normalize_view_id(&format!("https://notion.so/?v={ID}&v={ID}")).is_err());
    }

    #[test]
    fn native_json_matches_the_frontend_contract() {
        let config = serde_json::to_value(AppConfig::default()).unwrap();
        assert_eq!(config["refreshSeconds"], 60);
        assert_eq!(config["roamingEnabled"], true);
        assert_eq!(config["characterBackend"], "robot");
        let status = serde_json::to_value(SetupStatus {
            config: AppConfig::default(),
            has_token: false,
            snapshot: None,
        })
        .unwrap();
        assert_eq!(status["hasToken"], false);
        assert!(status["snapshot"].is_null());
        assert!(status.get("token").is_none());
        let old_card: CardSummary = serde_json::from_value(serde_json::json!({
            "id":"page-id", "source":"notion", "title":"기존 캐시", "url":"https://www.notion.so/page-id", "status":"진행 중"
        })).unwrap();
        assert!(old_card.status_color.is_none());
        assert!(serde_json::to_value(old_card)
            .unwrap()
            .get("statusColor")
            .is_none());
        let editor = serde_json::to_value(CardStatusEditor {
            card_id: "page-id".into(),
            fields: vec![CardStatusField {
                id: "f%5C%3Ap".into(),
                name: "작업 상태".into(),
                current_option_id: None,
                options: vec![StatusOption {
                    id: "option-id".into(),
                    name: "검토 대기".into(),
                    color: None,
                }],
            }],
        })
        .unwrap();
        assert_eq!(editor["cardId"], "page-id");
        assert!(editor["fields"][0]["currentOptionId"].is_null());
        assert_eq!(editor["fields"][0]["options"][0]["name"], "검토 대기");
    }

    #[test]
    fn old_settings_keep_their_values_and_default_to_the_robot() {
        let mut config: AppConfig = serde_json::from_value(serde_json::json!({
            "viewId": ID, "refreshSeconds": 120, "roamingEnabled": false
        }))
        .unwrap();
        assert_eq!(config.view_id, ID);
        assert_eq!(config.refresh_seconds, 120);
        assert!(!config.roaming_enabled);
        assert_eq!(config.character_backend, CharacterBackend::Robot);
        config.character_backend = CharacterBackend::Rive;
        let json = serde_json::to_value(&config).unwrap();
        assert_eq!(json["characterBackend"], "rive");
        assert_eq!(serde_json::from_value::<AppConfig>(json).unwrap(), config);
        for invalid in ["unknown", "Rive", "https://example.com/model.riv", ""] {
            assert!(
                serde_json::from_value::<CharacterBackend>(serde_json::json!(invalid)).is_err()
            );
        }
        assert!(serde_json::from_value::<CharacterBackend>(serde_json::Value::Null).is_err());
    }
}
