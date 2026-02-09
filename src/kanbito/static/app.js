let board = { columns: [], tasks: [], archived: [], nextId: 1 };
let editingTaskId = null;
let addingToColumn = null;
let addingToParent = null;
let viewingTaskId = null;
let viewingSource = 'tasks'; // 'tasks' | 'backlog' | 'trash'
let showTrash = false;
let modalTags = [];
let currentUser = localStorage.getItem('kanban_user') || '';
let backlogHeight = parseInt(localStorage.getItem('kanban_backlogHeight')) || 200;
let backlogCollapsed = localStorage.getItem('kanban_backlogCollapsed') === 'true';
let currentView = localStorage.getItem('kanban_view') || 'board';

// --- Git Sync State ---
let gitStatus = { enabled: false, is_repo: false, branch: null, changes: 0, ahead: 0, behind: 0, remote: null };
let gitSettings = { git_enabled: false, git_remote: '' };
let gitSyncing = false;
let hasExamples = false;

// --- Tag Filter State ---
let allUniqueTags = [];      // [{tag, count}] - all tags from tasks, sorted by frequency
let selectedTags = [];       // Currently selected tags for filtering
let tagGroups = [];          // [{id, name, tags}] - loaded from settings
let tagFilterMode = 'or';    // 'or' | 'and'
let filterPanelOpen = false;

// --- Utilities ---

function stringToColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = ((hash % 360) + 360) % 360;
  return `hsl(${h}, 70%, 60%)`;
}

function stringToColorAlpha(str, alpha) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = ((hash % 360) + 360) % 360;
  return `hsla(${h}, 70%, 60%, ${alpha})`;
}

function now() { return new Date().toISOString(); }

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function daysBetween(iso1, iso2) {
  return (new Date(iso2) - new Date(iso1)) / (1000 * 60 * 60 * 24);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function getSourceList(source) {
  if (source === 'backlog') return board.backlog;
  if (source === 'trash') return board.trash;
  return board.tasks;
}

// --- Subtask helpers ---

function getTaskChildren(parentId, source = 'tasks') {
  const list = getSourceList(source);
  return list.filter(t => t.parentId === parentId);
}

function getAllDescendants(taskId, source = 'tasks') {
  const descendants = [];
  const children = getTaskChildren(taskId, source);
  for (const child of children) {
    descendants.push(child);
    descendants.push(...getAllDescendants(child.id, source));
  }
  return descendants;
}

function getTaskAncestors(taskId, source = 'tasks') {
  const ancestors = [];
  const list = getSourceList(source);
  let task = list.find(t => t.id === taskId);
  while (task && task.parentId) {
    task = list.find(t => t.id === task.parentId);
    if (task) ancestors.unshift(task);
  }
  return ancestors;
}

function getRootTasksInColumn(colId) {
  return board.tasks.filter(t => t.column === colId && !t.parentId);
}

function getTaskDepth(taskId, source = 'tasks') {
  return getTaskAncestors(taskId, source).length;
}

function descriptionPreview(desc) {
  if (!desc) return '';
  const lines = desc.split('\n');
  for (const line of lines) {
    const stripped = line.replace(/^#+\s*/, '').replace(/\*\*/g, '').replace(/_/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^-\s*\[.\]\s*/, '').replace(/^-\s*/, '').trim();
    if (stripped) return stripped;
  }
  return '';
}

// --- Tag Filter Functions ---

function collectAllUniqueTags() {
  const tagCounts = {};
  const allTasks = [...board.tasks, ...board.backlog, ...(board.trash || [])];
  for (const task of allTasks) {
    for (const tag of (task.tags || [])) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
  }
  // Sort by frequency (descending), then alphabetically
  allUniqueTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, count]) => ({ tag, count }));
}

function taskMatchesFilter(task) {
  if (selectedTags.length === 0) return true;
  const taskTags = task.tags || [];
  if (tagFilterMode === 'and') {
    return selectedTags.every(tag => taskTags.includes(tag));
  }
  return selectedTags.some(tag => taskTags.includes(tag));
}

function toggleTagFilter(tag) {
  const idx = selectedTags.indexOf(tag);
  if (idx === -1) {
    selectedTags.push(tag);
  } else {
    selectedTags.splice(idx, 1);
  }
  render();
  renderFilterBar();
}

function clearTagFilters() {
  selectedTags = [];
  render();
  renderFilterBar();
}

function toggleFilterMode() {
  tagFilterMode = tagFilterMode === 'or' ? 'and' : 'or';
  saveTagFilterSettings();
  render();
  renderFilterBar();
}

function toggleFilterPanel() {
  filterPanelOpen = !filterPanelOpen;
  const panel = document.getElementById('filterPanel');
  const fab = document.getElementById('filterFab');
  if (panel) {
    panel.classList.toggle('open', filterPanelOpen);
  }
  if (fab) {
    fab.classList.toggle('active', filterPanelOpen);
  }
  if (filterPanelOpen) {
    renderFilterBar();
  }
}

async function saveTagFilterSettings() {
  try {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tagGroups, tagFilterMode })
    });
  } catch (e) {
    console.error('Failed to save tag filter settings:', e);
  }
}

async function loadTagFilterSettings() {
  try {
    const res = await fetch('/api/settings');
    const settings = await res.json();
    tagGroups = settings.tagGroups || [];
    tagFilterMode = settings.tagFilterMode || 'or';
  } catch (e) {
    console.error('Failed to load tag filter settings:', e);
  }
}

function getUngroupedTags() {
  const groupedTags = new Set();
  for (const group of tagGroups) {
    for (const tag of (group.tags || [])) {
      groupedTags.add(tag);
    }
  }
  return allUniqueTags.filter(t => !groupedTags.has(t.tag));
}

function renderFilterBar() {
  const panel = document.getElementById('filterPanel');
  const fab = document.getElementById('filterFab');
  const badge = document.getElementById('filterFabBadge');

  // Update FAB visibility - hide if no tags exist
  if (fab) {
    fab.style.display = allUniqueTags.length === 0 ? 'none' : 'flex';
  }

  // Update badge
  const activeCount = selectedTags.length;
  const hasActiveFilters = activeCount > 0;
  if (badge) {
    badge.textContent = activeCount;
    badge.classList.toggle('show', hasActiveFilters);
  }
  if (fab) {
    fab.classList.toggle('has-filters', hasActiveFilters);
  }

  if (!panel) return;

  let html = `
    <div class="filter-panel-header">
      <span class="filter-panel-title">${t('filter.title') || 'Filter by tags'}</span>
      <div class="filter-panel-actions">
        ${hasActiveFilters ? `<button class="filter-clear-btn" onclick="clearTagFilters()">${t('filter.clear') || 'Clear'}</button>` : ''}
        <button class="filter-settings-btn" onclick="openTagGroupsModal()" title="${t('filter.manageGroups') || 'Manage groups'}">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492ZM5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0Z"/>
            <path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52l-.094-.319Z"/>
          </svg>
        </button>
      </div>
    </div>
    <div class="filter-panel-content">`;

  // Filter mode toggle (only show if there are selected tags)
  if (hasActiveFilters && selectedTags.length > 1) {
    html += `
      <div class="filter-mode-toggle">
        <button class="filter-mode-btn ${tagFilterMode === 'or' ? 'active' : ''}" onclick="if(tagFilterMode !== 'or') toggleFilterMode()">
          ${t('filter.any') || 'Any'}
        </button>
        <button class="filter-mode-btn ${tagFilterMode === 'and' ? 'active' : ''}" onclick="if(tagFilterMode !== 'and') toggleFilterMode()">
          ${t('filter.all') || 'All'}
        </button>
      </div>`;
  }

  // Ungrouped tags (drop zone)
  const ungroupedTags = getUngroupedTags();
  html += `<div class="filter-tags-section filter-drop-zone" data-group-id=""
               ondragover="handleTagDragOver(event)" ondragleave="handleTagDragLeave(event)" ondrop="handleTagDrop(event)">`;
  if (ungroupedTags.length > 0) {
    html += '<div class="filter-tags-row">';
    for (const { tag, count } of ungroupedTags) {
      const isSelected = selectedTags.includes(tag);
      const c = stringToColor(tag);
      const bg = stringToColorAlpha(tag, isSelected ? 0.25 : 0.15);
      const bc = stringToColorAlpha(tag, isSelected ? 0.5 : 0.3);
      html += `<button class="filter-tag ${isSelected ? 'selected' : ''}"
                style="background:${bg};color:${c};border-color:${bc}"
                draggable="true"
                ondragstart="handleTagDragStart(event, '${escapeHtml(tag)}', '')"
                onclick="toggleTagFilter('${escapeHtml(tag)}')"
                title="${tag}: ${count} ${count === 1 ? 'task' : 'tasks'}">
        ${escapeHtml(tag)} <span class="filter-tag-count">${count}</span>
      </button>`;
    }
    html += '</div>';
  } else if (tagGroups.length > 0) {
    html += '<div class="filter-drop-hint">' + (t('filter.dropHere') || 'Drop tags here to ungroup') + '</div>';
  }
  html += '</div>';

  // Grouped tags
  for (const group of tagGroups) {
    const groupTags = (group.tags || []).filter(tag =>
      allUniqueTags.some(t => t.tag === tag)
    );

    const isGroupCollapsed = localStorage.getItem(`kanban_filterGroup_${group.id}`) === 'true';
    html += `
      <div class="filter-group filter-drop-zone" data-group-id="${group.id}"
           ondragover="handleTagDragOver(event)" ondragleave="handleTagDragLeave(event)" ondrop="handleTagDrop(event)">
        <div class="filter-group-header" onclick="toggleFilterGroup('${group.id}')">
          <span class="filter-group-chevron ${isGroupCollapsed ? 'collapsed' : ''}">&#9656;</span>
          <span class="filter-group-name">${escapeHtml(group.name || t('filter.untitledGroup') || 'Untitled')}</span>
          <span class="filter-group-count">${groupTags.length}</span>
        </div>
        ${!isGroupCollapsed ? '<div class="filter-tags-row">' + (groupTags.length > 0 ? groupTags.map(tag => {
          const tagData = allUniqueTags.find(t => t.tag === tag);
          const count = tagData ? tagData.count : 0;
          const isSelected = selectedTags.includes(tag);
          const c = stringToColor(tag);
          const bg = stringToColorAlpha(tag, isSelected ? 0.25 : 0.15);
          const bc = stringToColorAlpha(tag, isSelected ? 0.5 : 0.3);
          return `<button class="filter-tag ${isSelected ? 'selected' : ''}"
                    style="background:${bg};color:${c};border-color:${bc}"
                    draggable="true"
                    ondragstart="handleTagDragStart(event, '${escapeHtml(tag)}', '${group.id}')"
                    onclick="toggleTagFilter('${escapeHtml(tag)}')"
                    title="${tag}: ${count} ${count === 1 ? 'task' : 'tasks'}">
            ${escapeHtml(tag)} <span class="filter-tag-count">${count}</span>
          </button>`;
        }).join('') : `<div class="filter-drop-hint">${t('filter.dropHere') || 'Drop tags here'}</div>`) + '</div>' : ''}
      </div>`;
  }

  html += '</div>';

  panel.innerHTML = html;
}

// Drag and drop handlers for filter tags
let draggedTag = null;
let draggedFromGroup = null;

function handleTagDragStart(e, tag, fromGroupId) {
  draggedTag = tag;
  draggedFromGroup = fromGroupId;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', tag);
  e.target.classList.add('dragging');
}

function handleTagDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const dropZone = e.target.closest('.filter-drop-zone');
  if (dropZone) {
    dropZone.classList.add('drag-over');
  }
}

function handleTagDragLeave(e) {
  const dropZone = e.target.closest('.filter-drop-zone');
  if (dropZone && !dropZone.contains(e.relatedTarget)) {
    dropZone.classList.remove('drag-over');
  }
}

async function handleTagDrop(e) {
  e.preventDefault();
  const dropZone = e.target.closest('.filter-drop-zone');
  if (!dropZone) return;

  dropZone.classList.remove('drag-over');

  const toGroupId = dropZone.dataset.groupId;

  if (!draggedTag) return;

  // If dropping to a group
  if (toGroupId) {
    const targetGroup = tagGroups.find(g => g.id === toGroupId);
    if (targetGroup && !targetGroup.tags.includes(draggedTag)) {
      // Add tag to target group (tags can be in multiple groups)
      targetGroup.tags.push(draggedTag);
    }
  } else {
    // Dropping to ungrouped area - remove from source group only
    if (draggedFromGroup) {
      const sourceGroup = tagGroups.find(g => g.id === draggedFromGroup);
      if (sourceGroup) {
        sourceGroup.tags = sourceGroup.tags.filter(t => t !== draggedTag);
      }
    }
  }

  draggedTag = null;
  draggedFromGroup = null;

  await saveTagFilterSettings();
  renderFilterBar();
}

function toggleFilterGroup(groupId) {
  const key = `kanban_filterGroup_${groupId}`;
  const isCollapsed = localStorage.getItem(key) === 'true';
  localStorage.setItem(key, String(!isCollapsed));
  renderFilterBar();
}

// --- Tag Groups Modal ---

let editingTagGroups = [];

function openTagGroupsModal() {
  // Create a copy of tagGroups for editing
  editingTagGroups = JSON.parse(JSON.stringify(tagGroups));
  renderTagGroupsContent();
  document.getElementById('tagGroupsBackdrop').classList.add('open');
}

function closeTagGroupsModal() {
  document.getElementById('tagGroupsBackdrop').classList.remove('open');
  editingTagGroups = [];
}

