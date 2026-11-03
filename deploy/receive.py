#!/usr/bin/python3
"""Restricted SSH entry point. Runs as morning-deploy, never as root."""

import datetime
import fcntl
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import subprocess
import sys
import tarfile
import tempfile

BASE = Path('/opt/morning')
RELEASES = BASE / 'releases'


def fail(message):
    raise SystemExit(message)


def point(name, target):
    temporary = BASE / f'.{name}-{os.getpid()}'
    temporary.symlink_to(target)
    temporary.replace(BASE / name)


def restart():
    subprocess.run(['sudo', '-n', '/usr/bin/systemctl', 'restart', 'morning-api.service'], check=True)
    subprocess.run(['/usr/bin/systemctl', 'is-active', '--quiet', 'morning-api.service'], check=True)


def receive(sha, run_url):
    release = RELEASES / sha
    if release.exists():
        fail('This release already exists. Use rollback to reactivate it.')
    with tempfile.TemporaryDirectory(prefix='.incoming-', dir=RELEASES) as temporary:
        unpacked = Path(temporary) / 'release'
        unpacked.mkdir()
        archive = Path(temporary) / 'release.tar.gz'
        size = 0
        with archive.open('wb') as output:
            while block := sys.stdin.buffer.read(1024 * 1024):
                size += len(block)
                if size > 256 * 1024 * 1024:
                    fail('Release archive exceeds 256 MiB.')
                output.write(block)
        with tarfile.open(archive, 'r:gz') as bundle:
            members = bundle.getmembers()
            total = 0
            seen = set()
            for member in members:
                path = PurePosixPath(member.name)
                name = str(path)
                if path.is_absolute() or '..' in path.parts or name in seen:
                    fail('Unsafe or duplicate release path.')
                if name not in {'morning-server', 'deployment.json', 'web'} and not name.startswith('web/'):
                    fail('Unexpected release path.')
                if not (member.isfile() or member.isdir()):
                    fail('Release links and special files are not allowed.')
                seen.add(name)
                total += member.size
            if total > 512 * 1024 * 1024:
                fail('Unpacked release exceeds 512 MiB.')
            bundle.extractall(unpacked, filter='data')
        binary = unpacked / 'morning-server'
        if not binary.is_file() or binary.stat().st_size == 0 or not (unpacked / 'web/index.html').is_file():
            fail('The release must include an API binary and web/index.html.')
        metadata = json.loads((unpacked / 'deployment.json').read_text())
        if metadata.get('commit') != sha or metadata.get('workflow_run') != run_url:
            fail('Release provenance does not match the requested deployment.')
        for directory, _, files in os.walk(unpacked):
            Path(directory).chmod(0o755)
            for filename in files:
                (Path(directory) / filename).chmod(0o644)
        binary.chmod(0o755)
        unpacked.rename(release)
    return release


def main():
    arguments = shlex.split(os.environ.get('SSH_ORIGINAL_COMMAND', ''))
    if len(arguments) != 3:
        fail('Expected deploy|rollback COMMIT_SHA WORKFLOW_RUN_URL.')
    operation, sha, run_url = arguments
    if operation not in {'deploy', 'rollback'} or not re.fullmatch(r'[0-9a-f]{40}', sha):
        fail('Invalid deployment operation or commit SHA.')
    if not re.fullmatch(r'https://github\.com/0atxl/morning/actions/runs/[0-9]+', run_url):
        fail('Invalid workflow run URL.')
    with (BASE / '.deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if operation == 'deploy' and (BASE / 'current/deployment.json').is_file():
            active = json.loads((BASE / 'current/deployment.json').read_text())
            active_run = active['workflow_run'].rsplit('/', 1)[-1]
            if int(active_run) > int(run_url.rsplit('/', 1)[-1]):
                fail('A newer workflow already deployed. Use an explicit rollback for an older release.')
        release = receive(sha, run_url) if operation == 'deploy' else RELEASES / sha
        if not release.is_dir() or release.is_symlink() or not (release / 'morning-server').is_file():
            fail('The requested release is not installed.')
        previous = (BASE / 'current').resolve() if (BASE / 'current').is_symlink() else None
        point('current', release)
        try:
            restart()
        except subprocess.CalledProcessError:
            if previous is not None:
                point('current', previous)
                try:
                    restart()
                except subprocess.CalledProcessError:
                    fail('Activation and rollback both failed. Inspect morning-api.service on the VM.')
            else:
                (BASE / 'current').unlink()
            fail('API service activation failed; the previous release was restored when available.')
        if previous is not None and previous != release:
            point('previous', previous)
        with (BASE / 'deployments.jsonl').open('a') as history:
            history.write(json.dumps({
                'operation': operation, 'commit': sha, 'workflow_run': run_url,
                'activated_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            }) + '\n')
        print(f'Activated {sha}. Workflow: {run_url}. No application tests or provider probes ran.')


if __name__ == '__main__':
    main()
