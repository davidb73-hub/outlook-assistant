//! Start the deterministic synthetic archive-cycle worker.

fn main() -> anyhow::Result<()> {
    email_archive_aion_worker::run(email_archive_aion_worker::Profile::Synthetic)
}