function renderTagGroupsContent() {
  const container = document.getElementById('tagGroupsContent');
  if (!container) return;

  if (editingTagGroups.length === 0) {
    container.innerHTML = `<div class="tag-groups-empty">${t('filter.noGroups') || 'No tag groups yet. Create one to organize your tags.'}</div>`;
    return;
  }

  let html = '';
  for (const group of editingTagGroups) {
    html += `
      <div class="tag-group-item" data-group-id="${group.id}">
        <div class="tag-group-item-header">
          <input type="text" value="${escapeHtml(group.name)}" placeholder="${t('filter.groupName') || 'Group name'}"
                 onchange="updateGroupName('${group.id}', this.value)"
                 onkeydown="if(event.key==='Enter')this.blur()">
          <button class="tag-group-delete-btn" onclick="deleteTagGroup('${group.id}')" title="${t('task.delete') || 'Delete'}">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25ZM4.117 5.684l.625 7.516A1.75 1.75 0 0 0 6.487 15h3.026a1.75 1.75 0 0 0 1.745-1.8l.625-7.516a.25.25 0 0 0-.248-.268H4.365a.25.25 0 0 0-.248.268Z"/>
            </svg>
          </button>
        </div>
        <div class="tag-group-tags">
          ${allUniqueTags.map(({ tag, count }) => {
            const isInThisGroup = (group.tags || []).includes(tag);
            const c = stringToColor(tag);
            const bg = stringToColorAlpha(tag, isInThisGroup ? 0.25 : 0.15);
            const bc = stringToColorAlpha(tag, isInThisGroup ? 0.5 : 0.3);
            return `<button class="tag-group-tag ${isInThisGroup ? 'in-group' : ''}"
                      style="background:${bg};color:${c};border-color:${bc}"
                      onclick="toggleTagInGroup('${group.id}', '${escapeHtml(tag)}')">
              ${escapeHtml(tag)}
            </button>`;
          }).join('')}
        </div>
      </div>
    `;
  }

  container.innerHTML = html;
}

function addTagGroup() {
  const newGroup = {
    id: 'group-' + Date.now(),
    name: '',
    tags: []
  };
  editingTagGroups.push(newGroup);
  renderTagGroupsContent();

  // Focus the new group's input
  setTimeout(() => {
    const inputs = document.querySelectorAll('.tag-group-item-header input');
    if (inputs.length > 0) {
      inputs[inputs.length - 1].focus();
    }
  }, 50);
}

function deleteTagGroup(groupId) {
  editingTagGroups = editingTagGroups.filter(g => g.id !== groupId);
  renderTagGroupsContent();
}

function updateGroupName(groupId, name) {
  const group = editingTagGroups.find(g => g.id === groupId);
  if (group) {
    group.name = name.trim();
  }
}

function toggleTagInGroup(groupId, tag) {
  const group = editingTagGroups.find(g => g.id === groupId);
  if (!group) return;

  if (!group.tags) group.tags = [];

  const idx = group.tags.indexOf(tag);
  if (idx === -1) {
    // Add tag to this group (tags can be in multiple groups)
    group.tags.push(tag);
  } else {
    group.tags.splice(idx, 1);
  }

  renderTagGroupsContent();
}

async function saveTagGroups() {
  // Filter out empty groups (no name and no tags)
  tagGroups = editingTagGroups.filter(g => g.name.trim() || (g.tags && g.tags.length > 0));

  // Ensure all groups have a name
  for (const group of tagGroups) {
    if (!group.name.trim()) {
      group.name = t('filter.untitledGroup') || 'Untitled';
    }
  }

  await saveTagFilterSettings();
  closeTagGroupsModal();
  renderFilterBar();
}

// --- View Switching ---

function switchView(view) {
  currentView = view;
  localStorage.setItem('kanban_view', view);

  // Close filter panel when switching views
  if (filterPanelOpen) {
    filterPanelOpen = false;
    const panel = document.getElementById('filterPanel');
    const fab = document.getElementById('filterFab');
    if (panel) panel.classList.remove('open');
    if (fab) fab.classList.remove('active');
  }

  document.getElementById('boardView').style.display = view === 'board' ? '' : 'none';
  document.getElementById('notesView').style.display = view === 'notes' ? '' : 'none';

  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.view === view);
  });

  if (view === 'notes' && !notesLoaded) {
    loadNotes();
  }
}

// --- Cross-References ---

function renderCrossReferences(html) {
  // Task references: [[T7]] or [[t7]]
  html = html.replace(/\[\[T(\d+)\]\]/gi, (match, id) => {
    const taskId = parseInt(id);
    const task = board.tasks.find(tsk => tsk.id === taskId)
      || (board.backlog && board.backlog.find(tsk => tsk.id === taskId))
      || (board.trash && board.trash.find(tsk => tsk.id === taskId));
    const title = task ? task.title : t('xref.taskNotFound');
    const truncTitle = title.length > 25 ? title.substring(0, 25) + '...' : title;
    return `<span class="xref-badge xref-task" data-type="task" data-id="${taskId}"><span class="xref-badge-id">T${taskId}</span><span class="xref-badge-title">${escapeHtml(truncTitle)}</span></span>`;
  });

  // Note references: [[N3]] or [[n3]]
  html = html.replace(/\[\[N(\d+)\]\]/gi, (match, id) => {
    const noteId = parseInt(id);
    const note = typeof getNoteById === 'function' ? getNoteById(noteId) : null;
    const title = note ? note.title : t('xref.noteNotFound');
    const truncTitle = title.length > 25 ? title.substring(0, 25) + '...' : title;
    return `<span class="xref-badge xref-note" data-type="note" data-id="${noteId}"><span class="xref-badge-id">N${noteId}</span><span class="xref-badge-title">${escapeHtml(truncTitle)}</span></span>`;
  });

  return html;
}

// --- User ---

async function initUser() {
  // Try to load username from server settings first
  try {
    const res = await fetch('/api/settings');
    const settings = await res.json();
    if (settings.username) {
      currentUser = settings.username;
    }
    // Apply experience settings
    const showBoard = settings.showBoard !== false; // default true
    const showNotes = settings.showNotes !== false; // default true
    applyExperienceSettings(showBoard, showNotes);
  } catch (e) {
    console.error('Failed to load user settings:', e);
  }

  // Fallback to localStorage
  if (!currentUser) {
    currentUser = localStorage.getItem('kanban_user') || '';
  }

  // Show welcome modal only if:
  // 1. No username is set AND
  // 2. No existing data (truly first launch)
  if (!currentUser) {
    // Check if board has existing data (not empty)
    const hasExistingData = board.tasks && board.tasks.length > 0;
    
    if (hasExistingData) {
      // User has existing data, just render without welcome modal
      // They can set their username later from settings
      renderUserBadge();
      return;
    }
    
    // No existing data = true first launch, show welcome
    showWelcomeModal();
    return; // Don't render badge yet, wait for welcome completion
  }

  renderUserBadge();
}

let selectedExperience = 'both';
let experienceSettings = { showBoard: true, showNotes: true };
let confirmCallback = null;

// --- Generic Confirm/Alert Dialogs ---

function showConfirmDialog(message, onConfirm, isDanger = false) {
  const backdrop = document.getElementById('confirmBackdrop');
  const msgEl = document.getElementById('confirmMessage');
  const modal = backdrop.querySelector('.confirm-modal');

  msgEl.textContent = message;
  confirmCallback = onConfirm;

  if (isDanger) {
    modal.classList.add('danger');
  } else {
    modal.classList.remove('danger');
  }

  backdrop.classList.add('open');
}

function hideConfirmDialog() {
  document.getElementById('confirmBackdrop').classList.remove('open');
  confirmCallback = null;
}

function confirmDialogOk() {
  const callback = confirmCallback;
  hideConfirmDialog();
  if (callback) callback();
}

function showAlertDialog(message) {
  const backdrop = document.getElementById('alertBackdrop');
  const msgEl = document.getElementById('alertMessage');
  msgEl.textContent = message;
  backdrop.classList.add('open');
}

function hideAlertDialog() {
  document.getElementById('alertBackdrop').classList.remove('open');
}

function applyExperienceSettings(showBoard, showNotes) {
  experienceSettings = { showBoard, showNotes };

  // Update nav tabs visibility
  const boardTab = document.querySelector('[data-view="board"]');
  const notesTab = document.querySelector('[data-view="notes"]');

  if (boardTab) boardTab.style.display = showBoard ? '' : 'none';
  if (notesTab) notesTab.style.display = showNotes ? '' : 'none';

  // If current view is hidden, switch to the visible one
  if (currentView === 'board' && !showBoard && showNotes) {
    switchView('notes');
  } else if (currentView === 'notes' && !showNotes && showBoard) {
    switchView('board');
  }
}

async function showWelcomeModal() {
  document.getElementById('welcomeBackdrop').classList.add('open');
  document.getElementById('welcomeStep1').style.display = '';
  document.getElementById('welcomeStep2').style.display = 'none';

  // Pre-populate data directory input
  try {
    const res = await fetch('/api/data-dir');
    const data = await res.json();
    document.getElementById('welcomeDataDir').value = data.path || '';
  } catch (e) {
    console.error('Failed to get data directory:', e);
  }
}

async function selectLanguage(lang) {
  // Change language immediately
  await changeLanguage(lang);
  updateStaticText();
  translateStaticElements();

  // If examples exist, reload them in the new language
  if (hasExamples) {
    try {
      await fetch('/api/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'examples' })
      });
      await loadBoard();
    } catch (err) {
      console.error('Failed to reload examples:', err);
    }
  }

  // Move to step 2
  document.getElementById('welcomeStep1').style.display = 'none';
  document.getElementById('welcomeStep2').style.display = '';
  document.getElementById('welcomeUsername').focus();
}

function selectExperienceCompact(el, exp) {
  selectedExperience = exp;
  // Update button states
  document.querySelectorAll('.experience-option-compact').forEach(btn => {
    btn.classList.remove('selected');
  });
  el.classList.add('selected');
}

async function pickDataFolder() {
  // Check if pywebview API is available
  if (!window.pywebview || !window.pywebview.api) {
    console.warn('Folder picker not available (browser mode)');
    return;
  }

  const currentPath = document.getElementById('welcomeDataDir').value;

  try {
    const selectedPath = await window.pywebview.api.select_folder(currentPath);
    if (selectedPath) {
      document.getElementById('welcomeDataDir').value = selectedPath;
    }
  } catch (e) {
    console.error('Failed to pick folder:', e);
  }
}

let welcomeIdentitiesLoaded = false;

async function onWelcomeRepoInput() {
  const repoInput = document.getElementById('welcomeGitRepo').value.trim();
  const identityRow = document.getElementById('welcomeIdentityRow');

  if (repoInput) {
    identityRow.style.display = '';
    if (!welcomeIdentitiesLoaded) {
      await loadWelcomeIdentities();
    }
  } else {
    identityRow.style.display = 'none';
  }
}

async function loadWelcomeIdentities() {
  const select = document.getElementById('welcomeIdentity');
  select.innerHTML = '<option value="">Loading...</option>';

  try {
    const res = await fetch('/api/git/identities');
    const data = await res.json();

    select.innerHTML = '';

    // Add SSH hosts
    for (const host of data.ssh_hosts || []) {
      const opt = document.createElement('option');
      opt.value = `ssh:${host.host}`;
      opt.textContent = `🔑 ${host.label}`;
      select.appendChild(opt);
    }

    // Add gh accounts
    for (const acc of data.gh_accounts || []) {
      const opt = document.createElement('option');
      opt.value = `gh:${acc.username}`;
      opt.textContent = `🔗 ${acc.label}`;
      select.appendChild(opt);
    }

    if (select.options.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = t('welcome.noIdentities') || 'No GitHub identities found';
      select.appendChild(opt);
    }

    welcomeIdentitiesLoaded = true;
  } catch (e) {
    console.error('Failed to load identities:', e);
    select.innerHTML = '<option value="">Failed to load</option>';
  }
}

async function applyDataFolder(path) {
  // Change data directory via API and reload data
  try {
    const res = await fetch('/api/data-dir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path })
    });
    const result = await res.json();
    if (!res.ok) {
      throw new Error(result.error || 'Failed to change data directory');
    }
    // Reload board and notes data
    await loadBoard();
    await loadNotes();
    // Check for examples again
    await checkHasExamples();
    return true;
  } catch (e) {
    console.error('Failed to apply data folder:', e);
    alert('Failed to change data folder: ' + e.message);
    return false;
  }
}

function welcomeBack() {
  document.getElementById('welcomeStep1').style.display = '';
  document.getElementById('welcomeStep2').style.display = 'none';
}

async function completeWelcome() {
  const username = document.getElementById('welcomeUsername').value.trim() || t('user.anonymous');
  const gitRepo = document.getElementById('welcomeGitRepo').value.trim();
  const dataDir = document.getElementById('welcomeDataDir').value.trim();
  const identity = document.getElementById('welcomeIdentity')?.value || '';

  const startBtn = document.getElementById('welcomeStart');
  const originalText = startBtn.textContent;

  // If git repo is provided, clone it using the server API
  if (gitRepo) {
    // Always ask to clear folder when cloning a repo
    const msg = t('welcome.folderNotEmptyClone') || `The folder will be cleared and the repository will be cloned. Continue?`;
    if (!confirm(msg)) {
      return;
    }

    // Show loading state
    startBtn.disabled = true;
    startBtn.textContent = t('git.syncing') || 'Cloning...';

    try {
      const res = await fetch('/api/git/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo: gitRepo,
          target_dir: dataDir,
          identity_type: identity,
          clear_folder: true
        })
      });
      const result = await res.json();

      if (!result.ok) {
        startBtn.disabled = false;
        startBtn.textContent = originalText;
        alert(result.error || 'Failed to clone repository');
        return;
      }

      // Apply the cloned folder
      startBtn.textContent = t('save.saving') || 'Loading...';
      if (!await applyDataFolder(dataDir)) {
        startBtn.disabled = false;
        startBtn.textContent = originalText;
        return;
      }
    } catch (e) {
      console.error('Failed to clone repo:', e);
      startBtn.disabled = false;
      startBtn.textContent = originalText;
      alert('Failed to clone repository: ' + e.message);
      return;
    }
  } else if (dataDir) {
    // No git clone - check if custom folder needs to be applied
    try {
      const res = await fetch('/api/data-dir');
      const current = await res.json();

      if (current.path !== dataDir) {
        // Check if folder is not empty
        if (window.pywebview && window.pywebview.api) {
          const folderCheck = await window.pywebview.api.check_folder(dataDir);
          if (folderCheck.exists && !folderCheck.empty) {
            const msg = t('welcome.folderNotEmpty') || `The folder is not empty. Do you want to clear it and start fresh?`;
            if (!confirm(msg)) {
              return;
            }
            // Clear the folder
            startBtn.disabled = true;
            startBtn.textContent = t('save.saving') || 'Preparing...';
            const clearResult = await window.pywebview.api.clear_folder(dataDir);
            if (!clearResult.success) {
              startBtn.disabled = false;
              startBtn.textContent = originalText;
              alert(clearResult.error || 'Failed to clear folder');
              return;
            }
          }
        }

        startBtn.disabled = true;
        startBtn.textContent = t('save.saving') || 'Loading...';
        if (!await applyDataFolder(dataDir)) {
          startBtn.disabled = false;
          startBtn.textContent = originalText;
          return;
        }
      }
    } catch (e) {
      console.error('Failed to check data dir:', e);
    }
  }

  startBtn.disabled = false;
  startBtn.textContent = originalText;

  // Save username
  currentUser = username;
  await saveUsername(username);

  // Save experience selection
  const showBoard = selectedExperience === 'both' || selectedExperience === 'board';
  const showNotes = selectedExperience === 'both' || selectedExperience === 'notes';
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ showBoard, showNotes })
  });
  applyExperienceSettings(showBoard, showNotes);

  render();

  // Close welcome modal
  document.getElementById('welcomeBackdrop').classList.remove('open');

  // Now render the user badge
  renderUserBadge();

  // Check for examples in the new folder
  await checkHasExamples();

  // Show tooltip hint about clearing examples
  if (hasExamples) {
    setTimeout(showClearExamplesTooltip, 500);
  }
}

