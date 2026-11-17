use crate::model::{
    is_notion_host, normalize_view_id, CardStatusEditor, CardStatusField, CardSummary,
    FeedSnapshot, StatusOption,
};
use chrono::{SecondsFormat, Utc};
use futures_util::{stream, StreamExt, TryStreamExt};
use reqwest::{header, Client, Method, RequestBuilder, StatusCode};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};
use url::Url;

const API_BASE: &str = "https://api.notion.com/v1/";
const API_VERSION: &str = "2026-03-11";
const MAX_CARDS: usize = 20;
const MAX_ATTEMPTS: usize = 3;
const WRITE_UNCONFIRMED: &str =
    "Notion 상태 변경 결과를 확인하지 못했습니다. 카드를 새로고침해 실제 상태를 확인해 주세요.";

struct EditableStatusField {
    kind: &'static str,
    default_option_id: Option<String>,
    field: CardStatusField,
}

struct NotionClient {
    http: Client,
    base_url: Url,
}

#[derive(Deserialize)]
struct PageReference {
    id: String,
}

#[derive(Deserialize)]
struct RequestStatus {
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Deserialize)]
struct QueryPage {
    id: Option<String>,
    results: Vec<PageReference>,
    has_more: bool,
    next_cursor: Option<String>,
    total_count: Option<usize>,
    request_status: Option<RequestStatus>,
}

pub async fn fetch_feed(view_id: &str, token: &str) -> Result<FeedSnapshot, String> {
    let view_id = normalize_view_id(view_id)?;
    NotionClient::new(token)?.fetch(&view_id).await
}

pub async fn fetch_card_status(id: &str, token: &str) -> Result<CardStatusEditor, String> {
    NotionClient::new(token)?.card_status(id).await
}

pub async fn update_card_status(
    id: &str,
    field_id: &str,
    option_id: &str,
    token: &str,
) -> Result<CardSummary, String> {
    NotionClient::new(token)?
        .update_status(id, field_id, option_id)
        .await
}

