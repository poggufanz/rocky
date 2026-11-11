//! Reads the JSON records that Node writes under the Rocky home.
//!
//! The daemon only reads these; it never writes an agent config. Unknown
//! fields are ignored, and a record that is missing, malformed, or of another
//! version reads as absent.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use rocky_proto::paths::{binaries_record_path, cli_record_path, consent_path, expected_path};
use rocky_proto::pipe::ConsentState;
use serde::Deserialize;
use serde::de::DeserializeOwned;

/// The only record version these readers accept.
const RECORD_VERSION: u32 = 1;

/// Files the guard expects to keep Rocky's snippets, as Node last wrote them.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Expected {
    pub files: Vec<ExpectedFile>,
}

/// One guarded file and the byte snippets it must contain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpectedFile {
    pub path: PathBuf,
    pub snippets: Vec<String>,
}

/// The owner's consent and every config location the record names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsentView {
    pub state: ConsentState,
    /// `(harness, location)` pairs. Entries with an empty location are skipped.
    pub locations: BTreeSet<(String, String)>,
}

/// Where Node recorded the global CLI: its node binary and entry script.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliRecord {
    pub node: PathBuf,
    pub entry: PathBuf,
    pub version: String,
}

// `history` is not listed here, so serde skips it.
#[derive(Deserialize)]
struct RawExpected {
    v: u32,
    files: Vec<RawExpectedFile>,
}

#[derive(Deserialize)]
struct RawExpectedFile {
    path: String,
    snippets: Vec<String>,
}

#[derive(Deserialize)]
struct RawConsent {
    v: u32,
    state: ConsentState,
    config_dirs: BTreeMap<String, Vec<RawLocation>>,
}

#[derive(Deserialize)]
struct RawLocation {
    location: String,
}

#[derive(Deserialize)]
struct RawCli {
    v: u32,
    node: String,
    entry: String,
    version: String,
}

#[derive(Deserialize)]
struct RawBinaries {
    v: u32,
    version: String,
}

/// Reads `expected.json`. A missing, malformed, or other-version file gives no files.
pub fn read_expected(home: &Path) -> Expected {
    let files = match read_record::<RawExpected>(&expected_path(home)) {
        Some(raw) if raw.v == RECORD_VERSION => raw
            .files
            .into_iter()
            .map(|file| ExpectedFile {
                path: PathBuf::from(file.path),
                snippets: file.snippets,
            })
            .collect(),
        _ => Vec::new(),
    };
    Expected { files }
}

/// Reads `consent.json`. A missing file is `None`. An unreadable or malformed
/// file, another version, or a state Node never writes is `Invalid`.
pub fn read_consent(home: &Path) -> ConsentView {
    let bytes = match fs::read(consent_path(home)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return ConsentView {
                state: ConsentState::None,
                locations: BTreeSet::new(),
            };
        }
        Err(_) => return invalid_consent(),
    };
    let raw = match serde_json::from_slice::<RawConsent>(&bytes) {
        Ok(raw) if raw.v == RECORD_VERSION => raw,
        _ => return invalid_consent(),
    };
    let state = match raw.state {
        state @ (ConsentState::Approved | ConsentState::Later | ConsentState::Removed) => state,
        ConsentState::None | ConsentState::Invalid => return invalid_consent(),
    };
    ConsentView {
        state,
        locations: locations_of(raw.config_dirs),
    }
}

fn invalid_consent() -> ConsentView {
    ConsentView {
        state: ConsentState::Invalid,
        locations: BTreeSet::new(),
    }
}

fn locations_of(config_dirs: BTreeMap<String, Vec<RawLocation>>) -> BTreeSet<(String, String)> {
    config_dirs
        .into_iter()
        .flat_map(|(harness, dirs)| {
            dirs.into_iter()
                .filter(|dir| !dir.location.is_empty())
                .map(move |dir| (harness.clone(), dir.location))
        })
        .collect()
}

/// Reads `cli.json`. Requires version 1.
pub fn read_cli(home: &Path) -> Option<CliRecord> {
    let raw: RawCli = read_record(&cli_record_path(home))?;
    (raw.v == RECORD_VERSION).then(|| CliRecord {
        node: PathBuf::from(raw.node),
        entry: PathBuf::from(raw.entry),
        version: raw.version,
    })
}

/// Reads the installed binaries' version from `binaries.json`. Requires version 1.
pub fn read_bin_version(home: &Path) -> Option<String> {
    let raw: RawBinaries = read_record(&binaries_record_path(home))?;
    (raw.v == RECORD_VERSION).then_some(raw.version)
}

/// Checks the CLI record's node binary and entry script. Names the first path
/// that is not a regular file.
pub fn cli_status(cli: Option<&CliRecord>) -> (bool, Option<String>) {
    let Some(cli) = cli else {
        return (false, None);
    };
    if !is_regular_file(&cli.node) {
        return (false, Some(cli.node.display().to_string()));
    }
    if !is_regular_file(&cli.entry) {
        return (false, Some(cli.entry.display().to_string()));
    }
    (true, None)
}

/// Follows symlinks, since `metadata` resolves them.
fn is_regular_file(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|meta| meta.is_file())
}