async function saveUsername(name) {
  localStorage.setItem('kanban_user', name);
  try {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: name })
    });
  } catch (e) {
    console.error('Failed to save username:', e);
  }
}

async function changeUser() {
  const name = prompt(t('user.change'), currentUser);
  if (name !== null && name.trim()) {
    currentUser = name.trim();
    await saveUsername(currentUser);
    renderUserBadge();
  }
}

function renderUserBadge() {
  document.getElementById('userName').textContent = currentUser;
  document.getElementById('userDot').style.background = stringToColor(currentUser);
}

// --- Git Sync ---

async function loadGitStatus() {
  try {
    const res = await fetch('/api/git/status');
    gitStatus = await res.json();
    renderGitStatus();
  } catch (e) {
    console.error('Failed to load git status:', e);
    gitStatus = { enabled: false };
    renderGitStatus();
  }
}

async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    gitSettings = await res.json();
  } catch (e) {
    console.error('Failed to load settings:', e);
    gitSettings = { git_enabled: false, git_remote: '' };
  }
}

async function checkHasExamples() {
  try {
    const res = await fetch('/api/has-examples');
    const data = await res.json();
    hasExamples = data.has_examples;
  } catch (e) {
    console.error('Failed to check examples:', e);
    hasExamples = false;
  }
  updateClearExamplesButton();
}

function updateClearExamplesButton() {
  const container = document.getElementById('clearExamplesContainer');
  const btn = document.getElementById('headerClearExamplesBtn');

  if (!container) return;

  if (hasExamples) {
    container.style.display = 'flex';
    if (btn) btn.title = t('settings.clearExamplesTitle') || 'Clear example data';
  } else {
    container.style.display = 'none';
  }
}

function showClearExamplesTooltip() {
  if (!hasExamples) return;

  const tooltip = document.getElementById('clearExamplesTooltip');
  if (!tooltip) return;

  tooltip.textContent = t('examples.clearHint') || 'These are example tasks. Click to start fresh!';
  tooltip.classList.add('show');

  // Hide after 5 seconds
  setTimeout(() => {
    tooltip.classList.remove('show');
  }, 5000);
}

function clearExamplesFromHeader() {
  showConfirmDialog(
    t('confirm.clearExamples') || 'Remove example tasks and notes? Your own content will be kept.',
    doClearExamples
  );
}

async function doClearExamples() {
  try {
    const res = await fetch('/api/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'clear_examples' })
    });
    const data = await res.json();

    if (data.ok) {
      hasExamples = false;
      updateClearExamplesButton();
      await loadBoard();
      render();

      // Reload notes if loaded
      if (notesLoaded && typeof loadNotes === 'function') {
        await loadNotes();
        renderNotesTree();
        selectedNoteId = null;
        document.getElementById('notesEditor').style.display = 'none';
        document.getElementById('notesEmptyState').style.display = 'block';
      }
    }
  } catch (err) {
    console.error('Failed to clear examples:', err);
  }
}

function renderGitStatus() {
  const container = document.getElementById('gitSyncContainer');
  const btn = document.getElementById('gitSyncBtn');
  const label = document.getElementById('gitSyncLabel');
  const indicator = document.getElementById('gitStatusIndicator');

  // Hide sync button if git is not enabled
  if (!gitStatus.enabled) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'flex';

  if (!gitStatus.is_repo) {
    container.classList.add('not-repo');
    btn.disabled = true;
    label.textContent = t('git.noRepo');
    indicator.textContent = '';
    indicator.className = 'git-status-indicator';
    return;
  }

  container.classList.remove('not-repo');
  btn.disabled = gitSyncing;

  if (gitSyncing) {
    label.textContent = t('git.syncing') || 'Syncing...';
    indicator.textContent = '';
    indicator.className = 'git-status-indicator syncing';
    return;
  }

  label.textContent = t('git.sync') || 'Sync';

  // Simplified status based on sync_state
  const state = gitStatus.sync_state || 'synced';
  const localCount = (gitStatus.changes || 0) + (gitStatus.ahead || 0);
  const remoteCount = gitStatus.behind || 0;

  switch (state) {
    case 'synced':
      indicator.textContent = t('git.upToDate') || '✓';
      indicator.className = 'git-status-indicator synced';
      break;
    case 'local':
      indicator.textContent = t('git.unsaved', { count: localCount }) || `${localCount} unsaved`;
      indicator.className = 'git-status-indicator has-local';
      break;
    case 'remote':
      indicator.textContent = t('git.available', { count: remoteCount }) || `${remoteCount} available`;
      indicator.className = 'git-status-indicator has-remote';
      break;
    case 'both':
      indicator.textContent = t('git.syncNeeded') || '↕ Sync needed';
      indicator.className = 'git-status-indicator has-both';
      break;
  }
}

function showSyncOverlay() {
  const overlay = document.getElementById('syncOverlay');
  if (overlay) {
    // Update translated text
    const textSpan = overlay.querySelector('span');
    if (textSpan) textSpan.textContent = t('git.syncing') || 'Syncing...';
    overlay.classList.add('active');
  }
}

function hideSyncOverlay() {
  const overlay = document.getElementById('syncOverlay');
  if (overlay) overlay.classList.remove('active');
}

async function gitSync(resolution = 'auto') {
  if (!gitStatus.enabled || !gitStatus.is_repo || gitSyncing) return;

  gitSyncing = true;
  showSyncOverlay();
  renderGitStatus();

  try {
    const res = await fetch('/api/git/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Kanbito sync - ${new Date().toLocaleString()}`,
        resolution: resolution
      })
    });
    const result = await res.json();
    console.log('Sync result:', result);

    if (result.conflict) {
      // Show conflict resolution dialog
      console.log('Showing conflict dialog');
      gitSyncing = false;
      hideSyncOverlay();
      renderGitStatus();
      showConflictDialog();
      return;
    }

    if (!result.ok) {
      console.log('Sync failed, showing alert');
      hideSyncOverlay();  // Hide overlay before showing alert
      alert((t('git.syncFailed') || 'Sync failed') + ': ' + (result.error || 'Unknown error'));
    } else {
      // Always reload data after successful sync to ensure we have latest
      await loadBoard();
      render();
      if (typeof loadNotes === 'function') {
        await loadNotes();
        renderNotesTree();
      }
    }
  } catch (e) {
    console.error('Git sync error:', e);
    hideSyncOverlay();  // Hide overlay before showing alert
    alert((t('git.syncFailed') || 'Sync failed') + ': ' + e.message);
  } finally {
    gitSyncing = false;
    hideSyncOverlay();
    await loadGitStatus();
    await checkBackupStatus();  // Update undo button visibility
  }
}

function showConflictDialog() {
  const backdrop = document.getElementById('conflictBackdrop');
  if (backdrop) {
    backdrop.classList.add('open');
    // Reset diff viewer state
    const container = document.getElementById('diffViewerContainer');
    const toggleBtn = document.getElementById('diffToggleBtn');
    const modal = backdrop.querySelector('.conflict-modal');
    if (container) container.style.display = 'none';
    if (toggleBtn) toggleBtn.classList.remove('expanded');
    if (modal) modal.classList.remove('show-diff');
    // Reset confirm view
    const options = document.getElementById('conflictOptions');
    const confirm = document.getElementById('conflictConfirm');
    if (options) options.style.display = '';
    if (confirm) confirm.style.display = 'none';
  }
}

function closeConflictDialog() {
  const backdrop = document.getElementById('conflictBackdrop');
  if (backdrop) {
    backdrop.classList.remove('open');
  }
}

function colorizeDiff(text) {
  if (!text) return '';

  // Split into lines, filter out headers, and colorize
  return text.split('\n')
    .filter(line => {
      // Skip diff metadata lines
      if (line.startsWith('diff ')) return false;
      if (line.startsWith('index ')) return false;
      if (line.startsWith('--- ')) return false;
      if (line.startsWith('+++ ')) return false;
      if (line.startsWith('@@')) return false;
      return true;
    })
    .map(line => {
      // Escape HTML
      const escaped = line
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      if (escaped.startsWith('+')) {
        return `<span class="diff-add">${escaped}</span>`;
      } else if (escaped.startsWith('-')) {
        return `<span class="diff-del">${escaped}</span>`;
      }
      return escaped;
    }).join('\n');
}

async function toggleDiffViewer() {
  const container = document.getElementById('diffViewerContainer');
  const toggleBtn = document.getElementById('diffToggleBtn');
  const modal = document.querySelector('.conflict-modal');

  if (!container || !toggleBtn) return;

  const isHidden = container.style.display === 'none';

  if (isHidden) {
    // Show and fetch diff
    container.style.display = 'flex';
    toggleBtn.classList.add('expanded');
    if (modal) modal.classList.add('show-diff');

    // Update toggle text
    const span = toggleBtn.querySelector('span');
    if (span) span.textContent = t('conflict.hideDiff') || 'Hide differences';

    // Translate diff panel labels
    container.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      if (key) el.textContent = t(key) || el.textContent;
    });

    // Fetch diff data
    try {
      const localEl = document.getElementById('diffLocal');
      const remoteEl = document.getElementById('diffRemote');
      if (localEl) localEl.textContent = t('git.syncing') || 'Loading...';
      if (remoteEl) remoteEl.textContent = t('git.syncing') || 'Loading...';

      const res = await fetch('/api/git/diff');
      const data = await res.json();

      if (data.ok) {
        if (localEl) localEl.innerHTML = colorizeDiff(data.local || '(no changes)');
        if (remoteEl) remoteEl.innerHTML = colorizeDiff(data.remote || '(no changes)');
      } else {
        if (localEl) localEl.textContent = 'Error: ' + (data.error || 'Unknown');
        if (remoteEl) remoteEl.textContent = 'Error: ' + (data.error || 'Unknown');
      }
    } catch (e) {
      console.error('Failed to fetch diff:', e);
      const localEl = document.getElementById('diffLocal');
      const remoteEl = document.getElementById('diffRemote');
      if (localEl) localEl.textContent = 'Error: ' + e.message;
      if (remoteEl) remoteEl.textContent = 'Error: ' + e.message;
    }
  } else {
    // Hide
    container.style.display = 'none';
    toggleBtn.classList.remove('expanded');
    if (modal) modal.classList.remove('show-diff');

    // Update toggle text
    const span = toggleBtn.querySelector('span');
    if (span) span.textContent = t('conflict.showDiff') || 'Show differences';
  }
}

let pendingConflictResolution = null;

async function resolveConflict(resolution) {
  closeConflictDialog();

  // For keep_remote (with backup), just sync - backup is saved by backend
  await gitSync(resolution);

  // For resolutions without backup, delete backup and hide undo
  if (resolution === 'keep_local' || resolution === 'keep_remote_no_backup') {
    try {
      await fetch('/api/backup/delete', { method: 'POST' });
      const undoBtn = document.getElementById('undoBtn');
      if (undoBtn) undoBtn.style.display = 'none';
    } catch (e) {
      console.error('Failed to delete backup:', e);
    }
  }
}

function showConflictConfirm(resolution) {
  pendingConflictResolution = resolution;

  const options = document.getElementById('conflictOptions');
  const confirm = document.getElementById('conflictConfirm');
  const msg = document.getElementById('conflictConfirmMsg');
  const btn = document.getElementById('conflictConfirmBtn');

  if (!options || !confirm || !msg || !btn) return;

  // Set message and style based on resolution
  if (resolution === 'keep_local') {
    // Keep local is safe - cloud version can be recovered from git
    msg.textContent = t('conflict.confirmKeepLocal') || 'This will upload your version to the cloud.';
    confirm.className = 'conflict-confirm confirm-info';
    btn.className = 'btn-primary';
    btn.textContent = t('conflict.confirmBtn') || 'Yes, continue';
  } else if (resolution === 'keep_remote_no_backup') {
    // Keep cloud without backup is dangerous - local changes will be lost
    msg.textContent = t('conflict.confirmKeepCloud') || 'This will replace your version with the cloud.';
    confirm.className = 'conflict-confirm confirm-danger';
    btn.className = 'btn-danger';
    btn.textContent = t('conflict.confirmBtn') || 'Yes, continue';
  }

  // Update confirm button
  btn.onclick = confirmConflictAction;

  options.style.display = 'none';
  confirm.style.display = 'block';
}

