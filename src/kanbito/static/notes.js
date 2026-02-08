// --- Notes State ---
let notesData = { notes: [], nextNoteId: 1 };
let selectedNoteId = null;
let editingNote = false;
let notesLoaded = false;
let draggedNoteId = null;

// --- Data Operations ---

async function loadNotes() {
  const res = await fetch('/api/notes');
  notesData = await res.json();
  if (!notesData.notes) notesData.notes = [];
  if (!notesData.nextNoteId) notesData.nextNoteId = 1;
  notesLoaded = true;
  renderNotesTree();
}

async function saveNotes() {
  await fetch('/api/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(notesData)
  });
}

function createNote(parentId, title) {
  const note = {
    id: notesData.nextNoteId++,
    title: title || t('notes.new'),
    content: '',
    parentId: parentId,
    order: getChildren(parentId).length,
    collapsed: false,
    createdAt: new Date().toISOString(),
    modifiedAt: new Date().toISOString()
  };
  notesData.notes.push(note);
  saveNotes();
  return note;
}

function updateNote(id, updates) {
  const note = getNoteById(id);
  if (!note) return;
  Object.assign(note, updates, { modifiedAt: new Date().toISOString() });
  saveNotes();
}

function deleteNote(id) {
  const children = getChildren(id);
  for (const child of children) {
    deleteNote(child.id);
  }
  notesData.notes = notesData.notes.filter(n => n.id !== id);
  if (selectedNoteId === id) {
    selectedNoteId = null;
    showNotesEmptyState();
  }
  saveNotes();
}

function getChildren(parentId) {
  return notesData.notes
    .filter(n => n.parentId === parentId)
    .sort((a, b) => a.order - b.order);
}

function getAncestors(noteId) {
  const ancestors = [];
  let note = getNoteById(noteId);
  while (note && note.parentId !== null) {
    note = getNoteById(note.parentId);
    if (note) ancestors.unshift(note);
  }
  return ancestors;
}

function getNoteById(id) {
  return notesData.notes.find(n => n.id === id);
}

function isDescendantOf(noteId, potentialAncestorId) {
  let note = getNoteById(noteId);
  while (note && note.parentId !== null) {
    if (note.parentId === potentialAncestorId) return true;
    note = getNoteById(note.parentId);
  }
  return false;
}

function moveNoteInto(noteId, newParentId) {
  const note = getNoteById(noteId);
  if (!note) return;

  // Reorder siblings at old location
  const oldSiblings = getChildren(note.parentId).filter(n => n.id !== noteId);
  oldSiblings.forEach((sib, i) => sib.order = i);

  // Move to new parent
  note.parentId = newParentId;
  note.order = getChildren(newParentId).filter(n => n.id !== noteId).length;
  note.modifiedAt = new Date().toISOString();

  // Expand new parent
  const parent = getNoteById(newParentId);
  if (parent && parent.collapsed) parent.collapsed = false;

  saveNotes();
}

function moveNoteBefore(noteId, targetId) {
  const note = getNoteById(noteId);
  const target = getNoteById(targetId);
  if (!note || !target) return;

  // Reorder siblings at old location
  const oldSiblings = getChildren(note.parentId).filter(n => n.id !== noteId);
  oldSiblings.forEach((sib, i) => sib.order = i);

  // Move to same parent as target
  note.parentId = target.parentId;
  note.modifiedAt = new Date().toISOString();

  // Insert before target
  const newSiblings = getChildren(target.parentId);
  const targetIdx = newSiblings.findIndex(n => n.id === targetId);
  newSiblings.splice(targetIdx, 0, note);
  newSiblings.filter(n => n.id !== noteId || n === note).forEach((sib, i) => sib.order = i);

  saveNotes();
}

function moveNoteAfter(noteId, targetId) {
  const note = getNoteById(noteId);
  const target = getNoteById(targetId);
  if (!note || !target) return;

  // Reorder siblings at old location
  const oldSiblings = getChildren(note.parentId).filter(n => n.id !== noteId);
  oldSiblings.forEach((sib, i) => sib.order = i);

  // Move to same parent as target
  note.parentId = target.parentId;
  note.modifiedAt = new Date().toISOString();

  // Insert after target
  const newSiblings = getChildren(target.parentId).filter(n => n.id !== noteId);
  const targetIdx = newSiblings.findIndex(n => n.id === targetId);
  newSiblings.splice(targetIdx + 1, 0, note);
  newSiblings.forEach((sib, i) => sib.order = i);

  saveNotes();
}

