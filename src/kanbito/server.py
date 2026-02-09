"""Flask server for Kanbito kanban board."""
from __future__ import annotations

import json
import os
from pathlib import Path

from flask import Flask, Response, request

# Data directory - can be changed at runtime
_data_dir: Path | None = None


def get_data_dir() -> Path:
    """Get the data directory."""
    global _data_dir
    if _data_dir is not None:
        return _data_dir
    return Path.cwd()


def set_data_dir(path: str | Path) -> None:
    """Set the data directory at runtime."""
    global _data_dir
    _data_dir = Path(path).expanduser().resolve()
    _data_dir.mkdir(parents=True, exist_ok=True)
    # Sync to git_sync module
    from . import git_sync
    git_sync.set_data_dir(_data_dir)

def get_board_path() -> Path:
    return get_data_dir() / "board.json"

def get_notes_path() -> Path:
    return get_data_dir() / "notes.json"

def get_tasks_dir() -> Path:
    return get_data_dir() / "tasks"

def get_notes_dir() -> Path:
    return get_data_dir() / "notes"

def get_images_dir() -> Path:
    return get_data_dir() / "images"

EMPTY_BOARD = {
    "columns": [
        {"id": "todo", "title": "To Do"},
        {"id": "doing", "title": "In Progress"},
        {"id": "review", "title": "Pending Review"},
        {"id": "done", "title": "Done"}
    ],
    "tasks": [],
    "backlog": [],
    "trash": [],
    "nextId": 1
}

EMPTY_NOTES = {"notes": [], "nextNoteId": 1}

# Get the directory where this module is located (for static files)
_MODULE_DIR = Path(__file__).parent


def get_current_language() -> str:
    """Get the currently configured language."""
    from .git_sync import load_settings
    settings = load_settings()
    return settings.get("language", "en") or "en"


def load_locale(lang: str) -> dict:
    """Load translations from locale file."""
    locale_path = _MODULE_DIR / "static" / "locales" / f"{lang}.json"
    if locale_path.exists():
        try:
            return json.loads(locale_path.read_text(encoding="utf-8"))
        except Exception:
            pass
    # Fallback to English
    if lang != "en":
        return load_locale("en")
    return {}


def build_example_board(lang: str = None) -> dict:
    """Build example board data from locale file."""
    if lang is None:
        lang = get_current_language()
    locale = load_locale(lang)
    examples = locale.get("examples", {})
    tasks_data = examples.get("tasks", {})
    columns = locale.get("columns", {})

    timestamp = "2024-01-01T10:00:00.000Z"

    # Build tasks from locale
    tasks = []
    backlog = []

    # Task 1: Welcome (todo)
    t1 = tasks_data.get("1", {})
    task1 = {
        "id": 1, "title": t1.get("title", "Welcome to Kanbito!"), "column": "todo",
        "tags": t1.get("tags", ["guide"]), "createdBy": "Kanbito",
        "createdAt": timestamp, "modifiedAt": timestamp,
        "comments": [{
            "author": "Kanbito",
            "text": t1.get("comment", ""),
            "date": timestamp
        }] if t1.get("comment") else []
    }
    tasks.append(task1)

    # Task 2: Try filtering (todo)
    t2 = tasks_data.get("2", {})
    tasks.append({
        "id": 2, "title": t2.get("title", "Try filtering your tasks"), "column": "todo",
        "tags": t2.get("tags", ["guide", "today"]), "createdBy": "Kanbito",
        "createdAt": timestamp, "modifiedAt": timestamp
    })

    # Task 3: Fix login typo (doing)
    t3 = tasks_data.get("3", {})
    tasks.append({
        "id": 3, "title": t3.get("title", "Fix login page typo"), "column": "doing",
        "tags": t3.get("tags", ["bug", "work", "today"]), "createdBy": "Kanbito",
        "createdAt": timestamp, "modifiedAt": timestamp
    })

    # Task 4: Add dark mode (doing)
    t4 = tasks_data.get("4", {})
    tasks.append({
        "id": 4, "title": t4.get("title", "Add dark mode toggle"), "column": "doing",
        "tags": t4.get("tags", ["idea", "work", "this-week"]), "createdBy": "Kanbito",
        "createdAt": timestamp, "modifiedAt": timestamp
    })

    # Task 5: Plan weekend trip (review)
    t5 = tasks_data.get("5", {})
    tasks.append({
        "id": 5, "title": t5.get("title", "Plan weekend trip"), "column": "review",
        "tags": t5.get("tags", ["personal", "this-week"]), "createdBy": "Kanbito",
        "createdAt": timestamp, "modifiedAt": timestamp
    })

    # Task 6: Update documentation (done)
    t6 = tasks_data.get("6", {})
    tasks.append({
        "id": 6, "title": t6.get("title", "Update documentation"), "column": "done",
        "tags": t6.get("tags", ["work"]), "createdBy": "Kanbito",
        "createdAt": timestamp, "modifiedAt": timestamp
    })

    # Task 7: Learn a new language (backlog)
    t7 = tasks_data.get("7", {})
    backlog.append({
        "id": 7, "title": t7.get("title", "Learn a new language"), "column": "todo",
        "tags": t7.get("tags", ["personal", "someday"]), "createdBy": "Kanbito",
        "createdAt": timestamp, "modifiedAt": timestamp
    })

    return {
        "columns": [
            {"id": "todo", "title": columns.get("todo", "To Do")},
            {"id": "doing", "title": columns.get("doing", "In Progress")},
            {"id": "review", "title": columns.get("review", "Pending Review")},
            {"id": "done", "title": columns.get("done", "Done")}
        ],
        "tasks": tasks,
        "backlog": backlog,
        "trash": [],
        "nextId": 8
    }


def build_example_notes(lang: str = None) -> dict:
    """Build example notes data from locale file."""
    if lang is None:
        lang = get_current_language()
    locale = load_locale(lang)
    examples = locale.get("examples", {})
    notes_data = examples.get("notes", {})

    timestamp = "2024-01-01T10:00:00.000Z"

    return {
        "notes": [
            {"id": 1, "title": notes_data.get("1", {}).get("title", "Welcome to Notes"), "parentId": None, "order": 0, "collapsed": False, "createdAt": timestamp, "modifiedAt": timestamp},
            {"id": 2, "title": notes_data.get("2", {}).get("title", "Project Ideas"), "parentId": None, "order": 1, "collapsed": False, "createdAt": timestamp, "modifiedAt": timestamp},
            {"id": 3, "title": notes_data.get("3", {}).get("title", "Quick Reference"), "parentId": None, "order": 2, "collapsed": False, "createdAt": timestamp, "modifiedAt": timestamp}
        ],
        "nextNoteId": 4
    }


