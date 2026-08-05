//! Start the provider-profile-only identity preflight worker.

fn main() -> anyhow::Result<()> {
    email_archive_aion_worker::run(email_archive_aion_worker::Profile::IdentityPreflight)
}