/// Parses one record file. A read or parse failure reads as `None`.
fn read_record<T: DeserializeOwned>(path: &Path) -> Option<T> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::*;

    fn write(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    fn consent_json(state: &str, config_dirs: &str) -> String {
        format!(
            r#"{{"v":1,"scope":1,"state":"{state}","at":1,"harness_off":[],"shell_hook":false,"config_dirs":{config_dirs}}}"#
        )
    }

    #[test]
    fn read_expected_tolerates_missing_and_malformed() {
        let home = TempDir::new().unwrap();
        let path = expected_path(home.path());

        assert_eq!(read_expected(home.path()), Expected::default());

        write(&path, "{");
        assert_eq!(read_expected(home.path()), Expected::default());

        write(
            &path,
            r#"{"v":2,"files":[{"path":"/a","snippets":["x"]}],"history":{}}"#,
        );
        assert_eq!(read_expected(home.path()), Expected::default());

        write(
            &path,
            r#"{"v":1,"files":[{"path":"/a/settings.json","snippets":["one"]},{"path":"/b/config.toml","snippets":["two","three"]}],"history":{"/a/settings.json":["old"]}}"#,
        );
        assert_eq!(
            read_expected(home.path()),
            Expected {
                files: vec![
                    ExpectedFile {
                        path: PathBuf::from("/a/settings.json"),
                        snippets: vec!["one".to_string()],
                    },
                    ExpectedFile {
                        path: PathBuf::from("/b/config.toml"),
                        snippets: vec!["two".to_string(), "three".to_string()],
                    },
                ],
            }
        );
    }

    #[test]
    fn read_consent_maps_states_and_locations() {
        let home = TempDir::new().unwrap();
        let path = consent_path(home.path());
        let invalid = ConsentView {
            state: ConsentState::Invalid,
            locations: BTreeSet::new(),
        };

        assert_eq!(
            read_consent(home.path()),
            ConsentView {
                state: ConsentState::None,
                locations: BTreeSet::new(),
            }
        );

        write(
            &path,
            &consent_json("approved", r#"{"codex":[{"location":"/x","last_seen":1}]}"#),
        );
        assert_eq!(
            read_consent(home.path()),
            ConsentView {
                state: ConsentState::Approved,
                locations: BTreeSet::from([("codex".to_string(), "/x".to_string())]),
            }
        );

        write(&path, &consent_json("later", "{}"));
        assert_eq!(read_consent(home.path()).state, ConsentState::Later);

        write(&path, &consent_json("removed", "{}"));
        assert_eq!(read_consent(home.path()).state, ConsentState::Removed);

        write(&path, r#"{"v":1,"state":"odd","config_dirs":{}}"#);
        assert_eq!(read_consent(home.path()), invalid);

        write(&path, &consent_json("none", "{}"));
        assert_eq!(read_consent(home.path()), invalid);

        write(&path, "{");
        assert_eq!(read_consent(home.path()), invalid);

        write(&path, r#"{"v":2,"state":"approved","config_dirs":{}}"#);
        assert_eq!(read_consent(home.path()), invalid);

        write(
            &path,
            &consent_json(
                "approved",
                r#"{"codex":[{"location":"","last_seen":1},{"location":"/y","last_seen":2}]}"#,
            ),
        );
        assert_eq!(
            read_consent(home.path()).locations,
            BTreeSet::from([("codex".to_string(), "/y".to_string())])
        );
    }

    #[test]
    fn read_cli_and_bin_version_require_version_one() {
        let home = TempDir::new().unwrap();
        let cli_path = cli_record_path(home.path());
        let bin_path = binaries_record_path(home.path());
        assert_eq!(read_cli(home.path()), None);
        assert_eq!(read_bin_version(home.path()), None);

        write(
            &cli_path,
            r#"{"v":1,"node":"/n/node","entry":"/n/index.js","version":"1.2.3"}"#,
        );
        assert_eq!(
            read_cli(home.path()),
            Some(CliRecord {
                node: PathBuf::from("/n/node"),
                entry: PathBuf::from("/n/index.js"),
                version: "1.2.3".to_string(),
            })
        );
        write(
            &cli_path,
            r#"{"v":2,"node":"/n/node","entry":"/n/index.js","version":"1.2.3"}"#,
        );
        assert_eq!(read_cli(home.path()), None);

        write(&bin_path, r#"{"v":1,"version":"1.2.3"}"#);
        assert_eq!(read_bin_version(home.path()), Some("1.2.3".to_string()));
        write(&bin_path, r#"{"v":2,"version":"1.2.3"}"#);
        assert_eq!(read_bin_version(home.path()), None);
    }

    #[test]
    fn cli_status_names_the_missing_path() {
        let home = TempDir::new().unwrap();
        let node = home.path().join("node.exe");
        let entry = home.path().join("node_modules").join("index.js");
        write(&entry, "");
        let cli = CliRecord {
            node: node.clone(),
            entry: entry.clone(),
            version: "1.2.3".to_string(),
        };

        assert_eq!(cli_status(None), (false, None));
        assert_eq!(
            cli_status(Some(&cli)),
            (false, Some(node.display().to_string()))
        );

        write(&node, "");
        assert_eq!(cli_status(Some(&cli)), (true, None));

        fs::remove_file(&entry).unwrap();
        assert_eq!(
            cli_status(Some(&cli)),
            (false, Some(entry.display().to_string()))
        );

        fs::create_dir(&entry).unwrap();
        assert_eq!(
            cli_status(Some(&cli)),
            (false, Some(entry.display().to_string()))
        );
    }
}
