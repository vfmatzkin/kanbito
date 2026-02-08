"""Git sync functionality for Kanbito."""
from __future__ import annotations

import subprocess
import json
import os
import time
from pathlib import Path
from flask import Flask, Response, request

# Throttle for git fetch (seconds)
_last_fetch_time = 0
FETCH_THROTTLE_SECONDS = 60

# Repos that should not be used for data sync (the code repo itself)
BLOCKED_REPOS = {"vfmatzkin/kanbito", "vfmatzkin/kanbito.git"}

# Data directory - synced from server.py
_data_dir: Path | None = None


def get_data_dir() -> Path:
    """Get the data directory. Falls back to cwd if not set."""
    global _data_dir
    if _data_dir is not None:
        return _data_dir
    try:
        return Path.cwd()
    except OSError:
        return Path.home()


def set_data_dir(path: str | Path) -> None:
    """Set the data directory (called from server.py)."""
    global _data_dir
    _data_dir = Path(path).expanduser().resolve()


# Settings file path
def get_settings_path() -> Path:
    return get_data_dir() / ".kanbito.json"


def load_settings() -> dict:
    """Load kanbito settings."""
    settings_path = get_settings_path()
    default = {
        "git_enabled": False,
        "git_remote": "",
        "username": "",
        "language": "",
        "showBoard": True,
        "showNotes": True,
        "tagGroups": [],
        "tagFilterMode": "or"
    }
    if settings_path.exists():
        try:
            data = json.loads(settings_path.read_text(encoding="utf-8"))
            return {**default, **data}
        except Exception:
            pass
    return default


def save_settings(settings: dict) -> None:
    """Save kanbito settings."""
    get_settings_path().write_text(
        json.dumps(settings, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8"
    )


def run_command(cmd: list[str], env_extra: dict | None = None, timeout: int = 30, cwd: Path | str | None = None) -> tuple[int, str, str]:
    """Run a command and return (returncode, stdout, stderr)."""
    try:
        env = os.environ.copy()
        if env_extra:
            env.update(env_extra)
        # Disable SSH prompts - fail fast if key isn't loaded
        env["GIT_SSH_COMMAND"] = "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new"

        # Determine working directory - fall back to home if cwd is invalid
        if cwd is None:
            try:
                cwd = Path.cwd()
            except OSError:
                # Current directory was deleted, fall back to home
                cwd = Path.home()

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            cwd=str(cwd),
            env=env,
            timeout=timeout,
            stdin=subprocess.DEVNULL  # Prevent hanging on input prompts
        )
        return result.returncode, result.stdout.strip(), result.stderr.strip()
    except FileNotFoundError:
        return -1, "", f"{cmd[0]} not found"
    except subprocess.TimeoutExpired:
        return -1, "", f"Command timed out after {timeout}s (may be waiting for SSH passphrase or key)"


def run_git(*args: str) -> tuple[int, str, str]:
    """Run a git command in the data directory."""
    return run_command(["git", *args], cwd=get_data_dir())


def run_gh(*args: str, as_user: str = None) -> tuple[int, str, str]:
    """Run a gh CLI command, optionally as a specific authenticated user."""
    env_extra = None
    if as_user:
        # Get the token for the specific user
        code, token, _ = run_command(["gh", "auth", "token", "-u", as_user], cwd=Path.home())
        if code == 0 and token:
            env_extra = {"GH_TOKEN": token}
    return run_command(["gh", *args], env_extra=env_extra, cwd=Path.home())


def is_git_installed() -> bool:
    """Check if git is installed."""
    code, _, _ = run_git("--version")
    return code == 0


def is_gh_installed() -> bool:
    """Check if gh CLI is installed."""
    code, _, _ = run_gh("--version")
    return code == 0


def is_gh_authenticated() -> bool:
    """Check if gh CLI is authenticated."""
    code, _, _ = run_gh("auth", "status")
    return code == 0


def is_git_repo() -> bool:
    """Check if current directory is a git repository."""
    code, _, _ = run_git("rev-parse", "--git-dir")
    return code == 0


def get_branch() -> str | None:
    """Get current branch name."""
    code, stdout, _ = run_git("rev-parse", "--abbrev-ref", "HEAD")
    return stdout if code == 0 else None


def get_changes_count() -> int:
    """Get number of uncommitted changes."""
    code, stdout, _ = run_git("status", "--porcelain")
    if code != 0:
        return 0
    return len([line for line in stdout.split("\n") if line.strip()])


def get_ahead_behind() -> tuple[int, int]:
    """Get commits ahead and behind remote."""
    code, stdout, _ = run_git("rev-list", "--left-right", "--count", "@{upstream}...HEAD")
    if code != 0:
        return 0, 0
    parts = stdout.split()
    if len(parts) == 2:
        return int(parts[1]), int(parts[0])  # ahead, behind
    return 0, 0


def get_sync_state() -> dict:
    """Get simplified sync state for UI."""
    changes = get_changes_count()
    ahead, behind = get_ahead_behind()

    # Determine state
    has_local = changes > 0 or ahead > 0
    has_remote = behind > 0

    if has_local and has_remote:
        state = "both"  # Both have changes - needs sync
    elif has_local:
        state = "local"  # Only local changes
    elif has_remote:
        state = "remote"  # Only remote changes
    else:
        state = "synced"  # Up to date

    return {
        "state": state,
        "local_changes": changes,
        "to_upload": ahead,
        "to_download": behind
    }


