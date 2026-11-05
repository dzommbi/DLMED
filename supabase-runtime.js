(() => {
  const DATA_ERROR_KEY = 'dlmed-supabase-progress-v1';
  const EMPTY_MESSAGE = 'Aucun QCM disponible pour le moment.';
  const groupClass = {
    'Sémiologie': { list: '#modulePickerList', check: 'module-pick-check', badge: 'data-order' },
    'Biochimie': { list: '.bio-lesson-list', check: 'bio-lesson-check', badge: 'data-bio-order' },
    'Physiopathologie': { list: '.physiopathologie-lesson-list', check: 'physio-lesson-check', badge: 'data-physio-order' },
    'Psychologie médicale': { list: '.psychologie-lesson-list', check: 'psychologie-lesson-check', badge: 'data-psych-order' },
    'Radiologie': { list: '.radiologie-lesson-list', check: 'radiologie-lesson-check', badge: 'data-radio-order' }
  };
  const MODULES = [];
  const CATALOG_LESSONS = [];
  let subjects = [];
  let lessons = [];
  let selectedSubjectId = null;
  let loading = true;
  let loadError = '';
  let grading = false;
  let loadedFromCache = false;
  let initializePromise = null;

  function isAuthorized() {
    if (window.DLMED_AUTH?.isAuthorized()) return true;
    window.DLMED_AUTH?.requestLogin({ mandatory: true });
    return false;
  }

  async function hasCurrentServerSession() {
    if (!isAuthorized()) return false;
    try { return await window.DLMED_AUTH.ensureActiveSession(); }
    catch (_) { return false; }
  }

  function clearProtectedContent() {
    clearInterval(timerInterval);
    timerInterval = null;
    resetTimer();
    questions.splice(0, questions.length);
    subjects = []; lessons = []; selectedSubjectId = null;
    MODULES.length = 0; PARTS.length = 0; CATALOG_LESSONS.length = 0;
    BIOCHIMIE_PARTS.length = 0; PHYSIOPATHOLOGIE_PARTS.length = 0;
    PSYCHOLOGIE_PARTS.length = 0; SEMIOLOGIE_PARTS.length = 0;
    sessionModules = []; sessionQuestions = []; sessionActive = false;
    pendingChoice = null; reviewQueue = []; reviewMode = false;
    loading = false; loadError = ''; loadedFromCache = false;
    document.querySelector('#quiz')?.replaceChildren();
    document.querySelectorAll('.module-list,.bio-lesson-list,.physiopathologie-lesson-list,.psychologie-lesson-list,.radiologie-lesson-list,#modulePickerList').forEach(node => node.replaceChildren());
    if (document.body.dataset.page === 'quiz') {
      document.querySelector('#app')?.classList.remove('active');
      const welcome = document.querySelector('#welcomeScreen');
      if (welcome) welcome.hidden = false;
      document.querySelector('#quizLoading')?.remove();
    }
    renderModulePicker(); updateSideNav(); updateStats();
  }

  window.addEventListener('dlmed:auth-locked', clearProtectedContent);

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
  const normalName = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  const subjectGroup = name => {
    const normalized = normalName(name);
    if (normalized.includes('biochimie')) return 'Biochimie';
    if (normalized.includes('physiopathologie')) return 'Physiopathologie';
    if (normalized.includes('psychologie')) return 'Psychologie médicale';
    if (normalized.includes('semiologie')) return 'Sémiologie';
    return name;
  };
  const lessonSlug = value => normalName(value).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const fmt = seconds => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  const answerStore = () => {
    try {
      const value = JSON.parse(localStorage.getItem(DATA_ERROR_KEY) || '{}');
      return value && typeof value === 'object' && value.answers && typeof value.answers === 'object' ? value : { answers: {} };
    } catch (_) { return { answers: {} }; }
  };

  function persistSupabaseProgress() {
    try {
      localStorage.setItem(DATA_ERROR_KEY, JSON.stringify({ answers, numberingVersion: 'supabase-v1' }));
    } catch (_) {}
  }

  function getPartForId(id) {
    const pool = sessionActive ? sessionModules : MODULES;
    return pool.find(part => part.start <= id && part.end >= id) || pool.find(part => part.questions.some(question => question.id === id)) || pool[0] || null;
  }

  function partRange(key) {
    if (key === 'all') return [0, Number.MAX_SAFE_INTEGER];
    const part = MODULES.find(item => item.key === key);
    return part ? [part.start, part.end] : [0, Number.MAX_SAFE_INTEGER];
  }

  function questionsForPart(part) {
    return part?.questions || [];
  }

  function localNumber(question) {
    const part = getPartForId(question.id);
    const index = part?.questions.findIndex(item => item.id === question.id) ?? -1;
    return Math.max(1, index + 1);
  }

  function progressionScope() {
    if (sessionActive) return sessionQuestions;
    if (selectedPart !== 'all') {
      const part = MODULES.find(item => item.key === selectedPart);
      return part?.questions || [];
    }
    if (selectedSubjectId !== null) return questions.filter(question => question.subjectId === selectedSubjectId);
    return questions;
  }

  function scopedProgressPercent() {
    const scope = progressionScope();
    return scope.length ? Math.round(scope.filter(question => answers[question.id]).length / scope.length * 100) : 0;
  }

  function visible() {
    const base = sessionActive ? sessionQuestions : progressionScope();
    return base.filter(question => !onlyWrong || (answers[question.id] && !answers[question.id].correct));
  }

  function updateStats() {
    const scope = progressionScope();
    const scopeAnswered = scope.filter(question => answers[question.id]).length;
    const correctCount = Object.values(answers).filter(answer => answer?.correct).length;
    const percent = scope.length ? Math.round(scopeAnswered / scope.length * 100) : 0;
    $('#totalStat').textContent = String(questions.length);
    $('#correctStat').textContent = String(correctCount);
    $('#progressStat').textContent = `${percent}%`;
    $('#doneCount').textContent = `${scopeAnswered} / ${scope.length}`;
    $('#donutPct').textContent = `${percent}%`;
    $('#donut').style.setProperty('--pct', percent);
  }

  function firstQuestion(part) { return part?.questions[0]?.id ?? 0; }

  function resetTimer() {
    clearInterval(timerInterval);
    timerInterval = null;
    activePartKey = null;
    sectionStartedAt = null;
    pausedElapsedSeconds = 0;
    timerPaused = false;
    $('#pauseTimerBtn').disabled = true;
    $('#pauseTimerBtn').textContent = '⏸ Pause';
    $('#timerPill').textContent = '⏱ 00:00';
  }

  async function setPart(part) {
    if (!await hasCurrentServerSession()) return;
    sessionActive = false; sessionModules = []; sessionQuestions = [];
    selectedPart = part?.key || 'all';
    selectedModule = part?.name || 'Tous les QCM';
    selectedSubjectId = null;
    onlyWrong = false;
    resetTimer();
    current = firstQuestion(part) || questions[0]?.id || 0;
    pendingChoice = null;
    navWindowStart = 0;
    render();
  }

  function moduleVisual(name){
  const n=String(name||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  let tone='general';
  let svg='<circle cx="12" cy="12" r="8.5"/><path d="M12 7v10M7 12h10"/>';
  if(n.includes('radiologie')){tone='radiology';svg='<rect x="3.5" y="4" width="17" height="15" rx="2"/><path d="M7 15l3-3 2.5 2.5 2-2L19 17M8 8h.01M12 21v-2M8 22h8"/>'}
  else if(n.includes('ecg')){tone='ecg';svg='<path d="M2.5 12h4l2.1-5 4.1 10 2.2-5h6.6"/>'}
  else if(n.includes('examens complementaires')){tone='exams';svg='<path d="m7 4 5 5-2 2-5-5z"/><path d="m11 10 4 4m-7 1a6 6 0 0 0 10-4m-7 4v2m-3 3h12m-5-3H9a5 5 0 0 0 0 3"/>'}
  else if(n.includes('observation medicale')){svg='<path d="M7 3.5h7l4 4v13H7z"/><path d="M14 3.5v4h4M10 11h5m-5 3h5m-5 3h3"/>'}
  else if(n.includes('semiologie veineuse')){svg='<path d="M12 21v-7m0 0-5-5m5 5 5-5M7 9V5m10 4V5m-5 5v4m0 0-3 3m3-3 3 3"/><circle cx="7" cy="4" r="1.2"/><circle cx="17" cy="4" r="1.2"/>'}
  else if(n.includes('syndrome coronarien')||n.includes('douleurs thoraciques')||n.includes('marqueurs cardiaques')){tone='sca';svg='<path d="M20.8 8.8c0 5.1-8.8 11-8.8 11s-8.8-5.9-8.8-11A4.8 4.8 0 0 1 12 6.2a4.8 4.8 0 0 1 8.8 2.6Z"/><path d="M5 12h4l1.5-3 2.2 6 1.5-3H19"/>'}
  else if(n.includes('artérielle')||n.includes('arterielle')||n.includes('hémodynamique')||n.includes('hemodynamique')){tone='hemo';svg='<path d="M12 21V11m0 0L6 5m6 6 6-6M6 5V3m0 2h2m10-2v2m0-2h-2"/><circle cx="12" cy="16" r="2"/>'}
  else if(n.includes('hydratation')||n.includes('hydrique')){tone='water';svg='<path d="M12 3c-2.4 3.3-6.2 7-6.2 11.1a6.2 6.2 0 0 0 12.4 0C18.2 10 14.4 6.3 12 3Z"/><path d="M9 15c.2 1.4 1.1 2.2 2.5 2.5"/>'}
  else if(n.includes('pondérale')||n.includes('ponderale')){tone='weight';svg='<path d="M12 4v15M5 7h14M7 7l-4 7h8L7 7Zm10 0-4 7h8l-4-7ZM8 21h8"/>'}
  else if(n.includes('examen physique')||n.includes('signes fonctionnels')){tone='signes';svg='<path d="M6 4v5a4 4 0 0 0 8 0V4M4 4h4m4 0h4m-2 5v3a5 5 0 0 0 10 0v-1"/><circle cx="19" cy="9" r="2"/><circle cx="19" cy="16" r="2"/>'}
  else if(n.includes('insuffisances cardiaques')){tone='failure';svg='<path d="M20.8 8.8c0 5.1-8.8 11-8.8 11s-8.8-5.9-8.8-11A4.8 4.8 0 0 1 12 6.2a4.8 4.8 0 0 1 8.8 2.6Z"/><path d="M8 12h2l1-2 2 4 1-2h2"/>'}
  else if(n.includes('respiratoire')){tone='respiratory';svg='<path d="M12 4v7m0-4c-1.7-2-3.8-2.7-4.9-.8-1 1.7-3.1 6.1-3.1 8.4A3.4 3.4 0 0 0 7.4 18c2.8 0 4.6-1.9 4.6-4.8m0-6.2c1.7-2 3.8-2.7 4.9-.8 1 1.7 3.1 6.1 3.1 8.4a3.4 3.4 0 0 1-3.4 3.4c-2.8 0-4.6-1.9-4.6-4.8"/>'}
  else if(n.includes('thromboembolique')||n.includes('mtev')){tone='vte';svg='<path d="M12 3v6m0 0L6 14m6-5 6 5M6 14v7m12-7v7"/><circle cx="12" cy="12" r="2"/><path d="M4 21h4m8 0h4"/>'}
  else if(n.includes('choc')){tone='shock';svg='<path d="M12 3c-2.2 3.2-5.8 6.8-5.8 10.7a5.8 5.8 0 0 0 11.6 0C17.8 9.8 14.2 6.2 12 3Z"/><path d="M9 14h2l1-2 2 4 1-2h1"/>'}
  else if(n.includes('homme sain')){tone='health';svg='<circle cx="12" cy="5" r="2.2"/><circle cx="6" cy="17" r="2.2"/><circle cx="18" cy="17" r="2.2"/><path d="m10.9 7-3.4 7.8m5 0L13.1 7m-4.7 10h7.2"/>'}
else if(n.includes('etapes')){tone='analysis';svg='<path d="M7 4h10a2 2 0 0 1 2 2v14H5V6a2 2 0 0 1 2-2Z"/><path d="M9 9h6m-6 4h6m-6 4h4"/>'}else if(n.includes('biochimie')||n.includes('analyse biochimique')){tone='lab';svg='<path d="M9 3h6m-5 0v6l-5.2 8.3A2.5 2.5 0 0 0 7 21h10a2.5 2.5 0 0 0 2.2-3.7L14 9V3M7 15h10"/><path d="m10 18 1.3-1.5 1.4 1 1.4-1.5"/>'}
  else if(n.includes('psychologie')){tone='neuro';svg='<path d="M12 4a3 3 0 0 0-5.7 1.5 3.2 3.2 0 0 0-1.4 5.8 3.3 3.3 0 0 0 .4 5.3 3.2 3.2 0 0 0 5.6 2.1h2.2a3.2 3.2 0 0 0 5.6-2.1 3.3 3.3 0 0 0 .4-5.3 3.2 3.2 0 0 0-1.4-5.8A3 3 0 0 0 12 4Z"/><path d="M12 4v15M8 8c1.3.1 2 .8 2 2m-3 3c1.6 0 2.5.8 2.6 2m6-7c-1.3.1-2 .8-2 2m3 3c-1.6 0-2.5.8-2.6 2"/>'}
  else if(n.includes('physiopathologie')){tone='physio';svg='<path d="M20.8 8.8c0 5.1-8.8 11-8.8 11s-8.8-5.9-8.8-11A4.8 4.8 0 0 1 12 6.2a4.8 4.8 0 0 1 8.8 2.6Z"/><path d="M5 12h4l1.5-3 2.2 6 1.5-3H19"/>'}
  return '<span class="module-icon module-icon-'+tone+'" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false">'+svg+'</svg></span>';
}
function updateSideNav() {
    const seriesSection = document.querySelector('.sidebar .side-card:nth-child(2)');
    if (seriesSection) {
      seriesSection.querySelector('.eyebrow').textContent = 'Leçons';
      seriesSection.querySelectorAll('.series-nav').forEach(node => node.remove());
      seriesSection.insertAdjacentHTML('beforeend', MODULES.map(part => `<div class="nav-item series-nav ${selectedPart === part.key ? 'active' : ''}" data-part="${escapeHtml(part.key)}"><span class="nav-icon">${moduleVisual(part.name)}</span>${escapeHtml(part.name)} <span class="count">${part.count}</span></div>`).join(''));
    }
    const subjectTotals = subjects.map(subject => ({
      subject,
      count: questions.filter(question => question.subjectId === Number(subject.id)).length
    }));
    $('#moduleList').innerHTML = subjectTotals.map(({ subject, count }) => `<div class="module ${selectedSubjectId === Number(subject.id) && selectedPart === 'all' ? 'active' : ''}" data-subject-id="${escapeHtml(subject.id)}"><span class="module-main">${moduleVisual(subject.name)}<span class="module-name">${escapeHtml(subject.name)}</span></span><span class="count">${count}</span></div>`).join('');
    $('#allNav').classList.toggle('active', selectedPart === 'all' && selectedSubjectId === null && !onlyWrong);
    $('#wrongNav').classList.toggle('active', onlyWrong);
    document.querySelectorAll('.series-nav').forEach(node => {
      node.onclick = () => { void setPart(MODULES.find(part => part.key === node.dataset.part)); };
    });
    document.querySelectorAll('.module[data-subject-id]').forEach(node => {
      node.onclick = async () => {
        if (!await hasCurrentServerSession()) return;
        sessionActive = false; sessionModules = []; sessionQuestions = [];
        selectedPart = 'all'; selectedModule = subjects.find(subject => String(subject.id) === node.dataset.subjectId)?.name || 'Tous les QCM';
        selectedSubjectId = Number(node.dataset.subjectId); onlyWrong = false; resetTimer();
        current = progressionScope()[0]?.id || questions[0]?.id || 0; pendingChoice = null; render();
      };
    });
    const partSelect = $('#partSelect');
    if (partSelect) {
      partSelect.innerHTML = `<option value="all">Toutes les matières · ${questions.length} QCM</option>${MODULES.map(part => `<option value="${escapeHtml(part.key)}">${escapeHtml(part.name)} · ${part.count} QCM</option>`).join('')}`;
      partSelect.value = selectedPart;
    }
  }

  function lessonMarkup(part, group) {
    const config = groupClass[group] || groupClass['Sémiologie'];
    const disabled = part.count === 0 ? 'disabled' : '';
    const key = escapeHtml(part.key);
    const groupClassName = config.check;
    const badgeAttr = config.badge;
    return `<label class="module-pick" data-lesson-card="${key}"><span class="module-order" ${badgeAttr}="${key}">—</span><input class="module-pick-check ${groupClassName}" type="checkbox" data-lesson-id="${escapeHtml(part.lessonId)}" value="${key}" aria-label="Sélectionner ${escapeHtml(part.name)}" ${disabled}><span class="module-pick-copy">${moduleVisual(part.name)}<span class="module-pick-label"><strong>${escapeHtml(part.name)}</strong></span></span><span class="module-pick-count">${part.count} QCM</span></label>`;
  }

  function renderModulePicker() {
    const groupParts = new Map();
    for (const [name, config] of Object.entries(groupClass)) {
      const list = document.querySelector(config.list);
      if (!list) continue;
      const items = CATALOG_LESSONS.filter(part => part.group === name);
      groupParts.set(name, items);
      list.innerHTML = items.map(part => lessonMarkup(part, name)).join('') || (name === 'Radiologie' ? '<p class="quiet">Aucun QCM disponible pour le moment.</p>' : '<p class="quiet">Aucun cours enregistré.</p>');
    }
    for (const subject of subjects) {
      const name = subjectGroup(subject.name);
      if (!groupClass[name]) continue;
      const count = questions.filter(question => question.subjectId === Number(subject.id)).length;
      if (name === 'Biochimie') { const badge = $('#biochimieToggle .biochimie-total'); if (badge) badge.textContent = `${count} QCM`; }
      if (name === 'Physiopathologie') $('#physioTotal').textContent = `${count} QCM`;
      if (name === 'Psychologie médicale') $('#psychologieTotal').textContent = `${count} QCM`;
      if (name === 'Sémiologie') $('#semiologyTotal').textContent = `${count} QCM`;
    }
    const radioSubject = subjects.find(subject => subjectGroup(subject.name) === 'Radiologie');
    const radioCount = radioSubject ? questions.filter(question => question.subjectId === Number(radioSubject.id)).length : 0;
    const radioRow = document.querySelector('.cardio-subject-row--radio');
    if (radioRow) {
      let badge = radioRow.querySelector('.radio-total');
      if (!badge) { badge = document.createElement('span'); badge.className = 'biochimie-total radio-total'; radioRow.appendChild(badge); }
      badge.textContent = `${radioCount} QCM`;
    }
    document.querySelectorAll('.module-pick-check').forEach(input => { input.onchange = updateModulePicker; });
    const selectAll = (selector, inputsSelector) => {
      const control = $(selector);
      if (control) control.onchange = () => { document.querySelectorAll(inputsSelector).forEach(input => { input.checked = control.checked; }); updateModulePicker(); };
    };
    selectAll('#selectAllModules', '#modulePickerList .module-pick-check:not(:disabled)');
    selectAll('#selectAllBioLessons', '.bio-lesson-check:not(:disabled)');
    selectAll('#selectAllPhysioLessons', '.physio-lesson-check:not(:disabled)');
    selectAll('#selectAllRadiologyLessons', '.radiologie-lesson-check:not(:disabled)');
    const psychList = document.querySelector('.psychologie-lesson-list');
    if (psychList && !document.querySelector('#selectAllPsychLessons')) {
      const all = document.createElement('label');
      all.className = 'select-all-row'; all.innerHTML = '<input type="checkbox" id="selectAllPsychLessons"><span>Tout sélectionner</span>';
      psychList.parentElement.insertBefore(all, psychList);
    }
    selectAll('#selectAllPsychLessons', '.psychologie-lesson-check:not(:disabled)');
    const radiologyList = document.querySelector('.radiologie-lesson-list');
    if (radiologyList && CATALOG_LESSONS.some(part => part.group === 'Radiologie') && !document.querySelector('#selectAllRadiologyLessons')) {
      const all = document.createElement('label');
      all.className = 'select-all-row'; all.innerHTML = '<input type="checkbox" id="selectAllRadiologyLessons"><span>Tout sélectionner</span>';
      radiologyList.parentElement.insertBefore(all, radiologyList);
    }
    selectAll('#selectAllRadiologyLessons', '.radiologie-lesson-check:not(:disabled)');
    const radioToggle = $('#radiologieToggle');
    if (radioToggle && !radioToggle.dataset.bound) {
      radioToggle.dataset.bound = 'true';
      radioToggle.addEventListener('click', () => toggleAnimatedPanel(radioToggle, $('#radiologieLessons')));
    }
    updateModulePicker();
  }

  function selectedModules() {
    const ids = new Set([...document.querySelectorAll('.module-pick-check:checked')].map(input => String(input.dataset.lessonId)));
    return MODULES.filter(part => ids.has(String(part.lessonId))).sort((a, b) => a.start - b.start || a.sortOrder - b.sortOrder);
  }

  function updateModulePicker() {
    const selected = selectedModules();
    for (const part of MODULES) {
      const badge = document.querySelector(`[data-order="${CSS.escape(part.key)}"], [data-bio-order="${CSS.escape(part.key)}"], [data-physio-order="${CSS.escape(part.key)}"], [data-psych-order="${CSS.escape(part.key)}"], [data-radio-order="${CSS.escape(part.key)}"]`);
      if (badge) {
        const index = selected.findIndex(item => item.key === part.key);
        badge.textContent = index < 0 ? '—' : String(index + 1).padStart(2, '0');
      }
    }
    for (const [selector, group] of [['#selectAllModules', 'Sémiologie'], ['#selectAllBioLessons', 'Biochimie'], ['#selectAllPhysioLessons', 'Physiopathologie'], ['#selectAllPsychLessons', 'Psychologie médicale'], ['#selectAllRadiologyLessons', 'Radiologie']]) {
      const control = $(selector);
      if (!control) continue;
      const eligible = MODULES.filter(part => part.group === group && part.count > 0);
      control.checked = eligible.length > 0 && eligible.every(part => [...document.querySelectorAll('.module-pick-check:checked')].some(input => String(input.dataset.lessonId) === String(part.lessonId)));
      control.indeterminate = eligible.some(part => [...document.querySelectorAll('.module-pick-check:checked')].some(input => String(input.dataset.lessonId) === String(part.lessonId))) && !control.checked;
    }
    const selectedCount = selected.reduce((total, part) => total + part.count, 0);
    if (loading) $('#moduleSelectionSummary').textContent = 'Connexion à Supabase…';
    else if (loadError) $('#moduleSelectionSummary').textContent = `Erreur de chargement : ${loadError}`;
    else if (!questions.length) $('#moduleSelectionSummary').textContent = EMPTY_MESSAGE;
    else $('#moduleSelectionSummary').textContent = selected.length ? `${selected.length} module${selected.length > 1 ? 's' : ''} · ${selectedCount} QCM sélectionnés` : 'Aucun module sélectionné';
    $('#startChosenModules').disabled = loading || !selected.length;
  }

  async function startChosenModules() {
    if (!await hasCurrentServerSession()) return;
    sessionModules = selectedModules();
    if (!sessionModules.length) return;
    if (document.body.dataset.page === 'home') {
      const lessonIds = sessionModules.map(part => String(part.lessonId)).filter(id => id && id !== 'undefined');
      if (!lessonIds.length) return;
      try { sessionStorage.setItem('dlmed-selected-lesson-ids', JSON.stringify(lessonIds)); } catch (_) {}
      const destination = new URL('./quiz.html', window.location.href);
      destination.searchParams.set('lessons', lessonIds.join(','));
      window.location.href = destination.href;
      return;
    }
    sessionActive = true;
    sessionQuestions = sessionModules.flatMap(part => part.questions);
    selectedPart = 'all'; selectedModule = 'Tous les QCM'; selectedSubjectId = null;
    onlyWrong = false; reviewMode = false; reviewQueue = []; pendingChoice = null;
    navWindowStart = 0; sectionAnswerCount = 0; activePartKey = null; resetTimer();
    current = firstQuestion(sessionModules[0]);
    $('#welcomeScreen').hidden = true;
    $('#moduleModal').classList.remove('open'); $('#moduleModal').setAttribute('aria-hidden', 'true');
    $('#app').classList.add('active'); document.querySelector('#quizLoading')?.remove(); render();
  }

  function currentFlow() {
    if (sessionActive) return sessionModules;
    if (selectedPart !== 'all') return MODULES.filter(part => part.key === selectedPart);
    if (selectedSubjectId !== null) return MODULES.filter(part => part.subjectId === selectedSubjectId);
    return MODULES;
  }

  function beginSectionTransition(part) {
    clearInterval(timerInterval); timerInterval = null;
    const elapsed = timerPaused ? pausedElapsedSeconds : Math.floor((Date.now() - sectionStartedAt) / 1000);
    const flow = currentFlow();
    const next = flow[flow.findIndex(item => item.key === part.key) + 1];
    const overlay = $('#sectionOverlay');
    const restart = $('#restartCourse');
    const continueButton = $('#continueSection');
    const partQuestions = part.questions;
    const correct = partQuestions.filter(question => answers[question.id]?.correct).length;
    sectionStartedAt = null; timerPaused = false; $('#pauseTimerBtn').disabled = true;
    $('#timerPill').textContent = `⏸ ${fmt(elapsed)}`;
    $('#overlayTitle').textContent = `${part.name} terminée`;
    $('#overlayScore').textContent = `Résultat : ${correct} / ${partQuestions.length}`;
    $('#overlayElapsed').textContent = `Temps écoulé : ${fmt(elapsed)}`;
    restart.style.display = 'none'; overlay.classList.add('show');
    if (next) {
      $('#overlayNext').textContent = `Cliquez pour passer au module suivant : ${next.name}.`;
      continueButton.textContent = 'Next →'; continueButton.style.display = 'inline-flex';
      continueButton.onclick = async () => {
        if (!await hasCurrentServerSession()) return;
        overlay.classList.remove('show'); selectedPart = 'all'; selectedModule = 'Tous les QCM'; selectedSubjectId = null; onlyWrong = false;
        reviewMode = false; reviewQueue = []; current = firstQuestion(next); activePartKey = null; navWindowStart = 0; render();
      };
    } else {
      $('#overlayNext').textContent = 'Tous les modules sélectionnés sont terminés. Bravo!';
      continueButton.style.display = 'none'; restart.style.display = 'inline-flex'; restart.onclick = returnToWelcome;
    }
  }

  async function openGpt(question, chosen) {
    if (!await hasCurrentServerSession()) return;
    const choiceList = Array.isArray(chosen) ? chosen : [chosen];
    const correct = answers[question.id]?.correctChoices || [];
    const prompt = `Je révise un QCM de médecine en 3e année. Explique-moi pourquoi ma réponse est fausse et pourquoi la bonne réponse est correcte, en français simple.\n\nQuestion : ${question.text}\n${question.options.map((option, index) => `${letters[index]}. ${option}`).join('\n')}\n\nMa réponse : ${choiceList.map(index => `${letters[index]}. ${question.options[index]}`).join(' ; ')}\nRéponse(s) correcte(s) : ${correct.map(index => `${letters[index]}. ${question.options[index]}`).join(' ; ')}\nExplication : ${answers[question.id]?.explanation || ''}`;
    window.open(`https://chatgpt.com/?q=${encodeURIComponent(prompt)}`, '_blank', 'noopener,noreferrer');
  }

  function render() {
    if (!isAuthorized()) return;
    updateSideNav(); updateStats();
    const pool = visible();
    if (!pool.length) {
      $('#quiz').innerHTML = `<div class="empty"><h3>${onlyWrong ? 'Rien à revoir pour le moment 🎉' : 'Aucune question disponible'}</h3><p>${onlyWrong ? 'Les questions répondues incorrectement apparaîtront ici.' : escapeHtml(EMPTY_MESSAGE)}</p><button class="btn primary" id="backAll">Voir toutes les matières</button></div>`;
      $('#backAll').onclick = async () => { if (!await hasCurrentServerSession()) return; selectedSubjectId = null; selectedPart = 'all'; selectedModule = 'Tous les QCM'; onlyWrong = false; current = questions[0]?.id || 0; render(); };
      $('#jumpGrid').innerHTML = ''; $('#jumpPrev').disabled = true; $('#jumpNext').disabled = true; return;
    }
    let question = pool.find(item => item.id === current) || pool[0];
    current = question.id;
    const part = getPartForId(question.id);
    if (!part) return;
    if (activePartKey !== part.key) startSectionTimer(part);
    const previous = answers[question.id];
    const selected = pendingChoice?.id === question.id ? (Array.isArray(pendingChoice.choice) ? pendingChoice.choice : [pendingChoice.choice]) : [];
    const correctChoices = previous?.correctChoices || [];
    const qNumber = localNumber(question);
    const partCount = questionsForPart(part).length;
    const optionHtml = question.options.map((option, index) => {
      const isSelected = selected.includes(index);
      const isCorrect = correctChoices.includes(index);
      const isWrongPick = previous && !previous.correct && (Array.isArray(previous.choice) ? previous.choice : [previous.choice]).includes(index) && !isCorrect;
      const state = previous ? (isCorrect ? (previous.recovered ? ' recovered' : ' correct') : isWrongPick ? ' wrong' : '') : (isSelected ? ' selected' : '');
      const blurred = (blurredOptions[question.id] || []).includes(index);
      return `<button class="answer${state}${blurred ? ' blurred' : ''}" type="button" data-choice="${index}" title="Clic droit pour flouter ou réafficher cette réponse" aria-pressed="${isSelected}" ${previous || grading ? 'disabled' : ''}><span class="letter">${letters[index]}</span><span>${escapeHtml(option)}</span></button>`;
    }).join('');
    const explanation = previous ? `<div class="explanation show"><strong>${previous.recovered ? '✓ Réponse corrigée après révision' : previous.correct ? '✓ Bonne réponse !' : 'À retenir'}</strong> · ${escapeHtml(previous.explanation || '')}${!previous.correct ? '<div style="margin-top:12px"><button class="btn" id="askGptBtn" type="button">✨ Comprendre avec ChatGPT</button></div>' : ''}</div>` : '<div class="explanation"></div>';
    const selectedLabel = question.multiple ? 'Sélectionne toutes les réponses correctes.' : 'Choisis une seule réponse.';
    const nextLabel = previous ? (reviewMode ? (reviewQueue.indexOf(question.id) === reviewQueue.length - 1 ? 'Fin de la révision' : 'Question de révision suivante') : qNumber === partCount ? 'Terminer la section' : pool.indexOf(question) === pool.length - 1 ? 'Terminer la série' : 'Question suivante') : 'Confirmer ma réponse';
    $('#quiz').innerHTML = `<div class="quiz-head"><span class="tag">${escapeHtml(question.module)}</span><span class="q-count">${reviewMode ? `Révision des erreurs · ${reviewQueue.indexOf(question.id) + 1}/${reviewQueue.length}` : `Question ${qNumber} / ${partCount}`}</span></div><div class="progress"><span style="width:${scopedProgressPercent()}%"></span></div><h2 class="question">${escapeHtml(question.text)}</h2><div class="answers">${optionHtml}</div>${explanation}<div class="quiz-footer"><span class="quiet">${previous ? 'Réponse enregistrée sur cet appareil.' : selectedLabel}</span><button class="btn primary" type="button" id="${previous ? 'nextBtn' : 'confirmBtn'}" ${!previous && !selected.length ? 'disabled' : ''}>${previous ? nextLabel : (grading ? 'Correction…' : 'Confirmer ma réponse')} →</button></div>`;

    document.querySelectorAll('.answer').forEach(button => {
      button.onclick = async () => {
        if (previous || grading) return;
        if (!await hasCurrentServerSession()) return;
        const index = Number(button.dataset.choice);
        if ((blurredOptions[question.id] || []).includes(index)) return;
        const selectedSet = new Set(selected);
        if (question.multiple) selectedSet.has(index) ? selectedSet.delete(index) : selectedSet.add(index);
        else { selectedSet.clear(); selectedSet.add(index); }
        pendingChoice = { id: question.id, choice: [...selectedSet].sort((a, b) => a - b) };
        render();
      };
      button.oncontextmenu = event => {
        event.preventDefault();
        if (previous) return;
        const index = Number(button.dataset.choice);
        const blurredSet = new Set(blurredOptions[question.id] || []);
        blurredSet.has(index) ? blurredSet.delete(index) : blurredSet.add(index);
        blurredOptions[question.id] = [...blurredSet];
        button.classList.toggle('blurred', blurredSet.has(index));
      };
    });
    if (previous) $('#nextBtn').onclick = () => move(pool, question.id);
    else $('#confirmBtn').onclick = () => confirmAnswer(question);
    if (previous && !previous.correct) $('#askGptBtn').onclick = () => openGpt(question, previous.choice);

    const partQuestions = reviewMode ? reviewQueue.map(id => questions.find(item => item.id === id)).filter(Boolean) : sessionActive ? pool.filter(item => part.questions.some(partQuestion => partQuestion.id === item.id)) : pool;
    const currentIndex = partQuestions.findIndex(item => item.id === question.id);
    const maxStart = Math.max(0, partQuestions.length - 10);
    if (currentIndex >= 0) {
      if (currentIndex < navWindowStart) navWindowStart = currentIndex;
      else if (currentIndex >= navWindowStart + 10) navWindowStart = currentIndex - 9;
    }
    navWindowStart = Math.max(0, Math.min(navWindowStart, maxStart));
    $('#jumpGrid').innerHTML = partQuestions.slice(navWindowStart, navWindowStart + 10).map(item => `<button class="jump ${item.id === question.id ? 'current' : ''} ${answers[item.id] ? (answers[item.id].recovered ? 'recovered' : answers[item.id].correct ? 'done' : 'wrong') : ''}" type="button" data-id="${item.id}">${localNumber(item)}</button>`).join('');
    const strip = $('#jumpGrid');
    if (lastRenderedNavWindow !== navWindowStart) { strip.classList.remove('slide'); void strip.offsetWidth; strip.classList.add('slide'); lastRenderedNavWindow = navWindowStart; }
    document.querySelectorAll('.jump').forEach(button => { button.onclick = async () => { if (!await hasCurrentServerSession()) return; current = Number(button.dataset.id); pendingChoice = null; render(); }; });
    $('#jumpPrev').disabled = currentIndex <= 0;
    $('#jumpNext').disabled = currentIndex < 0 || currentIndex >= partQuestions.length - 1;
    $('#jumpPrev').onclick = async () => { if (currentIndex > 0 && await hasCurrentServerSession()) { current = partQuestions[currentIndex - 1].id; pendingChoice = null; if (currentIndex - 1 < navWindowStart) navWindowStart = Math.max(0, navWindowStart - 1); render(); } };
    $('#jumpNext').onclick = async () => { if (currentIndex >= 0 && currentIndex < partQuestions.length - 1 && await hasCurrentServerSession()) { current = partQuestions[currentIndex + 1].id; pendingChoice = null; if (currentIndex + 1 >= navWindowStart + 10) navWindowStart = Math.min(currentIndex - 8, maxStart); render(); } };
  }

  async function confirmAnswer(question) {
    if (!isAuthorized()) return;
    if (grading || answers[question.id] || pendingChoice?.id !== question.id) return;
    const displayChoices = Array.isArray(pendingChoice.choice) ? pendingChoice.choice : [pendingChoice.choice];
    if (!displayChoices.length || displayChoices.some(index => !Number.isInteger(index) || index < 0 || index > 4)) return;
    const selectedLetters = [...new Set(displayChoices.map(index => question.optionMap[index]))];
    if (selectedLetters.some(letter => !letter)) { toast('Les choix de réponse ne sont pas valides.'); return; }
    grading = true; render();
    try {
      const result = await DLMED_DATA.grade(question.id, selectedLetters);
      const correctLetters = new Set(result.correct_options.map(letter => String(letter).toUpperCase()));
      const correctChoices = question.optionMap.map((letter, index) => correctLetters.has(letter) ? index : -1).filter(index => index >= 0);
      const correct = Boolean(result.correct);
      answers[question.id] = {
        choice: displayChoices,
        correct,
        correctChoices,
        correctOptions: [...correctLetters],
        explanation: String(result.explanation || ''),
        recovered: reviewMode && correct
      };
      pendingChoice = null; grading = false; sectionAnswerCount++;
      const navLength = reviewMode ? reviewQueue.length : (getPartForId(question.id)?.questions.length || visible().length);
      navWindowStart = Math.min(Math.max(0, sectionAnswerCount - 9), Math.max(0, navLength - 10));
      playFeedback(correct); persistSupabaseProgress(); render();
      if (!correct) shakeWrongAnswer();
    } catch (error) {
      grading = false;
      if (!window.DLMED_AUTH?.isAuthorized()) return;
      toast('La correction n’a pas pu être récupérée. Vérifie ta connexion ou la configuration du RPC Supabase.');
      render();
      const button = $('#confirmBtn'); if (button) button.disabled = false;
    }
  }

  async function move(pool, id) {
    if (!await hasCurrentServerSession()) return;
    const part = getPartForId(id);
    if (!part) return;
    if (reviewMode) {
      const nextId = reviewQueue[reviewQueue.indexOf(id) + 1];
      if (nextId !== undefined) { current = nextId; render(); }
      else { reviewMode = false; reviewQueue = []; beginSectionTransition(part); }
      return;
    }
    const partQuestions = part.questions;
    const lastQuestion = partQuestions[partQuestions.length - 1];
    if (!onlyWrong && lastQuestion && id === lastQuestion.id) {
      const unanswered = partQuestions.filter(item => !answers[item.id]);
      if (unanswered.length) { current = unanswered[0].id; toast(`Questions sans réponse : ${unanswered.length} — réponds avant de terminer`); render(); return; }
      const missed = partQuestions.filter(item => answers[item.id] && !answers[item.id].correct).map(item => item.id);
      if (missed.length) {
        reviewQueue = missed; reviewMode = true; navWindowStart = 0; sectionAnswerCount = 0;
        missed.forEach(questionId => delete answers[questionId]);
        persistSupabaseProgress(); current = missed[0]; toast('Révision des réponses incorrectes'); render(); return;
      }
      beginSectionTransition(part); return;
    }
    const next = pool[pool.findIndex(item => item.id === id) + 1];
    if (!next) {
      if (onlyWrong) { onlyWrong = false; current = questions[0]?.id || 0; toast('Série terminée — bravo !'); }
      else { current = pool[0]?.id || 0; toast('Série terminée — tu peux recommencer à tout moment.'); }
    } else current = next.id;
    pendingChoice = null; render();
  }

  function returnToWelcome() {
    if (document.body.dataset.page === 'quiz') {
      try { sessionStorage.removeItem('dlmed-selected-lesson-ids'); } catch (_) {}
      window.location.href = './index.html';
      return;
    }
    clearInterval(timerInterval); clearInterval(transitionInterval); timerInterval = null; transitionInterval = null;
    activePartKey = null; sectionStartedAt = null; timerPaused = false; $('#pauseTimerBtn').disabled = true; $('#timerPill').textContent = '⏱ 00:00';
    sessionActive = false; sessionModules = []; sessionQuestions = []; reviewMode = false; reviewQueue = []; pendingChoice = null;
    selectedPart = 'all'; selectedModule = 'Tous les QCM'; selectedSubjectId = null; onlyWrong = false; current = questions[0]?.id || 0;
    $('#sectionOverlay').classList.remove('show'); $('#app').classList.remove('active'); $('#welcomeScreen').hidden = false;
    renderModulePicker(); updateSideNav(); updateStats(); animateWelcomeEntrance();
  }

  function bindNavigation() {
    $('#allNav').onclick = async () => { if (!await hasCurrentServerSession()) return; sessionActive = false; sessionModules = []; sessionQuestions = []; selectedPart = 'all'; selectedModule = 'Tous les QCM'; selectedSubjectId = null; onlyWrong = false; resetTimer(); current = questions[0]?.id || 0; pendingChoice = null; render(); };
    $('#wrongNav').onclick = async () => { if (!await hasCurrentServerSession()) return; sessionActive = false; sessionModules = []; sessionQuestions = []; selectedPart = 'all'; selectedModule = 'Tous les QCM'; selectedSubjectId = null; onlyWrong = true; navWindowStart = 0; resetTimer(); current = questions.find(question => answers[question.id] && !answers[question.id].correct)?.id || questions[0]?.id || 0; render(); };
    $('#partSelect').onchange = async () => {
      const part = MODULES.find(item => item.key === $('#partSelect').value);
      if (part) { await setPart(part); return; }
      if (!await hasCurrentServerSession()) return;
      sessionActive = false; sessionModules = []; sessionQuestions = []; selectedPart = 'all'; selectedSubjectId = null; selectedModule = 'Tous les QCM'; onlyWrong = false; resetTimer(); current = questions[0]?.id || 0; render();
    };
    $('#startChosenModules').onclick = startChosenModules;
    $('#resetBtn').onclick = async () => {
      if (!await hasCurrentServerSession()) return;
      if (!confirm('Effacer toutes les réponses et la progression enregistrées sur cet appareil ?')) return;
      answers = {}; try { localStorage.removeItem(DATA_ERROR_KEY); } catch (_) {}
      persistSupabaseProgress(); current = questions[0]?.id || 0; pendingChoice = null; reviewMode = false; reviewQueue = []; resetTimer(); render(); toast('Progression réinitialisée');
    };
  }

  function restoreSelectedSession() {
    const queryIds = new URLSearchParams(window.location.search).get('lessons');
    let lessonIds = queryIds ? queryIds.split(',') : [];
    if (!lessonIds.length) {
      try { lessonIds = JSON.parse(sessionStorage.getItem('dlmed-selected-lesson-ids') || '[]'); } catch (_) { lessonIds = []; }
    }
    lessonIds = Array.isArray(lessonIds) ? [...new Set(lessonIds.map(String).filter(Boolean))] : [];
    if (!lessonIds.length) { window.location.replace('./index.html'); return; }
    try { sessionStorage.setItem('dlmed-selected-lesson-ids', JSON.stringify(lessonIds)); } catch (_) {}
    const selectedIds = new Set(lessonIds);
    document.querySelectorAll('.module-pick-check').forEach(input => {
      input.checked = selectedIds.has(String(input.dataset.lessonId));
    });
    updateModulePicker();
    if (!selectedModules().length) { window.location.replace('./index.html'); return; }
    startChosenModules();
  }
  async function initialize() {
    if (initializePromise) return initializePromise;
    initializePromise = (async () => {
      const authState = await window.DLMED_AUTH?.ready;
      if (authState !== 'active' || !window.DLMED_AUTH?.isAuthorized()) {
        loading = false;
        $('#startChosenModules').disabled = true;
        return;
      }
      $('#moduleSelectionSummary').textContent = 'Connexion à Supabase…';
      $('#startChosenModules').disabled = true;
      try {
        const result = await DLMED_DATA.load();
      subjects = result.subjects || []; lessons = result.lessons || []; loadedFromCache = Boolean(result.cached);
      questions.splice(0, questions.length, ...result.questions);
      MODULES.length = 0; PARTS.length = 0; CATALOG_LESSONS.length = 0; BIOCHIMIE_PARTS.length = 0; PHYSIOPATHOLOGIE_PARTS.length = 0; PSYCHOLOGIE_PARTS.length = 0; SEMIOLOGIE_PARTS.length = 0;
      const lessonMap = new Map(lessons.map(lesson => [String(lesson.id), lesson]));
      const questionByLesson = new Map();
      for (const question of questions) {
        if (!questionByLesson.has(String(question.lessonId))) questionByLesson.set(String(question.lessonId), []);
        questionByLesson.get(String(question.lessonId)).push(question);
      }
      let globalIndex = 0;
      for (const lesson of lessons) {
        const subject = subjects.find(item => String(item.id) === String(lesson.subject_id));
        const group = subjectGroup(subject?.name || questionByLesson.get(String(lesson.id))?.[0]?.subjectName || 'Sémiologie');
        const lessonQuestions = questionByLesson.get(String(lesson.id)) || [];
        const part = {
          key: `lesson-${lesson.id}`,
          lessonKey: lessonSlug(lesson.title),
          lessonId: Number(lesson.id), subjectId: Number(lesson.subject_id),
          name: lesson.title, group, sortOrder: Number(lesson.sort_order) || globalIndex + 1,
          start: lessonQuestions[0]?.id || 0, end: lessonQuestions.at(-1)?.id || 0,
          questions: lessonQuestions, count: lessonQuestions.length,
          subjectName: subject?.name || group
        };
        globalIndex++;
        CATALOG_LESSONS.push(part);
        if (part.count) MODULES.push(part);
      }
      MODULES.sort((a, b) => a.start - b.start || a.subjectId - b.subjectId || a.sortOrder - b.sortOrder);
      PARTS.push(...MODULES);
      for (const part of MODULES) {
        if (part.group === 'Biochimie') BIOCHIMIE_PARTS.push(part);
        else if (part.group === 'Physiopathologie') PHYSIOPATHOLOGIE_PARTS.push(part);
        else if (part.group === 'Psychologie médicale') PSYCHOLOGIE_PARTS.push(part);
        else if (part.group === 'Sémiologie') SEMIOLOGIE_PARTS.push(part);
      }
      const stored = answerStore(); answers = stored.answers || {};
      // Do not mix old numbered answers with the new Supabase identity sequence.
      for (const questionId of Object.keys(answers)) {
        const answer = answers[questionId];
        if (!questions.some(question => String(question.id) === String(questionId)) || !answer || typeof answer.correct !== 'boolean' || !Array.isArray(answer.correctChoices)) delete answers[questionId];
      }
      loading = false; loadError = '';
      if (!questions.length) loadError = '';
      renderModulePicker(); bindNavigation(); updateSideNav(); updateStats();
      if (!window.DLMED_AUTH?.isAuthorized()) { clearProtectedContent(); return; }
      if (!questions.length) { if (document.body.dataset.page === 'quiz') { $('#welcomeScreen').hidden = true; $('#app').classList.add('active'); document.querySelector('#quizLoading')?.remove(); }
        $('#quiz').innerHTML = `<div class="empty"><h3>La banque Supabase est vide</h3><p>${escapeHtml(EMPTY_MESSAGE)}</p></div>`;
      } else if (document.body.dataset.page === 'quiz') { restoreSelectedSession(); }
      } catch (error) {
        if (!window.DLMED_AUTH?.isAuthorized()) { clearProtectedContent(); return; }
        loading = false;
        loadError = error?.message || 'connexion impossible';
        if (document.body.dataset.page === 'quiz') { $('#welcomeScreen').hidden = true; $('#app').classList.add('active'); document.querySelector('#quizLoading')?.remove(); }
        renderModulePicker(); updateSideNav(); updateStats();
        $('#quiz').innerHTML = `<div class="empty"><h3>Impossible de charger la banque Supabase</h3><p>${escapeHtml(loadError)}</p><button class="btn primary" id="retrySupabase">Réessayer</button></div>`;
        $('#retrySupabase').onclick = () => { loading = true; loadError = ''; renderModulePicker(); initialize(); };
      }
    })();
    try { return await initializePromise; }
    finally { initializePromise = null; }
  }

  window.partFor = getPartForId;
  window.partRange = partRange;
  window.questionsForPart = questionsForPart;
  window.localQuestionNumber = localNumber;
  window.progressionScope = progressionScope;
  window.scopedProgressPercent = scopedProgressPercent;
  window.visible = visible;
  window.stats = updateStats;
  window.renderModulePicker = renderModulePicker;
  window.updateModulePicker = updateModulePicker;
  window.beginChosenModules = startChosenModules;
  window.beginSectionTransition = beginSectionTransition;
  window.openGpt = openGpt;
  window.render = render;
  window.confirmAnswer = confirmAnswer;
  window.move = move;
  window.returnToWelcome = returnToWelcome;
  window.persist = persistSupabaseProgress;
  window.list = updateSideNav;
  window.DLMED_UI = Object.freeze({ initialize });

  resetTimer(); bindNavigation(); renderModulePicker(); updateSideNav(); updateStats(); initialize();
})();