impl NotionClient {
    fn new(token: &str) -> Result<Self, String> {
        if token.trim().is_empty() {
            return Err("Notion 토큰을 먼저 연결해 주세요.".into());
        }
        let mut authorization = header::HeaderValue::from_str(&format!("Bearer {}", token.trim()))
            .map_err(|_| "Notion 토큰 형식이 올바르지 않습니다.".to_string())?;
        authorization.set_sensitive(true);
        let mut headers = header::HeaderMap::new();
        headers.insert(header::AUTHORIZATION, authorization);
        headers.insert(
            "Notion-Version",
            header::HeaderValue::from_static(API_VERSION),
        );
        let http = Client::builder()
            .default_headers(headers)
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(25))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("card-captor/0.1")
            .build()
            .map_err(|_| "Notion 연결을 준비할 수 없습니다.".to_string())?;
        Ok(Self {
            http,
            base_url: Url::parse(API_BASE).expect("fixed Notion API URL"),
        })
    }

    fn request(&self, method: Method, segments: &[&str]) -> RequestBuilder {
        let mut url = self.base_url.clone();
        url.path_segments_mut()
            .expect("fixed HTTP base URL")
            .pop_if_empty()
            .extend(segments.iter().copied());
        self.http.request(method, url)
    }

    async fn json(&self, request: RequestBuilder) -> Result<Value, String> {
        self.json_request(request, false).await
    }

    async fn json_request(&self, request: RequestBuilder, writing: bool) -> Result<Value, String> {
        for attempt in 0..MAX_ATTEMPTS {
            let response = request
                .try_clone()
                .ok_or_else(|| "Notion 요청을 준비할 수 없습니다.".to_string())?
                .send()
                .await
                .map_err(|error| {
                    if writing {
                        WRITE_UNCONFIRMED.to_string()
                    } else if error.is_timeout() {
                        "Notion 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.".to_string()
                    } else {
                        "Notion에 연결하지 못했습니다. 네트워크 연결을 확인해 주세요.".to_string()
                    }
                })?;
            let status = response.status();
            if status.is_success() {
                if status == StatusCode::NO_CONTENT {
                    return Ok(Value::Null);
                }
                return response.json().await.map_err(|_| {
                    if writing {
                        WRITE_UNCONFIRMED.to_string()
                    } else {
                        "Notion 응답 형식을 읽을 수 없습니다.".to_string()
                    }
                });
            }
            if status.as_u16() == 429 || status.as_u16() == 529 {
                if writing && status.as_u16() == 529 {
                    return Err(WRITE_UNCONFIRMED.into());
                }
                let retry_after = response
                    .headers()
                    .get(header::RETRY_AFTER)
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.parse::<u64>().ok())
                    .unwrap_or(1 << attempt);
                // A blocked connection cannot recover through automatic retries.
                if status.as_u16() == 429 {
                    let body = response.json::<Value>().await.unwrap_or(Value::Null);
                    if body
                        .pointer("/additional_data/rate_limit_reason")
                        .and_then(Value::as_str)
                        == Some("public_api_request_blocked")
                    {
                        return Err("Notion 연결의 API 접근이 제한되었습니다. Notion 연결 상태를 확인해 주세요.".into());
                    }
                }
                // Never retry sooner than Retry-After; long waits are deferred to the next refresh.
                if attempt + 1 == MAX_ATTEMPTS || retry_after > 60 {
                    return Err(
                        "Notion 요청이 일시적으로 제한되었습니다. 잠시 후 다시 시도해 주세요."
                            .into(),
                    );
                }
                tokio::time::sleep(Duration::from_secs(retry_after)).await;
                continue;
            }
            return Err(if writing {
                match status.as_u16() {
                    400 => "Notion 상태를 변경할 수 없습니다. 상태 목록을 다시 열어 최신 항목을 선택해 주세요.".into(),
                    403 => "Notion 상태 변경 권한이 없습니다. 연결의 콘텐츠 수정 권한과 원본 페이지 권한을 확인해 주세요.".into(),
                    409 => "Notion에서 다른 변경과 충돌했습니다. 카드를 새로고침한 뒤 다시 시도해 주세요.".into(),
                    500..=599 => WRITE_UNCONFIRMED.into(),
                    _ => status_message(status),
                }
            } else {
                status_message(status)
            });
        }
        Err("Notion 요청을 완료하지 못했습니다.".into())
    }

    async fn load_status_fields(
        &self,
        id: &str,
    ) -> Result<(Value, Vec<EditableStatusField>), String> {
        let page = self.json(self.request(Method::GET, &["pages", id])).await?;
        let card = card_from_page(&page)?;
        if card.id != id {
            return Err(
                "Notion 카드의 식별자가 일치하지 않습니다. 카드를 새로고침해 주세요.".into(),
            );
        }
        if page.get("in_trash").and_then(Value::as_bool) == Some(true)
            || page.get("archived").and_then(Value::as_bool) == Some(true)
        {
            return Err("휴지통에 있는 Notion 카드의 상태는 변경할 수 없습니다.".into());
        }
        let parent = page
            .get("parent")
            .ok_or_else(|| "Notion 카드의 데이터 소스를 확인할 수 없습니다.".to_string())?;
        if parent.get("type").and_then(Value::as_str) != Some("data_source_id") {
            return Ok((page, Vec::new()));
        }
        let data_source_id = parent
            .get("data_source_id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "Notion 카드의 데이터 소스를 확인할 수 없습니다.".to_string())?;
        let schema = self
            .json(self.request(Method::GET, &["data_sources", data_source_id]))
            .await?;
        if schema.get("id").and_then(Value::as_str) != Some(data_source_id) {
            return Err(
                "Notion 데이터 소스의 식별자가 일치하지 않습니다. 카드를 새로고침해 주세요.".into(),
            );
        }
        let fields = status_fields_from_schema(&page, &schema)?;
        Ok((page, fields))
    }

    async fn card_status(&self, id: &str) -> Result<CardStatusEditor, String> {
        let (_, fields) = self.load_status_fields(id).await?;
        Ok(CardStatusEditor {
            card_id: id.into(),
            fields: fields.into_iter().map(|field| field.field).collect(),
        })
    }

    async fn update_status(
        &self,
        id: &str,
        field_id: &str,
        option_id: &str,
    ) -> Result<CardSummary, String> {
        // Re-read both objects for each write. Values from a stale picker are never
        // used to create a new option or to write a different property by name.
        let (_, fields) = self.load_status_fields(id).await?;
        let selected = fields
            .into_iter()
            .find(|field| field.field.id == field_id)
            .ok_or_else(|| {
                "변경할 상태 속성이 없거나 변경되었습니다. 상태 목록을 다시 열어 주세요."
                    .to_string()
            })?;
        let selected_option = selected
            .field
            .options
            .iter()
            .find(|option| option.id == option_id)
            .ok_or_else(|| {
                "선택한 상태가 없거나 변경되었습니다. 상태 목록을 다시 열어 주세요.".to_string()
            })?;
        let payload = json!({"properties": {
            (field_id): { (selected.kind): { "id": option_id } }
        }});
        let updated = self
            .json_request(
                self.request(Method::PATCH, &["pages", id]).json(&payload),
                true,
            )
            .await?;
        let mut card = card_from_page(&updated).map_err(|_| WRITE_UNCONFIRMED.to_string())?;
        let applied_value = updated
            .get("properties")
            .and_then(Value::as_object)
            .and_then(|properties| {
                properties.values().find(|property| {
                    property.get("id").and_then(Value::as_str) == Some(field_id)
                        && property.get("type").and_then(Value::as_str) == Some(selected.kind)
                })
            })
            .and_then(|property| property.get(selected.kind));
        let applied = applied_value.and_then(|value| {
            if value.is_null() && selected.kind == "status" {
                selected.default_option_id.as_deref()
            } else {
                value.get("id").and_then(Value::as_str)
            }
        });
        if card.id != id || applied != Some(option_id) {
            return Err(WRITE_UNCONFIRMED.into());
        }
        let displayed_field = displayed_status_property(&updated);
        let displayed_field_id = displayed_field
            .and_then(|property| property.get("id"))
            .and_then(Value::as_str);
        if displayed_field_id == Some(field_id)
            || (selected.kind == "select" && displayed_field.is_none())
        {
            // Resolve a default or a property renamed during the read. Explicit
            // response names win over the previously fetched schema.
            card.status = Some(
                applied_value
                    .and_then(|value| value.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or(&selected_option.name)
                    .into(),
            );
            card.status_color = applied_value
                .and_then(|value| value.get("color"))
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| selected_option.color.clone());
        }
        Ok(card)
    }

    async fn fetch(&self, view_id: &str) -> Result<FeedSnapshot, String> {
        let first: QueryPage = serde_json::from_value(
            self.json(
                self.request(Method::POST, &["views", view_id, "queries"])
                    .json(&json!({ "page_size": MAX_CARDS })),
            )
            .await?,
        )
        .map_err(|_| "Notion 뷰 조회 결과를 읽을 수 없습니다.".to_string())?;
        let query_id = first
            .id
            .clone()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| "Notion 뷰 조회 ID가 응답에 없습니다.".to_string())?;
        let result = self.hydrate_query(view_id, &query_id, first).await;
        // Delete only the temporary query cache, never the saved view or its pages.
        let _ = self
            .json(self.request(Method::DELETE, &["views", view_id, "queries", &query_id]))
            .await;
        result
    }

    async fn hydrate_query(
        &self,
        view_id: &str,
        query_id: &str,
        mut page: QueryPage,
    ) -> Result<FeedSnapshot, String> {
        let mut ids = Vec::new();
        let mut seen_ids = HashSet::new();
        let mut seen_cursors = HashSet::new();
        let mut incomplete = false;
        let total_count = page.total_count;
        let has_more = loop {
            incomplete |= page
                .request_status
                .as_ref()
                .is_some_and(|status| status.kind == "incomplete");
            for reference in page.results {
                if seen_ids.insert(reference.id.clone()) {
                    ids.push(reference.id);
                }
            }
            if ids.len() >= MAX_CARDS || !page.has_more {
                break page.has_more || ids.len() > MAX_CARDS;
            }
            let cursor = page
                .next_cursor
                .filter(|cursor| !cursor.is_empty())
                .ok_or_else(|| "Notion의 다음 카드 위치를 확인할 수 없습니다.".to_string())?;
            if !seen_cursors.insert(cursor.clone()) || seen_cursors.len() > 100 {
                return Err(
                    "Notion 카드 목록의 페이지 위치가 반복되었습니다. 다시 새로고침해 주세요."
                        .into(),
                );
            }
            let remaining = MAX_CARDS - ids.len();
            page = serde_json::from_value(
                self.json(
                    self.request(Method::GET, &["views", view_id, "queries", query_id])
                        .query(&[
                            ("start_cursor", cursor),
                            ("page_size", remaining.to_string()),
                        ]),
                )
                .await?,
            )
            .map_err(|_| "Notion의 다음 카드 목록을 읽을 수 없습니다.".to_string())?;
        };
        ids.truncate(MAX_CARDS);
        let displayed_count = ids.len();
        let mut ordered: Vec<(usize, Value)> = stream::iter(ids.into_iter().enumerate())
            .map(|(index, id)| async move {
                let page = self
                    .json(self.request(Method::GET, &["pages", &id]))
                    .await?;
                Ok::<_, String>((index, page))
            })
            .buffer_unordered(2)
            .try_collect()
            .await?;
        ordered.sort_by_key(|(index, _)| *index);
        // Only a displayed null Status needs schema metadata. Resolve each source
        // once per refresh, including failed reads, without adding requests for
        // pages with explicit status values. Metadata failure must preserve cards.
        let sources: HashSet<String> = ordered
            .iter()
            .filter(|(_, page)| needs_default_status(page))
            .filter_map(|(_, page)| status_data_source(page).map(str::to_owned))
            .collect();
        let schemas: HashMap<String, Result<Value, String>> = stream::iter(sources)
            .map(|id| async move {
                let result = self
                    .json(self.request(Method::GET, &["data_sources", &id]))
                    .await
                    .and_then(|schema| {
                        if schema.get("id").and_then(Value::as_str) == Some(id.as_str()) {
                            Ok(schema)
                        } else {
                            Err("Notion 데이터 소스의 식별자가 일치하지 않습니다.".into())
                        }
                    });
                (id, result)
            })
            .buffer_unordered(2)
            .collect()
            .await;
        let mut default_status_failed = false;
        let mut cards = Vec::with_capacity(ordered.len());
        for (_, page) in ordered {
            let mut card = card_from_page(&page)?;
            if needs_default_status(&page) {
                let resolved = status_data_source(&page)
                    .and_then(|id| schemas.get(id))
                    .and_then(|result| result.as_ref().ok())
                    .and_then(|schema| default_status_option(&page, schema).ok());
                match resolved {
                    Some(Some(option)) => {
                        card.status = Some(option.name);
                        card.status_color = option.color;
                    }
                    Some(None) => {
                        card.status = None;
                        card.status_color = None;
                    }
                    None => default_status_failed = true,
                }
            }
            cards.push(card);
        }
        let mut warnings = Vec::new();
        if incomplete {
            warnings.push("Notion 조회 제한으로 일부 카드만 표시됩니다.");
        }
        if default_status_failed {
            warnings.push("일부 카드의 기본 상태를 확인하지 못했습니다.");
        }
        Ok(FeedSnapshot {
            cards,
            refreshed_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
            has_more: has_more
                || incomplete
                || total_count.is_some_and(|total| total > displayed_count),
            warning: (!warnings.is_empty()).then(|| warnings.join(" ")),
        })
    }
}

