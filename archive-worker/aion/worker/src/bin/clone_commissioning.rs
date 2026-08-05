//! Start the disposable-clone archive commissioning worker.

fn main() -> anyhow::Result<()> {
    email_archive_aion_worker::run(email_archive_aion_worker::Profile::CloneCommissioning)
}