// --- Tree Rendering ---

function renderNotesTree() {
  const tree = document.getElementById('notesTree');
  tree.innerHTML = '';
  const roots = getChildren(null);
  for (const note of roots) {
    renderTreeNode(note, 0, tree);
  }
}

function renderTreeNode(note, depth, container) {
  const children = getChildren(note.id);
  const hasChildren = children.length > 0;

  const item = document.createElement('div');
  item.className = 'notes-tree-item' + (selectedNoteId === note.id ? ' selected' : '');
  item.style.setProperty('--indent', depth);
  item.dataset.noteId = note.id;
  item.draggable = true;

  // Drag and drop handlers
  item.addEventListener('dragstart', e => {
    draggedNoteId = note.id;
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', note.id);
  });

  item.addEventListener('dragend', () => {
    draggedNoteId = null;
    item.classList.remove('dragging');
    document.querySelectorAll('.notes-tree-item.drag-over, .notes-tree-item.drag-above, .notes-tree-item.drag-below').forEach(el => {
      el.classList.remove('drag-over', 'drag-above', 'drag-below');
    });
  });

  item.addEventListener('dragover', e => {
    e.preventDefault();
    if (draggedNoteId === note.id) return;
    if (isDescendantOf(note.id, draggedNoteId)) return;

    const rect = item.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const zone = rect.height / 3;

    item.classList.remove('drag-over', 'drag-above', 'drag-below');
    if (y < zone) {
      item.classList.add('drag-above');
    } else if (y > zone * 2) {
      item.classList.add('drag-below');
    } else {
      item.classList.add('drag-over');
    }
  });

  item.addEventListener('dragleave', () => {
    item.classList.remove('drag-over', 'drag-above', 'drag-below');
  });

  item.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation();
    if (!draggedNoteId || draggedNoteId === note.id) return;
    if (isDescendantOf(note.id, draggedNoteId)) return;

    const rect = item.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const zone = rect.height / 3;

    if (y < zone) {
      moveNoteBefore(draggedNoteId, note.id);
    } else if (y > zone * 2) {
      moveNoteAfter(draggedNoteId, note.id);
    } else {
      moveNoteInto(draggedNoteId, note.id);
    }

    item.classList.remove('drag-over', 'drag-above', 'drag-below');
    draggedNoteId = null;
    renderNotesTree();
  });

  const chevron = document.createElement('span');
  chevron.className = 'notes-tree-chevron' + (note.collapsed ? ' collapsed' : '') + (!hasChildren ? ' empty' : '');
  chevron.innerHTML = '&#9660;';
  chevron.addEventListener('click', e => {
    e.stopPropagation();
    toggleCollapse(note.id);
  });

  const idBadge = document.createElement('span');
  idBadge.className = 'notes-tree-id';
  idBadge.textContent = 'N' + note.id;

  const title = document.createElement('span');
  title.className = 'notes-tree-title';
  title.textContent = note.title;

  item.appendChild(chevron);
  item.appendChild(idBadge);
  item.appendChild(title);

  item.addEventListener('click', () => selectNote(note.id));

  container.appendChild(item);

  if (hasChildren && !note.collapsed) {
    for (const child of children) {
      renderTreeNode(child, depth + 1, container);
    }
  }
}

function toggleCollapse(noteId) {
  const note = getNoteById(noteId);
  if (!note) return;
  note.collapsed = !note.collapsed;
  saveNotes();
  renderNotesTree();
}

// --- Content Area ---

function showNotesEmptyState() {
  document.getElementById('notesEmptyState').style.display = 'flex';
  document.getElementById('notesEditor').style.display = 'none';
}