fn displayed_native_status(page: &Value) -> Option<&Value> {
    page.get("properties")
        .and_then(Value::as_object)?
        .values()
        .find(|property| property.get("type").and_then(Value::as_str) == Some("status"))
}

fn displayed_status_property(page: &Value) -> Option<&Value> {
    if let Some(property) = displayed_native_status(page) {
        return Some(property);
    }
    page.get("properties")
        .and_then(Value::as_object)?
        .iter()
        .find_map(|(name, property)| {
            (is_status_name(name) && property.get("type").and_then(Value::as_str) == Some("select"))
                .then_some(property)
        })
}

fn needs_default_status(page: &Value) -> bool {
    displayed_native_status(page)
        .and_then(|property| property.get("status"))
        .is_some_and(Value::is_null)
}

fn status_data_source(page: &Value) -> Option<&str> {
    let parent = page.get("parent")?;
    if parent.get("type").and_then(Value::as_str) != Some("data_source_id") {
        return None;
    }
    parent
        .get("data_source_id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
}

fn default_status_option(page: &Value, schema: &Value) -> Result<Option<StatusOption>, String> {
    let invalid = || "Notion 기본 상태의 설정을 읽을 수 없습니다.".to_string();
    let id = displayed_native_status(page)
        .and_then(|property| property.get("id"))
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    let configuration = schema
        .get("properties")
        .and_then(Value::as_object)
        .and_then(|properties| {
            properties.values().find(|property| {
                property.get("id").and_then(Value::as_str) == Some(id)
                    && property.get("type").and_then(Value::as_str) == Some("status")
            })
        })
        .and_then(|property| property.get("status"))
        .ok_or_else(invalid)?;
    match configuration.get("default_option") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(default)) => {
            let options = configuration
                .get("options")
                .and_then(Value::as_array)
                .ok_or_else(invalid)?;
            let option = options
                .iter()
                .find(|option| option.get("name").and_then(Value::as_str) == Some(default.as_str()))
                .ok_or_else(invalid)?;
            Ok(Some(StatusOption {
                id: option
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(invalid)?
                    .into(),
                name: default.clone(),
                color: option
                    .get("color")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            }))
        }
        _ => Err(invalid()),
    }
}