function hideConflictConfirm() {
  const options = document.getElementById('conflictOptions');
  const confirm = document.getElementById('conflictConfirm');

  if (options) options.style.display = '';
  if (confirm) confirm.style.display = 'none';
  pendingConflictResolution = null;
}

async function confirmConflictAction() {
  if (!pendingConflictResolution) return;

  // Map keep_remote_no_backup to keep_remote but without backup
  const resolution = pendingConflictResolution === 'keep_remote_no_backup' ? 'keep_remote_no_backup' : pendingConflictResolution;

  hideConflictConfirm();
  await resolveConflict(resolution);
}

// --- Backup/Restore ---

async function checkBackupStatus() {
  try {
    const res = await fetch('/api/backup/status');
    const data = await res.json();

    // Settings restore button (always show if backup exists)
    const settingsBtn = document.getElementById('restoreBackupBtn');
    if (settingsBtn) {
      settingsBtn.style.display = data.has_backup ? '' : 'none';
    }

    // Header undo button (only show if backup is recent - less than 24 hours)
    const undoBtn = document.getElementById('undoBtn');
    if (undoBtn) {
      undoBtn.style.display = data.is_recent ? '' : 'none';
      // Update the button text with translated label
      const span = undoBtn.querySelector('span');
      if (span) span.textContent = t('backup.undo') || 'Undo';
    }
  } catch (e) {
    console.error('Failed to check backup status:', e);
  }
}

function showUndoConfirm() {
  const popover = document.getElementById('undoConfirmPopover');
  if (popover) {
    popover.classList.add('open');
    // Update text with translation
    const msg = popover.querySelector('p');
    if (msg) msg.textContent = t('backup.confirmUndo') || 'Undo the last sync? This will restore your previous data.';
  }
}

function hideUndoConfirm() {
  const popover = document.getElementById('undoConfirmPopover');
  if (popover) popover.classList.remove('open');
}

async function confirmUndo() {
  hideUndoConfirm();
  showSyncOverlay();

  try {
    const res = await fetch('/api/backup/restore', { method: 'POST' });
    const data = await res.json();

    if (data.ok) {
      // Reload everything
      await loadBoard();
      render();
      if (typeof loadNotes === 'function') {
        await loadNotes();
        renderNotesTree();
      }
      // Hide undo button after successful restore
      const undoBtn = document.getElementById('undoBtn');
      if (undoBtn) undoBtn.style.display = 'none';
      // Refresh git status to show local changes
      await loadGitStatus();
    } else {
      alert((t('backup.restoreFailed') || 'Restore failed') + ': ' + data.error);
    }
  } catch (e) {
    alert((t('backup.restoreFailed') || 'Restore failed') + ': ' + e.message);
  } finally {
    hideSyncOverlay();
  }
}

async function restoreBackup() {
  const confirmMsg = t('backup.confirmRestore') || 'Restore to previous state? This will replace your current data.';
  if (!confirm(confirmMsg)) return;

  try {
    const res = await fetch('/api/backup/restore', { method: 'POST' });
    const data = await res.json();

    if (data.ok) {
      // Reload everything
      await loadBoard();
      render();
      if (typeof loadNotes === 'function') {
        await loadNotes();
        renderNotesTree();
      }
      closeGitSettings();
      alert(t('backup.restored') || 'Restored successfully');
    } else {
      alert((t('backup.restoreFailed') || 'Restore failed') + ': ' + data.error);
    }
  } catch (e) {
    alert((t('backup.restoreFailed') || 'Restore failed') + ': ' + e.message);
  }
}

// --- Git Settings Modal ---

let gitIdentities = { ssh_hosts: [], gh_accounts: [] };

function openGitSettings() {
  Promise.all([loadSettings(), checkHasExamples(), loadGitIdentities(), checkBackupStatus()]).then(() => {
    renderGitSettingsModal();
    // Load username into input
    const usernameInput = document.getElementById('usernameInput');
    if (usernameInput) {
      usernameInput.value = currentUser;
      updateUsernamePreview();
    }
    document.getElementById('gitSettingsBackdrop').classList.add('open');
  });
}

function closeGitSettings() {
  document.getElementById('gitSettingsBackdrop').classList.remove('open');
}

function updateUsernamePreview() {
  const input = document.getElementById('usernameInput');
  const dot = document.getElementById('userDotPreview');
  if (input && dot) {
    const name = input.value.trim() || 'Anonymous';
    dot.style.backgroundColor = stringToColor(name);
  }
}

function openGitHubRepo() {
  const remote = gitStatus.remote || gitSettings._current_remote;
  if (!remote) return;

  // Extract GitHub URL from remote
  let url = '';
  if (remote.startsWith('https://')) {
    url = remote.replace(/\.git$/, '');
  } else if (remote.startsWith('git@')) {
    // git@github.com:user/repo.git -> https://github.com/user/repo
    const match = remote.match(/git@([^:]+):(.+?)(?:\.git)?$/);
    if (match) {
      url = `https://${match[1]}/${match[2]}`;
    }
  }

  if (url) {
    window.open(url, '_blank');
  }
}

async function loadGitIdentities() {
  try {
    const res = await fetch('/api/git/identities');
    gitIdentities = await res.json();
  } catch (e) {
    console.error('Failed to load git identities:', e);
    gitIdentities = { ssh_hosts: [], gh_accounts: [] };
  }
}

function renderIdentityDropdown() {
  const select = document.getElementById('gitIdentitySelect');
  const identityField = document.getElementById('gitIdentityField');
  if (!select) return;
  select.innerHTML = '';

  // Count total options
  const sshCount = gitIdentities.ssh_hosts.length;
  const ghCount = gitIdentities.gh_accounts.length;
  // Only count credential manager if no gh accounts (it's a fallback)
  const hasCredentialManager = ghCount === 0;
  const totalOptions = sshCount + ghCount + (hasCredentialManager ? 1 : 0);

  // If only one option, hide the identity field entirely
  const showSelector = totalOptions > 1;
  if (identityField) {
    identityField.style.display = showSelector ? '' : 'none';
  }

  // Add SSH options
  if (sshCount > 0) {
    const sshGroup = document.createElement('optgroup');
    sshGroup.label = 'SSH';
    gitIdentities.ssh_hosts.forEach(host => {
      const opt = document.createElement('option');
      opt.value = `ssh:${host.host}`;
      opt.textContent = host.label;
      sshGroup.appendChild(opt);
    });
    select.appendChild(sshGroup);
  }

  // Add gh CLI options
  if (ghCount > 0) {
    const ghGroup = document.createElement('optgroup');
    ghGroup.label = 'HTTPS (gh CLI)';
    gitIdentities.gh_accounts.forEach(account => {
      const opt = document.createElement('option');
      opt.value = `https:${account.username}`;
      opt.textContent = account.label;
      ghGroup.appendChild(opt);
    });
    select.appendChild(ghGroup);
  }

  // Add fallback HTTPS option only if no gh accounts
  if (hasCredentialManager) {
    const httpsOpt = document.createElement('option');
    httpsOpt.value = 'https:';
    httpsOpt.textContent = 'HTTPS (credential manager)';
    select.appendChild(httpsOpt);
  }

  // Try to select based on current remote URL
  const currentRemote = gitSettings.git_remote || gitSettings._current_remote || '';
  if (currentRemote) {
    const repoInput = document.getElementById('gitRepoInput');
    // Extract repo from URL
    const match = currentRemote.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (match) {
      repoInput.value = match[1];
    }
    // Select matching identity
    if (currentRemote.startsWith('git@')) {
      const host = currentRemote.split(':')[0].replace('git@', '');
      select.value = `ssh:${host}`;
    } else if (currentRemote.startsWith('https://')) {
      // Try to match a gh account, otherwise use credential manager
      const matchedGh = gitIdentities.gh_accounts.find(a => currentRemote.includes(a.username));
      if (matchedGh) {
        select.value = `https:${matchedGh.username}`;
      } else {
        select.value = 'https:';
      }
    }
  }

  // Auto-select first option if nothing selected
  if (!select.value && select.options.length > 0) {
    select.selectedIndex = 0;
  }

  updateRemoteUrl();
}

function onIdentityChange() {
  updateRemoteUrl();
  updateGitAuthInfo();
}

function updateRemoteUrl() {
  const repoInput = document.getElementById('gitRepoInput');
  const identitySelect = document.getElementById('gitIdentitySelect');
  const remoteInput = document.getElementById('gitRemoteInput');

  if (!repoInput || !identitySelect || !remoteInput) return;

  let input = repoInput.value.trim();
  const identity = identitySelect.value;

  if (!input || !identity) {
    remoteInput.value = '';
    return;
  }

  // Extract repo name if user pasted a full URL
  let repo = input;
  // Match HTTPS: https://github.com/user/repo.git or https://github.com/user/repo
  const httpsMatch = input.match(/https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (httpsMatch) {
    repo = httpsMatch[1];
    repoInput.value = repo; // Update input to show clean repo name
  }
  // Match SSH: git@github.com:user/repo.git or git@host:user/repo
  const sshMatch = input.match(/git@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    repo = sshMatch[1];
    repoInput.value = repo; // Update input to show clean repo name
  }

  let url = '';
  if (identity.startsWith('ssh:')) {
    const host = identity.replace('ssh:', '');
    url = `git@${host}:${repo}.git`;
  } else if (identity.startsWith('https:')) {
    url = `https://github.com/${repo}.git`;
  }

  remoteInput.value = url;
  updateGitAuthInfo();
}

function updateGitAuthInfo() {
  const remoteInput = document.getElementById('gitRemoteInput');
  const remoteUrl = remoteInput ? remoteInput.value : '';

  // Show/hide GitHub button based on remote
  const githubBtn = document.getElementById('githubBtn');
  if (githubBtn) {
    const isGitHub = remoteUrl && remoteUrl.includes('github.com');
    githubBtn.style.display = isGitHub ? '' : 'none';
  }
}

function renderGitSettingsModal() {
  // Render identity dropdown and update URL
  renderIdentityDropdown();

  // Update labels
  const userTitle = document.getElementById('settingsUserTitle');
  if (userTitle) userTitle.textContent = t('settings.username') || 'Username';

  const langTitle = document.getElementById('settingsLangTitle');
  if (langTitle) langTitle.textContent = t('settings.language') || 'Language';

  const repoLabel = document.getElementById('gitRepoLabel');
  if (repoLabel) repoLabel.textContent = t('settings.repository') || 'GitHub Repository';

  const identityLabel = document.getElementById('gitIdentityLabel');
  if (identityLabel) identityLabel.textContent = t('settings.connectVia') || 'Connect via';

  // Language selector
  const langSelect = document.getElementById('languageSelect');
  if (langSelect) langSelect.value = getCurrentLanguage();

  // Section picker
  const { showBoard, showNotes } = experienceSettings;
  const mode = (showBoard && showNotes) ? 'both' : (showBoard ? 'board' : 'notes');
  const pickBoth = document.getElementById('pickBoth');
  const pickBoard = document.getElementById('pickBoard');
  const pickNotes = document.getElementById('pickNotes');
  if (pickBoth) pickBoth.classList.toggle('active', mode === 'both');
  if (pickBoard) pickBoard.classList.toggle('active', mode === 'board');
  if (pickNotes) pickNotes.classList.toggle('active', mode === 'notes');

  // Username input placeholder
  const usernameInput = document.getElementById('usernameInput');
  if (usernameInput) usernameInput.placeholder = t('settings.usernamePlaceholder') || 'Your name';

  // Button texts
  const saveBtn = document.getElementById('gitSaveBtn');
  if (saveBtn) saveBtn.textContent = t('settings.save') || 'Save';

  const restoreBtn = document.getElementById('restoreBackupBtn');
  if (restoreBtn) restoreBtn.textContent = t('backup.restore') || 'Restore previous state';

  // Clear any previous test result
  const testResult = document.getElementById('gitTestResult');
  if (testResult) {
    testResult.textContent = '';
    testResult.className = 'git-test-result';
  }
}

function toggleGitSection() {
  const section = document.getElementById('gitSyncSection');
  if (section) {
    section.classList.toggle('collapsed');
  }
}

function onRepoInputChange() {
  updateRemoteUrl();
}

async function testGitConnection() {
  const btn = document.getElementById('gitTestBtn');
  const result = document.getElementById('gitTestResult');
  const createBtn = document.getElementById('gitCreateRepoBtn');

  btn.disabled = true;
  if (createBtn) createBtn.style.display = 'none';
  result.textContent = t('settings.testing') || 'Testing...';
  result.className = 'git-test-result testing';

  try {
    // First save the remote if changed
    const remoteInput = document.getElementById('gitRemoteInput');
    const identitySelect = document.getElementById('gitIdentitySelect');
    const identity = identitySelect ? identitySelect.value : '';

    if (remoteInput.value.trim()) {
      await fetch('/api/git/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remote: remoteInput.value.trim() })
      });
    }

    // Pass gh account if using HTTPS with gh CLI
    const testBody = {};
    if (identity.startsWith('https:')) {
      const ghAccount = identity.replace('https:', '');
      if (ghAccount) {
        testBody.gh_account = ghAccount;
      }
    }

    const res = await fetch('/api/git/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testBody)
    });
    const data = await res.json();

    if (data.ok) {
      result.textContent = t('settings.connectionSuccess');
      result.className = 'git-test-result success';
    } else {
      // Show full error with line breaks
      const msg = data.message || t('settings.connectionFailed');
      result.innerHTML = msg.replace(/\n/g, '<br>');
      result.className = 'git-test-result error';

      // Show create repo button if repo doesn't exist and gh CLI is available
      if (data.can_create && createBtn && identity.startsWith('https:')) {
        createBtn.style.display = 'inline-block';
      }
    }
  } catch (e) {
    result.textContent = 'Test failed: ' + e.message;
    result.className = 'git-test-result error';
  } finally {
    btn.disabled = false;
  }
}