def create_backup() -> bool:
    """Create a single backup of current data (overwrites previous backup)."""
    import shutil

    backup_dir = get_data_dir() / ".kanbito-backup"

    # Remove old backup if exists
    if backup_dir.exists():
        shutil.rmtree(backup_dir)

    backup_dir.mkdir(exist_ok=True)

    # Files to backup
    files_to_backup = ["board.json", "notes.json"]
    dirs_to_backup = ["tasks", "notes", "images"]

    backed_up = False
    for f in files_to_backup:
        src = get_data_dir() / f
        if src.exists():
            shutil.copy2(src, backup_dir / f)
            backed_up = True

    for d in dirs_to_backup:
        src = get_data_dir() / d
        if src.exists() and src.is_dir():
            shutil.copytree(src, backup_dir / d)
            backed_up = True

    # Save timestamp
    if backed_up:
        (backup_dir / ".timestamp").write_text(str(time.time()), encoding="utf-8")

    return backed_up


def get_backup_age_hours() -> float | None:
    """Get backup age in hours, or None if no backup."""
    backup_dir = get_data_dir() / ".kanbito-backup"
    timestamp_file = backup_dir / ".timestamp"

    if not timestamp_file.exists():
        # Fallback: check directory modification time
        if backup_dir.exists():
            mtime = backup_dir.stat().st_mtime
            return (time.time() - mtime) / 3600
        return None

    try:
        timestamp = float(timestamp_file.read_text(encoding="utf-8").strip())
        return (time.time() - timestamp) / 3600
    except (ValueError, OSError):
        return None


def has_backup() -> bool:
    """Check if a backup exists."""
    backup_dir = get_data_dir() / ".kanbito-backup"
    return backup_dir.exists() and any(f for f in backup_dir.iterdir() if f.name != ".timestamp")


def delete_backup() -> None:
    """Delete the backup folder."""
    import shutil
    backup_dir = get_data_dir() / ".kanbito-backup"
    if backup_dir.exists():
        shutil.rmtree(backup_dir)


def restore_backup() -> bool:
    """Restore from the backup."""
    import shutil

    backup_dir = get_data_dir() / ".kanbito-backup"
    if not backup_dir.exists():
        return False

    # Files to restore
    files_to_restore = ["board.json", "notes.json"]
    dirs_to_restore = ["tasks", "notes", "images"]

    restored = False
    for f in files_to_restore:
        src = backup_dir / f
        dst = get_data_dir() / f
        if src.exists():
            shutil.copy2(src, dst)
            restored = True

    for d in dirs_to_restore:
        src = backup_dir / d
        dst = get_data_dir() / d
        if src.exists() and src.is_dir():
            if dst.exists():
                shutil.rmtree(dst)
            shutil.copytree(src, dst)
            restored = True

    return restored


def ensure_backup_gitignored() -> None:
    """Ensure .kanbito-backup is in .gitignore and not tracked."""
    gitignore = get_data_dir() / ".gitignore"
    backup_entry = ".kanbito-backup/"

    # Add to .gitignore if not present
    if gitignore.exists():
        content = gitignore.read_text(encoding="utf-8")
        if backup_entry not in content and ".kanbito-backup" not in content:
            # Append to gitignore
            if not content.endswith("\n"):
                content += "\n"
            content += f"{backup_entry}\n"
            gitignore.write_text(content, encoding="utf-8")
    else:
        # Create .gitignore with backup entry
        gitignore.write_text(f"# Kanbito\n{backup_entry}\n", encoding="utf-8")

    # Remove from git tracking if tracked
    code, stdout, _ = run_git("ls-files", ".kanbito-backup")
    if code == 0 and stdout.strip():
        # It's tracked, remove it
        run_git("rm", "-r", "--cached", ".kanbito-backup")