fn status_fields_from_schema(
    page: &Value,
    schema: &Value,
) -> Result<Vec<EditableStatusField>, String> {
    let page_properties = page
        .get("properties")
        .and_then(Value::as_object)
        .ok_or_else(|| "Notion 카드 속성을 읽을 수 없습니다.".to_string())?;
    let schema_properties = schema
        .get("properties")
        .and_then(Value::as_object)
        .ok_or_else(|| "Notion 데이터 소스의 상태 목록을 읽을 수 없습니다.".to_string())?;
    let has_native_status = schema_properties
        .values()
        .any(|property| property.get("type").and_then(Value::as_str) == Some("status"));
    let mut fields = Vec::new();
    let mut field_ids = HashSet::new();
    for (key, property) in schema_properties {
        let kind = match property.get("type").and_then(Value::as_str) {
            Some("status") => "status",
            Some("select") if !has_native_status && is_status_name(key) => "select",
            _ => continue,
        };
        let id = property
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| "Notion 상태 속성의 식별자를 읽을 수 없습니다.".to_string())?;
        if !field_ids.insert(id) {
            return Err(
                "Notion 상태 속성의 식별자가 중복되었습니다. 다시 새로고침해 주세요.".into(),
            );
        }
        // Property names can change independently of their stable, URL-encoded IDs.
        let page_property = page_properties
            .values()
            .find(|value| value.get("id").and_then(Value::as_str) == Some(id))
            .filter(|value| value.get("type").and_then(Value::as_str) == Some(kind))
            .ok_or_else(|| {
                "Notion 상태 속성이 변경되었습니다. 카드를 새로고침해 주세요.".to_string()
            })?;
        let configuration = property
            .get(kind)
            .ok_or_else(|| "Notion 상태 속성의 설정을 읽을 수 없습니다.".to_string())?;
        let mut option_ids = HashSet::new();
        let options: Vec<StatusOption> = configuration
            .get("options")
            .and_then(Value::as_array)
            .ok_or_else(|| "Notion 상태 선택 항목을 읽을 수 없습니다.".to_string())?
            .iter()
            .map(|option| {
                let id = option
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| {
                        "Notion 상태 선택 항목의 식별자를 읽을 수 없습니다.".to_string()
                    })?;
                if !option_ids.insert(id) {
                    return Err("Notion 상태 선택 항목의 식별자가 중복되었습니다.".into());
                }
                let name = option
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|name| !name.trim().is_empty())
                    .ok_or_else(|| {
                        "Notion 상태 선택 항목의 이름을 읽을 수 없습니다.".to_string()
                    })?;
                Ok(StatusOption {
                    id: id.into(),
                    name: name.into(),
                    color: option
                        .get("color")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                })
            })
            .collect::<Result<_, String>>()?;
        let current = page_property
            .get(kind)
            .ok_or_else(|| "Notion 카드의 현재 상태를 읽을 수 없습니다.".to_string())?;
        // A null Status displays the configured default, which need not
        // be the first option. A missing default is never guessed.
        let default_option_id = if kind == "status" {
            configuration
                .get("default_option")
                .and_then(Value::as_str)
                .and_then(|name| options.iter().find(|option| option.name == name))
                .map(|option| option.id.clone())
        } else {
            None
        };
        let current_option_id = if current.is_null() {
            default_option_id.clone()
        } else {
            let id = current
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| "Notion 카드의 현재 상태를 읽을 수 없습니다.".to_string())?;
            if !options.iter().any(|option| option.id == id) {
                return Err(
                    "Notion 상태 선택 항목이 변경되었습니다. 상태 목록을 다시 열어 주세요.".into(),
                );
            }
            Some(id.into())
        };
        fields.push(EditableStatusField {
            kind,
            default_option_id,
            field: CardStatusField {
                id: id.into(),
                name: property
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(key)
                    .into(),
                current_option_id,
                options,
            },
        });
    }
    Ok(fields)
}

fn is_status_name(name: &str) -> bool {
    matches!(
        normalized_property_name(name).as_str(),
        "status" | "상태" | "진행상태"
    )
}

fn status_message(status: StatusCode) -> String {
    match status.as_u16() {
        400 => "Notion 뷰를 조회할 수 없습니다. 뷰 ID와 필터 설정을 확인해 주세요.",
        401 => "Notion 토큰이 만료되었거나 유효하지 않습니다. 토큰을 다시 연결해 주세요.",
        403 => {
            "Notion 읽기 권한이 없습니다. 토큰 권한과 원본 페이지·데이터 소스 공유를 확인해 주세요."
        }
        404 => "Notion 뷰·페이지·데이터 소스를 찾을 수 없습니다. 연결의 접근 권한을 확인해 주세요.",
        406 => "Notion 조회 범위가 너무 큽니다. 뷰 필터를 좁혀 주세요.",
        500..=599 => "Notion 서비스가 일시적으로 응답하지 않습니다. 잠시 후 다시 시도해 주세요.",
        _ => "Notion 요청을 처리할 수 없습니다. 연결 설정을 확인해 주세요.",
    }
    .into()
}