async function createGitHubRepo() {
  const btn = document.getElementById('gitCreateRepoBtn');
  const result = document.getElementById('gitTestResult');

  btn.disabled = true;
  btn.textContent = '...';

  try {
    const res = await fetch('/api/git/create-repo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ private: true })
    });
    const data = await res.json();

    if (data.ok) {
      result.textContent = t('settings.connectionSuccess');
      result.className = 'git-test-result success';
      btn.style.display = 'none';
      // Refresh git status
      loadGitStatus();
    } else {
      result.innerHTML = data.message.replace(/\n/g, '<br>');
      result.className = 'git-test-result error';
    }
  } catch (e) {
    result.textContent = 'Create failed: ' + e.message;
    result.className = 'git-test-result error';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create';
  }
}

async function onLanguageChange() {
  const select = document.getElementById('languageSelect');
  const lang = select.value;
  const previousLang = getCurrentLanguage();

  await changeLanguage(lang);

  // Refresh UI with new language
  updateStaticText();
  renderGitSettingsModal();
  render();
  renderGitStatus();

  // Refresh notes if loaded
  if (notesLoaded && typeof renderNotesTree === 'function') {
    renderNotesTree();
    if (selectedNoteId) {
      const note = getNoteById(selectedNoteId);
      if (note) renderNoteContent(note);
    }
  }

  // If language changed and we have example data, automatically reload in new language
  if (lang !== previousLang && hasExamples) {
    try {
      const res = await fetch('/api/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'examples' })
      });
      const data = await res.json();
      if (data.ok) {
        // Reload data
        await loadBoard();
        render();
        // Reload notes if on notes view
        if (currentView === 'notes' && typeof loadNotes === 'function') {
          await loadNotes();
          renderNotesTree();
        }
      }
    } catch (err) {
      console.error('Failed to reload examples:', err);
    }
  }
}

async function pickSections(mode) {
  const showBoard = mode === 'both' || mode === 'board';
  const showNotes = mode === 'both' || mode === 'notes';

  // Update picker UI
  document.getElementById('pickBoth').classList.toggle('active', mode === 'both');
  document.getElementById('pickBoard').classList.toggle('active', mode === 'board');
  document.getElementById('pickNotes').classList.toggle('active', mode === 'notes');

  // Save to server
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ showBoard, showNotes })
  });

  // Apply changes
  applyExperienceSettings(showBoard, showNotes);
}

async function saveGitSettings() {
  const checkbox = document.getElementById('gitEnabledCheckbox');
  const remoteInput = document.getElementById('gitRemoteInput');
  const usernameInput = document.getElementById('usernameInput');

  const enabled = checkbox.checked;
  const remote = remoteInput.value.trim();
  const newUsername = usernameInput ? usernameInput.value.trim() : '';

  // Save username
  if (newUsername !== currentUser) {
    currentUser = newUsername;
    localStorage.setItem('kanban_user', newUsername);
    updateUserBadge();
    // Also save to server settings
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: newUsername })
    });
  }

  try {
    if (enabled && remote) {
      // Setup git with the remote
      const res = await fetch('/api/git/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remote })
      });
      const data = await res.json();
      if (!data.ok) {
        alert('Failed to setup Git: ' + (data.error || 'Unknown error'));
        return;
      }
    } else if (enabled) {
      // Just enable without changing remote
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ git_enabled: true })
      });
    } else {
      // Disable git sync
      await fetch('/api/git/disable', { method: 'POST' });
    }

    closeGitSettings();
    await loadGitStatus();
  } catch (e) {
    alert('Failed to save settings: ' + e.message);
  }
}

// --- Data Management ---

async function clearAllData() {
  if (!confirm(t('confirm.clearAllData'))) {
    return;
  }

  try {
    const res = await fetch('/api/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'empty' })
    });
    const data = await res.json();

    if (data.ok) {
      closeGitSettings();
      // Reload the page to get fresh data
      window.location.reload();
    } else {
      alert('Failed to clear data: ' + (data.error || 'Unknown error'));
    }
  } catch (e) {
    alert('Failed to clear data: ' + e.message);
  }
}

async function resetToExamples() {
  if (!confirm(t('confirm.restoreExamples'))) {
    return;
  }

  try {
    const res = await fetch('/api/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'examples' })
    });
    const data = await res.json();

    if (data.ok) {
      closeGitSettings();
      // Reload the page to get fresh data
      window.location.reload();
    } else {
      alert('Failed to restore examples: ' + (data.error || 'Unknown error'));
    }
  } catch (e) {
    alert('Failed to restore examples: ' + e.message);
  }
}

// --- Board data ---

function autoBacklog() {
  const cutoff = now();
  const toBacklog = [];
  board.tasks = board.tasks.filter(t => {
    if (t.column === 'done' && t.modifiedAt && daysBetween(t.modifiedAt, cutoff) >= 2) {
      toBacklog.push(t);
      return false;
    }
    return true;
  });
  if (toBacklog.length > 0) {
    board.backlog.push(...toBacklog);
    saveBoard();
  }
}

async function loadBoard() {
  const res = await fetch('/api/board');
  board = await res.json();
  if (board.archived && !board.backlog) {
    board.backlog = board.archived;
    delete board.archived;
  }
  if (!board.backlog) board.backlog = [];
  if (!board.trash) board.trash = [];
  const ts = now();
  let migrated = false;
  for (const t of [...board.tasks, ...board.backlog]) {
    if (!t.createdAt) { t.createdAt = ts; migrated = true; }
    if (!t.modifiedAt) { t.modifiedAt = ts; migrated = true; }
  }
  if (migrated) await saveBoard();
  autoBacklog();
  collectAllUniqueTags(); // Collect tags for filter
  render();
}

async function saveBoard() {
  const ind = document.getElementById('saveIndicator');
  ind.textContent = t('save.saving');
  ind.className = 'save-indicator saving';
  try {
    await fetch('/api/board', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(board)
    });
    ind.textContent = t('save.saved');
    ind.className = 'save-indicator saved';
    setTimeout(() => { ind.textContent = ''; }, 2000);
    // Refresh git status after save
    loadGitStatus();
  } catch {
    ind.textContent = t('save.error');
    ind.className = 'save-indicator error';
  }
}

// --- Drag & drop helpers ---

function getDropIndex(container, y, selector) {
  const items = [...container.querySelectorAll(selector + ':not(.dragging)')];
  for (let i = 0; i < items.length; i++) {
    const rect = items[i].getBoundingClientRect();
    if (y < rect.top + rect.height / 2) return i;
  }
  return items.length;
}

function showDropIndicator(container, y, selector) {
  const items = [...container.querySelectorAll(selector)];
  items.forEach(el => el.classList.remove('drop-before'));
  container.classList.remove('drag-over');
  const visible = items.filter(el => !el.classList.contains('dragging'));
  for (let i = 0; i < visible.length; i++) {
    const rect = visible[i].getBoundingClientRect();
    if (y < rect.top + rect.height / 2) {
      visible[i].classList.add('drop-before');
      return;
    }
  }
  container.classList.add('drag-over');
}

function clearDropIndicators(container, selector) {
  container.querySelectorAll(selector).forEach(el => el.classList.remove('drop-before'));
  container.classList.remove('drag-over');
}

function insertTaskInColumn(task, colId, dropIndex) {
  const colTasks = board.tasks.filter(t => t.column === colId);
  if (dropIndex < colTasks.length) {
    const refTask = colTasks[dropIndex];
    const refIdx = board.tasks.indexOf(refTask);
    board.tasks.splice(refIdx, 0, task);
  } else {
    let insertAt = board.tasks.length;
    for (let i = board.tasks.length - 1; i >= 0; i--) {
      if (board.tasks[i].column === colId) { insertAt = i + 1; break; }
    }
    board.tasks.splice(insertAt, 0, task);
  }
}

// --- Tags ---

function renderTagPills(tags) {
  if (!tags || !tags.length) return '';
  return '<div class="card-tags">' + tags.map(t => {
    const c = stringToColor(t);
    const bg = stringToColorAlpha(t, 0.15);
    const bc = stringToColorAlpha(t, 0.3);
    return '<span class="tag" style="background:' + bg + ';color:' + c + ';border:1px solid ' + bc + '">' + escapeHtml(t) + '</span>';
  }).join('') + '</div>';
}

function renderModalTags() {
  const container = document.getElementById('tagsContainer');
  container.innerHTML = '';
  for (const tag of modalTags) {
    const c = stringToColor(tag);
    const pill = document.createElement('span');
    pill.className = 'tag';
    pill.style.background = stringToColorAlpha(tag, 0.15);
    pill.style.color = c;
    pill.style.border = '1px solid ' + stringToColorAlpha(tag, 0.3);
    pill.innerHTML = escapeHtml(tag) + '<button class="tag-remove" type="button">&times;</button>';
    pill.querySelector('.tag-remove').addEventListener('click', () => {
      modalTags = modalTags.filter(t => t !== tag);
      renderModalTags();
    });
    container.appendChild(pill);
  }
}

function addTagFromInput() {
  const input = document.getElementById('tagsInput');
  const val = input.value.replace(/,/g, '').trim();
  if (val && !modalTags.includes(val)) {
    modalTags.push(val);
    renderModalTags();
  }
  input.value = '';
}

// --- Markdown toolbar ---

function mdInsert(before, after, targetTa) {
  const ta = targetTa || document.getElementById('taskDesc');
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const selected = ta.value.substring(start, end);
  const replacement = before + selected + after;
  ta.setRangeText(replacement, start, end, 'select');
  ta.focus();
}

function buildMdToolbar(targetTa) {
  const bar = document.createElement('div');
  bar.className = 'md-toolbar';
  const buttons = [
    ['<b>B</b>', '**', '**', 'Negrita'],
    ['<i>I</i>', '_', '_', 'Cursiva'],
    ['&lt;/&gt;', '`', '`', 'Codigo inline'],
    ['```', '\\n```\\n', '\\n```\\n', 'Bloque de codigo'],
    ['- Lista', '\\n- ', '', 'Lista'],
    ['[ ] Check', '\\n- [ ] ', '', 'Checklist'],
    ['H2', '\\n## ', '', 'Titulo'],
    ['Link', '[', '](url)', 'Link'],
  ];
  for (const [label, before, after, title] of buttons) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = title;
    btn.innerHTML = label;
    btn.addEventListener('click', () => mdInsert(before, after, targetTa));
    bar.appendChild(btn);
  }
  return bar;
}

// --- Backlog layout ---

function applyBacklogLayout() {
  const panel = document.getElementById('bottomPanel');
  const handle = document.getElementById('resizeHandle');
  if (backlogCollapsed) {
    panel.classList.add('collapsed');
    handle.style.display = 'none';
  } else {
    panel.classList.remove('collapsed');
    handle.style.display = '';
    panel.style.height = backlogHeight + 'px';
  }
}

// --- Render: board columns ---

function render() {
  const container = document.getElementById('board');
  container.innerHTML = '';

  // Check if filter is active
  const hasActiveFilter = selectedTags.length > 0;

  for (const col of board.columns) {
    const allColTasks = board.tasks.filter(t => t.column === col.id);
    // Apply filter to get visible tasks
    const filteredColTasks = allColTasks.filter(t => taskMatchesFilter(t));
    const colEl = document.createElement('div');
    colEl.className = 'column';
    const colTitle = t('columns.' + col.id) || col.title;
    // Show filtered/total count when filter is active
    const countText = hasActiveFilter && filteredColTasks.length !== allColTasks.length
      ? `${filteredColTasks.length}/${allColTasks.length}`
      : `${allColTasks.length}`;
    colEl.innerHTML = `
      <div class="column-header">
        ${colTitle}
        <span class="count${hasActiveFilter && filteredColTasks.length !== allColTasks.length ? ' filtered' : ''}">${countText}</span>
      </div>
      <div class="column-body" data-column="${col.id}"></div>
      <button class="add-card-btn" data-column="${col.id}">${t('task.addTask')}</button>
    `;

    const body = colEl.querySelector('.column-body');

    body.addEventListener('dragover', e => {
      e.preventDefault();
      showDropIndicator(body, e.clientY, '.card:not(.subtask-card)');
    });
    body.addEventListener('dragleave', () => {
      clearDropIndicators(body, '.card');
    });
    body.addEventListener('drop', e => {
      e.preventDefault();
      const dropIdx = getDropIndex(body, e.clientY, '.card:not(.subtask-card)');
      clearDropIndicators(body, '.card');
      const taskId = parseInt(e.dataTransfer.getData('text/plain'));

      let task;
      let fromBacklog = false;
      const blIdx = board.backlog.findIndex(t => t.id === taskId);
      if (blIdx !== -1) {
        task = board.backlog.splice(blIdx, 1)[0];
        fromBacklog = true;
      } else {
        const fromIdx = board.tasks.findIndex(t => t.id === taskId);
        if (fromIdx === -1) return;
        task = board.tasks.splice(fromIdx, 1)[0];
      }

      task.column = col.id;
      // Keep parentId when moving between columns (subtask stays a subtask)
      // Only clear parentId when coming from backlog (parent relationship unknown)
      if (fromBacklog) {
        task.parentId = null;
      }
      task.modifiedAt = now();
      insertTaskInColumn(task, col.id, dropIdx);
      render();
      saveBoard();
    });

    // Render root tasks (no parent) and "orphaned" subtasks (parent in different column)
    // Apply filter to determine which tasks to render
    const tasksToRender = filteredColTasks.filter(t => {
      if (!t.parentId) return true; // Root task
      const parent = board.tasks.find(p => p.id === t.parentId);
      // Render as root if parent doesn't exist or parent is in different column
      // Or if parent doesn't match filter (so orphaned subtask becomes visible)
      if (!parent || parent.column !== col.id) return true;
      // If parent is filtered out but this task matches, show it
      if (!taskMatchesFilter(parent)) return true;
      return false;
    });

    for (const task of tasksToRender) {
      renderTaskTree(task, body, 'tasks', 0);
    }

    colEl.querySelector('.add-card-btn').addEventListener('click', () => {
      openAddModal(col.id);
    });

    container.appendChild(colEl);
  }

  renderBacklog();
  renderTrash();
  renderFilterBar();
}