def ensure_readme() -> None:
    """Ensure README.md exists in the data folder, update if language changed."""
    readme_path = get_data_dir() / "README.md"

    # Load translations based on current language
    settings = load_settings()
    lang = settings.get("language", "en") or "en"
    lang_marker = f"<!-- kanbito-lang:{lang} -->"

    # Check if README exists and has correct language
    if readme_path.exists():
        content = readme_path.read_text(encoding="utf-8")
        if lang_marker in content:
            return  # Already up to date
        # Language changed, will regenerate

    # Load locale file
    locale_path = Path(__file__).parent / "static" / "locales" / f"{lang}.json"
    try:
        locale = json.loads(locale_path.read_text(encoding="utf-8"))
        r = locale.get("readme", {})
    except Exception:
        r = {}

    # Get translations with defaults
    title = r.get("title", "Kanbito Data")
    intro = r.get("intro", "This repository contains data from [Kanbito](https://github.com/vfmatzkin/kanbito), a personal Kanban board app.")
    files_title = r.get("filesTitle", "Files")
    files_board = r.get("filesBoard", "`board.json` - Task metadata (columns, task list, backlog, trash)")
    files_notes = r.get("filesNotes", "`notes.json` - Notes metadata (tree structure)")
    files_tasks = r.get("filesTasks", "`tasks/` - Task descriptions in Markdown (T1.md, T2.md, ...)")
    files_notes_dir = r.get("filesNotesDir", "`notes/` - Note content in Markdown (N1.md, N2.md, ...)")
    files_images = r.get("filesImages", "`images/` - Attached images")
    files_settings = r.get("filesSettings", "`.kanbito.json` - App settings (git sync config, language, username)")
    restore_title = r.get("restoreTitle", "Restoring a Previous Version")
    restore_intro = r.get("restoreIntro", "If you need to restore your data to a previous state:")
    option1_title = r.get("option1Title", "Option 1: Using GitHub Web Interface")
    option1_steps = r.get("option1Steps", '1. Go to your repository on GitHub\n2. Click on "Commits" to see the history\n3. Find the commit you want to restore to\n4. Click the commit hash, then click "Browse files"\n5. Download the files you need (board.json, notes.json, etc.)\n6. Replace the files in your Kanbito data folder')
    option2_title = r.get("option2Title", "Option 2: Using Git Commands")
    option2_code = r.get("option2Code", "# See commit history\ngit log --oneline\n\n# Restore to a specific commit (replace COMMIT_HASH)\ngit checkout COMMIT_HASH -- board.json notes.json tasks/ notes/\n\n# Or restore everything to a specific commit\ngit reset --hard COMMIT_HASH")
    option3_title = r.get("option3Title", 'Option 3: Using GitHub\'s "Restore" Feature')
    option3_steps = r.get("option3Steps", '1. Go to your repository on GitHub\n2. Click on "Commits"\n3. Find the commit before the unwanted change\n4. Click "..." → "Revert changes in this commit" (creates a new commit)')
    note = r.get("note", "The `.kanbito-backup/` folder (if present) is local only and not synced to GitHub.")

    readme_content = f"""# {title}

{intro}

## {files_title}

- {files_board}
- {files_notes}
- {files_tasks}
- {files_notes_dir}
- {files_images}
- {files_settings}

## {restore_title}

{restore_intro}

### {option1_title}

{option1_steps}

### {option2_title}

```bash
{option2_code}
```

### {option3_title}

{option3_steps}

## Note

{note}

{lang_marker}
"""
    readme_path.write_text(readme_content, encoding="utf-8")


def get_remote() -> str | None:
    """Get the remote URL."""
    code, stdout, _ = run_git("remote", "get-url", "origin")
    return stdout if code == 0 else None


def detect_remote_type(url: str) -> str:
    """Detect remote type: ssh, https, or unknown."""
    if not url:
        return "none"
    if url.startswith("git@") or url.startswith("ssh://"):
        return "ssh"
    if url.startswith("https://"):
        return "https"
    return "unknown"


def get_ssh_github_hosts() -> list[dict]:
    """Parse ~/.ssh/config to find GitHub-related hosts."""
    ssh_config = Path.home() / ".ssh" / "config"
    hosts = []

    # Always include default github.com
    hosts.append({
        "host": "github.com",
        "label": "github.com (default)",
        "is_alias": False
    })

    if not ssh_config.exists():
        return hosts

    try:
        content = ssh_config.read_text(encoding="utf-8")
        current_host = None
        current_hostname = None

        for line in content.split("\n"):
            line = line.strip()
            if line.lower().startswith("host ") and not line.lower().startswith("hostname"):
                # Save previous host if it was GitHub
                if current_host and current_hostname and "github.com" in current_hostname.lower():
                    if current_host != "github.com":  # Don't duplicate default
                        hosts.append({
                            "host": current_host,
                            "label": current_host,
                            "is_alias": True
                        })
                # Start new host
                current_host = line.split()[1] if len(line.split()) > 1 else None
                current_hostname = None
            elif line.lower().startswith("hostname "):
                current_hostname = line.split()[1] if len(line.split()) > 1 else None

        # Don't forget last host
        if current_host and current_hostname and "github.com" in current_hostname.lower():
            if current_host != "github.com":
                hosts.append({
                    "host": current_host,
                    "label": current_host,
                    "is_alias": True
                })
    except Exception:
        pass

    return hosts


def get_gh_accounts() -> list[dict]:
    """Get authenticated GitHub accounts from gh CLI."""
    accounts = []

    if not is_gh_installed():
        return accounts

    # gh auth status shows all authenticated accounts
    code, stdout, stderr = run_gh("auth", "status")

    # Parse output to find accounts
    # Format: "  ✓ Logged in to github.com account username (keyring)"
    output = stdout + "\n" + stderr
    for line in output.split("\n"):
        if "Logged in to" in line and "account" in line:
            try:
                # Extract username between "account" and "("
                parts = line.split("account")
                if len(parts) > 1:
                    username_part = parts[1].strip()
                    username = username_part.split()[0].strip("()")
                    if username:
                        accounts.append({
                            "username": username,
                            "host": "github.com",
                            "label": f"@{username} (gh CLI)"
                        })
            except Exception:
                pass

    return accounts


def extract_repo_from_url(url: str) -> str | None:
    """Extract owner/repo from GitHub URL."""
    import re
    # HTTPS: https://github.com/owner/repo.git
    match = re.search(r'github\.com/([^/]+/[^/]+?)(?:\.git)?$', url)
    if match:
        return match.group(1)
    # SSH: git@github.com:owner/repo.git or git@alias:owner/repo.git
    match = re.search(r'git@[^:]+:([^/]+/[^/]+?)(?:\.git)?$', url)
    if match:
        return match.group(1)
    return None


