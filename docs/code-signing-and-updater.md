# Windows Code Signing & Tauri Auto-Updater Key Generation

This guide explains how to generate Ed25519 signing keys for Tauri's cryptographic auto-updater (`tauri-plugin-updater`), configure a Windows Authenticode certificate for `.exe` (NSIS) and `.msi` installers, and wire GitHub Actions secrets for `.github/workflows/release.yml`.

---

## 1. Generating Tauri Ed25519 Auto-Updater Keys

Per `security.md` §5 and `non_functional_requirements.md` §5, Tauri verifies an Ed25519 signature on every update bundle before installing it.

Run the following command inside `apps/desktop`:

```powershell
cd E:\GuideLens\apps\desktop
npx @tauri-apps/cli signer generate -w "$env:USERPROFILE\.tauri\guidelens.key"
```

This outputs two files:
1. **Private Key (`~/.tauri/guidelens.key`)** — Keep secret! Store its contents in GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY` (and its password in `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).
2. **Public Key (`~/.tauri/guidelens.key.pub`)** — Copy the base64 public key string into `apps/desktop/src-tauri/tauri.conf.json` under `plugins.updater.pubkey`:
   ```json
   {
     "plugins": {
       "updater": {
         "pubkey": "<BASE64_PUBLIC_KEY_FROM_GUIDELENS_KEY_PUB>",
         "endpoints": [
           "https://github.com/<org>/GuideLens/releases/latest/download/latest.json"
         ],
         "windows": {
           "installMode": "passive"
         }
       }
     }
   }
   ```

---

## 2. Windows Authenticode Certificate (`WINDOWS_CERTIFICATE`)

To prevent Windows Defender SmartScreen prompts on `.msi` and `.exe` installers:

1. Export your OV or EV Authenticode certificate as a `.pfx` file.
2. Base64-encode the `.pfx` file in PowerShell:
   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\certificate.pfx")) | Set-Clipboard
   ```
3. Save the Base64 string as the `WINDOWS_CERTIFICATE` repository secret in GitHub (`Settings -> Secrets and variables -> Actions`), and save the PFX password as `WINDOWS_CERTIFICATE_PASSWORD`.

> **Unsigned / Placeholder Mode:** As specified in `decisions.md` §1, if `WINDOWS_CERTIFICATE` is left unset in GitHub Secrets, `.github/workflows/release.yml` automatically skips `signtool.exe` and produces functional unsigned `.exe` and `.msi` installers for local/testing builds.

---

## 3. Required GitHub Actions Secrets (`release.yml`)

| Secret Name | Required? | Description |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Recommended | Contents of `~/.tauri/guidelens.key` for signing updater bundles and emitting `latest.json`. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Optional | Password protecting `TAURI_SIGNING_PRIVATE_KEY` (empty string if generated without password). |
| `WINDOWS_CERTIFICATE` | Optional (placeholder supported) | Base64-encoded `.pfx` Authenticode certificate. |
| `WINDOWS_CERTIFICATE_PASSWORD` | Optional (placeholder supported) | Password for `WINDOWS_CERTIFICATE`. |

---

## 4. Triggering a Release (`v*.*.*`)

1. Bump the version in `apps/desktop/package.json`, `apps/desktop/src-tauri/Cargo.toml`, and `apps/desktop/src-tauri/tauri.conf.json`.
2. Tag and push:
   ```powershell
   git tag v1.0.0
   git push origin v1.0.0
   ```
3. `.github/workflows/release.yml` will:
   - Run the IoU visual accuracy benchmark self-test (`benchmarks/run_benchmark.py --validate-only`).
   - Run `tsc`, `vitest`, `cargo clippy -- -D warnings`, and `cargo test`.
   - Build both **NSIS (`*-setup.exe`)** and **MSI (`*.msi`)** bundles via `tauri-apps/tauri-action@v0`.
   - Sign installers with `signtool.exe` (SHA-256 + DigiCert RFC3161 timestamp) when `WINDOWS_CERTIFICATE` is configured.
   - Sign updater bundles with `TAURI_SIGNING_PRIVATE_KEY` and publish `latest.json` to GitHub Releases.