function renderTaskTree(task, container, source, depth) {
  const card = renderCard(task, source, depth);
  container.appendChild(card);

  // Render children if not collapsed (only children in same column)
  if (!task.collapsed && source === 'tasks') {
    const children = getTaskChildren(task.id, source)
      .filter(c => c.column === task.column)
      .filter(c => taskMatchesFilter(c)); // Apply tag filter to subtasks
    for (const child of children) {
      renderTaskTree(child, container, source, depth + 1);
    }
  } else if (!task.collapsed && source !== 'tasks') {
    // In backlog/trash, render all children (no column filtering, but apply tag filter)
    const children = getTaskChildren(task.id, source)
      .filter(c => taskMatchesFilter(c));
    for (const child of children) {
      renderTaskTree(child, container, source, depth + 1);
    }
  }
}

function renderCard(task, source, depth = 0) {
  const card = document.createElement('div');
  card.className = 'card' + (depth > 0 ? ' subtask-card' : '');
  card.draggable = source === 'tasks';
  card.dataset.id = task.id;
  if (depth > 0) {
    card.style.setProperty('--depth', depth);
  }

  const children = getTaskChildren(task.id, source);
  const hasChildren = children.length > 0;
  const childrenInSameColumn = source === 'tasks'
    ? children.filter(c => c.column === task.column)
    : children;
  const hasVisibleChildren = childrenInSameColumn.length > 0;

  if (source === 'tasks') {
    card.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', task.id);
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
    });
  }

  card.addEventListener('click', e => {
    if (e.target.closest('.card-actions')) return;
    if (e.target.closest('.card-chevron')) return;
    openDetail(task.id, source);
  });

  let actionsHtml = '';
  if (source === 'tasks') {
    actionsHtml = `
      <div class="card-actions">
        <button onclick="addSubtask(${task.id})" title="${t('task.addSubtask')}">+</button>
        <button onclick="editTask(${task.id})" title="${t('task.edit_btn')}">&#9998;</button>
        <button onclick="backlogTask(${task.id})" title="${t('task.backlog')}">&#8921;</button>
        <button class="delete" onclick="trashTask(${task.id})" title="${t('task.delete')}">&times;</button>
      </div>`;
  } else if (source === 'backlog') {
    actionsHtml = `
      <div class="card-actions">
        <button onclick="restoreTask(${task.id}, 'backlog')" title="${t('backlog.restore')}">&#8634;</button>
        <button class="delete" onclick="trashFromList(${task.id}, 'backlog')" title="${t('task.delete')}">&times;</button>
      </div>`;
  } else if (source === 'trash') {
    actionsHtml = `
      <div class="card-actions">
        <button onclick="restoreTask(${task.id}, 'trash')" title="${t('backlog.restore')}">&#8634;</button>
        <button class="delete" onclick="permanentDelete(${task.id})" title="${t('trash.permanentDelete')}">&#10006;</button>
      </div>`;
  }

  // Chevron for collapse/expand
  let chevronHtml = '';
  if (hasVisibleChildren) {
    const chevronClass = task.collapsed ? 'collapsed' : '';
    chevronHtml = `<span class="card-chevron ${chevronClass}" onclick="toggleTaskCollapse(${task.id}, event)">&#9660;</span>`;
  } else {
    chevronHtml = '<span class="card-chevron empty"></span>';
  }

  let html = actionsHtml + chevronHtml + `<div class="card-title"><span class="card-id">T${task.id}</span>${escapeHtml(task.title)}</div>`;
  html += renderTagPills(task.tags);

  const metaParts = [];
  if (task.createdBy) {
    const c = stringToColor(task.createdBy);
    metaParts.push(`<span class="user-dot" style="background:${c};width:8px;height:8px"></span> ${escapeHtml(task.createdBy)}`);
  }
  if (task.description) metaParts.push('&#9776;');
  const commentCount = (task.comments || []).length;
  if (commentCount) metaParts.push(`&#128172; ${commentCount}`);
  // Show subtask count if collapsed or has children in other columns
  const allDescendants = getAllDescendants(task.id, source);
  if (allDescendants.length > 0) {
    metaParts.push(`&#9656; ${t('task.subtasksCount', { count: allDescendants.length })}`);
  }
  if (task.modifiedAt) metaParts.push(formatDate(task.modifiedAt));
  if (metaParts.length) {
    html += `<div class="card-meta">${metaParts.join(' &middot; ')}</div>`;
  }

  card.innerHTML = html;
  return card;
}

function toggleTaskCollapse(taskId, event) {
  event.stopPropagation();
  const task = board.tasks.find(t => t.id === taskId);
  if (!task) return;
  task.collapsed = !task.collapsed;
  render();
  saveBoard();
}

// --- Render: backlog ---

function toggleTrash() {
  showTrash = !showTrash;
  if (showTrash && backlogCollapsed) {
    backlogCollapsed = false;
    localStorage.setItem('kanban_backlogCollapsed', 'false');
  }
  renderBacklog();
  renderTrash();
}

function renderBacklog() {
  const section = document.getElementById('backlogSection');
  const allItems = board.backlog;
  const items = allItems.filter(task => taskMatchesFilter(task));
  section.innerHTML = '';

  const hasActiveFilter = selectedTags.length > 0;
  const countText = hasActiveFilter && items.length !== allItems.length
    ? `${items.length}/${allItems.length}`
    : `${allItems.length}`;
  const header = document.createElement('div');
  header.className = 'backlog-header';
  header.innerHTML = '<span class="backlog-chevron">&#9660;</span> ' + t('backlog.title') + ' <span class="count' + (hasActiveFilter && items.length !== allItems.length ? ' filtered' : '') + '">' + countText + '</span>';
  header.addEventListener('click', e => {
    if (e.target.closest('.trash-toggle')) return;
    backlogCollapsed = !backlogCollapsed;
    localStorage.setItem('kanban_backlogCollapsed', String(backlogCollapsed));
    applyBacklogLayout();
    renderBacklog();
    renderTrash();
  });

  const trashBtn = document.createElement('button');
  trashBtn.className = 'trash-toggle' + (showTrash ? ' active' : '');
  trashBtn.title = t('trash.title') + (board.trash.length ? ' (' + board.trash.length + ')' : '');
  trashBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25ZM4.117 5.684l.625 7.516A1.75 1.75 0 0 0 6.487 15h3.026a1.75 1.75 0 0 0 1.745-1.8l.625-7.516a.25.25 0 0 0-.248-.268H4.365a.25.25 0 0 0-.248.268Z"/></svg>';
  trashBtn.addEventListener('click', toggleTrash);
  header.appendChild(trashBtn);
  section.appendChild(header);

  const list = document.createElement('div');
  list.className = 'backlog-list';

  for (const task of items) {
    const row = document.createElement('div');
    row.className = 'backlog-row';
    row.draggable = true;
    row.dataset.id = task.id;

    row.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', task.id);
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
    });
    row.addEventListener('click', e => {
      if (e.target.closest('.card-actions')) return;
      openDetail(task.id, 'backlog');
    });

    let tagsHtml = '';
    if (task.tags && task.tags.length) {
      tagsHtml = task.tags.map(t => {
        const c = stringToColor(t);
        const bg = stringToColorAlpha(t, 0.15);
        const bc = stringToColorAlpha(t, 0.3);
        return '<span class="tag" style="background:' + bg + ';color:' + c + ';border:1px solid ' + bc + '">' + escapeHtml(t) + '</span>';
      }).join('');
    }

    const preview = descriptionPreview(task.description);
    row.innerHTML = '<span class="card-id">T' + task.id + '</span>' + tagsHtml +
      '<span class="backlog-row-title">' + escapeHtml(task.title) + '</span>' +
      (preview ? '<span class="backlog-row-desc">' + escapeHtml(preview) + '</span>' : '') +
      '<div class="card-actions">' +
        '<button onclick="restoreTask(' + task.id + ', \'backlog\')" title="' + t('backlog.restore') + '">&#8634;</button>' +
        '<button class="delete" onclick="trashFromList(' + task.id + ', \'backlog\')" title="' + t('task.delete') + '">&times;</button>' +
      '</div>';
    list.appendChild(row);
  }

  section.appendChild(list);

  section.ondragover = e => {
    e.preventDefault();
    showDropIndicator(list, e.clientY, '.backlog-row');
  };
  section.ondragleave = e => {
    if (!section.contains(e.relatedTarget)) {
      clearDropIndicators(list, '.backlog-row');
    }
  };
  section.ondrop = e => {
    e.preventDefault();
    const dropIdx = getDropIndex(list, e.clientY, '.backlog-row');
    clearDropIndicators(list, '.backlog-row');
    const taskId = parseInt(e.dataTransfer.getData('text/plain'));

    const boardIdx = board.tasks.findIndex(t => t.id === taskId);
    if (boardIdx !== -1) {
      const task = board.tasks.splice(boardIdx, 1)[0];
      task.modifiedAt = now();
      board.backlog.splice(dropIdx, 0, task);
      render();
      saveBoard();
      return;
    }

    const blIdx = board.backlog.findIndex(t => t.id === taskId);
    if (blIdx !== -1 && blIdx !== dropIdx) {
      const [task] = board.backlog.splice(blIdx, 1);
      const adj = blIdx < dropIdx ? dropIdx - 1 : dropIdx;
      board.backlog.splice(adj, 0, task);
      render();
      saveBoard();
    }
  };

  applyBacklogLayout();
}

// --- Render: trash ---

function renderTrash() {
  const section = document.getElementById('trashSection');
  section.style.display = showTrash ? '' : 'none';
  if (!showTrash) return;

  const allItems = board.trash;
  const items = allItems.filter(task => taskMatchesFilter(task));
  section.innerHTML = '';

  const hasActiveFilter = selectedTags.length > 0;
  const countText = hasActiveFilter && items.length !== allItems.length
    ? `${items.length}/${allItems.length}`
    : `${allItems.length}`;
  const header = document.createElement('div');
  header.className = 'trash-header';
  header.innerHTML = t('trash.title') + ' <span class="count' + (hasActiveFilter && items.length !== allItems.length ? ' filtered' : '') + '">' + countText + '</span>';
  if (allItems.length > 0) {
    const emptyBtn = document.createElement('button');
    emptyBtn.className = 'empty-trash-btn';
    emptyBtn.textContent = t('trash.empty');
    emptyBtn.addEventListener('click', emptyTrash);
    header.appendChild(emptyBtn);
  }
  section.appendChild(header);

  for (const task of items) {
    section.appendChild(renderCard(task, 'trash'));
  }
}

function emptyTrash() {
  if (!board.trash.length) return;
  if (!confirm(t('trash.emptyConfirm', { count: board.trash.length }))) return;
  board.trash = [];
  render();
  saveBoard();
}

// --- Modals ---

function openAddModal(columnId) {
  editingTaskId = null;
  addingToColumn = columnId;
  document.getElementById('modalTitle').textContent = t('task.new');
  document.getElementById('taskTitle').value = '';
  document.getElementById('taskDesc').value = '';
  modalTags = [];
  renderModalTags();
  document.getElementById('tagsInput').value = '';
  document.getElementById('modalBackdrop').classList.add('open');
  document.getElementById('taskTitle').focus();
}

function editTask(id) {
  const task = board.tasks.find(t => t.id === id);
  if (!task) return;
  editingTaskId = id;
  addingToColumn = null;
  document.getElementById('modalTitle').textContent = t('task.edit');
  document.getElementById('taskTitle').value = task.title;
  document.getElementById('taskDesc').value = task.description || '';
  modalTags = [...(task.tags || [])];
  renderModalTags();
  document.getElementById('tagsInput').value = '';
  document.getElementById('modalBackdrop').classList.add('open');
  document.getElementById('taskTitle').focus();
}

function closeModal() {
  document.getElementById('modalBackdrop').classList.remove('open');
  editingTaskId = null;
  addingToColumn = null;
  addingToParent = null;
}

function saveModal() {
  const title = document.getElementById('taskTitle').value.trim();
  if (!title) return;
  const desc = document.getElementById('taskDesc').value.trim();
  const ts = now();

  if (editingTaskId !== null) {
    const task = board.tasks.find(t => t.id === editingTaskId);
    if (task) {
      task.title = title;
      task.description = desc;
      task.tags = modalTags.length ? [...modalTags] : [];
      task.modifiedAt = ts;
    }
  } else if (addingToColumn) {
    const newTask = {
      id: board.nextId++,
      title,
      description: desc,
      tags: modalTags.length ? [...modalTags] : [],
      column: addingToColumn,
      createdBy: currentUser,
      createdAt: ts,
      modifiedAt: ts
    };
    if (addingToParent) {
      newTask.parentId = addingToParent;
    }
    board.tasks.push(newTask);
  }

  closeModal();
  render();
  saveBoard();
}

// --- Detail view ---