def test_remote_connection(use_gh_account: str = None) -> tuple[bool, str, bool]:
    """Test if we can connect to the remote.

    Returns: (success, message, repo_not_found)
    repo_not_found is True if the repo doesn't exist on GitHub (can be created).
    """
    remote = get_remote()
    if not remote:
        return False, "No remote configured", False

    repo = extract_repo_from_url(remote)

    # Block the code repo from being used for data sync
    if repo and repo.lower() in {r.lower() for r in BLOCKED_REPOS}:
        return False, "This is the Kanbito source code repository.\n\nCreate a separate repository for your data.", False

    # For HTTPS with gh CLI, use gh to test
    if remote.startswith("https://") and use_gh_account and is_gh_authenticated():
        if repo:
            # Use gh repo view to test access, using the specific account
            code, stdout, stderr = run_gh("repo", "view", repo, "--json", "name", as_user=use_gh_account)
            if code == 0:
                return True, f"Connection successful (as @{use_gh_account})", False
            error = stderr or "Connection failed"
            if "Could not resolve" in error or "not found" in error.lower():
                return False, f"Repository not found: {repo}\n\nThe repository doesn't exist on GitHub yet.\nClick 'Create Repository' to create it.", True
            return False, f"Testing: {remote} (as @{use_gh_account})\n\n{error}", False

    # For SSH or fallback, use git ls-remote
    # First try without HEAD (works on empty repos too)
    code, stdout, stderr = run_git("ls-remote", "origin")
    if code == 0:
        # Connection works - repo may be empty but that's OK
        if not stdout.strip():
            return True, "Connection successful (empty repository)", False
        return True, "Connection successful", False

    # Return the actual error for debugging
    error = stderr or stdout or ""

    # Show what we're testing
    debug_info = f"Testing: {remote}\n"
    debug_info += f"Exit code: {code}\n"
    if stderr:
        debug_info += f"stderr: {stderr}\n"
    if stdout:
        debug_info += f"stdout: {stdout}\n"
    debug_info += "\n"

    # If no error output, try direct SSH test to get better error
    if not error and remote.startswith("git@"):
        # Extract host from git@host:path
        try:
            host = remote.split("@")[1].split(":")[0]
            ssh_code, ssh_out, ssh_err = run_command(
                ["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", f"git@{host}"],
                timeout=10
            )
            # GitHub returns code 1 with "successfully authenticated" on success
            if "successfully authenticated" in (ssh_out + ssh_err).lower():
                # SSH works, but git ls-remote failed - likely repo access issue
                error = f"SSH authentication OK, but cannot access repository.\nCheck that the repo exists and you have access."
            else:
                error = ssh_err or ssh_out or f"SSH connection failed (code {ssh_code})"
        except Exception as e:
            error = f"SSH test failed: {e}"

    if not error:
        error = "Connection failed (no error output)"

    # Detect repo not found
    repo_not_found = False
    if "Repository not found" in error or "not found" in error.lower():
        repo_not_found = True
        error = f"Repository not found: {repo or remote}\n\nThe repository doesn't exist on GitHub yet.\nClick 'Create Repository' to create it."
        return False, error, repo_not_found

    # Add helpful hints based on error type
    if "Permission denied" in error:
        error += "\n\nTip: For multiple SSH keys, use a custom host alias in ~/.ssh/config"
    elif "No such identity" in error or "no such identity" in error.lower():
        error += "\n\nTip: Your SSH key may not be loaded. Run: ssh-add ~/.ssh/your_key"

    return False, debug_info + error, repo_not_found


def create_github_repo(repo_name: str, private: bool = True) -> tuple[bool, str]:
    """Create a GitHub repository using gh CLI."""
    if not is_gh_installed():
        return False, "GitHub CLI (gh) is not installed"
    if not is_gh_authenticated():
        return False, "GitHub CLI is not authenticated. Run 'gh auth login' first."

    # Extract just the repo name (without owner)
    if "/" in repo_name:
        repo_name = repo_name.split("/")[-1]

    visibility = "--private" if private else "--public"
    code, stdout, stderr = run_gh("repo", "create", repo_name, visibility, "--source=.", "--push")

    if code == 0:
        return True, f"Repository created and pushed successfully"

    error = stderr or stdout or "Failed to create repository"
    return False, error


