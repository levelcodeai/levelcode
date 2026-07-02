# Security Policy

Atom++ is built to keep your code and your credentials on your machine.

## The model (and why it's a feature)

- **No Atom++ backend for AI.** AI requests go **directly** from your machine to the model provider you
  choose. Atom++ runs no inference proxy and never sees your prompts, code, or responses.
- **Bring-your-own-key.** Provider API keys are stored in your **OS keychain** (VS Code SecretStorage),
  one per provider — never in plaintext files, never committed, and **never synced** by Settings Sync.
- **No key leaks to untrusted hosts.** For a custom OpenAI-compatible endpoint, Atom++ refuses to send
  your API key over plaintext `http://` to a non-local host (https, or an explicit localhost, only).
- **Readable.** The AI layer is plain, dependency-free JS — you can see exactly what is sent to a
  provider. Transparency is a design goal, not an afterthought.

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue.

- Preferred: **GitHub → the "Security" tab → "Report a vulnerability"** (a private advisory on this repo).
- Or email **security@atompp.ai**.

Include steps to reproduce and the impact you see. We aim to acknowledge within a few days and will keep
you posted through the fix.

## Scope

- **In scope:** the Atom++ first-party extensions and the build / branding kit in this repository.
- **Out of scope:** upstream Code-OSS / VS Code itself (report those to Microsoft), and third-party
  extensions you install from Open VSX.
