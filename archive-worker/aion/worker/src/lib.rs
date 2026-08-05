//! Liminal Aion transport for the email archive's reviewed Node activity adapters.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use aion_worker::{ActivityFailure, ActivityRegistry, RedialTiming, WorkerConfig};
use serde_json::Value;

mod adapter;
mod declaration;
mod profile;

use adapter::AdapterConfig;
use declaration::Declaration;
pub use profile::Profile;

/// Start one isolated activity profile and serve until the process is stopped.
///
/// # Errors
///
/// Returns an error for invalid settings, contract drift, registration failure,
/// or a non-recoverable transport failure.
pub fn run(profile: Profile) -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let declaration = Declaration::compile(profile)?;
    declaration.require_complete()?;
    let settings = Settings::from_env(profile)?;
    let registry = build_registry(profile, &declaration, &settings.adapter)?;
    let config = settings.worker_config(profile)?;
    let stop = AtomicBool::new(false);

    tracing::info!(
        task_queue = profile.task_queue(),
        actions = profile.actions().len(),
        endpoint = %settings.endpoint,
        "email archive Aion worker starting"
    );

    aion_worker::serve_with_redial(
        vec![settings.endpoint.clone()],
        &config,
        &registry,
        RedialTiming::new(
            settings.reconnect_initial_backoff,
            settings.reconnect_max_backoff,
        ),
        &stop,
        None,
        || {
            tracing::info!(
                identity = %config.identity,
                task_queue = profile.task_queue(),
                "liminal worker registered; serving reviewed Node adapters"
            );
        },
    )?;
    Ok(())
}

fn build_registry(
    profile: Profile,
    declaration: &Declaration,
    adapter: &Arc<AdapterConfig>,
) -> anyhow::Result<Arc<ActivityRegistry>> {
    let mut registry = ActivityRegistry::new();
    for action in profile.actions() {
        let action = *action;
        let action_adapter = Arc::clone(adapter);
        registry = registry.register_activity_with_descriptor::<Value, Value, _>(
            action,
            declaration.descriptor(action)?,
            move |input, _context| {
                let adapter = Arc::clone(&action_adapter);
                Box::pin(async move {
                    adapter
                        .execute(profile, action, &input)
                        .map_err(|error| ActivityFailure::terminal(error.to_string()))
                })
            },
        )?;
    }
    Ok(Arc::new(registry))
}

struct Settings {
    endpoint: String,
    namespace: String,
    identity_prefix: String,
    max_concurrency: usize,
    reconnect_initial_backoff: Duration,
    reconnect_max_backoff: Duration,
    reconnect_max_attempts: usize,
    adapter: Arc<AdapterConfig>,
}

impl Settings {
    fn from_env(_profile: Profile) -> anyhow::Result<Self> {
        Ok(Self {
            endpoint: require_var("AION_WORKER_ENDPOINT")?,
            namespace: require_var("AION_WORKER_NAMESPACE")?,
            identity_prefix: require_var("AION_WORKER_IDENTITY")?,
            max_concurrency: require_parse("AION_WORKER_CONCURRENCY")?,
            reconnect_initial_backoff: Duration::from_secs_f64(require_parse(
                "AION_RECONNECT_INITIAL_BACKOFF_SECONDS",
            )?),
            reconnect_max_backoff: Duration::from_secs_f64(require_parse(
                "AION_RECONNECT_MAX_BACKOFF_SECONDS",
            )?),
            reconnect_max_attempts: require_parse("AION_RECONNECT_MAX_ATTEMPTS")?,
            adapter: Arc::new(AdapterConfig::new(
                require_path("EMAIL_ARCHIVE_NODE_BIN")?,
                require_path("EMAIL_ARCHIVE_REPO_ROOT")?,
                require_path("EMAIL_ARCHIVE_HOME")?,
            )?),
        })
    }

    fn worker_config(&self, profile: Profile) -> anyhow::Result<WorkerConfig> {
        Ok(WorkerConfig::builder()
            .endpoint("unused-direct-address")
            .namespace(self.namespace.clone())
            .task_queue(profile.task_queue())
            .identity(format!(
                "{}-{}",
                self.identity_prefix,
                profile.identity_suffix()
            ))
            .max_concurrency(self.max_concurrency)
            .reconnect_initial_backoff(self.reconnect_initial_backoff)
            .reconnect_max_backoff(self.reconnect_max_backoff)
            .reconnect_max_attempts(self.reconnect_max_attempts)
            .build()?)
    }
}

fn require_var(name: &str) -> anyhow::Result<String> {
    std::env::var(name)
        .map_err(|_| anyhow::anyhow!("required environment variable `{name}` is not set"))
}

fn require_path(name: &str) -> anyhow::Result<std::path::PathBuf> {
    Ok(std::path::PathBuf::from(require_var(name)?))
}

fn require_parse<T>(name: &str) -> anyhow::Result<T>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display,
{
    let value = require_var(name)?;
    value
        .parse::<T>()
        .map_err(|error| anyhow::anyhow!("environment variable `{name}` is invalid: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{Declaration, Profile};

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    #[test]
    fn every_profile_compiles_and_advertises_every_handler() -> TestResult {
        for profile in [Profile::Synthetic, Profile::IdentityPreflight] {
            let declaration = Declaration::compile(profile)?;
            declaration.require_complete()?;
            for action in profile.actions() {
                assert_eq!(declaration.descriptor(action)?.name, *action);
            }
        }
        Ok(())
    }
}