def register_routes(app: Flask):
    """Register git sync routes on the Flask app."""

    @app.route("/api/settings", methods=["GET"])
    def get_settings():
        """Get kanbito settings."""
        settings = load_settings()

        # Add runtime info
        settings["_git_installed"] = is_git_installed()
        settings["_gh_installed"] = is_gh_installed()
        settings["_gh_authenticated"] = is_gh_authenticated() if is_gh_installed() else False
        settings["_is_repo"] = is_git_repo()
        settings["_current_remote"] = get_remote() if is_git_repo() else None

        return Response(json.dumps(settings), content_type="application/json")

    @app.route("/api/settings", methods=["POST"])
    def update_settings():
        """Update kanbito settings."""
        data = request.get_json() or {}
        settings = load_settings()

        if "git_enabled" in data:
            settings["git_enabled"] = bool(data["git_enabled"])
        if "git_remote" in data:
            settings["git_remote"] = data["git_remote"].strip()
        if "username" in data:
            settings["username"] = data["username"].strip()
        if "language" in data:
            settings["language"] = data["language"].strip()
        if "showBoard" in data:
            settings["showBoard"] = bool(data["showBoard"])
        if "showNotes" in data:
            settings["showNotes"] = bool(data["showNotes"])
        if "tagGroups" in data:
            settings["tagGroups"] = data["tagGroups"]
        if "tagFilterMode" in data:
            settings["tagFilterMode"] = data["tagFilterMode"]

        save_settings(settings)
        return Response(json.dumps({"ok": True}), content_type="application/json")

    @app.route("/api/git/status", methods=["GET"])
    def git_status():
        """Get git repository status."""
        settings = load_settings()

        if not settings.get("git_enabled"):
            return Response(
                json.dumps({"enabled": False}),
                content_type="application/json"
            )

        if not is_git_repo():
            return Response(
                json.dumps({
                    "enabled": True,
                    "is_repo": False,
                    "branch": None,
                    "changes": 0,
                    "ahead": 0,
                    "behind": 0,
                    "remote": None,
                    "remote_type": "none"
                }),
                content_type="application/json"
            )

        remote = get_remote()
        branch = get_branch()
        changes = get_changes_count()

        # Fetch from remote to get accurate ahead/behind counts (throttled)
        global _last_fetch_time
        now = time.time()
        if remote and (now - _last_fetch_time) > FETCH_THROTTLE_SECONDS:
            run_git("fetch", "origin", "--quiet")
            _last_fetch_time = now

        ahead, behind = get_ahead_behind()

        # Simplified sync state
        has_local = changes > 0 or ahead > 0
        has_remote = behind > 0
        if has_local and has_remote:
            sync_state = "both"
        elif has_local:
            sync_state = "local"
        elif has_remote:
            sync_state = "remote"
        else:
            sync_state = "synced"

        return Response(
            json.dumps({
                "enabled": True,
                "is_repo": True,
                "branch": branch,
                "changes": changes,
                "ahead": ahead,
                "behind": behind,
                "remote": remote,
                "remote_type": detect_remote_type(remote),
                "sync_state": sync_state
            }),
            content_type="application/json"
        )

    @app.route("/api/git/test", methods=["POST"])
    def git_test():
        """Test git remote connection."""
        data = request.get_json() or {}
        gh_account = data.get("gh_account")
        ok, message, can_create = test_remote_connection(use_gh_account=gh_account)
        return Response(
            json.dumps({"ok": ok, "message": message, "can_create": can_create}),
            content_type="application/json"
        )

    @app.route("/api/git/setup", methods=["POST"])
    def git_setup():
        """Setup git repository with remote."""
        data = request.get_json() or {}
        remote_url = data.get("remote", "").strip()

        if not remote_url:
            return Response(
                json.dumps({"ok": False, "error": "Remote URL is required"}),
                status=400,
                content_type="application/json"
            )

        # Block the code repo from being used for data sync
        repo = extract_repo_from_url(remote_url)
        if repo and repo.lower() in {r.lower() for r in BLOCKED_REPOS}:
            return Response(
                json.dumps({"ok": False, "error": "This is the Kanbito source code repository.\n\nCreate a separate repository for your data."}),
                status=400,
                content_type="application/json"
            )

        steps = []

        # Initialize repo if needed
        if not is_git_repo():
            code, stdout, stderr = run_git("init")
            steps.append({"step": "init", "ok": code == 0, "output": stdout or stderr})
            if code != 0:
                return Response(
                    json.dumps({"ok": False, "error": f"git init failed: {stderr}", "steps": steps}),
                    status=500,
                    content_type="application/json"
                )

            # Create initial .gitignore
            gitignore = get_data_dir() / ".gitignore"
            if not gitignore.exists():
                gitignore.write_text("# Kanbito\nimages/\n.kanbito.json\n.kanbito-backup/\n", encoding="utf-8")

        # Ensure .kanbito-backup is gitignored and not tracked
        ensure_backup_gitignored()

        # Ensure README exists
        ensure_readme()

        # Set or update remote
        current_remote = get_remote()
        if current_remote:
            code, stdout, stderr = run_git("remote", "set-url", "origin", remote_url)
            steps.append({"step": "set-url", "ok": code == 0, "output": stdout or stderr})
        else:
            code, stdout, stderr = run_git("remote", "add", "origin", remote_url)
            steps.append({"step": "add-remote", "ok": code == 0, "output": stdout or stderr})

        if code != 0:
            return Response(
                json.dumps({"ok": False, "error": f"Failed to set remote: {stderr}", "steps": steps}),
                status=500,
                content_type="application/json"
            )

        # Update settings
        settings = load_settings()
        settings["git_enabled"] = True
        settings["git_remote"] = remote_url
        save_settings(settings)

        # Test connection
        ok, message, can_create = test_remote_connection()
        steps.append({"step": "test", "ok": ok, "output": message, "can_create": can_create})

        return Response(
            json.dumps({
                "ok": True,
                "message": "Git configured" + (" - " + message if not ok else ""),
                "connection_ok": ok,
                "steps": steps
            }),
            content_type="application/json"
        )

    @app.route("/api/git/sync", methods=["POST"])
    def git_sync():
        """Sync with git: add, commit, pull, push."""
        settings = load_settings()

        if not settings.get("git_enabled"):
            return Response(
                json.dumps({"ok": False, "error": "Git sync is not enabled"}),
                status=400,
                content_type="application/json"
            )

        if not is_git_repo():
            return Response(
                json.dumps({"ok": False, "error": "Not a git repository"}),
                status=400,
                content_type="application/json"
            )

        # Ensure backup folder is gitignored and not tracked
        ensure_backup_gitignored()

        # Ensure README exists
        ensure_readme()

        data = request.get_json() or {}
        message = data.get("message", "Kanbito auto-sync")
        # Resolution mode: "auto" (default), "keep_local", "keep_remote", "keep_both"
        resolution = data.get("resolution", "auto")

        steps = []

        # Check current state
        changes = get_changes_count()
        remote = get_remote()

        # Fetch to check if we need to pull
        if remote:
            run_git("fetch", "origin")

        # Check if upstream is set and get ahead/behind
        code, _, _ = run_git("rev-parse", "--abbrev-ref", "@{upstream}")
        has_upstream = code == 0
        behind = 0

        if has_upstream:
            code, behind_count, _ = run_git("rev-list", "--count", "HEAD..@{upstream}")
            behind = int(behind_count.strip()) if code == 0 and behind_count.strip().isdigit() else 0

        # Determine if we have a conflict situation (both local and remote changes)
        has_local = changes > 0
        has_remote = behind > 0
        skip_push = False  # Flag to skip push for keep_remote/keep_both

        # Handle "keep_remote" (with backup) or "keep_remote_no_backup" (without)
        if resolution in ("keep_remote", "keep_remote_no_backup"):
            branch = get_branch() or "main"

            # Create backup only for keep_remote (not for keep_remote_no_backup)
            if resolution == "keep_remote":
                create_backup()
                steps.append({"step": "backup", "ok": True})

                # Restore files from origin WITHOUT moving HEAD
                # This preserves the diverged state so undo + sync will show conflict again
                code, stdout, stderr = run_git("checkout", f"origin/{branch}", "--", ".")
                steps.append({"step": "checkout_origin_files", "ok": code == 0, "output": stdout or stderr})
            else:
                # No backup - do a hard reset (permanently discard local changes)
                code, stdout, stderr = run_git("reset", "--hard", f"origin/{branch}")
                steps.append({"step": "reset_to_origin", "ok": code == 0, "output": stdout or stderr})
                # Delete any existing backup since user chose no backup
                delete_backup()

            if code == 0:
                return Response(
                    json.dumps({
                        "ok": True,
                        "message": "Synced to cloud version",
                        "steps": steps,
                        "pulled": True
                    }),
                    content_type="application/json"
                )
            else:
                return Response(
                    json.dumps({"ok": False, "error": f"Reset failed: {stderr}", "steps": steps}),
                    status=500,
                    content_type="application/json"
                )

        # Handle "keep_both" - just save backup, don't resolve conflict
        # User can undo to restore and try again later
        if resolution == "keep_both":
            create_backup()
            steps.append({"step": "backup", "ok": True})

            # Don't reset - keep the diverged state so conflict persists
            # Just abort any in-progress merge
            run_git("merge", "--abort")

            return Response(
                json.dumps({
                    "ok": True,
                    "message": "Backup saved. Sync again when ready.",
                    "steps": steps,
                    "pulled": False
                }),
                content_type="application/json"
            )

        # Add and commit local changes
        if has_local or changes > 0:
            code, stdout, stderr = run_git("add", "-A")
            steps.append({"step": "add", "ok": code == 0, "output": stdout or stderr})
            if code != 0:
                return Response(
                    json.dumps({"ok": False, "error": f"git add failed: {stderr}", "steps": steps}),
                    status=500,
                    content_type="application/json"
                )

            # Check if there's anything to commit
            code, stdout, stderr = run_git("diff", "--cached", "--quiet")
            has_staged = code != 0

            if has_staged:
                code, stdout, stderr = run_git("commit", "-m", message)
                steps.append({"step": "commit", "ok": code == 0, "output": stdout or stderr})
                if code != 0 and "nothing to commit" not in stderr:
                    return Response(
                        json.dumps({"ok": False, "error": f"git commit failed: {stderr}", "steps": steps}),
                        status=500,
                        content_type="application/json"
                    )

        # Check if remote is configured
        if not remote:
            return Response(
                json.dumps({"ok": True, "message": "Committed locally (no remote)", "steps": steps}),
                content_type="application/json"
            )

        # Re-check ahead/behind AFTER committing (state may have changed)
        branch = get_branch() or "main"
        code, _, _ = run_git("rev-parse", "--abbrev-ref", "@{upstream}")
        has_upstream = code == 0

        # Check if we're behind, either from upstream or origin/branch
        behind = 0
        if has_upstream:
            code, behind_count, _ = run_git("rev-list", "--count", "HEAD..@{upstream}")
            behind = int(behind_count.strip()) if code == 0 and behind_count.strip().isdigit() else 0
        else:
            # No upstream, but check if origin/branch exists and if we're behind
            code, _, _ = run_git("rev-parse", "--verify", f"origin/{branch}")
            if code == 0:
                code, behind_count, _ = run_git("rev-list", "--count", f"HEAD..origin/{branch}")
                behind = int(behind_count.strip()) if code == 0 and behind_count.strip().isdigit() else 0

        pulled = False
        if behind > 0:
            # Create backup before pull if we have local commits and remote changes
            code, ahead_count, _ = run_git("rev-list", "--count", f"origin/{branch}..HEAD")
            ahead = int(ahead_count.strip()) if code == 0 and ahead_count.strip().isdigit() else 0

            if ahead > 0 and behind > 0:
                create_backup()
                steps.append({"step": "backup", "ok": True})

            # Use fetch + merge instead of pull to avoid "divergent branches" error
            # fetch is already done above, so just merge
            code, stdout, stderr = run_git("merge", f"origin/{branch}", "--no-edit")
            steps.append({"step": "pull", "ok": code == 0, "output": stdout or stderr})

            if code != 0:
                # Conflict detected - abort merge
                run_git("merge", "--abort")

                # If auto mode, return conflict status for user to decide
                if resolution == "auto":
                    return Response(
                        json.dumps({
                            "ok": False,
                            "conflict": True,
                            "error": "Sync conflict: both local and cloud have changes",
                            "steps": steps
                        }),
                        status=409,
                        content_type="application/json"
                    )

                # For keep_local, force push
                if resolution == "keep_local":
                    code, stdout, stderr = run_git("push", "--force-with-lease")
                    steps.append({"step": "force_push", "ok": code == 0, "output": stdout or stderr})
                    if code != 0:
                        return Response(
                            json.dumps({"ok": False, "error": f"Force push failed: {stderr}", "steps": steps}),
                            status=500,
                            content_type="application/json"
                        )
                    # Delete backup - keep_local doesn't save backup
                    delete_backup()
                    return Response(
                        json.dumps({"ok": True, "message": "Kept local version", "steps": steps, "pulled": False}),
                        content_type="application/json"
                    )

            pulled = True

        # Push (skip if we just discarded local changes to accept remote)
        if not skip_push:
            branch = get_branch() or "main"
            if has_upstream:
                code, stdout, stderr = run_git("push")
            else:
                code, stdout, stderr = run_git("push", "-u", "origin", branch)

            steps.append({"step": "push", "ok": code == 0, "output": stdout or stderr})
            if code != 0:
                return Response(
                    json.dumps({"ok": False, "error": f"git push failed: {stderr}", "steps": steps}),
                    status=500,
                    content_type="application/json"
                )

        # Normal sync completed - delete any old backup (no conflict resolution happened)
        delete_backup()

        return Response(
            json.dumps({
                "ok": True,
                "message": "Synced successfully",
                "steps": steps,
                "pulled": pulled
            }),
            content_type="application/json"
        )

    @app.route("/api/backup/status", methods=["GET"])
    def backup_status():
        """Check if a backup exists and its age."""
        age_hours = get_backup_age_hours()
        return Response(
            json.dumps({
                "has_backup": has_backup(),
                "age_hours": age_hours,
                "is_recent": age_hours is not None and age_hours < 24
            }),
            content_type="application/json"
        )

    @app.route("/api/backup/restore", methods=["POST"])
    def backup_restore():
        """Restore from backup."""
        if not has_backup():
            return Response(
                json.dumps({"ok": False, "error": "No backup available"}),
                status=404,
                content_type="application/json"
            )

        if restore_backup():
            # Delete backup after successful restore
            delete_backup()
            return Response(
                json.dumps({"ok": True, "message": "Restored successfully"}),
                content_type="application/json"
            )
        else:
            return Response(
                json.dumps({"ok": False, "error": "Restore failed"}),
                status=500,
                content_type="application/json"
            )

    @app.route("/api/backup/delete", methods=["POST"])
    def backup_delete():
        """Delete backup."""
        delete_backup()
        return Response(
            json.dumps({"ok": True}),
            content_type="application/json"
        )

    @app.route("/api/git/disable", methods=["POST"])
    def git_disable():
        """Disable git sync."""
        settings = load_settings()
        settings["git_enabled"] = False
        save_settings(settings)
        return Response(
            json.dumps({"ok": True, "message": "Git sync disabled"}),
            content_type="application/json"
        )

    @app.route("/api/git/diff", methods=["GET"])
    def git_diff():
        """Get diff between local and remote for conflict visualization."""
        if not is_git_repo():
            return Response(
                json.dumps({"ok": False, "error": "Not a git repository"}),
                status=400,
                content_type="application/json"
            )

        branch = get_branch() or "main"

        # Get local changes (uncommitted + committed ahead of origin)
        # First, get uncommitted changes
        code, local_diff, _ = run_git("diff", "HEAD")

        # Also get committed changes ahead of origin
        code2, committed_diff, _ = run_git("diff", f"origin/{branch}...HEAD")

        # Combine: show what's different locally
        local_changes = committed_diff if committed_diff else local_diff

        # Get what's on remote that we don't have
        code3, remote_diff, _ = run_git("diff", f"HEAD...origin/{branch}")

        return Response(
            json.dumps({
                "ok": True,
                "local": local_changes or "(no changes)",
                "remote": remote_diff or "(no changes)"
            }),
            content_type="application/json"
        )

    @app.route("/api/git/create-repo", methods=["POST"])
    def git_create_repo():
        """Create a GitHub repository using gh CLI."""
        data = request.get_json() or {}
        private = data.get("private", True)

        # Get repo name from current remote URL
        remote = get_remote()
        if not remote:
            return Response(
                json.dumps({"ok": False, "error": "No remote URL configured"}),
                status=400,
                content_type="application/json"
            )

        repo = extract_repo_from_url(remote)
        if not repo:
            return Response(
                json.dumps({"ok": False, "error": f"Could not parse repo from URL: {remote}"}),
                status=400,
                content_type="application/json"
            )

        ok, message = create_github_repo(repo, private=private)
        return Response(
            json.dumps({"ok": ok, "message": message}),
            status=200 if ok else 500,
            content_type="application/json"
        )

    @app.route("/api/git/identities", methods=["GET"])
    def git_identities():
        """Get available Git identities (SSH hosts and gh accounts)."""
        ssh_hosts = get_ssh_github_hosts()
        gh_accounts = get_gh_accounts()

        return Response(
            json.dumps({
                "ssh_hosts": ssh_hosts,
                "gh_accounts": gh_accounts
            }),
            content_type="application/json"
        )

    @app.route("/api/git/clone", methods=["POST"])
    def git_clone():
        """Clone a GitHub repository into a target directory.

        This is used during first-time setup to clone an existing Kanbito data repo.
        """
        import shutil

        data = request.get_json() or {}
        repo_input = data.get("repo", "").strip()
        target_dir = data.get("target_dir", "").strip()
        identity_type = data.get("identity_type", "")  # "ssh:hostname" or "gh:username"
        clear_folder = data.get("clear_folder", False)

        if not repo_input:
            return Response(
                json.dumps({"ok": False, "error": "Repository URL is required"}),
                status=400,
                content_type="application/json"
            )

        if not target_dir:
            return Response(
                json.dumps({"ok": False, "error": "Target directory is required"}),
                status=400,
                content_type="application/json"
            )

        # Block the code repo
        repo_name = repo_input
        if "/" in repo_input and not repo_input.startswith(("http", "git@")):
            repo_name = repo_input
        else:
            repo_name = extract_repo_from_url(repo_input) or repo_input

        if repo_name and repo_name.lower() in {r.lower() for r in BLOCKED_REPOS}:
            return Response(
                json.dumps({"ok": False, "error": "This is the Kanbito source code repository.\n\nCreate a separate repository for your data."}),
                status=400,
                content_type="application/json"
            )

        # Build the clone URL based on identity
        if identity_type.startswith("ssh:"):
            # Use SSH with specific host alias
            ssh_host = identity_type.split(":", 1)[1]
            if "/" in repo_input and not repo_input.startswith(("http", "git@")):
                clone_url = f"git@{ssh_host}:{repo_input}.git"
            else:
                # Extract owner/repo from URL
                repo_path = extract_repo_from_url(repo_input) or repo_input
                clone_url = f"git@{ssh_host}:{repo_path}.git"
        elif identity_type.startswith("gh:"):
            # Use HTTPS with gh credential helper
            gh_user = identity_type.split(":", 1)[1]
            if "/" in repo_input and not repo_input.startswith(("http", "git@")):
                clone_url = f"https://github.com/{repo_input}.git"
            elif repo_input.startswith("git@"):
                # Convert SSH to HTTPS
                repo_path = extract_repo_from_url(repo_input)
                clone_url = f"https://github.com/{repo_path}.git"
            else:
                clone_url = repo_input if repo_input.endswith(".git") else repo_input + ".git"
        else:
            # Default: try to auto-detect
            if "/" in repo_input and not repo_input.startswith(("http", "git@")):
                # Short format - prefer SSH
                clone_url = f"git@github.com:{repo_input}.git"
            else:
                clone_url = repo_input

        target_path = Path(target_dir).expanduser().resolve()

        # Clear folder if requested
        if clear_folder and target_path.exists():
            try:
                shutil.rmtree(target_path)
            except Exception as e:
                return Response(
                    json.dumps({"ok": False, "error": f"Failed to clear folder: {e}"}),
                    status=500,
                    content_type="application/json"
                )

        # Create parent directory
        target_path.parent.mkdir(parents=True, exist_ok=True)

        # Set up environment for gh CLI if using HTTPS
        env_extra = {}
        if identity_type.startswith("gh:"):
            gh_user = identity_type.split(":", 1)[1]
            code, token, _ = run_command(["gh", "auth", "token", "-u", gh_user])
            if code == 0 and token:
                env_extra = {"GH_TOKEN": token}

        # Clone the repository
        env = os.environ.copy()
        env.update(env_extra)
        # Disable SSH prompts
        env["GIT_SSH_COMMAND"] = "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new"

        try:
            # Run from home directory to avoid issues if cwd was deleted
            result = subprocess.run(
                ["git", "clone", clone_url, str(target_path)],
                capture_output=True,
                text=True,
                timeout=120,
                env=env,
                stdin=subprocess.DEVNULL,
                cwd=str(Path.home())
            )

            if result.returncode == 0:
                # Save the data directory config
                config_file = Path.home() / '.kanbito-config'
                config_file.write_text(str(target_path))

                return Response(
                    json.dumps({"ok": True, "message": "Repository cloned successfully", "path": str(target_path)}),
                    content_type="application/json"
                )
            else:
                error = result.stderr.strip()

                # Improve error messages
                if "Permission denied" in error or "publickey" in error:
                    error = "SSH key not authorized. Make sure your SSH key is added to GitHub."
                elif "not found" in error.lower() or "does not exist" in error.lower():
                    error = f"Repository not found: {repo_name}"
                elif "Could not read from remote" in error:
                    error = "Authentication failed. Select a different identity or run 'gh auth login' first."

                return Response(
                    json.dumps({"ok": False, "error": error}),
                    status=500,
                    content_type="application/json"
                )

        except subprocess.TimeoutExpired:
            return Response(
                json.dumps({"ok": False, "error": "Clone timed out (slow connection or waiting for SSH passphrase)"}),
                status=500,
                content_type="application/json"
            )
        except FileNotFoundError:
            return Response(
                json.dumps({"ok": False, "error": "Git is not installed"}),
                status=500,
                content_type="application/json"
            )
