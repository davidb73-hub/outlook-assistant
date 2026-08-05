//! Compile embedded AWL documents into the exact descriptors workers advertise.

use std::path::Path;

use aion_package::{ActivityDescriptor, PackageContract, WorkerContract};

use crate::Profile;

const DOCUMENT_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/..");

/// A startup refusal caused by drift between an AWL document and its worker.
#[derive(Debug, thiserror::Error)]
pub enum DeclarationError {
    /// The embedded AWL document does not compile.
    #[error("the embedded AWL document does not compile: {reason}")]
    Compile {
        /// The compiler diagnostic.
        reason: String,
    },
    /// The expected queue is absent from the compiled contract.
    #[error("the document declares no worker queue `{queue}`; declared: [{declared}]")]
    NoSuchWorker {
        /// The required queue.
        queue: &'static str,
        /// The queues the document actually declares.
        declared: String,
    },
    /// The worker attempts to serve an undeclared action.
    #[error("action `{action}` is not declared on queue `{queue}`; declared: [{declared}]")]
    UndeclaredAction {
        /// The requested action.
        action: String,
        /// The selected queue.
        queue: &'static str,
        /// The actions the document actually declares.
        declared: String,
    },
    /// This package does not support node-pinned archive actions.
    #[error(
        "action `{action}` is pinned to node `{node}`; this worker serves only unpinned actions"
    )]
    PinnedAction {
        /// The pinned action.
        action: String,
        /// The authored node pin.
        node: String,
    },
    /// At least one required action has no handler.
    #[error("queue `{queue}` has unserved bodyless action(s): {missing}")]
    Unserved {
        /// The selected queue.
        queue: &'static str,
        /// The missing actions.
        missing: String,
    },
}

/// The selected worker contract compiled from one embedded AWL document.
#[derive(Clone, Debug)]
pub struct Declaration {
    profile: Profile,
    contract: WorkerContract,
}

impl Declaration {
    /// Compile one profile and select its required worker queue.
    ///
    /// # Errors
    ///
    /// Returns a typed startup refusal when the document is invalid or the queue
    /// is absent.
    pub fn compile(profile: Profile) -> Result<Self, DeclarationError> {
        let compiled =
            aion_awl::compile(profile.document(), Path::new(DOCUMENT_DIR)).map_err(|error| {
                DeclarationError::Compile {
                    reason: error.to_string(),
                }
            })?;
        Ok(Self {
            profile,
            contract: select_worker(compiled.contract, profile)?,
        })
    }

    /// Return an action's exact AWL-derived wire descriptor.
    ///
    /// # Errors
    ///
    /// Returns a typed refusal for an undeclared or node-pinned action.
    pub fn descriptor(&self, action: &str) -> Result<ActivityDescriptor, DeclarationError> {
        let declared = self
            .contract
            .actions
            .iter()
            .find(|candidate| candidate.name == action)
            .ok_or_else(|| DeclarationError::UndeclaredAction {
                action: action.to_owned(),
                queue: self.profile.task_queue(),
                declared: self.action_names(),
            })?;
        if let Some(node) = declared.node.as_deref() {
            return Err(DeclarationError::PinnedAction {
                action: action.to_owned(),
                node: node.to_owned(),
            });
        }
        Ok(ActivityDescriptor {
            name: declared.name.clone(),
            input_schema: declared.input_schema.clone(),
            output_schema: declared.output_schema.clone(),
        })
    }

    /// Prove every bodyless declared action has a reviewed handler.
    ///
    /// # Errors
    ///
    /// Returns a typed refusal naming every unserved action.
    pub fn require_complete(&self) -> Result<(), DeclarationError> {
        let missing = self
            .contract
            .actions
            .iter()
            .filter(|action| action.body.is_none())
            .filter(|action| !self.profile.actions().contains(&action.name.as_str()))
            .map(|action| format!("`{}`", action.name))
            .collect::<Vec<_>>();
        if missing.is_empty() {
            return Ok(());
        }
        Err(DeclarationError::Unserved {
            queue: self.profile.task_queue(),
            missing: missing.join(", "),
        })
    }

    fn action_names(&self) -> String {
        self.contract
            .actions
            .iter()
            .map(|action| format!("`{}`", action.name))
            .collect::<Vec<_>>()
            .join(", ")
    }
}

fn select_worker(
    contract: PackageContract,
    profile: Profile,
) -> Result<WorkerContract, DeclarationError> {
    let declared = contract
        .workers
        .iter()
        .map(|worker| format!("`{}`", worker.task_queue))
        .collect::<Vec<_>>()
        .join(", ");
    contract
        .workers
        .into_iter()
        .find(|worker| worker.task_queue == profile.task_queue())
        .ok_or(DeclarationError::NoSuchWorker {
            queue: profile.task_queue(),
            declared,
        })
}
