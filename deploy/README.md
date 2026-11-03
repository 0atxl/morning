# Azure VM deployment

The [Build and deploy workflow](../.github/workflows/deploy.yml) builds the exact pushed commit on a GitHub-hosted runner, then sends its Go linux/amd64 binary and Vite assets to the VM through Tailscale and verified OpenSSH. One live URL, `https://morning.atuls.me`, serves the latest successful release from `main`.

This workflow runs no test suites, browser checks or provider probes. Go compilation, TypeScript checking and Vite compilation are build steps. npm installation disables lifecycle scripts; the workflow invokes the compiler and Vite directly, so `prebuild`, `postbuild` and test scripts cannot run implicitly. Backend tests stay in the separate, manually dispatched workflow and require approval for every run.

## First-release requirements

Commit `web/package.json`, `web/package-lock.json`, `web/index.html` and the web source before releasing. The workflow records a skip when the frontend is absent from the requested commit. Uncommitted files on a developer's machine never enter the build. The frontend must render the landing page at `/` and the guest dashboard at `/app`; nginx supplies the SPA fallback for direct visits and refreshes.

The Go backend currently uses only the standard library. The build disables module downloads. If external Go dependencies are added, review dependency installation before changing that setting.

## Configure the VM once

Use an administrator's existing, verified SSH connection. The bootstrap targets Debian 13 amd64 with Python 3.12 or newer, systemd and Tailscale already installed. It installs nginx if necessary. Copy the `deploy/` directory to the VM without provider credentials or private keys.

Generate a dedicated Ed25519 SSH key on a trusted machine, outside the repository. Store its private key directly in the GitHub `production` environment secret `MORNING_DEPLOY_SSH_KEY`. Supply only its public key to bootstrap:

```bash
sudo bash deploy/bootstrap.sh /path/to/morning-deploy.pub
sudoedit /etc/morning/server.env
```

Fill `DEEPGRAM_API_KEY` and `GROQ_API_KEY` in that VM file. Keep `LISTEN_ADDR=127.0.0.1:8080`. The file is `root:morning`, mode `0640`, and is read by systemd. It is never copied into a release, GitHub artifact or frontend environment. Do not paste keys into chat or shell commands.

Bootstrap creates the unprivileged `morning` API account and a separate `morning-deploy` account. The deploy key can only invoke the root-owned release receiver. Port forwarding, PTYs and arbitrary SSH commands are disabled. Its only sudo permission restarts the root-owned API unit, which executes the app as `morning`.

Both services start at boot. nginx listens only on `127.0.0.1:80`, serves the compiled frontend and forwards `/api/*` to `127.0.0.1:8080`. Keep the Cloudflare Tunnel published route for `morning.atuls.me` pointed at `http://127.0.0.1:80`. No public VM application port is needed. For a loopback peer, Go uses the `CF-Connecting-IP` header set by Cloudflare and forwarded by nginx to limit each visitor separately. Direct non-loopback requests cannot override their identity with that header, and `X-Forwarded-For` is ignored. Keep both origin listeners private; another public proxy must sanitize the client address before using this setup. The global request cap still applies across visitors.

## Give GitHub runners restricted tailnet access