function openDetail(id, source) {
  const list = getSourceList(source);
  const task = list.find(t => t.id === id);
  if (!task) return;
  viewingTaskId = id;
  viewingSource = source;
  document.getElementById('detailTitle').innerHTML = '<span class="card-id">T' + task.id + '</span>' + escapeHtml(task.title);

  const col = board.columns.find(c => c.id === task.column);
  const sourceLabel = source === 'backlog' ? t('backlog.title') : source === 'trash' ? t('trash.title') : '';
  document.getElementById('detailColumn').textContent =
    (sourceLabel ? sourceLabel + ' - ' : '') + (col ? col.title : task.column);

  const detailTagsEl = document.getElementById('detailTags');
  if (task.tags && task.tags.length) {
    detailTagsEl.innerHTML = task.tags.map(t => {
      const c = stringToColor(t);
      const bg = stringToColorAlpha(t, 0.15);
      const bc = stringToColorAlpha(t, 0.3);
      return '<span class="tag" style="background:' + bg + ';color:' + c + ';border:1px solid ' + bc + '">' + escapeHtml(t) + '</span>';
    }).join(' ');
  } else {
    detailTagsEl.innerHTML = '';
  }

  let datesText = '';
  if (task.createdBy) {
    const c = stringToColor(task.createdBy);
    datesText += '<span class="user-dot" style="background:' + c + ';width:8px;height:8px"></span> ' + escapeHtml(task.createdBy) + '  |  ';
  }
  if (task.createdAt) datesText += t('task.created') + ' ' + formatDate(task.createdAt);
  if (task.modifiedAt) datesText += '  |  ' + t('task.modified') + ' ' + formatDate(task.modifiedAt);
  document.getElementById('detailDates').innerHTML = datesText;

  const blBtn = document.getElementById('detailBacklogBtn');
  if (source === 'tasks') {
    blBtn.textContent = t('task.backlog');
    blBtn.onclick = backlogFromDetail;
  } else {
    blBtn.textContent = t('task.restore');
    blBtn.onclick = restoreFromDetail;
  }

  const body = document.getElementById('detailBody');
  let bodyHtml = '';

  // Show parent link if this is a subtask
  if (task.parentId) {
    const parent = list.find(t => t.id === task.parentId);
    if (parent) {
      bodyHtml += `<div class="detail-parent">${t('task.subtaskOf')} <a onclick="openDetail(${parent.id}, '${source}')">[T${parent.id}] ${escapeHtml(parent.title)}</a></div>`;
    }
  }

  if (task.description) {
    let descHtml = marked.parse(task.description);
    descHtml = renderCrossReferences(descHtml);
    bodyHtml += descHtml;
    body.innerHTML = bodyHtml;
    body.classList.remove('empty');
    body.querySelectorAll('input[type="checkbox"]').forEach((cb, idx) => {
      cb.disabled = false;
      cb.style.cursor = 'pointer';
      cb.addEventListener('change', () => {
        toggleCheckbox(task, idx, cb.checked);
      });
    });
  } else {
    body.innerHTML = bodyHtml + '<p class="empty">' + t('task.noDescription') + '</p>';
    if (!task.parentId) body.classList.add('empty');
    else body.classList.remove('empty');
  }

  // Show subtasks
  const subtasks = getTaskChildren(task.id, source);
  if (subtasks.length > 0 || source === 'tasks') {
    renderDetailSubtasks(task, subtasks, source);
  } else {
    const existingSubtasks = document.getElementById('detailSubtasks');
    if (existingSubtasks) existingSubtasks.remove();
  }

  renderComments(task);
  document.getElementById('detailBackdrop').classList.add('open');
}

function renderDetailSubtasks(task, subtasks, source) {
  let container = document.getElementById('detailSubtasks');
  if (!container) {
    container = document.createElement('div');
    container.id = 'detailSubtasks';
    container.className = 'detail-subtasks';
    document.getElementById('detailBody').after(container);
  }

  let html = `<div class="detail-subtasks-title">
    <span>${t('task.subtasks')}${subtasks.length ? ` (${subtasks.length})` : ''}</span>
    ${source === 'tasks' ? `<button onclick="addSubtaskFromDetail()">${t('task.add')}</button>` : ''}
  </div>`;

  for (const sub of subtasks) {
    const col = board.columns.find(c => c.id === sub.column);
    const colName = t('columns.' + sub.column) || (col ? col.title : sub.column);
    const subSubtasks = getTaskChildren(sub.id, source);
    const subCount = subSubtasks.length > 0 ? ` (+${getAllDescendants(sub.id, source).length})` : '';
    html += `<div class="detail-subtask-item" onclick="openDetail(${sub.id}, '${source}')">
      <span class="card-id">T${sub.id}</span>
      <span>${escapeHtml(sub.title)}${subCount}</span>
      <span class="detail-subtask-column">${colName}</span>
    </div>`;
  }

  if (subtasks.length === 0 && source === 'tasks') {
    html += '<div style="color:#484f58;font-size:12px;padding:8px 0;">' + t('task.noSubtasks') + '</div>';
  }

  container.innerHTML = html;
}

function addSubtaskFromDetail() {
  if (!viewingTaskId) return;
  closeDetail();
  addSubtask(viewingTaskId);
}

function closeDetail() {
  document.getElementById('detailBackdrop').classList.remove('open');
  viewingTaskId = null;
  viewingSource = 'tasks';
}

function editFromDetail(event) {
  // Don't trigger edit if clicking on links, checkboxes, or buttons
  if (event && event.target) {
    const tag = event.target.tagName.toLowerCase();
    if (tag === 'a' || tag === 'input' || tag === 'button' || tag === 'code') return;
    if (event.target.closest('a') || event.target.closest('input') || event.target.closest('button')) return;
  }
  if (viewingSource !== 'tasks') return;
  const id = viewingTaskId;
  closeDetail();
  editTask(id);
}

function backlogFromDetail() {
  const id = viewingTaskId;
  closeDetail();
  backlogTask(id);
}

function restoreFromDetail() {
  const src = viewingSource;
  const id = viewingTaskId;
  closeDetail();
  restoreTask(id, src);
}

function toggleCheckbox(task, checkboxIndex, checked) {
  let count = 0;
  const lines = task.description.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^(\s*)-\s\[[ x]\]\s/.test(lines[i])) {
      if (count === checkboxIndex) {
        lines[i] = checked
          ? lines[i].replace('- [ ] ', '- [x] ')
          : lines[i].replace('- [x] ', '- [ ] ');
        break;
      }
      count++;
    }
  }
  task.description = lines.join('\n');
  task.modifiedAt = now();
  render();
  saveBoard();
}

// --- Comments ---

function renderComments(task) {
  const list = document.getElementById('commentsList');
  list.innerHTML = '';
  const comments = task.comments || [];
  document.getElementById('commentsTitle').textContent =
    comments.length ? t('comments.titleCount', { count: comments.length }) : t('comments.title');
  for (let ci = 0; ci < comments.length; ci++) {
    const c = comments[ci];
    const color = stringToColor(c.author);
    const el = document.createElement('div');
    el.className = 'comment';
    let commentHtml = marked.parse(c.text);
    commentHtml = renderCrossReferences(commentHtml);
    el.innerHTML = `
      <div class="comment-header">
        <span class="user-dot" style="background:${color}"></span>
        <span class="comment-author" style="color:${color}">${escapeHtml(c.author)}</span>
        <span class="comment-date">${formatDate(c.date)}</span>
        <div class="comment-actions">
          <button onclick="editComment(${ci})" title="${t('task.edit_btn')}">&#9998;</button>
          <button class="delete" onclick="deleteComment(${ci})" title="${t('task.delete')}">&times;</button>
        </div>
      </div>
      <div class="comment-body detail-body">${commentHtml}</div>
    `;
    list.appendChild(el);
  }
  document.getElementById('commentInput').value = '';
}

function addComment() {
  const input = document.getElementById('commentInput');
  const text = input.value.trim();
  if (!text) return;
  const list = getSourceList(viewingSource);
  const task = list.find(t => t.id === viewingTaskId);
  if (!task) return;
  if (!task.comments) task.comments = [];
  task.comments.push({ author: currentUser, text, date: now() });
  task.modifiedAt = now();
  renderComments(task);
  render();
  saveBoard();
}

function editComment(idx) {
  const list = getSourceList(viewingSource);
  const task = list.find(t => t.id === viewingTaskId);
  if (!task || !task.comments || !task.comments[idx]) return;
  const comment = task.comments[idx];

  const commentEls = document.getElementById('commentsList').querySelectorAll('.comment');
  const el = commentEls[idx];
  if (!el) return;
  const bodyEl = el.querySelector('.comment-body');

  const ta = document.createElement('textarea');
  ta.className = 'comment-edit-area';
  ta.value = comment.text;

  const btns = document.createElement('div');
  btns.className = 'comment-edit-buttons';
  btns.innerHTML = '<button class="btn-cancel">' + t('task.cancel') + '</button><button class="btn-save">' + t('task.save') + '</button>';

  const toolbar = buildMdToolbar(ta);
  bodyEl.replaceWith(toolbar);
  toolbar.after(ta);
  ta.after(btns);
  ta.focus();
  ta.selectionStart = ta.value.length;

  btns.querySelector('.btn-cancel').addEventListener('click', () => {
    renderComments(task);
  });

  btns.querySelector('.btn-save').addEventListener('click', () => {
    const newText = ta.value.trim();
    if (!newText) {
      task.comments.splice(idx, 1);
    } else {
      comment.text = newText;
      comment.date = now();
    }
    task.modifiedAt = now();
    renderComments(task);
    render();
    saveBoard();
  });

  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      btns.querySelector('.btn-save').click();
    }
    if (e.key === 'Escape') {
      renderComments(task);
    }
  });
}

function deleteComment(idx) {
  if (!confirm(t('comments.deleteConfirm'))) return;
  const list = getSourceList(viewingSource);
  const task = list.find(t => t.id === viewingTaskId);
  if (!task || !task.comments) return;
  task.comments.splice(idx, 1);
  task.modifiedAt = now();
  renderComments(task);
  render();
  saveBoard();
}

// --- Task actions ---

function addSubtask(parentId) {
  const parent = board.tasks.find(t => t.id === parentId);
  if (!parent) return;
  // Expand parent if collapsed
  if (parent.collapsed) {
    parent.collapsed = false;
    render();
    saveBoard();
  }
  // Open modal for new subtask
  editingTaskId = null;
  addingToColumn = parent.column;
  addingToParent = parentId;
  document.getElementById('modalTitle').textContent = t('task.newSubtaskOf', { id: parentId });
  document.getElementById('taskTitle').value = '';
  document.getElementById('taskDesc').value = '';
  modalTags = [];
  renderModalTags();
  document.getElementById('tagsInput').value = '';
  document.getElementById('modalBackdrop').classList.add('open');
  document.getElementById('taskTitle').focus();
}

function backlogTask(id) {
  const idx = board.tasks.findIndex(t => t.id === id);
  if (idx === -1) return;
  const task = board.tasks[idx];
  const descendants = getAllDescendants(id, 'tasks');

  if (descendants.length > 0) {
    const choice = prompt(
      t('prompt.subtasksMove', { count: descendants.length }),
      t('prompt.defaultAll')
    );
    if (!choice || choice.toLowerCase() === 'cancelar' || choice.toLowerCase() === 'cancel') return;

    const choiceLower = choice.toLowerCase();
    if (choiceLower === 'todas' || choiceLower === 'all') {
      // Move task and all descendants
      const toMove = [task, ...descendants];
      for (const tsk of toMove) {
        const i = board.tasks.findIndex(x => x.id === tsk.id);
        if (i !== -1) board.tasks.splice(i, 1);
        tsk.modifiedAt = now();
        board.backlog.push(tsk);
      }
    } else {
      // Move only this task, orphan children
      board.tasks.splice(idx, 1);
      task.modifiedAt = now();
      board.backlog.push(task);
      // Clear parentId of direct children
      for (const child of getTaskChildren(id, 'tasks')) {
        child.parentId = null;
      }
    }
  } else {
    board.tasks.splice(idx, 1);
    task.modifiedAt = now();
    board.backlog.push(task);
  }

  render();
  saveBoard();
}

function trashTask(id) {
  const idx = board.tasks.findIndex(t => t.id === id);
  if (idx === -1) return;
  const task = board.tasks[idx];
  const descendants = getAllDescendants(id, 'tasks');

  if (descendants.length > 0) {
    const choice = prompt(
      t('prompt.subtasksDelete', { count: descendants.length }),
      t('prompt.defaultAll')
    );
    if (!choice || choice.toLowerCase() === 'cancelar' || choice.toLowerCase() === 'cancel') return;

    const choiceLower = choice.toLowerCase();
    if (choiceLower === 'todas' || choiceLower === 'all') {
      // Trash task and all descendants
      const toTrash = [task, ...descendants];
      for (const tsk of toTrash) {
        const i = board.tasks.findIndex(x => x.id === tsk.id);
        if (i !== -1) board.tasks.splice(i, 1);
        tsk.modifiedAt = now();
        board.trash.push(tsk);
      }
    } else {
      // Trash only this task, orphan children
      board.tasks.splice(idx, 1);
      task.modifiedAt = now();
      board.trash.push(task);
      // Clear parentId of direct children
      for (const child of getTaskChildren(id, 'tasks')) {
        child.parentId = null;
      }
    }
  } else {
    board.tasks.splice(idx, 1);
    task.modifiedAt = now();
    board.trash.push(task);
  }

  render();
  saveBoard();
}

function trashFromList(id, source) {
  const list = getSourceList(source);
  const idx = list.findIndex(t => t.id === id);
  if (idx === -1) return;
  const task = list[idx];
  const descendants = getAllDescendants(id, source);

  if (descendants.length > 0) {
    const choice = prompt(
      t('prompt.subtasksDelete', { count: descendants.length }),
      t('prompt.defaultAll')
    );
    if (!choice || choice.toLowerCase() === 'cancelar' || choice.toLowerCase() === 'cancel') return;

    const choiceLower = choice.toLowerCase();
    if (choiceLower === 'todas' || choiceLower === 'all') {
      const toTrash = [task, ...descendants];
      for (const tsk of toTrash) {
        const i = list.findIndex(x => x.id === tsk.id);
        if (i !== -1) list.splice(i, 1);
        tsk.modifiedAt = now();
        board.trash.push(tsk);
      }
    } else {
      list.splice(idx, 1);
      task.modifiedAt = now();
      board.trash.push(task);
      for (const child of getTaskChildren(id, source)) {
        child.parentId = null;
      }
    }
  } else {
    list.splice(idx, 1);
    task.modifiedAt = now();
    board.trash.push(task);
  }

  render();
  saveBoard();
}