fn card_from_page(page: &Value) -> Result<CardSummary, String> {
    let id = page
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Notion 카드 ID가 응답에 없습니다.".to_string())?;
    let url = page
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| "Notion 카드 링크가 응답에 없습니다.".to_string())?;
    let parsed_url =
        Url::parse(url).map_err(|_| "Notion 카드 링크가 올바르지 않습니다.".to_string())?;
    if parsed_url.scheme() != "https"
        || !parsed_url.host_str().is_some_and(is_notion_host)
        || !parsed_url.username().is_empty()
        || parsed_url.password().is_some()
    {
        return Err("Notion 카드 링크의 출처를 확인할 수 없습니다.".into());
    }
    let properties = page
        .get("properties")
        .and_then(Value::as_object)
        .ok_or_else(|| "Notion 카드 속성을 읽을 수 없습니다.".to_string())?;
    let title = properties
        .values()
        .find(|property| property.get("type").and_then(Value::as_str) == Some("title"))
        .and_then(|property| property.get("title").and_then(Value::as_array))
        .map(|fragments| {
            fragments
                .iter()
                .filter_map(|fragment| {
                    fragment
                        .get("plain_text")
                        .and_then(Value::as_str)
                        .or_else(|| fragment.pointer("/text/content").and_then(Value::as_str))
                })
                .collect::<String>()
        })
        .filter(|title| !title.trim().is_empty())
        .unwrap_or_else(|| "(제목 없음)".into());
    let status_value = displayed_status_property(page)
        .and_then(|property| property.get(property.get("type")?.as_str()?));
    let status = status_value
        .and_then(|value| value.get("name"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let status_color = status_value
        .and_then(|value| value.get("color"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    // Only recognize semantic due-date names; an arbitrary date might be a creation/start date.
    let due_at = properties.iter().find_map(|(name, property)| {
        if matches!(
            normalized_property_name(name).as_str(),
            "due" | "dueat" | "duedate" | "deadline" | "마감" | "마감일" | "기한" | "완료예정일"
        ) {
            property
                .pointer("/date/start")
                .and_then(Value::as_str)
                .map(str::to_owned)
        } else {
            None
        }
    });
    Ok(CardSummary {
        id: id.into(),
        source: "notion".into(),
        title,
        url: url.into(),
        status,
        status_color,
        due_at,
    })
}

fn normalized_property_name(name: &str) -> String {
    name.chars()
        .filter(|c| !c.is_whitespace() && *c != '_' && *c != '-')
        .collect::<String>()
        .to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Read, Write},
        net::TcpListener,
        sync::{Arc, Mutex},
        thread,
    };

    const VIEW: &str = "a3f1b2c4-5678-4def-abcd-1234567890ab";

    #[derive(Clone)]
    struct CapturedRequest {
        method: String,
        target: String,
        headers: String,
        body: String,
    }

    fn mock_server<F>(
        count: usize,
        handler: F,
    ) -> (
        String,
        Arc<Mutex<Vec<CapturedRequest>>>,
        thread::JoinHandle<()>,
    )
    where
        F: Fn(usize, &CapturedRequest) -> (u16, Value) + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let handle = thread::spawn(move || {
            for index in 0..count {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(socket.try_clone().unwrap());
                let mut first = String::new();
                reader.read_line(&mut first).unwrap();
                let mut headers = String::new();
                let mut content_length = 0;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                    if let Some(value) = line.to_lowercase().strip_prefix("content-length:") {
                        content_length = value.trim().parse().unwrap();
                    }
                    headers.push_str(&line.to_lowercase());
                }
                let mut bytes = vec![0; content_length];
                reader.read_exact(&mut bytes).unwrap();
                let mut parts = first.split_whitespace();
                let request = CapturedRequest {
                    method: parts.next().unwrap().into(),
                    target: parts.next().unwrap().into(),
                    headers,
                    body: String::from_utf8(bytes).unwrap(),
                };
                let (status, body) = handler(index, &request);
                captured.lock().unwrap().push(request);
                let body = body.to_string();
                write!(socket, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nRetry-After: 0\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        (format!("http://{address}/v1/"), requests, handle)
    }

    fn test_client(base: &str) -> NotionClient {
        let mut client = NotionClient::new("synthetic-test-token").unwrap();
        client.base_url = Url::parse(base).unwrap();
        client
    }

    fn page(id: &str, title: &str) -> Value {
        json!({"id":id,"url":format!("https://app.notion.com/p/{id}"),"properties": {
            "Name":{"type":"title","title":[{"plain_text":title}]},
            "Status":{"type":"status","status":{"name":"진행 중", "color":"blue"}},
            "Due date":{"type":"date","date":{"start":"2026-11-17"}},
            "Started":{"type":"date","date":{"start":"2026-10-01"}}
        }})
    }

    fn editable_page(kind: &str) -> Value {
        let mut value = page("page-one", "새 릴리스 검토");
        value["parent"] = json!({"type":"data_source_id", "data_source_id":"source-one"});
        value["properties"]
            .as_object_mut()
            .unwrap()
            .remove("Status");
        // Names deliberately differ between the page and schema. The stable ID
        // is already URL encoded and must remain unchanged in the JSON key.
        value["properties"]["옛 상태 이름"] = json!({
            "id":"f%5C%5C%3Ap", "type":kind,
            (kind): {"id":"in-flight", "name":"집중 중 ✨", "color":"blue"}
        });
        value
    }

    fn editable_schema(kind: &str) -> Value {
        json!({"object":"data_source", "id":"source-one", "properties": {
            "진행 상태": {"id":"f%5C%5C%3Ap", "name":"진행 상태", "type":kind,
                (kind): {"default_option":"집중 중 ✨", "options":[
                    {"id":"complete-custom", "name":"검토 끝 ✓", "color":"green"},
                    {"id":"in-flight", "name":"집중 중 ✨", "color":"blue"}
                ]}}
        }})
    }

    #[tokio::test]
    async fn reads_real_status_ids_and_default_without_guessing_the_first_option() {
        let (base, requests, server) = mock_server(2, |index, _| {
            if index == 0 {
                let mut page = editable_page("status");
                page["properties"]["옛 상태 이름"]["status"] = Value::Null;
                (200, page)
            } else {
                (200, editable_schema("status"))
            }
        });
        let editor = test_client(&base).card_status("page-one").await.unwrap();
        server.join().unwrap();
        assert_eq!(editor.card_id, "page-one");
        assert_eq!(editor.fields.len(), 1);
        assert_eq!(editor.fields[0].id, "f%5C%5C%3Ap");
        assert_eq!(editor.fields[0].name, "진행 상태");
        assert_eq!(editor.fields[0].options[0].name, "검토 끝 ✓");
        assert_eq!(
            editor.fields[0].current_option_id.as_deref(),
            Some("in-flight")
        );
        let requests = requests.lock().unwrap();
        assert_eq!(requests[0].target, "/v1/pages/page-one");
        assert_eq!(requests[1].target, "/v1/data_sources/source-one");
        assert!(requests.iter().all(|request| request.method == "GET"));

        let mut page = editable_page("status");
        page["properties"]["옛 상태 이름"]["status"] = Value::Null;
        let mut schema = editable_schema("status");
        schema["properties"]["진행 상태"]["status"]["default_option"] = Value::Null;
        let fields = status_fields_from_schema(&page, &schema).unwrap();
        assert!(fields[0].field.current_option_id.is_none());
    }

    #[tokio::test]
    async fn changes_only_the_validated_status_property_by_existing_option_id() {
        let (base, requests, server) = mock_server(3, |index, _| match index {
            0 => (200, editable_page("status")),
            1 => (200, editable_schema("status")),
            _ => {
                let mut page = editable_page("status");
                page["properties"]["옛 상태 이름"]["status"] = json!({
                    "id":"complete-custom", "name":"검토 끝 ✓", "color":"green"
                });
                (200, page)
            }
        });
        let card = test_client(&base)
            .update_status("page-one", "f%5C%5C%3Ap", "complete-custom")
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(card.status.as_deref(), Some("검토 끝 ✓"));
        assert_eq!(card.status_color.as_deref(), Some("green"));
        let requests = requests.lock().unwrap();
        assert_eq!(requests[2].method, "PATCH");
        assert_eq!(requests[2].target, "/v1/pages/page-one");
        assert_eq!(
            serde_json::from_str::<Value>(&requests[2].body).unwrap(),
            json!({"properties":{"f%5C%5C%3Ap":{"status":{"id":"complete-custom"}}}})
        );
        assert!(requests
            .iter()
            .all(|request| request.headers.contains("notion-version: 2026-03-11")));
    }

    #[tokio::test]
    async fn changing_second_status_preserves_the_displayed_status_color() {
        let (base, _, server) = mock_server(3, |index, _| {
            if index == 1 {
                let mut schema = editable_schema("status");
                schema["properties"]["A-primary"] = json!({
                    "id":"first-status", "name":"A-primary", "type":"status",
                    "status":{"options":[{"id":"primary-value", "name":"주 상태", "color":"red"}]}
                });
                (200, schema)
            } else {
                let mut page = editable_page("status");
                page["properties"]["A-primary"] = json!({
                    "id":"first-status", "type":"status",
                    "status":{"id":"primary-value", "name":"주 상태", "color":"red"}
                });
                if index == 2 {
                    page["properties"]["옛 상태 이름"]["status"] = json!({
                        "id":"complete-custom", "name":"검토 끝 ✓", "color":"green"
                    });
                }
                (200, page)
            }
        });
        let card = test_client(&base)
            .update_status("page-one", "f%5C%5C%3Ap", "complete-custom")
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(card.status.as_deref(), Some("주 상태"));
        assert_eq!(card.status_color.as_deref(), Some("red"));
    }

    #[tokio::test]
    async fn rejects_removed_option_or_property_before_any_patch() {
        for (field_id, option_id) in [("f%5C%5C%3Ap", "deleted"), ("other-field", "in-flight")] {
            let (base, requests, server) = mock_server(2, |index, _| {
                (
                    200,
                    if index == 0 {
                        editable_page("status")
                    } else {
                        editable_schema("status")
                    },
                )
            });
            let error = test_client(&base)
                .update_status("page-one", field_id, option_id)
                .await
                .unwrap_err();
            server.join().unwrap();
            assert!(error.contains("상태 목록을 다시 열어"));
            assert!(requests
                .lock()
                .unwrap()
                .iter()
                .all(|request| request.method == "GET"));
        }
    }

    #[tokio::test]
    async fn changes_semantic_select_only_when_no_native_status_exists() {
        let (base, requests, server) = mock_server(3, |index, _| match index {
            0 => (200, editable_page("select")),
            1 => (200, editable_schema("select")),
            _ => {
                let mut page = editable_page("select");
                page["properties"]["옛 상태 이름"]["select"] =
                    json!({"id":"complete-custom","name":"검토 끝 ✓"});
                // The page can retain an old name; ID matching controls the write.
                (200, page)
            }
        });
        let card = test_client(&base)
            .update_status("page-one", "f%5C%5C%3Ap", "complete-custom")
            .await
            .unwrap();
        assert_eq!(card.status.as_deref(), Some("검토 끝 ✓"));
        assert_eq!(card.status_color.as_deref(), Some("green"));
        server.join().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&requests.lock().unwrap()[2].body).unwrap(),
            json!({"properties":{"f%5C%5C%3Ap":{"select":{"id":"complete-custom"}}}})
        );

        let mut page = editable_page("status");
        let mut schema = editable_schema("status");
        page["properties"]["Status"] = json!({"id":"other", "type":"select", "select":null});
        schema["properties"]["Status"] =
            json!({"id":"other", "type":"select", "select":{"options":[]}});
        assert_eq!(status_fields_from_schema(&page, &schema).unwrap().len(), 1);
        schema["properties"]["진행 상태"]["type"] = json!("select");
        schema["properties"]
            .as_object_mut()
            .unwrap()
            .remove("진행 상태");
        schema["properties"]["Priority"] =
            json!({"id":"other", "type":"select", "select":{"options":[]}});
        schema["properties"]
            .as_object_mut()
            .unwrap()
            .remove("Status");
        assert!(status_fields_from_schema(&page, &schema)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn exposes_multiple_status_fields_and_rejects_schema_page_mismatch() {
        let mut page = editable_page("status");
        let mut schema = editable_schema("status");
        page["properties"]["다른 상태"] = json!({"id":"second", "type":"status", "status":null});
        schema["properties"]["다른 상태"] =
            json!({"id":"second", "name":"다른 상태", "type":"status", "status":{"options":[]}});
        assert_eq!(status_fields_from_schema(&page, &schema).unwrap().len(), 2);
        page["properties"]["다른 상태"]["id"] = json!("changed");
        assert!(status_fields_from_schema(&page, &schema).is_err());
    }

    #[tokio::test]
    async fn schema_read_or_page_write_permission_errors_do_not_leak_remote_bodies() {
        for deny_index in [1, 2] {
            let (base, requests, server) = mock_server(deny_index + 1, move |index, _| {
                if index == deny_index {
                    (
                        403,
                        json!({"message":"private-status-synthetic-test-token"}),
                    )
                } else {
                    (
                        200,
                        if index == 0 {
                            editable_page("status")
                        } else {
                            editable_schema("status")
                        },
                    )
                }
            });
            let error = test_client(&base)
                .update_status("page-one", "f%5C%5C%3Ap", "complete-custom")
                .await
                .unwrap_err();
            server.join().unwrap();
            assert!(!error.contains("private-status"));
            assert!(!error.contains("synthetic-test-token"));
            if deny_index == 1 {
                assert!(error.contains("읽기 권한"));
                assert!(requests
                    .lock()
                    .unwrap()
                    .iter()
                    .all(|request| request.method == "GET"));
            } else {
                assert!(error.contains("콘텐츠 수정 권한"));
            }
        }
    }

    #[tokio::test]
    async fn unconfirmed_patch_response_requires_refresh_instead_of_claiming_rollback() {
        let (base, _, server) = mock_server(3, |index, _| {
            (
                200,
                match index {
                    0 => editable_page("status"),
                    1 => editable_schema("status"),
                    _ => Value::Null,
                },
            )
        });
        let error = test_client(&base)
            .update_status("page-one", "f%5C%5C%3Ap", "complete-custom")
            .await
            .unwrap_err();
        server.join().unwrap();
        assert_eq!(error, WRITE_UNCONFIRMED);
    }

    #[tokio::test]
    async fn confirms_effective_default_and_does_not_replay_an_ambiguous_write() {
        let (base, _, server) = mock_server(3, |index, _| match index {
            0 => (200, editable_page("status")),
            1 => (200, editable_schema("status")),
            _ => {
                let mut page = editable_page("status");
                page["properties"]["옛 상태 이름"]["status"] = Value::Null;
                (200, page)
            }
        });
        let card = test_client(&base)
            .update_status("page-one", "f%5C%5C%3Ap", "in-flight")
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(card.status.as_deref(), Some("집중 중 ✨"));
        assert_eq!(card.status_color.as_deref(), Some("blue"));

        let (base, requests, server) = mock_server(3, |index, _| match index {
            0 => (200, editable_page("status")),
            1 => (200, editable_schema("status")),
            _ => (529, json!({"message":"private-body"})),
        });
        let error = test_client(&base)
            .update_status("page-one", "f%5C%5C%3Ap", "in-flight")
            .await
            .unwrap_err();
        server.join().unwrap();
        assert_eq!(error, WRITE_UNCONFIRMED);
        assert_eq!(
            requests
                .lock()
                .unwrap()
                .iter()
                .filter(|request| request.method == "PATCH")
                .count(),
            1
        );
    }

    #[test]
    fn extracts_cards_without_mistaking_an_arbitrary_date_for_due_date() {
        let mut value = page("page-one", "첫 번째");
        let card = card_from_page(&value).unwrap();
        assert_eq!(card.title, "첫 번째");
        assert_eq!(card.due_at.as_deref(), Some("2026-11-17"));
        assert_eq!(card.status_color.as_deref(), Some("blue"));
        value["properties"]
            .as_object_mut()
            .unwrap()
            .remove("Due date");
        assert!(card_from_page(&value).unwrap().due_at.is_none());
        value["properties"]
            .as_object_mut()
            .unwrap()
            .remove("Status");
        value["properties"]["진행 상태"] =
            json!({"type":"select", "select":{"name":"검토 대기", "color":"orange"}});
        let select_card = card_from_page(&value).unwrap();
        assert_eq!(select_card.status.as_deref(), Some("검토 대기"));
        assert_eq!(select_card.status_color.as_deref(), Some("orange"));
        value["url"] = json!("https://notion.so.attacker.test/p/id");
        assert!(card_from_page(&value).is_err());
    }

    #[tokio::test]
    async fn feed_resolves_null_status_once_per_source_and_preserves_cards_if_schema_fails() {
        for fail_schema in [false, true] {
            let (base, requests, server) = mock_server(5, move |_, request| {
                if request.method == "POST" {
                    (
                        200,
                        json!({"id":"query-one", "results":[{"id":"page-one"},{"id":"page-two"}], "has_more":false, "next_cursor":null}),
                    )
                } else if request.method == "DELETE" {
                    (200, json!({"deleted":true}))
                } else if request.target.starts_with("/v1/data_sources/") {
                    if fail_schema {
                        (403, json!({"message":"private-schema-body"}))
                    } else {
                        (200, editable_schema("status"))
                    }
                } else {
                    let id = request.target.strip_prefix("/v1/pages/").unwrap();
                    let mut page = editable_page("status");
                    page["id"] = json!(id);
                    page["url"] = json!(format!("https://app.notion.com/p/{id}"));
                    page["properties"]["옛 상태 이름"]["status"] = Value::Null;
                    (200, page)
                }
            });
            let snapshot = test_client(&base).fetch(VIEW).await.unwrap();
            server.join().unwrap();
            assert_eq!(snapshot.cards.len(), 2);
            assert_eq!(snapshot.cards[0].id, "page-one");
            assert_eq!(snapshot.cards[1].id, "page-two");
            if fail_schema {
                assert!(snapshot.cards.iter().all(|card| card.status.is_none()));
                assert!(snapshot
                    .cards
                    .iter()
                    .all(|card| card.status_color.is_none()));
                assert_eq!(
                    snapshot.warning.as_deref(),
                    Some("일부 카드의 기본 상태를 확인하지 못했습니다.")
                );
            } else {
                assert!(snapshot
                    .cards
                    .iter()
                    .all(|card| card.status.as_deref() == Some("집중 중 ✨")));
                assert!(snapshot
                    .cards
                    .iter()
                    .all(|card| card.status_color.as_deref() == Some("blue")));
                assert!(snapshot.warning.is_none());
            }
            let requests = requests.lock().unwrap();
            assert_eq!(
                requests
                    .iter()
                    .filter(|request| request.target == "/v1/data_sources/source-one")
                    .count(),
                1
            );
            assert_eq!(requests.last().unwrap().method, "DELETE");
        }
    }

    #[test]
    fn null_native_status_does_not_fall_back_to_select_and_default_requires_matching_id() {
        let mut page = editable_page("status");
        page["properties"]["옛 상태 이름"]["status"] = Value::Null;
        page["properties"]["Status"] = json!({"id":"select-other", "type":"select", "select":{"id":"false-status", "name":"잘못된 대체 상태", "color":"red"}});
        assert!(card_from_page(&page).unwrap().status.is_none());
        assert!(card_from_page(&page).unwrap().status_color.is_none());
        let mut schema = editable_schema("status");
        assert_eq!(
            default_status_option(&page, &schema)
                .unwrap()
                .map(|option| option.name)
                .as_deref(),
            Some("집중 중 ✨")
        );
        schema["properties"]["진행 상태"]["id"] = json!("different-id");
        assert!(default_status_option(&page, &schema).is_err());
        schema["properties"]["진행 상태"]["id"] = json!("f%5C%5C%3Ap");
        schema["properties"]["진행 상태"]["status"]["default_option"] = Value::Null;
        assert!(default_status_option(&page, &schema).unwrap().is_none());
    }

    #[tokio::test]
    async fn wire_uses_saved_view_cursor_hydration_order_and_cleanup() {
        let cursor = "opaque /+= cursor";
        let (base, captured, server) = mock_server(5, move |_, request| {
            if request.method == "POST" {
                (
                    200,
                    json!({"id":"query-one","results":[{"id":"page-one"}],"has_more":true,"next_cursor":cursor,"total_count":2}),
                )
            } else if request.method == "DELETE" {
                (200, json!({"deleted":true}))
            } else if request.target.starts_with("/v1/views/") {
                (
                    200,
                    json!({"results":[{"id":"page-two"}],"has_more":false,"next_cursor":null}),
                )
            } else if request.target == "/v1/pages/page-one" {
                (200, page("page-one", "첫 번째"))
            } else {
                (200, page("page-two", "두 번째"))
            }
        });
        let snapshot = test_client(&base).fetch(VIEW).await.unwrap();
        server.join().unwrap();
        assert_eq!(
            snapshot
                .cards
                .iter()
                .map(|card| card.title.as_str())
                .collect::<Vec<_>>(),
            ["첫 번째", "두 번째"]
        );
        assert!(!snapshot.has_more);
        let requests = captured.lock().unwrap();
        assert_eq!(requests[0].target, format!("/v1/views/{VIEW}/queries"));
        assert_eq!(
            serde_json::from_str::<Value>(&requests[0].body).unwrap(),
            json!({"page_size":20})
        );
        let pagination_url =
            Url::parse(&format!("http://localhost{}", requests[1].target)).unwrap();
        assert_eq!(
            pagination_url
                .query_pairs()
                .find(|(key, _)| key == "start_cursor")
                .unwrap()
                .1,
            cursor
        );
        assert!(requests
            .iter()
            .all(|r| r.headers.contains("notion-version: 2026-03-11")
                && r.headers
                    .contains("authorization: bearer synthetic-test-token")));
        assert_eq!(requests.last().unwrap().method, "DELETE");
    }

    #[tokio::test]
    async fn rate_limit_retries_and_incomplete_results_remain_visible() {
        let (base, _, server) = mock_server(3, |index, _| match index {
            0 => (429, json!({"message":"not echoed"})),
            1 => (
                200,
                json!({"id":"query-one","results":[],"has_more":false,"next_cursor":null,"request_status":{"type":"incomplete"}}),
            ),
            _ => (200, json!({"deleted":true})),
        });
        let snapshot = test_client(&base).fetch(VIEW).await.unwrap();
        server.join().unwrap();
        assert!(snapshot.has_more);
        assert!(snapshot.warning.is_some());
    }

    #[tokio::test]
    async fn permission_errors_are_not_retried_or_leaked() {
        let (base, captured, server) = mock_server(1, |_, _| {
            (403, json!({"message":"private-body-synthetic-test-token"}))
        });
        let error = test_client(&base).fetch(VIEW).await.unwrap_err();
        server.join().unwrap();
        assert_eq!(captured.lock().unwrap().len(), 1);
        assert!(error.contains("권한"));
        assert!(!error.contains("private-body"));
        assert!(!error.contains("synthetic-test-token"));
    }

    #[tokio::test]
    async fn hydrates_only_twenty_cards_and_reports_the_remaining_results() {
        let (base, captured, server) = mock_server(22, |_, request| {
            if request.method == "POST" {
                let results: Vec<_> = (0..25)
                    .map(|index| json!({"id":format!("page-{index}")}))
                    .collect();
                (
                    200,
                    json!({"id":"query-one","results":results,"has_more":false,"next_cursor":null}),
                )
            } else if request.method == "DELETE" {
                (200, json!({"deleted":true}))
            } else {
                let id = request.target.rsplit('/').next().unwrap();
                (200, page(id, id))
            }
        });
        let snapshot = test_client(&base).fetch(VIEW).await.unwrap();
        server.join().unwrap();
        assert_eq!(snapshot.cards.len(), MAX_CARDS);
        assert!(snapshot.has_more);
        assert_eq!(
            captured
                .lock()
                .unwrap()
                .iter()
                .filter(|request| request.method == "GET")
                .count(),
            MAX_CARDS
        );
    }

    #[tokio::test]
    async fn failed_hydration_still_cleans_up_the_query_cache() {
        let (base, captured, server) = mock_server(3, |index, _| match index {
            0 => (
                200,
                json!({"id":"query-one","results":[{"id":"page-one"}],"has_more":false,"next_cursor":null}),
            ),
            1 => (403, json!({"message":"private-body"})),
            _ => (200, json!({"deleted":true})),
        });
        let error = test_client(&base).fetch(VIEW).await.unwrap_err();
        server.join().unwrap();
        assert!(error.contains("권한"));
        assert_eq!(captured.lock().unwrap().last().unwrap().method, "DELETE");
    }
}
