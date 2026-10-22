# Privacy

MOTIF Studio is local-first.
- **No telemetry.** The app sends no analytics or crash reports. Crash logs stay in your profile folder (`logs/`), and the diagnostic bundle is only written to a file you choose.
- **Local AI.** Auto captions (Whisper), text-to-speech, stabilization and noise reduction run on your computer. Your media is never uploaded for AI processing.
- **Cloud is opt-in.** Only when you sign in and press Upload/Sync are the project manifest and its media sent to the MOTIF Cloud server you configured. Manifests never contain your local file paths.
- **Credentials.** Passwords are stored as scrypt hashes; session tokens are stored server-side only as SHA-256 hashes and on your computer encrypted with the OS keychain.
- **Deletion.** Deleting a cloud project hides it immediately; account deletion removes your workspaces, projects and media objects.
- **Payments** are processed by Stripe; MOTIF never sees card numbers.