function selectNote(noteId) {
  selectedNoteId = noteId;
  editingNote = false;
  renderNotesTree();
  const note = getNoteById(noteId);
  if (!note) {
    showNotesEmptyState();
    return;
  }

  // Expand ancestors to show selection
  let parent = getNoteById(note.parentId);
  while (parent) {
    if (parent.collapsed) {
      parent.collapsed = false;
    }
    parent = getNoteById(parent.parentId);
  }
  renderNotesTree();

  document.getElementById('notesEmptyState').style.display = 'none';
  document.getElementById('notesEditor').style.display = 'flex';

  renderNoteContent(note);
}

function renderNoteContent(note) {
  document.getElementById('notesTitleId').textContent = 'N' + note.id;
  document.getElementById('notesTitleDisplay').textContent = note.title;
  document.getElementById('notesTitleDisplay').style.display = editingNote ? 'none' : '';
  document.getElementById('notesTitleInput').style.display = editingNote ? '' : 'none';
  document.getElementById('notesTitleInput').value = note.title;

  const metaParts = [];
  if (note.createdAt) metaParts.push(t('task.created') + ' ' + formatDateNotes(note.createdAt));
  if (note.modifiedAt) metaParts.push(t('task.modified') + ' ' + formatDateNotes(note.modifiedAt));
  document.getElementById('notesMeta').textContent = metaParts.join('  |  ');

  renderBreadcrumb(note.id);

  // Rendered content with cross-references and checkboxes
  const rendered = document.getElementById('noteRendered');
  const textarea = document.getElementById('noteTextarea');
  const toolbar = document.getElementById('notesMdToolbar');
  const editBtns = document.getElementById('notesEditButtons');
  const pasteHint = document.getElementById('notesPasteHint');

  if (editingNote) {
    rendered.style.display = 'none';
    textarea.style.display = '';
    toolbar.style.display = '';
    editBtns.style.display = 'flex';
    if (pasteHint) pasteHint.style.display = '';
    textarea.value = note.content || '';

    // Build toolbar if empty
    if (!toolbar.hasChildNodes()) {
      toolbar.appendChild(buildMdToolbar(textarea));
    }
  } else {
    rendered.style.display = '';
    textarea.style.display = 'none';
    toolbar.style.display = 'none';
    editBtns.style.display = 'none';
    if (pasteHint) pasteHint.style.display = 'none';

    if (note.content) {
      let html = marked.parse(note.content);
      html = renderCrossReferences(html);
      rendered.innerHTML = html;
      rendered.classList.remove('empty');

      // Enable checkboxes
      rendered.querySelectorAll('input[type="checkbox"]').forEach((cb, idx) => {
        cb.disabled = false;
        cb.style.cursor = 'pointer';
        cb.addEventListener('change', () => {
          toggleNoteCheckbox(note, idx, cb.checked);
        });
      });
    } else {
      rendered.textContent = t('task.noDescription');
      rendered.classList.add('empty');
    }
  }
}

function renderBreadcrumb(noteId) {
  const breadcrumb = document.getElementById('notesBreadcrumb');
  breadcrumb.innerHTML = '';
  const ancestors = getAncestors(noteId);

  for (let i = 0; i < ancestors.length; i++) {
    const anc = ancestors[i];
    const item = document.createElement('span');
    item.className = 'notes-breadcrumb-item';
    item.textContent = anc.title;
    item.addEventListener('click', () => selectNote(anc.id));
    breadcrumb.appendChild(item);

    const sep = document.createElement('span');
    sep.className = 'notes-breadcrumb-sep';
    sep.textContent = '/';
    breadcrumb.appendChild(sep);
  }
}

function toggleNoteCheckbox(note, checkboxIndex, checked) {
  let count = 0;
  const lines = note.content.split('\n');
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
  note.content = lines.join('\n');
  note.modifiedAt = new Date().toISOString();
  saveNotes();
  renderNoteContent(note);
}

// --- Editing ---