function restoreTask(id, source) {
  const list = getSourceList(source);
  const idx = list.findIndex(t => t.id === id);
  if (idx === -1) return;
  const task = list[idx];
  const descendants = getAllDescendants(id, source);

  if (descendants.length > 0) {
    const location = source === 'backlog' ? t('prompt.backlog') : t('prompt.theTrash');
    const choice = prompt(
      t('prompt.subtasksRestore', { count: descendants.length, location }),
      t('prompt.defaultAll')
    );
    if (!choice || choice.toLowerCase() === 'cancelar' || choice.toLowerCase() === 'cancel') return;

    const choiceLower = choice.toLowerCase();
    if (choiceLower === 'todas' || choiceLower === 'all') {
      // Restore task and all descendants
      const toRestore = [task, ...descendants];
      for (const tsk of toRestore) {
        const i = list.findIndex(x => x.id === tsk.id);
        if (i !== -1) list.splice(i, 1);
        tsk.column = 'todo';
        tsk.modifiedAt = now();
        board.tasks.push(tsk);
      }
    } else {
      // Restore only this task
      list.splice(idx, 1);
      task.column = 'todo';
      task.parentId = null; // Clear parent since parent might not be restored
      task.modifiedAt = now();
      board.tasks.push(task);
    }
  } else {
    list.splice(idx, 1);
    task.column = 'todo';
    task.parentId = null; // Clear parent when restoring (parent might be elsewhere)
    task.modifiedAt = now();
    board.tasks.push(task);
  }

  render();
  saveBoard();
}

function permanentDelete(id) {
  const task = board.trash.find(t => t.id === id);
  if (!task) return;
  const descendants = getAllDescendants(id, 'trash');

  if (descendants.length > 0) {
    const choice = prompt(
      t('prompt.subtasksPermanent', { count: descendants.length }),
      t('prompt.defaultAll')
    );
    if (!choice || choice.toLowerCase() === 'cancelar' || choice.toLowerCase() === 'cancel') return;

    const choiceLower = choice.toLowerCase();
    if (choiceLower === 'todas' || choiceLower === 'all') {
      const toDelete = [task, ...descendants];
      for (const tsk of toDelete) {
        board.trash = board.trash.filter(x => x.id !== tsk.id);
      }
    } else {
      board.trash = board.trash.filter(tsk => tsk.id !== id);
      for (const child of getTaskChildren(id, 'trash')) {
        child.parentId = null;
      }
    }
  } else {
    if (!confirm(t('trash.permanentDeleteConfirm'))) return;
    board.trash = board.trash.filter(tsk => tsk.id !== id);
  }

  render();
  saveBoard();
}

function deleteTask(id) {
  trashTask(id);
}

// --- Image paste ---

async function uploadImage(file, taskId) {
  const formData = new FormData();
  formData.append('image', file);
  const res = await fetch(`/api/images/${taskId}`, { method: 'POST', body: formData });
  const data = await res.json();
  return data.path;
}

function getActiveTaskId() {
  if (viewingTaskId) return viewingTaskId;
  if (editingTaskId) return editingTaskId;
  return null;
}

async function handlePasteImage(e, textarea) {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      let taskId = getActiveTaskId();
      if (!taskId) {
        taskId = board.nextId;
      }
      const path = await uploadImage(file, taskId);
      const mdImg = `![image](${path})`;
      const start = textarea.selectionStart;
      textarea.setRangeText(mdImg, start, textarea.selectionEnd, 'end');
      textarea.focus();
      return;
    }
  }
}

// --- Event listeners ---

// Resize handle for bottom panel
(function() {
  const handle = document.getElementById('resizeHandle');
  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    handle.classList.add('active');
    const startY = e.clientY;
    const startHeight = backlogHeight;
    function onMove(e) {
      backlogHeight = Math.max(80, Math.min(window.innerHeight * 0.6, startHeight + (startY - e.clientY)));
      applyBacklogLayout();
    }
    function onUp() {
      handle.classList.remove('active');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      localStorage.setItem('kanban_backlogHeight', String(backlogHeight));
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
})();

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeDetail(); closeModal(); }
  if (e.key === 'Enter' && document.getElementById('modalBackdrop').classList.contains('open')) {
    if (document.activeElement.tagName !== 'TEXTAREA') {
      saveModal();
    }
  }
});

document.getElementById('commentInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    addComment();
  }
});

document.addEventListener('paste', e => {
  const ta = e.target;
  if (ta.id === 'taskDesc' || ta.id === 'commentInput' || ta.classList.contains('comment-edit-area')) {
    handlePasteImage(e, ta);
  }
  if (ta.id === 'noteTextarea' && selectedNoteId) {
    handlePasteImageForNote(e, ta, selectedNoteId);
  }
});

// Cross-reference click handler
document.addEventListener('click', e => {
  const badge = e.target.closest('.xref-badge');
  if (badge) {
    const type = badge.dataset.type;
    const id = parseInt(badge.dataset.id);
    if (type === 'task') {
      // Find task and open detail
      let source = 'tasks';
      let task = board.tasks.find(t => t.id === id);
      if (!task && board.backlog) {
        task = board.backlog.find(t => t.id === id);
        if (task) source = 'backlog';
      }
      if (!task && board.trash) {
        task = board.trash.find(t => t.id === id);
        if (task) source = 'trash';
      }
      if (task) {
        switchView('board');
        openDetail(id, source);
      }
    } else if (type === 'note') {
      switchView('notes');
      if (typeof selectNote === 'function') {
        selectNote(id);
      }
    }
  }
});

document.getElementById('detailBackdrop').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeDetail();
});

// Close undo popover when clicking outside
document.addEventListener('click', e => {
  const popover = document.getElementById('undoConfirmPopover');
  const undoContainer = e.target.closest('.undo-container');
  if (popover && popover.classList.contains('open') && !undoContainer) {
    hideUndoConfirm();
  }
});

// Close filter panel when clicking outside
document.addEventListener('click', e => {
  if (!filterPanelOpen) return;
  const panel = document.getElementById('filterPanel');
  const fab = document.getElementById('filterFab');
  const isClickInside = (panel && panel.contains(e.target)) || (fab && fab.contains(e.target));
  if (!isClickInside) {
    toggleFilterPanel();
  }
});

document.getElementById('modalBackdrop').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeModal();
});
document.getElementById('gitSettingsBackdrop').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeGitSettings();
});
const gitRepoInputEl = document.getElementById('gitRepoInput');
if (gitRepoInputEl) {
  gitRepoInputEl.addEventListener('input', () => {
    updateRemoteUrl();
  });
}

document.getElementById('commentToolbar').appendChild(
  buildMdToolbar(document.getElementById('commentInput'))
);

document.getElementById('tagsInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    e.stopPropagation();
    addTagFromInput();
  }
  if (e.key === 'Backspace' && !e.target.value && modalTags.length) {
    modalTags.pop();
    renderModalTags();
  }
});

document.getElementById('tagsInput').addEventListener('blur', () => {
  addTagFromInput();
});

document.getElementById('welcomeUsername').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    completeWelcome();
  }
});

// --- Init ---

function hideSplash() {
  const splash = document.getElementById('splash');
  if (splash) {
    splash.classList.add('fade-out');
    setTimeout(() => splash.remove(), 300);
  }
  // Show the main content
  document.querySelector('header').style.visibility = 'visible';
  document.getElementById('boardView').style.visibility = 'visible';
}

async function init() {
  try {
    // Initialize i18n (defaults to English for fast startup)
    await initI18n();

    // Update static UI text
    updateStaticText();

    // Load tag filter settings before loading board
    await loadTagFilterSettings();

    // Load data first
    await loadBoard();
    await checkHasExamples();
    loadGitStatus();
    checkBackupStatus();  // Show undo button if backup exists

    // Initialize user (may show welcome modal)
    await initUser();

    // Restore saved view
    if (currentView === 'notes') {
      switchView('notes');
    }

    // Show tooltip hint about clearing examples (only for returning users)
    // First-time users will see it after completing the welcome modal
    if (hasExamples && currentUser) {
      setTimeout(showClearExamplesTooltip, 1000);
    }
  } catch (err) {
    console.error('Init error:', err);
  } finally {
    // Always hide splash, even if there's an error
    hideSplash();
  }
}

// Update static text elements with translations
function updateStaticText() {
  try {
    // Header nav - update only the span inside the tabs
    const boardTabSpan = document.querySelector('[data-view="board"] span');
    const notesTabSpan = document.querySelector('[data-view="notes"] span');
    if (boardTabSpan) boardTabSpan.textContent = t('app.board');
    if (notesTabSpan) notesTabSpan.textContent = t('app.notes');

  // Notes sidebar
  const notesSidebarHeader = document.querySelector('.notes-sidebar-header span');
  if (notesSidebarHeader) notesSidebarHeader.textContent = t('notes.title');

  // Notes empty state - update only the span inside
  const notesEmptyStateSpan = document.querySelector('#notesEmptyState span');
  if (notesEmptyStateSpan) notesEmptyStateSpan.textContent = t('notes.select');

  // Note editor buttons
  const noteAddChildBtn = document.getElementById('noteAddChildBtn');
  if (noteAddChildBtn) noteAddChildBtn.textContent = t('notes.addChild');
  const noteDeleteBtn = document.getElementById('noteDeleteBtn');
  if (noteDeleteBtn) noteDeleteBtn.textContent = t('notes.delete');

  // Note textarea placeholder
  const noteTextarea = document.getElementById('noteTextarea');
  if (noteTextarea) noteTextarea.placeholder = t('notes.contentPlaceholder');
  const notesTitleInput = document.getElementById('notesTitleInput');
  if (notesTitleInput) notesTitleInput.placeholder = t('notes.titlePlaceholder');

  // Notes edit buttons
  const notesEditButtons = document.getElementById('notesEditButtons');
  if (notesEditButtons) {
    const cancelBtn = notesEditButtons.querySelector('.btn-cancel');
    const saveBtn = notesEditButtons.querySelector('.btn-save');
    if (cancelBtn) cancelBtn.textContent = t('task.cancel');
    if (saveBtn) saveBtn.textContent = t('task.save');
  }

  // Paste hint
  const pasteHints = document.querySelectorAll('.paste-hint');
  pasteHints.forEach(hint => hint.textContent = t('task.pasteHint'));

  // Modal
  document.querySelector('#modalBackdrop label[for="taskTitle"]').textContent = t('task.title');
  document.querySelector('#modalBackdrop label[for="taskDesc"]').textContent = t('task.description');
  document.getElementById('taskTitle').placeholder = t('task.titlePlaceholder');
  document.getElementById('taskDesc').placeholder = t('task.descPlaceholder');
  const tagsLabel = document.querySelector('#modalBackdrop .tags-container').previousElementSibling;
  if (tagsLabel && tagsLabel.tagName === 'LABEL') tagsLabel.textContent = t('task.tags');
  document.getElementById('tagsInput').placeholder = t('task.tagsPlaceholder');

  // Modal buttons
  document.querySelector('#modalBackdrop .btn-cancel').textContent = t('task.cancel');
  document.getElementById('modalSave').textContent = t('task.save');

  // Detail modal
  const detailEditBtn = document.querySelector('.detail-header-actions button:first-child');
  if (detailEditBtn) detailEditBtn.textContent = t('task.edit_btn');
  const detailCloseBtn = document.querySelector('.detail-header-actions button:last-child');
  if (detailCloseBtn) detailCloseBtn.textContent = t('task.close');

  // Comment input
  document.getElementById('commentInput').placeholder = t('comments.placeholder');
  document.querySelector('.comment-input-row button').textContent = t('comments.send');

  // Settings modal - new clean design
  const settingsTitle = document.querySelector('#gitSettingsBackdrop h2');
  if (settingsTitle) settingsTitle.textContent = t('settings.title');

  const userTitle = document.getElementById('settingsUserTitle');
  if (userTitle) userTitle.textContent = t('settings.username') || 'Username';

  const langTitle = document.getElementById('settingsLangTitle');
  if (langTitle) langTitle.textContent = t('settings.language') || 'Language';

  const repoLabel = document.getElementById('gitRepoLabel');
  if (repoLabel) repoLabel.textContent = t('settings.repository') || 'GitHub Repository';

  const repoInput = document.getElementById('gitRepoInput');
  if (repoInput) repoInput.placeholder = t('settings.repositoryPlaceholder') || 'user/repo or paste URL';

  const identityLabel = document.getElementById('gitIdentityLabel');
  if (identityLabel) identityLabel.textContent = t('settings.connectVia') || 'Connect via';

  const gitSaveBtn = document.getElementById('gitSaveBtn');
  if (gitSaveBtn) gitSaveBtn.textContent = t('settings.save') || 'Save';

  // Conflict dialog
  const conflictTitle = document.querySelector('#conflictBackdrop h2');
  if (conflictTitle) conflictTitle.textContent = t('conflict.title') || 'Sync Conflict';

  const conflictDesc = document.querySelector('#conflictBackdrop .conflict-desc');
  if (conflictDesc) conflictDesc.textContent = t('conflict.description') || 'Your data and cloud data have both changed. What would you like to do?';

  const conflictOptions = document.querySelectorAll('#conflictBackdrop .conflict-option');
  if (conflictOptions.length >= 3) {
    // Keep local (yours) - first button
    conflictOptions[0].querySelector('.conflict-option-title').textContent = t('conflict.keepLocal') || 'Keep yours';
    conflictOptions[0].querySelector('.conflict-option-desc').textContent = t('conflict.keepLocalDesc') || 'Upload your version to the cloud';
    // Keep cloud + backup (recommended) - second button in cloud row
    const keepCloudBackupTitle = conflictOptions[1].querySelector('.conflict-option-title');
    if (keepCloudBackupTitle) {
      keepCloudBackupTitle.innerHTML = `<span>${t('conflict.keepCloudBackup') || 'Keep cloud + backup'}</span><span class="recommended-badge">${t('conflict.recommended') || 'Recommended'}</span>`;
    }
    conflictOptions[1].querySelector('.conflict-option-desc').textContent = t('conflict.keepCloudBackupDesc') || 'Download cloud version, your changes are saved (use Undo to restore)';
    // Keep cloud (no backup) - third button, smaller
    conflictOptions[2].querySelector('.conflict-option-title').textContent = t('conflict.keepCloud') || 'Keep cloud';
    conflictOptions[2].querySelector('.conflict-option-desc').textContent = t('conflict.keepCloudDesc') || 'Discard your changes';
  }

  const conflictCancel = document.querySelector('#conflictBackdrop .conflict-cancel');
  if (conflictCancel) conflictCancel.textContent = t('conflict.decideLater') || 'Decide later';

  } catch (err) {
    console.error('Error updating static text:', err);
  }
}

init();

// Refresh git status periodically
setInterval(loadGitStatus, 30000);
