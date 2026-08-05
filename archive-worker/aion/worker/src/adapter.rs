//! A narrow process boundary from Aion transport into reviewed Node handlers.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

use crate::Profile;

/// Safe adapter failures returned to Aion without child output or secrets.
#[derive(Debug, thiserror::Error)]
pub enum AdapterError {
    /// The activity input could not be encoded for the child process.
    #[error("activity `{action}` input could not be encoded")]
    Encode {
        /// The action being invoked.
        action: &'static str,
        /// The JSON encoder error.
        #[source]
        source: serde_json::Error,
    },
    /// The reviewed Node process could not be started.
    #[error("activity `{action}` adapter could not be started")]
    Spawn {
        /// The action being invoked.
        action: &'static str,
        /// The operating-system error.
        #[source]
        source: std::io::Error,
    },
    /// The reviewed adapter refused or failed the request.
    #[error("activity `{action}` adapter exited unsuccessfully")]
    Exit {
        /// The action being invoked.
        action: &'static str,
    },
    /// The adapter did not return JSON.
    #[error("activity `{action}` adapter returned invalid JSON")]
    Decode {
        /// The action being invoked.
        action: &'static str,
        /// The JSON decoder error.
        #[source]
        source: serde_json::Error,
    },
}

/// Filesystem and executable boundaries for the reviewed Node adapters.
#[derive(Clone, Debug)]
pub struct AdapterConfig {
    node_bin: PathBuf,
    repo_root: PathBuf,
    home: PathBuf,
}

impl AdapterConfig {
    /// Validate explicit operator paths before any worker connects.
    ///
    /// # Errors
    ///
    /// Returns an error when a path is relative or its required target is absent.
    pub fn new(node_bin: PathBuf, repo_root: PathBuf, home: PathBuf) -> anyhow::Result<Self> {
        require_absolute_file(&node_bin, "EMAIL_ARCHIVE_NODE_BIN")?;
        require_absolute_directory(&repo_root, "EMAIL_ARCHIVE_REPO_ROOT")?;
        require_absolute_directory(&home, "EMAIL_ARCHIVE_HOME")?;
        for profile in [Profile::Synthetic, Profile::IdentityPreflight] {
            let adapter = repo_root.join(profile.adapter_path());
            require_absolute_file(&adapter, profile.adapter_path())?;
        }
        Ok(Self {
            node_bin,
            repo_root,
            home,
        })
    }

    /// Execute one reviewed adapter with a cleared child environment.
    ///
    /// # Errors
    ///
    /// Returns a safe error that never includes child output or activity input.
    pub fn execute(
        &self,
        profile: Profile,
        action: &'static str,
        input: &Value,
    ) -> Result<Value, AdapterError> {
        let encoded = serde_json::to_string(input)
            .map_err(|source| AdapterError::Encode { action, source })?;
        let mut command = Command::new(&self.node_bin);
        command
            .current_dir(&self.repo_root)
            .env_clear()
            .env("HOME", &self.home)
            .arg(self.repo_root.join(profile.adapter_path()));
        if profile == Profile::Synthetic {
            command.arg(action);
        }
        let output = command
            .arg(encoded)
            .output()
            .map_err(|source| AdapterError::Spawn { action, source })?;
        if !output.status.success() {
            return Err(AdapterError::Exit { action });
        }
        serde_json::from_slice(&output.stdout)
            .map_err(|source| AdapterError::Decode { action, source })
    }
}

fn require_absolute_file(path: &Path, name: &str) -> anyhow::Result<()> {
    if !path.is_absolute() || !path.is_file() {
        anyhow::bail!("`{name}` must identify an existing absolute file");
    }
    Ok(())
}

fn require_absolute_directory(path: &Path, name: &str) -> anyhow::Result<()> {
    if !path.is_absolute() || !path.is_dir() {
        anyhow::bail!("`{name}` must identify an existing absolute directory");
    }
    Ok(())
}