function toggleNoteEdit(event) {
  // Don't trigger edit if clicking on links, checkboxes, or buttons
  if (event && event.target) {
    const tag = event.target.tagName.toLowerCase();
    if (tag === 'a' || tag === 'input' || tag === 'button' || tag === 'code') return;
    if (event.target.closest('a') || event.target.closest('input') || event.target.closest('button')) return;
  }
  if (editingNote) {
    cancelNoteEdit();
  } else {
    editingNote = true;
    const note = getNoteById(selectedNoteId);
    if (note) renderNoteContent(note);
    document.getElementById('notesTitleInput').focus();
  }
}

function saveNoteEdit() {
  const note = getNoteById(selectedNoteId);
  if (!note) return;

  const newTitle = document.getElementById('notesTitleInput').value.trim() || t('notes.new');
  const newContent = document.getElementById('noteTextarea').value;

  updateNote(note.id, { title: newTitle, content: newContent });
  editingNote = false;
  renderNotesTree();
  renderNoteContent(note);
}

function cancelNoteEdit() {
  editingNote = false;
  const note = getNoteById(selectedNoteId);
  if (note) renderNoteContent(note);
}

function addChildNote() {
  if (!selectedNoteId) return;
  const parent = getNoteById(selectedNoteId);
  if (parent && parent.collapsed) {
    parent.collapsed = false;
  }
  const note = createNote(selectedNoteId, t('notes.addChild').replace('+ ', ''));
  renderNotesTree();
  selectNote(note.id);
  editingNote = true;
  renderNoteContent(note);
  document.getElementById('notesTitleInput').focus();
  document.getElementById('notesTitleInput').select();
}

function deleteCurrentNote() {
  if (!selectedNoteId) return;
  const note = getNoteById(selectedNoteId);
  if (!note) return;
  if (!confirm(t('notes.deleteConfirm'))) return;
  deleteNote(note.id);
  renderNotesTree();
}

// --- Image Paste for Notes ---

async function handlePasteImageForNote(e, textarea, noteId) {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      const formData = new FormData();
      formData.append('image', file);
      const res = await fetch(`/api/images/n${noteId}`, { method: 'POST', body: formData });
      const data = await res.json();
      const mdImg = `![image](${data.path})`;
      const start = textarea.selectionStart;
      textarea.setRangeText(mdImg, start, textarea.selectionEnd, 'end');
      textarea.focus();
      return;
    }
  }
}

// --- Utilities ---

function formatDateNotes(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// --- Init (called from app.js when switching to notes view) ---

document.getElementById('addRootNote').addEventListener('click', () => {
  const note = createNote(null, t('notes.new'));
  renderNotesTree();
  selectNote(note.id);
  editingNote = true;
  renderNoteContent(note);
  document.getElementById('notesTitleInput').focus();
  document.getElementById('notesTitleInput').select();
});

// Drop on tree container to make root-level note
const notesTree = document.getElementById('notesTree');
notesTree.addEventListener('dragover', e => {
  if (!draggedNoteId) return;
  // Only show drop indicator if dropping on empty space (not on a note)
  if (e.target === notesTree) {
    e.preventDefault();
    notesTree.classList.add('drag-over-root');
  }
});
notesTree.addEventListener('dragleave', e => {
  if (e.target === notesTree) {
    notesTree.classList.remove('drag-over-root');
  }
});
notesTree.addEventListener('drop', e => {
  if (!draggedNoteId) return;
  if (e.target !== notesTree) return;
  e.preventDefault();

  const note = getNoteById(draggedNoteId);
  if (note && note.parentId !== null) {
    // Move to root level
    const oldSiblings = getChildren(note.parentId).filter(n => n.id !== draggedNoteId);
    oldSiblings.forEach((sib, i) => sib.order = i);

    note.parentId = null;
    note.order = getChildren(null).filter(n => n.id !== draggedNoteId).length;
    note.modifiedAt = new Date().toISOString();
    saveNotes();
    renderNotesTree();
  }

  notesTree.classList.remove('drag-over-root');
  draggedNoteId = null;
});

// Handle keyboard shortcuts in notes editor
document.getElementById('noteTextarea').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    saveNoteEdit();
  }
  if (e.key === 'Escape') {
    cancelNoteEdit();
  }
});

document.getElementById('notesTitleInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('noteTextarea').focus();
  }
  if (e.key === 'Escape') {
    cancelNoteEdit();
  }
});
