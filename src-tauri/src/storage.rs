use crate::model::{AppConfig, FeedSnapshot};
use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::Path};

const KEYRING_SERVICE: &str = "app.card-captor";
const KEYRING_USER: &str = "notion";

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Store {
    pub config: AppConfig,
    pub snapshot: Option<FeedSnapshot>,
}

impl Store {
    /// `path` is the app's state file, not a directory. Credentials are never serialized.
    pub fn load(path: &Path) -> Result<Self, String> {
        match fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|_| "저장된 설정을 읽을 수 없습니다. 설정 파일을 확인해 주세요.".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(_) => Err("설정 파일에 접근할 수 없습니다.".into()),
        }
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        fs::create_dir_all(parent).map_err(|_| "설정 폴더를 만들 수 없습니다.".to_string())?;
        let bytes = serde_json::to_vec_pretty(self)
            .map_err(|_| "설정을 저장할 수 없습니다.".to_string())?;
        // Same-directory replace keeps the previous complete snapshot on write failure.
        // tempfile uses private permissions and supports atomic replacement on Windows too.
        let mut temporary = tempfile::NamedTempFile::new_in(parent)
            .map_err(|_| "설정 임시 파일을 만들 수 없습니다.".to_string())?;
        temporary
            .write_all(&bytes)
            .map_err(|_| "설정 파일을 쓸 수 없습니다.".to_string())?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|_| "설정 파일을 저장할 수 없습니다.".to_string())?;
        temporary
            .persist(path)
            .map_err(|_| "설정 파일을 교체할 수 없습니다.".to_string())?;
        Ok(())
    }
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|_| {
        "OS 보안 저장소에 접근할 수 없습니다. Keychain 또는 자격 증명 관리자를 확인해 주세요."
            .into()
    })
}

pub fn get_token() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("OS 보안 저장소에서 Notion 토큰을 읽을 수 없습니다.".into()),
    }
}

pub fn set_token(token: &str) -> Result<(), String> {
    if token.trim().is_empty() {
        return Err("Notion 토큰을 입력해 주세요.".into());
    }
    entry()?
        .set_password(token.trim())
        .map_err(|_| "OS 보안 저장소에 Notion 토큰을 저장하지 못했습니다.".into())
}

pub fn delete_token() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("OS 보안 저장소에서 Notion 토큰을 삭제하지 못했습니다.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_roundtrip_replaces_existing_file_and_keeps_credentials_out() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/config.json");
        let mut store = Store::load(&path).unwrap();
        assert_eq!(store.config.refresh_seconds, 60);
        store.config.view_id = "a3f1b2c4-5678-4def-abcd-1234567890ab".into();
        store.save(&path).unwrap();
        store.config.refresh_seconds = 120;
        store.save(&path).unwrap();
        assert_eq!(Store::load(&path).unwrap().config.refresh_seconds, 120);
        let value: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert!(value.get("token").is_none());
        assert!(value.get("hasToken").is_none());
    }

    #[test]
    fn corrupted_state_is_reported_without_echoing_private_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        fs::write(&path, "private-title-not-valid-json").unwrap();
        let error = Store::load(&path).unwrap_err();
        assert!(!error.contains("private-title"));
    }
}