In [Tailscale access controls](https://login.tailscale.com/admin/acls), add the tag owner and a grant below to the existing policy. Replace the sample address with the VM's Tailscale IPv4 address. Preserve administrator access. Narrow any existing wildcard source grant that would also give tagged runners access to other devices; adding a narrow grant does not override a broader allow rule.

```json
{
  "tagOwners": {"tag:morning-deploy": ["autogroup:admin"]},
  "grants": [
    {"src": ["tag:morning-deploy"], "dst": ["100.x.y.z"], "ip": ["tcp:22"]}
  ]
}
```

This connection uses the VM's normal OpenSSH service, not Tailscale SSH. In [Tailscale trust credentials](https://login.tailscale.com/admin/settings/oauth), create an OAuth client with only writable `auth_keys` access and the `tag:morning-deploy` tag. Put the generated client ID and secret directly into the GitHub `production` environment secrets `TS_OAUTH_CLIENT_ID` and `TS_OAUTH_SECRET`. The official [Tailscale action](https://github.com/tailscale/github-action) creates an ephemeral runner identity and removes it when the job ends.

## GitHub settings

Open [repository environments](https://github.com/0atxl/morning/settings/environments) and create `production`. Limit deployment branches to `main`. Set these environment secrets:

| Secret | Value |
| --- | --- |
| `TS_OAUTH_CLIENT_ID` | The restricted Tailscale OAuth client's ID. |
| `TS_OAUTH_SECRET` | That client's secret, copied directly from Tailscale. |
| `MORNING_DEPLOY_SSH_KEY` | The dedicated deployment private key. |
| `MORNING_DEPLOY_KNOWN_HOSTS` | The VM address and public SSH host key from an already trusted connection. |

Use the VM's verified `/etc/ssh/ssh_host_ed25519_key.pub` to construct the known-hosts line, `VM_TAILSCALE_IP ssh-ed25519 PUBLIC_KEY`. Do not trust a fresh `ssh-keyscan` result without comparing it to the VM's existing host key. SSH uses `StrictHostKeyChecking=yes`.

In [repository Actions variables](https://github.com/0atxl/morning/settings/variables/actions), set `MORNING_DEPLOY_HOST` to the VM's Tailscale IPv4 address. After the VM environment and tailnet credentials are ready, set `MORNING_DEPLOY_ENABLED` to `true`. Until then, builds can run but deployment is skipped. Push committed app changes to `main`, or manually run **Build and deploy** on `main` to deploy the current commit. Neither operation runs the manual test workflow.

## Release records and rollback

Releases live under `/opt/morning/releases/COMMIT_SHA`. `current` points to the active release and `previous` retains its predecessor. The receiver serializes activation with a VM file lock, in addition to the workflow concurrency group. Files are extracted as `morning-deploy`, with archive path, size and link restrictions. No release content runs as root. A failed API service activation restores the previous pointer and restarts that service. This is process supervision, not an application health check; a running service can still have functional problems.

The workflow summary and `/deployment.json` record the SHA and build workflow URL. `/opt/morning/deployments.jsonl` records activation history. All release directories are retained, including failed releases. Monitor disk space and remove old, unused releases manually, preserving both `current` and `previous`.

To roll back without rebuilding, select an installed SHA and its original workflow URL from that history, then run through the administrator's SSH session:

```bash
sudo -u morning-deploy env \
  SSH_ORIGINAL_COMMAND="rollback FULL_COMMIT_SHA https://github.com/0atxl/morning/actions/runs/RUN_ID" \
  /usr/local/libexec/morning-receive
```

Do not pass the word `previous` as the SHA; use the full 40-character commit. Rollback changes only the active app release. Provider configuration stays on the VM. No smoke check, provider call or test suite is part of deployment or rollback. Approve those checks separately when needed.

Root-owned deployment tooling and unit files are installed during bootstrap, not overwritten by app artifacts. After changing these files, repeat the administrator bootstrap with the same public key before using the updated deployment workflow.

## Owner reminder email

Morning can email one configured inbox automatically at a reminder's due time. Gmail acts as both sender and recipient. The public guest workspace never chooses a mail recipient. Only the browser paired with the private owner link schedules emails.

Turn on Google 2-Step Verification and create a dedicated [Google app password](https://myaccount.google.com/apppasswords) for Morning. From the project checkout on your laptop, set `vm` to the same SSH destination you use to administer the VM.

```bash
vm='admin@your-vm'
scp deploy/configure-reminder-email.py "$vm:configure-reminder-email.py"
ssh -t "$vm" 'sudo python3 ./configure-reminder-email.py'
```

Enter the Gmail address and app password at the VM prompts. The script stores them in a root-only environment file, enables persistent queue storage, restarts the API, and prints a private pairing link. Open that link once in your own browser. Keep it out of chat, recordings and shared links. Removing the site data forgets the pairing. Run the script again with the same account to update the app password or recover the pairing link.

Create a new reminder and wait for **All reminder email changes are scheduled. You can close this tab.** before closing the tab. Editing its title or time resets that status. The old server schedule remains active until the server accepts the edit; an acknowledgement for an older revision cannot clear a newer pending change. The dashboard retries unacknowledged schedules while open and on return. The server persists accepted schedules across restarts and checks every five seconds. Gmail failures retry after five minutes. Inbox arrival depends on Gmail and the VM's outbound access to TCP 587. SMTP can deliver a duplicate if the connection or server fails immediately after Gmail accepts a message but before the success is recorded.

The chime is independent of email. Leave Morning visible and focused, and interact with the page so the browser allows sound. Only an eligible foreground tab claims a due occurrence's automatic chime. The alert stays pending in browser storage until dismissed, including if a background tab notices it first. A suspended or closed tab shows undismissed overdue reminders on return. The visible alert has a manual **Play chime** button.
