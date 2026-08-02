---
description: "Reference: Secrets — keep them out of the repo; when they must be in it, SOPS+age, always"
---

# Reference: Security and Secrets

Two rules, in this order. The first one settles most cases.

## 1. Default — the secret does not enter the repository

A secret that was never committed cannot leak, cannot be scraped out of git
history, and does not depend on a key staying safe. Prefer this every time.

| Kind of secret | Where it lives |
|:--|:--|
| Personal API keys, tokens | `~/.secrets/secrets.enc.yaml` — age-encrypted, outside every repo, delivered by `~/Projects/.envrc`. Never a value in a repo, and never exported from `.zshrc` (a shell-wide export is inherited by every child process, including every `npm install` hook) |
| Per-project runtime config | `.env` / `.envrc` — **gitignored**, with a committed `.env.example` carrying the *names* and empty values |
| CI credentials | the CI provider's own secret store |
| Cloud / cluster credentials | the provider's keychain, `~/.kube/config`, `~/.aws/` — never copied in |
| Agent access tokens (identity-gated apps) | minted on demand by `scripts/agent-token.sh` into a gitignored, mode-600 `.agent-token`; the client secret is SOPS-only. See mac-setup's `projects/claude-code.md` § Service-account tokens |

If a repo has no `.gitignore` entry for `.env`, `.envrc` and `*.key`, add one
before writing anything that could land there.

## 2. Exception — when a secret genuinely must be versioned with the code

Some secrets have to sit beside what consumes them: Kubernetes `Secret`
manifests, Helm values, CI pipeline config, a deploy-time compose file. For
those, and **only** those, the answer is always **SOPS + age**. Never plaintext,
never base64 (`base64` is encoding, not encryption — a base64 secret in git is a
plaintext secret in git), and never a hand-rolled scheme.

### Setup, once per repo

`.sops.yaml` at the repo root declares which files get encrypted and to which
recipient. Copy it from mac-setup — do not write one from memory:

```bash
cp ~/Projects/Github/lukaskellerstein/mac-setup/projects/templates/sops.yaml .sops.yaml
```

The private key is `~/.config/sops/age/keys.txt` and is never in any repo.

> [!warning]
> On macOS sops does **not** look there. Its default is
> `~/Library/Application Support/sops/age/keys.txt`, so decryption needs
> `SOPS_AGE_KEY_FILE=$HOME/.config/sops/age/keys.txt` in the environment —
> exported from `.zshrc` on this machine, and a required CI variable elsewhere.
> Encrypting works without it; only decrypting fails, so the symptom shows up
> later and somewhere else. `failed to load age identities` is this and nothing
> more sinister.

### Naming

Encrypted files carry an `.enc.` infix — `secrets.enc.yaml`,
`values.enc.yaml`. It is what `.sops.yaml`'s `path_regex` matches, and it makes
an encrypted file obvious in review.

### Working with them

| Task | Command |
|:--|:--|
| Create / edit | `sops edit secrets.enc.yaml` — decrypts to a temp file, re-encrypts on save |
| Encrypt an existing plaintext file | `sops -e -i secrets.enc.yaml`, then verify it changed |
| Read one value | `sops -d --extract '["db"]["password"]' secrets.enc.yaml` |
| Run something with the values as env | `sops exec-env env.enc.yaml 'the-command'` |
| Apply to a cluster | `sops -d secrets.enc.yaml \| kubectl apply -f -` |

`sops exec-env` and the pipe form exist so the decrypted content never touches
the disk. Prefer them.

`exec-env` only accepts a **flat** map — one level of `KEY: value`. A nested file
fails with `cannot use complex value in environment; offending key <name>`. Keep
env-shaped secrets in their own flat `env.enc.yaml` rather than nesting them
under a heading, and use `-d --extract` for structured files.

## Never

- **Never `sops -d file > file.plain`.** It writes plaintext next to an encrypted
  file, and that is how it gets committed. Use `sops edit`, `exec-env`, or a pipe.
- **Never commit a decrypted file.** If one exists after debugging, delete it,
  then check `git status` before reporting.
- **Never reformat an encrypted file.** SOPS stores a MAC over the values;
  reindenting or reordering invalidates it and the file stops decrypting —
  a corruption that only surfaces at deploy time. If a formatter or a
  pre-commit hook touches `*.enc.*`, exclude it.
- **Never commit `keys.txt`, `*.agekey`, or any age private key**, and never
  paste one into a chat, an issue or a log.
- **Never print a decrypted secret** into terminal output, a commit message, a
  log line or a test fixture. Report *that* a value was read, not the value.
- **Never keep a plaintext credential file, gitignored or not.** A
  `claude_tokens.md`-style file at the repo root dodges every control above —
  every session and tool can read it, and it never expires. Mint short-lived
  tokens on demand instead (`scripts/agent-token.sh` → `.agent-token`), and
  treat an existing plaintext credential file as a found secret: report it,
  move the value into SOPS, delete the file, recommend rotation.
- **Never invent an alternative** — no `openssl enc`, no git-crypt, no committed
  encrypted zip. One scheme per machine is what makes it reviewable.

## When you find a secret already committed

Say so immediately and stop. Rotating the credential at the provider comes
first — history rewriting is secondary and never sufficient on its own, because
the value is already in every clone and on every forge that mirrored it.
Do not rewrite history without being asked.

The contract behind this file is `projects/claude-code.md` in mac-setup.
