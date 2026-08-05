//! The two deliberately isolated activity surfaces served by this package.

/// Which reviewed Aion activity surface one worker process serves.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Profile {
    /// Deterministic handlers that cannot access external state.
    Synthetic,
    /// Provider-profile reads with no archive or credential persistence.
    IdentityPreflight,
}

const SYNTHETIC_ACTIONS: &[&str] = &[
    "check_identity",
    "assess_identities",
    "synchronize",
    "reconcile",
    "verify_integrity",
    "create_backup",
    "summarize_success",
    "summarize_failure",
];

const IDENTITY_PREFLIGHT_ACTIONS: &[&str] = &["audit_identity_bindings"];

const SYNTHETIC_DOCUMENT: &str = include_str!("../../three_account_archive_cycle.awl");
const IDENTITY_PREFLIGHT_DOCUMENT: &str =
    include_str!("../../email_archive_identity_preflight.awl");

impl Profile {
    /// The embedded AWL source used for both deployment and worker descriptors.
    #[must_use]
    pub const fn document(self) -> &'static str {
        match self {
            Self::Synthetic => SYNTHETIC_DOCUMENT,
            Self::IdentityPreflight => IDENTITY_PREFLIGHT_DOCUMENT,
        }
    }

    /// The AWL worker-block name, which is the Aion task queue.
    #[must_use]
    pub const fn task_queue(self) -> &'static str {
        match self {
            Self::Synthetic => "archive_ops",
            Self::IdentityPreflight => "email_archive_identity_preflight",
        }
    }

    /// Every activity this profile must serve.
    #[must_use]
    pub const fn actions(self) -> &'static [&'static str] {
        match self {
            Self::Synthetic => SYNTHETIC_ACTIONS,
            Self::IdentityPreflight => IDENTITY_PREFLIGHT_ACTIONS,
        }
    }

    /// The reviewed Node adapter, relative to the email repository root.
    #[must_use]
    pub const fn adapter_path(self) -> &'static str {
        match self {
            Self::Synthetic => "archive-worker/aion/synthetic-action.js",
            Self::IdentityPreflight => "archive-worker/aion/identity-preflight-action.js",
        }
    }

    /// A stable suffix that distinguishes worker identities in operations.
    #[must_use]
    pub const fn identity_suffix(self) -> &'static str {
        match self {
            Self::Synthetic => "synthetic",
            Self::IdentityPreflight => "identity-preflight",
        }
    }
}