def get_example_task_descriptions(lang: str = None) -> dict:
    """Get example task descriptions from locale file."""
    if lang is None:
        lang = get_current_language()
    locale = load_locale(lang)
    examples = locale.get("examples", {})
    tasks_data = examples.get("tasks", {})

    return {
        int(task_id): task_data.get("description", "")
        for task_id, task_data in tasks_data.items()
        if task_data.get("description")
    }


def get_example_note_contents(lang: str = None) -> dict:
    """Get example note contents from locale file."""
    if lang is None:
        lang = get_current_language()
    locale = load_locale(lang)
    examples = locale.get("examples", {})
    notes_data = examples.get("notes", {})

    return {
        int(note_id): note_data.get("content", "")
        for note_id, note_data in notes_data.items()
        if note_data.get("content")
    }

app = Flask(__name__,
            static_folder=str(_MODULE_DIR / "static"),
            static_url_path="/static")


def ensure_dirs():
    """Ensure all required directories exist."""
    for d in [get_tasks_dir(), get_notes_dir(), get_images_dir()]:
        try:
            d.mkdir(exist_ok=True)
        except Exception as e:
            print(f"Warning: Could not create {d}: {e}")


def ensure_board_exists():
    """Ensure board.json exists with example content on first run.
    
    Only creates examples on a true first launch (no git repo + no data files).
    Does NOT create examples after a clone or git operation.
    """
    from .git_sync import load_settings, save_settings, is_git_repo

    board_path = get_board_path()
    notes_path = get_notes_path()
    lang = get_current_language()
    created_examples = False

    # Determine if this is a true first launch:
    # - No git repo (user hasn't cloned or started one)
    # - No board.json and no notes.json (no existing data)
    in_git_repo = is_git_repo()
    has_board = board_path.exists()
    has_notes = notes_path.exists()
    
    # Only create examples if:
    # 1. NOT in a git repo (not a cloned/synced setup)
    # 2. AND neither board.json nor notes.json exist
    should_create_examples = (not in_git_repo) and (not has_board) and (not has_notes)

    # If board doesn't exist AND we should create examples, create with examples
    if not has_board and should_create_examples:
        example_board = build_example_board(lang)
        board_path.write_text(
            json.dumps(example_board, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8"
        )
        # Write example task descriptions
        for task_id, content in get_example_task_descriptions(lang).items():
            write_task_md(task_id, content)
        created_examples = True
    elif not has_board and not should_create_examples:
        # In git repo or have partial data - create empty board instead
        board_path.write_text(
            json.dumps(EMPTY_BOARD, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8"
        )

    # If notes don't exist AND we should create examples, create with examples
    if not has_notes and should_create_examples:
        example_notes = build_example_notes(lang)
        notes_path.write_text(
            json.dumps(example_notes, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8"
        )
        # Write example note contents
        for note_id, content in get_example_note_contents(lang).items():
            write_note_md(note_id, content)
        created_examples = True
    elif not has_notes and not should_create_examples:
        # In git repo or have partial data - create empty notes instead
        notes_path.write_text(
            json.dumps(EMPTY_NOTES, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8"
        )

    # Set example tag groups in settings when creating initial examples
    if created_examples:
        locale = load_locale(lang)
        example_tag_groups = locale.get("examples", {}).get("tagGroups", [])
        settings = load_settings()
        # Only set if tagGroups not already configured
        if not settings.get("tagGroups"):
            settings["tagGroups"] = example_tag_groups
            save_settings(settings)


def clear_all_data():
    """Clear all board and notes data to empty state."""
    import shutil

    # Write empty board
    get_board_path().write_text(
        json.dumps(EMPTY_BOARD, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8"
    )

    # Write empty notes
    get_notes_path().write_text(
        json.dumps(EMPTY_NOTES, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8"
    )

    # Clear task descriptions
    tasks_dir = get_tasks_dir()
    if tasks_dir.exists():
        for f in tasks_dir.glob("T*.md"):
            f.unlink()

    # Clear note contents
    notes_dir = get_notes_dir()
    if notes_dir.exists():
        for f in notes_dir.glob("N*.md"):
            f.unlink()

    # Clear images
    images_dir = get_images_dir()
    if images_dir.exists():
        shutil.rmtree(images_dir)
        images_dir.mkdir()


def clear_example_data():
    """Clear only example data (IDs 1-7 for tasks, 1-3 for notes), keeping user content."""
    example_task_ids = {1, 2, 3, 4, 5, 6, 7}
    example_note_ids = {1, 2, 3}

    # Load and filter board data
    board_path = get_board_path()
    if board_path.exists():
        try:
            data = json.loads(board_path.read_text(encoding="utf-8"))

            # Filter out example tasks from all lists
            data["tasks"] = [t for t in data.get("tasks", []) if t["id"] not in example_task_ids]
            data["backlog"] = [t for t in data.get("backlog", []) if t["id"] not in example_task_ids]
            data["trash"] = [t for t in data.get("trash", []) if t["id"] not in example_task_ids]

            # Remove parentId references to example tasks
            for task in data["tasks"] + data["backlog"] + data["trash"]:
                if task.get("parentId") in example_task_ids:
                    task["parentId"] = None

            board_path.write_text(
                json.dumps(data, indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8"
            )
        except Exception as e:
            print(f"Error clearing example tasks: {e}")

    # Delete example task markdown files
    tasks_dir = get_tasks_dir()
    if tasks_dir.exists():
        for task_id in example_task_ids:
            md_path = tasks_dir / f"T{task_id}.md"
            if md_path.exists():
                md_path.unlink()

    # Load and filter notes data
    notes_path = get_notes_path()
    if notes_path.exists():
        try:
            data = json.loads(notes_path.read_text(encoding="utf-8"))

            # Filter out example notes
            data["notes"] = [n for n in data.get("notes", []) if n["id"] not in example_note_ids]

            # Remove parentId references to example notes
            for note in data["notes"]:
                if note.get("parentId") in example_note_ids:
                    note["parentId"] = None

            notes_path.write_text(
                json.dumps(data, indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8"
            )
        except Exception as e:
            print(f"Error clearing example notes: {e}")

    # Delete example note markdown files
    notes_dir = get_notes_dir()
    if notes_dir.exists():
        for note_id in example_note_ids:
            md_path = notes_dir / f"N{note_id}.md"
            if md_path.exists():
                md_path.unlink()

    # Delete example images (folders 1-6)
    images_dir = get_images_dir()
    if images_dir.exists():
        import shutil
        for task_id in example_task_ids:
            img_dir = images_dir / str(task_id)
            if img_dir.exists():
                shutil.rmtree(img_dir)


def restore_example_data():
    """Restore example data in the current language."""
    from .git_sync import load_settings, save_settings

    lang = get_current_language()
    locale = load_locale(lang)

    # Write example board
    example_board = build_example_board(lang)
    get_board_path().write_text(
        json.dumps(example_board, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8"
    )

    # Write example notes
    example_notes = build_example_notes(lang)
    get_notes_path().write_text(
        json.dumps(example_notes, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8"
    )

    # Clear existing and write example task descriptions
    tasks_dir = get_tasks_dir()
    if tasks_dir.exists():
        for f in tasks_dir.glob("T*.md"):
            f.unlink()
    for task_id, content in get_example_task_descriptions(lang).items():
        write_task_md(task_id, content)

    # Clear existing and write example note contents
    notes_dir = get_notes_dir()
    if notes_dir.exists():
        for f in notes_dir.glob("N*.md"):
            f.unlink()
    for note_id, content in get_example_note_contents(lang).items():
        write_note_md(note_id, content)

    # Set example tag groups in settings
    example_tag_groups = locale.get("examples", {}).get("tagGroups", [])
    settings = load_settings()
    settings["tagGroups"] = example_tag_groups
    save_settings(settings)


# --- Markdown file helpers ---

def read_task_md(task_id: int) -> str | None:
    """Read task description from tasks/T{id}.md"""
    md_path = get_tasks_dir() / f"T{task_id}.md"
    if md_path.exists():
        return md_path.read_text(encoding="utf-8")
    return None


def write_task_md(task_id: int, content: str) -> None:
    """Write task description to tasks/T{id}.md"""
    get_tasks_dir().mkdir(exist_ok=True)
    md_path = get_tasks_dir() / f"T{task_id}.md"
    if content and content.strip():
        md_path.write_text(content, encoding="utf-8")
    elif md_path.exists():
        md_path.unlink()


def delete_task_md(task_id: int) -> None:
    """Delete task markdown file"""
    md_path = get_tasks_dir() / f"T{task_id}.md"
    if md_path.exists():
        md_path.unlink()


def read_note_md(note_id: int) -> str | None:
    """Read note content from notes/N{id}.md"""
    md_path = get_notes_dir() / f"N{note_id}.md"
    if md_path.exists():
        return md_path.read_text(encoding="utf-8")
    return None


def write_note_md(note_id: int, content: str) -> None:
    """Write note content to notes/N{id}.md"""
    get_notes_dir().mkdir(exist_ok=True)
    md_path = get_notes_dir() / f"N{note_id}.md"
    if content and content.strip():
        md_path.write_text(content, encoding="utf-8")
    elif md_path.exists():
        md_path.unlink()


def delete_note_md(note_id: int) -> None:
    """Delete note markdown file"""
    md_path = get_notes_dir() / f"N{note_id}.md"
    if md_path.exists():
        md_path.unlink()


HTML = r"""<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kanbito</title>
<script src="https://cdn.jsdelivr.net/npm/marked@15/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/i18next@23/i18next.min.js"></script>
<link rel="stylesheet" href="/static/style.css">
</head>
<body>

<div id="splash" style="position:fixed;inset:0;background:#0d1117;display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999">
  <img src="/static/logo.png" alt="Kanbito" style="width:120px;height:120px;margin-bottom:1rem;border-radius:16px">
  <div class="splash-spinner"></div>
</div>

<div id="syncOverlay" class="sync-overlay">
  <div class="sync-overlay-content">
    <div class="sync-spinner"></div>
    <span data-i18n="git.syncing">Syncing...</span>
  </div>
</div>

<header style="visibility:hidden">
  <div class="header-left">
    <div class="header-brand">
      <img src="/static/logo.png" alt="Kanbito" class="header-logo">
      <h1>anbito</h1>
    </div>
    <nav class="header-nav">
      <button class="nav-tab active" data-view="board" onclick="switchView('board')">
        <svg class="nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <rect x="3" y="3" width="7" height="7" rx="1"/>
          <rect x="14" y="3" width="7" height="7" rx="1"/>
          <rect x="3" y="14" width="7" height="7" rx="1"/>
          <rect x="14" y="14" width="7" height="7" rx="1"/>
        </svg>
        <span data-i18n="app.board">Board</span>
      </button>
      <button class="nav-tab" data-view="notes" onclick="switchView('notes')">
        <svg class="nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
        <span data-i18n="app.notes">Notes</span>
      </button>
    </nav>
  </div>
  <div class="header-right">
    <div class="git-sync-container" id="gitSyncContainer" style="display:none">
      <button class="git-sync-btn" id="gitSyncBtn" onclick="gitSync()" data-i18n-title="git.sync" title="Sync">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z"/>
        </svg>
        <span id="gitSyncLabel">Sync</span>
      </button>
      <span class="git-status-indicator" id="gitStatusIndicator"></span>
      <div class="undo-container">
        <button class="undo-btn" id="undoBtn" onclick="showUndoConfirm()" style="display:none" title="Undo">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1a7 7 0 1 0 7 7.001h-1.5A5.5 5.5 0 1 1 8 2.5V5l4-3-4-3v2Z"/>
          </svg>
          <span data-i18n="backup.undo">Undo</span>
        </button>
        <div class="undo-confirm-popover" id="undoConfirmPopover">
          <p data-i18n="backup.confirmUndo">Undo the last sync? This will restore your previous data.</p>
          <div class="undo-confirm-actions">
            <button class="btn-cancel" onclick="hideUndoConfirm()" data-i18n="task.cancel">Cancel</button>
            <button class="btn-primary" onclick="confirmUndo()" data-i18n="conflict.confirmBtn">Yes, continue</button>
          </div>
        </div>
      </div>
    </div>
    <div class="clear-examples-container" id="clearExamplesContainer" style="display:none">
      <button class="clear-examples-btn icon-btn" id="headerClearExamplesBtn" onclick="clearExamplesFromHeader()" title="Clear Examples">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M7.657 6.247c.11-.33.576-.33.686 0l.645 1.937a2.89 2.89 0 0 0 1.828 1.828l1.937.645c.33.11.33.576 0 .686l-1.937.645a2.89 2.89 0 0 0-1.828 1.828l-.645 1.937a.361.361 0 0 1-.686 0l-.645-1.937a2.89 2.89 0 0 0-1.828-1.828l-1.937-.645a.361.361 0 0 1 0-.686l1.937-.645a2.89 2.89 0 0 0 1.828-1.828l.645-1.937zM3.794 1.148a.217.217 0 0 1 .412 0l.387 1.162c.173.518.579.924 1.097 1.097l1.162.387a.217.217 0 0 1 0 .412l-1.162.387A1.734 1.734 0 0 0 4.593 5.69l-.387 1.162a.217.217 0 0 1-.412 0L3.407 5.69a1.734 1.734 0 0 0-1.097-1.097l-1.162-.387a.217.217 0 0 1 0-.412l1.162-.387A1.734 1.734 0 0 0 3.407 2.31l.387-1.162z"/>
        </svg>
      </button>
      <div class="clear-examples-tooltip" id="clearExamplesTooltip"></div>
    </div>
    <button class="icon-btn" id="settingsBtn" onclick="openGitSettings()" title="Settings">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492ZM5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0Z"/>
        <path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52l-.094-.319Zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 2.693 1.115l.291-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 0 0 1.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 0 0-1.115 2.693l.16.291c.415.764-.42 1.6-1.185 1.184l-.291-.159a1.873 1.873 0 0 0-2.693 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 0 0-2.692-1.115l-.292.16c-.764.415-1.6-.42-1.184-1.185l.159-.291A1.873 1.873 0 0 0 1.945 8.93l-.319-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 0 0 3.06 4.377l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 0 0 2.692-1.115l.094-.319Z"/>
      </svg>
    </button>
    <div class="user-badge" id="userBadge" title="Username">
      <span class="user-dot" id="userDot"></span>
      <span id="userName"></span>
    </div>
    <span class="save-indicator" id="saveIndicator"></span>
  </div>
</header>

<div id="boardView" style="visibility:hidden">
  <div class="board" id="board"></div>
  <div class="filter-fab" id="filterFab" onclick="event.stopPropagation(); toggleFilterPanel()">
    <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
      <path d="M6 10.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 0 1h-3a.5.5 0 0 1-.5-.5zm-2-3a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5zm-2-3a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5z"/>
    </svg>
    <span class="filter-fab-badge" id="filterFabBadge"></span>
  </div>
  <div class="filter-panel" id="filterPanel" onclick="event.stopPropagation()"></div>
  <div class="resize-handle" id="resizeHandle"></div>
  <div class="bottom-panel" id="bottomPanel">
    <div class="backlog-section" id="backlogSection"></div>
    <div class="trash-section" id="trashSection" style="display:none"></div>
  </div>
</div>

<div id="notesView" style="display:none">
  <div class="notes-layout">
    <div class="notes-sidebar" id="notesSidebar">
      <div class="notes-sidebar-header">
        <span data-i18n="notes.title">Notes</span>
        <button id="addRootNote" data-i18n-title="notes.new" title="New note">+</button>
      </div>
      <div class="notes-tree" id="notesTree"></div>
    </div>
    <div class="notes-content" id="notesContent">
      <div class="notes-empty-state" id="notesEmptyState">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
        </svg>
        <span data-i18n="notes.select">Select a note</span>
      </div>
      <div class="notes-editor" id="notesEditor" style="display:none">
        <div class="notes-editor-header">
          <div class="notes-breadcrumb" id="notesBreadcrumb"></div>
          <div class="notes-editor-actions">
            <button id="noteAddChildBtn" onclick="addChildNote()" data-i18n="notes.addChild">+ Sub-note</button>
            <button id="noteDeleteBtn" onclick="deleteCurrentNote()" data-i18n="notes.delete">Delete</button>
          </div>
        </div>
        <div class="notes-title-row" id="notesTitleRow">
          <span class="notes-title-id" id="notesTitleId"></span>
          <h2 class="notes-title-display clickable-text" id="notesTitleDisplay" onclick="toggleNoteEdit(event)"></h2>
          <input type="text" class="notes-title-input" id="notesTitleInput" style="display:none" data-i18n-placeholder="notes.titlePlaceholder" placeholder="Note title">
        </div>
        <div class="notes-meta" id="notesMeta"></div>
        <div class="notes-md-toolbar" id="notesMdToolbar" style="display:none"></div>
        <div class="notes-rendered detail-body clickable-text" id="noteRendered" onclick="toggleNoteEdit(event)"></div>
        <textarea class="notes-textarea" id="noteTextarea" style="display:none" data-i18n-placeholder="notes.contentPlaceholder" placeholder="Content in Markdown..."></textarea>
        <div class="paste-hint" id="notesPasteHint" style="display:none" data-i18n="task.pasteHint">Paste images directly with Ctrl+V</div>
        <div class="notes-edit-buttons" id="notesEditButtons" style="display:none">
          <button class="btn-cancel" onclick="cancelNoteEdit()" data-i18n="task.cancel">Cancel</button>
          <button class="btn-save" onclick="saveNoteEdit()" data-i18n="task.save">Save</button>
        </div>
      </div>
    </div>
  </div>
</div>

<div class="modal-backdrop" id="detailBackdrop">
  <div class="detail-modal">
    <div class="detail-header">
      <h2 id="detailTitle" class="clickable-text" onclick="editFromDetail(event)"></h2>
      <div class="detail-header-actions">
        <button id="detailBacklogBtn" onclick="backlogFromDetail()" data-i18n="task.backlog">Backlog</button>
        <button onclick="closeDetail()" data-i18n="task.close">Close</button>
      </div>
    </div>
    <div class="detail-meta">
      <span class="detail-column-badge" id="detailColumn"></span>
      <span id="detailTags"></span>
      <span class="detail-dates" id="detailDates"></span>
    </div>
    <div class="detail-body clickable-text" id="detailBody" onclick="editFromDetail(event)"></div>
    <div class="comments-section" id="commentsSection">
      <div class="comments-title" id="commentsTitle" data-i18n="comments.title">Comments</div>
      <div id="commentsList"></div>
      <div id="commentToolbar"></div>
      <div class="comment-input-row">
        <textarea id="commentInput" data-i18n-placeholder="comments.placeholder" placeholder="Write a comment (supports Markdown)..." rows="2"></textarea>
        <button onclick="addComment()" data-i18n="comments.send">Send</button>
      </div>
    </div>
  </div>
</div>

<div class="modal-backdrop" id="modalBackdrop">
  <div class="modal">
    <h2 id="modalTitle" data-i18n="task.new">New task</h2>
    <label for="taskTitle" data-i18n="task.title">Title</label>
    <input type="text" id="taskTitle" data-i18n-placeholder="task.titlePlaceholder" placeholder="Task title" />
    <label for="taskDesc" data-i18n="task.description">Description (optional, supports Markdown)</label>
    <div class="md-toolbar">
      <button type="button" onclick="mdInsert('**','**')" title="Negrita"><b>B</b></button>
      <button type="button" onclick="mdInsert('_','_')" title="Cursiva"><i>I</i></button>
      <button type="button" onclick="mdInsert('`','`')" title="Codigo inline">&lt;/&gt;</button>
      <button type="button" onclick="mdInsert('\n```\n','\n```\n')" title="Bloque de codigo">```</button>
      <button type="button" onclick="mdInsert('\n- ','')" title="Lista">- Lista</button>
      <button type="button" onclick="mdInsert('\n- [ ] ','')" title="Checklist">[ ] Check</button>
      <button type="button" onclick="mdInsert('\n## ','')" title="Titulo">H2</button>
      <button type="button" onclick="mdInsert('[','](url)')" title="Link">Link</button>
    </div>
    <textarea id="taskDesc" data-i18n-placeholder="task.descPlaceholder" placeholder="Details, user story, notes..."></textarea>
    <div class="paste-hint" data-i18n="task.pasteHint">Paste images directly with Ctrl+V</div>
    <label data-i18n="task.tags">Tags</label>
    <div class="tags-container" id="tagsContainer"></div>
    <input type="text" class="tags-input" id="tagsInput" data-i18n-placeholder="task.tagsPlaceholder" placeholder="Type a tag and press Enter or comma" />
    <div class="modal-buttons">
      <button class="btn-cancel" onclick="closeModal()" data-i18n="task.cancel">Cancel</button>
      <button class="btn-save" id="modalSave" onclick="saveModal()" data-i18n="task.save">Save</button>
    </div>
  </div>
</div>

<div class="modal-backdrop" id="gitSettingsBackdrop">
  <div class="modal settings-modal">
    <div class="settings-header">
      <h2>Settings</h2>
      <button class="settings-close-btn" onclick="closeGitSettings()" title="Close">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/>
        </svg>
      </button>
    </div>

    <!-- Profile Row: Username + Language side by side -->
    <div class="settings-profile-row">
      <div class="settings-field settings-username">
        <label id="settingsUserTitle">Username</label>
        <div class="username-input-row">
          <span class="user-dot-preview" id="userDotPreview"></span>
          <input type="text" id="usernameInput" data-i18n-placeholder="settings.usernamePlaceholder" placeholder="Your name" onchange="updateUsernamePreview()" oninput="updateUsernamePreview()" />
        </div>
      </div>
      <div class="settings-field settings-language">
        <label id="settingsLangTitle">Language</label>
        <select id="languageSelect" onchange="onLanguageChange()">
          <option value="en">🇺🇸 English</option>
          <option value="zh">🇨🇳 中文</option>
          <option value="hi">🇮🇳 हिन्दी</option>
          <option value="es">🇦🇷 Español</option>
          <option value="ar">🇪🇬 العربية</option>
          <option value="it">🇮🇹 Italiano</option>
          <option value="fr">🇫🇷 Français</option>
          <option value="de">🇩🇪 Deutsch</option>
          <option value="pt">🇧🇷 Português</option>
          <option value="ja">🇯🇵 日本語</option>
          <option value="ko">🇰🇷 한국어</option>
          <option value="ru">🇷🇺 Русский</option>
          <option value="id">🇮🇩 Bahasa Indonesia</option>
          <option value="tr">🇹🇷 Türkçe</option>
          <option value="vi">🇻🇳 Tiếng Việt</option>
          <option value="pl">🇵🇱 Polski</option>
          <option value="bn">🇧🇩 বাংলা</option>
          <option value="he">🇮🇱 עברית</option>
          <option value="fa">🇮🇷 فارسی</option>
          <option value="ur">🇵🇰 اردو</option>
        </select>
      </div>
    </div>

    <!-- Show Sections Row -->
    <div class="settings-sections-row">
      <div class="section-picker">
        <button class="section-pick active" id="pickBoth" onclick="pickSections('both')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
            <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
          </svg>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-left:-4px">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
          <span data-i18n="welcome.both">Both</span>
        </button>
        <button class="section-pick" id="pickBoard" onclick="pickSections('board')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
            <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
          </svg>
          <span data-i18n="app.board">Board</span>
        </button>
        <button class="section-pick" id="pickNotes" onclick="pickSections('notes')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
          <span data-i18n="app.notes">Notes</span>
        </button>
      </div>
    </div>

    <!-- GitHub Sync Section -->
    <div class="settings-section" id="gitSyncSection">
      <div class="settings-section-header" onclick="toggleGitSection()">
        <h3>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" class="github-icon">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
          </svg>
          GitHub Sync
        </h3>
        <svg class="chevron" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M12.78 5.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 6.28a.749.749 0 1 1 1.06-1.06L8 8.94l3.72-3.72a.749.749 0 0 1 1.06 0Z"/>
        </svg>
      </div>

      <div class="settings-section-content" id="gitSyncContent">
        <div class="settings-field">
          <label for="gitRepoInput" id="gitRepoLabel">GitHub Repository</label>
          <input type="text" id="gitRepoInput" placeholder="user/repo or paste URL" oninput="onRepoInputChange()" />
        </div>

        <div class="settings-field git-connect-row" id="gitIdentityField" style="display:none">
          <label for="gitIdentitySelect" id="gitIdentityLabel">Connect via</label>
          <div class="git-connect-controls">
            <select id="gitIdentitySelect" onchange="onIdentityChange()">
              <option value="">Loading...</option>
            </select>
            <button class="btn-icon" id="gitTestBtn" onclick="testGitConnection()" title="Test Connection">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M4 2.5a.5.5 0 0 1 .78-.42l8 5a.5.5 0 0 1 0 .84l-8 5A.5.5 0 0 1 4 12.5v-10z"/>
              </svg>
            </button>
            <button class="btn-icon" id="githubBtn" onclick="openGitHubRepo()" data-i18n-title="settings.openOnGitHub" title="Open on GitHub" style="display:none">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
              </svg>
            </button>
            <button class="btn-small btn-success" id="gitCreateRepoBtn" onclick="createGitHubRepo()" style="display:none">Create</button>
          </div>
        </div>

        <input type="hidden" id="gitRemoteInput" />
        <input type="hidden" id="gitEnabledCheckbox" checked />
        <div class="git-test-result" id="gitTestResult"></div>
      </div>
    </div>

    <!-- Footer -->
    <div class="settings-footer">
      <div class="settings-footer-left">
        <button class="btn-small btn-restore" id="restoreBackupBtn" onclick="restoreBackup()" style="display:none" data-i18n="backup.restore">
          Restore previous state
        </button>
      </div>
      <button class="btn-small btn-primary" id="gitSaveBtn" onclick="saveGitSettings()">Save</button>
    </div>
  </div>
</div>

<div class="modal-backdrop" id="conflictBackdrop">
  <div class="modal conflict-modal">
    <div class="conflict-header">
      <span class="conflict-icon">⚠️</span>
      <h2 data-i18n="conflict.title">Sync Conflict</h2>
    </div>
    <p class="conflict-desc" data-i18n="conflict.description">Your data and cloud data have both changed. What would you like to do?</p>

    <div class="conflict-options" id="conflictOptions">
      <button class="conflict-option" onclick="showConflictConfirm('keep_local')">
        <div class="conflict-option-title" data-i18n="conflict.keepLocal">Keep yours</div>
        <div class="conflict-option-desc" data-i18n="conflict.keepLocalDesc">Upload your version to the cloud</div>
      </button>

      <div class="conflict-cloud-row">
        <button class="conflict-option recommended" onclick="resolveConflict('keep_remote')">
          <div class="conflict-option-title">
            <span data-i18n="conflict.keepCloudBackup">Keep cloud + backup</span>
            <span class="recommended-badge" data-i18n="conflict.recommended">Recommended</span>
          </div>
          <div class="conflict-option-desc" data-i18n="conflict.keepCloudBackupDesc">Download cloud version, your changes are saved (use Undo to restore)</div>
        </button>
        <button class="conflict-option conflict-option-small" onclick="showConflictConfirm('keep_remote_no_backup')">
          <div class="conflict-option-title" data-i18n="conflict.keepCloud">Keep cloud</div>
          <div class="conflict-option-desc" data-i18n="conflict.keepCloudDesc">Discard your changes</div>
        </button>
      </div>
    </div>

    <div class="conflict-confirm" id="conflictConfirm" style="display:none">
      <p class="conflict-confirm-msg" id="conflictConfirmMsg"></p>
      <div class="conflict-confirm-actions">
        <button class="btn-cancel" onclick="hideConflictConfirm()" data-i18n="task.cancel">Cancel</button>
        <button class="btn-danger" id="conflictConfirmBtn" data-i18n="conflict.confirmBtn">Yes, continue</button>
      </div>
    </div>

    <button class="diff-toggle" onclick="toggleDiffViewer()" id="diffToggleBtn">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" class="diff-toggle-icon">
        <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"/>
      </svg>
      <span data-i18n="conflict.showDiff">Show differences</span>
    </button>

    <div class="diff-viewer-container" id="diffViewerContainer" style="display:none">
      <div class="diff-panel">
        <div class="diff-panel-header" data-i18n="conflict.myChanges">Your edits</div>
        <div class="diff-legend">
          <span class="diff-legend-del" data-i18n="conflict.legendLocalDel">Was</span>
          <span class="diff-legend-add" data-i18n="conflict.legendLocalAdd">You changed to</span>
        </div>
        <pre class="diff-content" id="diffLocal"></pre>
      </div>
      <div class="diff-panel">
        <div class="diff-panel-header" data-i18n="conflict.cloudChanges">Cloud edits</div>
        <div class="diff-legend">
          <span class="diff-legend-del" data-i18n="conflict.legendRemoteDel">Was</span>
          <span class="diff-legend-add" data-i18n="conflict.legendRemoteAdd">Cloud changed to</span>
        </div>
        <pre class="diff-content" id="diffRemote"></pre>
      </div>
    </div>

    <button class="conflict-cancel" onclick="resolveConflict('keep_both')" data-i18n="conflict.decideLater">Decide later</button>
  </div>
</div>

<div class="modal-backdrop" id="welcomeBackdrop">
  <div class="modal welcome-modal">
    <!-- Step 1: Language Selection -->
    <div id="welcomeStep1">
      <h2>Welcome to Kanbito! / ¡Bienvenido!</h2>
      <p class="welcome-subtitle">Select your language / Seleccioná tu idioma</p>

      <div class="lang-grid">
        <button class="lang-btn" onclick="selectLanguage('en')">🇺🇸 English</button>
        <button class="lang-btn" onclick="selectLanguage('es')">🇦🇷 Español</button>
        <button class="lang-btn" onclick="selectLanguage('zh')">🇨🇳 中文</button>
        <button class="lang-btn" onclick="selectLanguage('hi')">🇮🇳 हिन्दी</button>
        <button class="lang-btn" onclick="selectLanguage('ar')">🇪🇬 العربية</button>
        <button class="lang-btn" onclick="selectLanguage('pt')">🇧🇷 Português</button>
        <button class="lang-btn" onclick="selectLanguage('fr')">🇫🇷 Français</button>
        <button class="lang-btn" onclick="selectLanguage('de')">🇩🇪 Deutsch</button>
        <button class="lang-btn" onclick="selectLanguage('it')">🇮🇹 Italiano</button>
        <button class="lang-btn" onclick="selectLanguage('ja')">🇯🇵 日本語</button>
        <button class="lang-btn" onclick="selectLanguage('ko')">🇰🇷 한국어</button>
        <button class="lang-btn" onclick="selectLanguage('ru')">🇷🇺 Русский</button>
        <button class="lang-btn" onclick="selectLanguage('id')">🇮🇩 Indonesia</button>
        <button class="lang-btn" onclick="selectLanguage('tr')">🇹🇷 Türkçe</button>
        <button class="lang-btn" onclick="selectLanguage('vi')">🇻🇳 Tiếng Việt</button>
        <button class="lang-btn" onclick="selectLanguage('pl')">🇵🇱 Polski</button>
        <button class="lang-btn" onclick="selectLanguage('bn')">🇧🇩 বাংলা</button>
        <button class="lang-btn" onclick="selectLanguage('he')">🇮🇱 עברית</button>
        <button class="lang-btn" onclick="selectLanguage('fa')">🇮🇷 فارسی</button>
        <button class="lang-btn" onclick="selectLanguage('ur')">🇵🇰 اردو</button>
      </div>
    </div>

    <!-- Step 2: Setup (Experience, Name, Data Folder) -->
    <div id="welcomeStep2" style="display:none">
      <h2 data-i18n="welcome.setupPrefs">Set up your preferences</h2>

      <label for="welcomeUsername" data-i18n="welcome.yourName">Your name</label>
      <input type="text" id="welcomeUsername" data-i18n-placeholder="welcome.yourNamePlaceholder" placeholder="Enter your name" />

      <label data-i18n="welcome.whatWillYouUse">What will you use Kanbito for?</label>
      <div class="experience-options-compact">
        <button class="experience-option-compact selected" data-exp="both" onclick="selectExperienceCompact(this, 'both')">
          <span data-i18n="welcome.both">Both</span>
        </button>
        <button class="experience-option-compact" data-exp="board" onclick="selectExperienceCompact(this, 'board')">
          <span data-i18n="welcome.boardOnly">Board only</span>
        </button>
        <button class="experience-option-compact" data-exp="notes" onclick="selectExperienceCompact(this, 'notes')">
          <span data-i18n="welcome.notesOnly">Notes only</span>
        </button>
      </div>

      <label for="welcomeDataDir" data-i18n="welcome.dataFolder">Data folder</label>
      <div class="data-dir-row">
        <input type="text" id="welcomeDataDir" readonly />
        <button type="button" class="folder-picker-btn" onclick="pickDataFolder()" title="Browse...">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h2.764c.958 0 1.76.56 2.311 1.184C7.604 3.217 7.663 3.5 8 3.5h4.5A1.5 1.5 0 0 1 14 5v7.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 0 12.5v-9A1.5 1.5 0 0 1 1.5 2h.5v1.5H1.5a.5.5 0 0 0-.5.5v8a.5.5 0 0 0 .5.5h11a.5.5 0 0 0 .5-.5V5a.5.5 0 0 0-.5-.5H8c-.964 0-1.71-.552-2.199-1.124C5.584 3.123 5.416 3 5.264 3H2.5a.5.5 0 0 0-.5.5V5H1V3.5z"/>
          </svg>
        </button>
      </div>
      <p class="welcome-hint" data-i18n="welcome.dataFolderHint">Where your tasks and notes will be saved</p>

      <label for="welcomeGitRepo" data-i18n="welcome.gitRepo">Sync with GitHub (optional)</label>
      <input type="text" id="welcomeGitRepo" data-i18n-placeholder="welcome.gitRepoPlaceholder" placeholder="user/repo or https://github.com/user/repo" oninput="onWelcomeRepoInput()" />
      <div class="welcome-identity-row" id="welcomeIdentityRow" style="display:none">
        <label for="welcomeIdentity" data-i18n="welcome.connectVia">Connect via</label>
        <select id="welcomeIdentity">
          <option value="">Loading...</option>
        </select>
      </div>
      <p class="welcome-hint" data-i18n="welcome.gitRepoHint">Clone an existing Kanbito repo to sync across devices</p>

      <div class="modal-buttons">
        <button class="btn-cancel" onclick="welcomeBack()" data-i18n="welcome.back">Back</button>
        <button class="btn-save" id="welcomeStart" onclick="completeWelcome()" data-i18n="welcome.getStarted">Get Started</button>
      </div>
    </div>
  </div>
</div>

<div class="modal-backdrop" id="confirmBackdrop">
  <div class="modal confirm-modal">
    <p id="confirmMessage"></p>
    <div class="confirm-actions">
      <button class="btn-cancel" onclick="hideConfirmDialog()" data-i18n="task.cancel">Cancel</button>
      <button class="btn-primary" id="confirmOkBtn" onclick="confirmDialogOk()" data-i18n="conflict.confirmBtn">Yes, continue</button>
    </div>
  </div>
</div>

<div class="modal-backdrop" id="alertBackdrop">
  <div class="modal alert-modal">
    <p id="alertMessage"></p>
    <div class="alert-actions">
      <button class="btn-primary" onclick="hideAlertDialog()">OK</button>
    </div>
  </div>
</div>

<div class="modal-backdrop" id="tagGroupsBackdrop">
  <div class="modal tag-groups-modal">
    <div class="tag-groups-header">
      <h2 data-i18n="filter.manageGroups">Manage Tag Groups</h2>
      <button class="settings-close-btn" onclick="closeTagGroupsModal()" title="Close">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/>
        </svg>
      </button>
    </div>
    <div class="tag-groups-content" id="tagGroupsContent"></div>
    <div class="tag-groups-footer">
      <button class="btn-small" onclick="addTagGroup()">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
          <path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z"/>
        </svg>
        <span data-i18n="filter.addGroup">Add Group</span>
      </button>
      <button class="btn-small btn-primary" onclick="saveTagGroups()" data-i18n="settings.save">Save</button>
    </div>
  </div>
</div>

<script src="/static/i18n.js"></script>
<script src="/static/notes.js"></script>
<script src="/static/app.js"></script>
</body>
</html>"""


@app.route("/")
def index():
    return Response(HTML, content_type="text/html; charset=utf-8")


@app.route("/api/board", methods=["GET"])
def get_board():
    ensure_board_exists()
    data = json.loads(get_board_path().read_text(encoding="utf-8"))
    # Load descriptions from MD files
    for task in data.get("tasks", []) + data.get("backlog", []) + data.get("trash", []):
        md_content = read_task_md(task["id"])
        if md_content is not None:
            task["description"] = md_content
    return Response(json.dumps(data), content_type="application/json")


@app.route("/api/board", methods=["POST"])
def save_board():
    data = request.get_json()
    # Track which task IDs exist in the new data
    current_ids = set()
    # Extract descriptions to MD files
    for task in data.get("tasks", []) + data.get("backlog", []) + data.get("trash", []):
        current_ids.add(task["id"])
        desc = task.pop("description", None)
        if desc is not None:
            write_task_md(task["id"], desc)
    # Save metadata to JSON
    get_board_path().write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return Response(json.dumps({"ok": True}), content_type="application/json")


@app.route("/api/notes", methods=["GET"])
def get_notes():
    notes_path = get_notes_path()
    if not notes_path.exists():
        return Response(json.dumps(EMPTY_NOTES), content_type="application/json")
    data = json.loads(notes_path.read_text(encoding="utf-8"))
    # Load content from MD files
    for note in data.get("notes", []):
        md_content = read_note_md(note["id"])
        if md_content is not None:
            note["content"] = md_content
    return Response(json.dumps(data), content_type="application/json")


@app.route("/api/notes", methods=["POST"])
def save_notes():
    data = request.get_json()
    # Track which note IDs exist
    current_ids = set()
    # Extract content to MD files
    for note in data.get("notes", []):
        current_ids.add(note["id"])
        content = note.pop("content", None)
        if content is not None:
            write_note_md(note["id"], content)
    # Save metadata to JSON
    get_notes_path().write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return Response(json.dumps({"ok": True}), content_type="application/json")


@app.route("/api/images/<task_id>", methods=["POST"])
def upload_image(task_id: str):
    import time
    file = request.files.get("image")
    if not file:
        return Response(json.dumps({"error": "no image"}), status=400)
    task_dir = get_images_dir() / str(task_id)
    task_dir.mkdir(parents=True, exist_ok=True)
    ext = file.content_type.split("/")[-1].replace("jpeg", "jpg")
    filename = f"{int(time.time() * 1000)}.{ext}"
    filepath = task_dir / filename
    file.save(str(filepath))
    return Response(
        json.dumps({"path": f"/images/{task_id}/{filename}"}),
        content_type="application/json",
    )


@app.route("/images/<task_id>/<filename>")
def serve_image(task_id: str, filename: str):
    filepath = get_images_dir() / str(task_id) / filename
    if not filepath.is_file():
        return Response("Not found", status=404)
    import mimetypes
    mime = mimetypes.guess_type(str(filepath))[0] or "image/png"
    return Response(filepath.read_bytes(), content_type=mime)


@app.route("/favicon.ico")
def favicon():
    return Response("", status=204)


def has_example_data() -> bool:
    """Check if example tasks or notes exist in current data.
    
    Only returns True if:
    1. Not in a git repo (i.e., not a cloned/synced setup)
    2. AND example task/note IDs are present
    
    This prevents showing "clear examples" button on cloned data
    where IDs 1-7 might be legitimate user content.
    """
    # If in a git repo, don't show clear examples button
    # (it's a cloned/synced repo, not a fresh example install)
    from .git_sync import is_git_repo
    if is_git_repo():
        return False

    # Check for example task IDs (1-7)
    board_path = get_board_path()
    if board_path.exists():
        try:
            data = json.loads(board_path.read_text(encoding="utf-8"))
            example_task_ids = {1, 2, 3, 4, 5, 6, 7}
            all_tasks = data.get("tasks", []) + data.get("backlog", [])
            current_ids = {t["id"] for t in all_tasks}
            if example_task_ids & current_ids:  # Intersection
                return True
        except Exception:
            pass

    # Check for example note IDs (1-3)
    notes_path = get_notes_path()
    if notes_path.exists():
        try:
            data = json.loads(notes_path.read_text(encoding="utf-8"))
            example_note_ids = {1, 2, 3}
            current_ids = {n["id"] for n in data.get("notes", [])}
            if example_note_ids & current_ids:
                return True
        except Exception:
            pass

    return False


@app.route("/api/has-examples", methods=["GET"])
def check_examples():
    """Check if example data exists."""
    return Response(
        json.dumps({"has_examples": has_example_data()}),
        content_type="application/json"
    )


@app.route("/api/reset", methods=["POST"])
def reset_data():
    """Reset data based on mode."""
    data = request.get_json() or {}
    mode = data.get("mode", "empty")

    if mode == "examples":
        restore_example_data()
        return Response(
            json.dumps({"ok": True, "message": "Restored example data"}),
            content_type="application/json"
        )
    elif mode == "clear_examples":
        clear_example_data()
        return Response(
            json.dumps({"ok": True, "message": "Example data cleared"}),
            content_type="application/json"
        )
    else:
        clear_all_data()
        return Response(
            json.dumps({"ok": True, "message": "All data cleared"}),
            content_type="application/json"
        )


@app.route("/api/data-dir", methods=["GET"])
def get_data_directory():
    """Get the current data directory path."""
    return Response(
        json.dumps({"path": str(get_data_dir())}),
        content_type="application/json"
    )


@app.route("/api/data-dir", methods=["POST"])
def change_data_directory():
    """Change the data directory at runtime."""
    data = request.get_json() or {}
    new_path = data.get("path", "").strip()

    if not new_path:
        return Response(
            json.dumps({"error": "Path is required"}),
            status=400,
            content_type="application/json"
        )

    try:
        # Set the new data directory
        set_data_dir(new_path)

        # Ensure required directories exist
        ensure_dirs()

        # Check if board exists, if not create with examples
        ensure_board_exists()

        # Save config for next launch
        config_file = Path.home() / '.kanbito-config'
        config_file.write_text(str(get_data_dir()))

        return Response(
            json.dumps({"ok": True, "path": str(get_data_dir())}),
            content_type="application/json"
        )
    except Exception as e:
        return Response(
            json.dumps({"error": str(e)}),
            status=500,
            content_type="application/json"
        )


# Register git sync routes
from . import git_sync
git_sync.register_routes(app)
