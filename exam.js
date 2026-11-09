(() => {
  'use strict';

  const $ = selector => document.querySelector(selector);
  const LETTERS = ['A', 'B', 'C', 'D', 'E'];
  const panel = $('#examPanel');
  const main = $('#examMain');
  const loading = $('#quizLoading');
  const timer = $('#examTimer');
  const attemptId = new URLSearchParams(window.location.search).get('attempt') || '';
  const attemptStorageKey = /^[\w-]{1,100}$/.test(attemptId) ? `dlmed-exam-attempt:${attemptId}` : '';
  let questions = [];
  let choices = new Map();
  let index = 0;
  let startedAt = 0;
  let elapsedSeconds = 0;
  let clock = 0;
  let results = [];
  let initPromise = null;
  let grading = false;

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);

  function formatTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remaining = seconds % 60;
    return hours ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}` : `${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`;
  }

  function updateTimer() {
    const seconds = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : elapsedSeconds;
    timer.textContent = `⏱ ${formatTime(seconds)}`;
  }

  function saveAttemptState(phase = 'in-progress') {
    if (!attemptStorageKey) return;
    try {
      sessionStorage.setItem(attemptStorageKey, JSON.stringify({
        phase,
        questions: questions.map(question => ({
          id: question.id,
          lessonId: question.lessonId,
          module: question.module,
          text: question.text,
          options: Array.isArray(question.options) ? question.options : [],
          multiple: question.multiple === true,
          optionMap: Array.isArray(question.optionMap) ? question.optionMap : LETTERS
        })),
        choices: [...choices.entries()],
        index,
        startedAt,
        elapsedSeconds,
        results: results.map(result => ({
          questionId: result.question.id,
          selectedIndexes: result.selectedIndexes,
          correctIndexes: result.correctIndexes,
          explanation: result.explanation,
          correct: result.correct
        }))
      }));
    } catch (_) {}
  }

  function readAttemptState(pool, count) {
    if (!attemptStorageKey) return null;
    try {
      const saved = JSON.parse(sessionStorage.getItem(attemptStorageKey) || 'null');
      if (!saved || !Array.isArray(saved.questions) || saved.questions.length !== count) return null;
      const poolById = new Map(pool.map(question => [String(question.id), question]));
      const restoredQuestions = saved.questions.map(snapshot => {
        const current = poolById.get(String(snapshot.id));
        if (!current || typeof snapshot.text !== 'string' || !Array.isArray(snapshot.options)) return null;
        return {
          ...current,
          text: snapshot.text,
          module: typeof snapshot.module === 'string' ? snapshot.module : current.module,
          options: snapshot.options.map(String),
          multiple: snapshot.multiple === true,
          optionMap: Array.isArray(snapshot.optionMap) ? snapshot.optionMap.map(String) : LETTERS
        };
      });
      if (restoredQuestions.some(question => !question)) return null;
      const questionById = new Map(restoredQuestions.map(question => [String(question.id), question]));
      const restoredChoices = new Map((Array.isArray(saved.choices) ? saved.choices : [])
        .filter(entry => Array.isArray(entry) && questionById.has(String(entry[0])) && Array.isArray(entry[1]))
        .map(([id, indexes]) => {
          const question = questionById.get(String(id));
          return [id, indexes.filter(value => Number.isInteger(value) && value >= 0 && value < question.options.length)];
        }));
      const restoredResults = Array.isArray(saved.results) ? saved.results.map(result => {
        const question = questionById.get(String(result.questionId));
        if (!question) return null;
        return {
          question,
          selectedIndexes: Array.isArray(result.selectedIndexes) ? result.selectedIndexes : [],
          correctIndexes: Array.isArray(result.correctIndexes) ? result.correctIndexes : [],
          explanation: typeof result.explanation === 'string' ? result.explanation : '',
          correct: result.correct === true
        };
      }) : [];
      if (restoredResults.some(result => !result)) return null;
      if (saved.phase === 'results' && restoredResults.length !== count) return null;
      return {
        phase: ['in-progress', 'grading', 'results'].includes(saved.phase) ? saved.phase : 'in-progress',
        questions: restoredQuestions,
        choices: restoredChoices,
        index: Math.min(Math.max(Number(saved.index) || 0, 0), count - 1),
        startedAt: Number.isFinite(Number(saved.startedAt)) ? Number(saved.startedAt) : 0,
        elapsedSeconds: Math.max(0, Number(saved.elapsedSeconds) || 0),
        results: restoredResults
      };
    } catch (_) {
      return null;
    }
  }

  function setPageMessage(title, copy, buttonLabel = 'Retour à l’accueil') {
    loading.hidden = true;
    main.hidden = false;
    panel.innerHTML = `<div class="exam-message"><span class="exam-pill">DLMED · Mode examen</span><h1>${escapeHtml(title)}</h1><p>${escapeHtml(copy)}</p><a class="btn primary" href="./index.html">${escapeHtml(buttonLabel)}</a></div>`;
  }

  function shuffle(items) {
    const output = [...items];
    for (let cursor = output.length - 1; cursor > 0; cursor--) {
      const target = Math.floor(Math.random() * (cursor + 1));
      [output[cursor], output[target]] = [output[target], output[cursor]];
    }
    return output;
  }

  function readSelection() {
    const params = new URLSearchParams(window.location.search);
    const lessonIds = [...new Set((params.get('lessons') || '').split(',').map(value => value.trim()).filter(value => /^\d+$/.test(value)))];
    const count = Number(params.get('count'));
    if (lessonIds.length < 5 || ![40, 50, 60, 80, 100].includes(count)) throw new Error('Le lien de cet examen est incomplet. Retourne au menu, sélectionne au moins cinq modules puis choisis le nombre de QCM.');
    return { lessonIds: new Set(lessonIds), count };
  }

  async function initialize() {
    if (initPromise) return initPromise;
    if (!window.DLMED_AUTH?.isAuthorized()) return;
    initPromise = (async () => {
      loading.hidden = false;
      main.hidden = true;
      try {
        if (!await window.DLMED_AUTH.ensureActiveSession()) return;
        const selection = readSelection();
        const bank = await window.DLMED_DATA.load();
        if (!window.DLMED_AUTH.isAuthorized()) return;
        const chosenLessons = bank.lessons.filter(lesson => selection.lessonIds.has(String(lesson.id)));
        if (chosenLessons.length < 5) throw new Error('Certains modules ne sont plus disponibles. Retourne au menu et prépare un nouvel examen.');
        const acceptedIds = new Set(chosenLessons.map(lesson => String(lesson.id)));
        const pool = bank.questions.filter(question => acceptedIds.has(String(question.lessonId)));
        if (pool.length < selection.count) throw new Error(`Les modules sélectionnés contiennent ${pool.length} QCM. Choisis moins de questions ou ajoute d’autres modules.`);
        const savedAttempt = readAttemptState(pool, selection.count);
        if (savedAttempt) {
          questions = savedAttempt.questions;
          choices = savedAttempt.choices;
          index = savedAttempt.index;
          results = savedAttempt.results;
          elapsedSeconds = savedAttempt.elapsedSeconds;
          startedAt = ['results', 'grading'].includes(savedAttempt.phase) ? 0 : (savedAttempt.startedAt || Date.now());
        } else {
          questions = shuffle(pool).slice(0, selection.count);
          choices = new Map();
          index = 0;
          results = [];
          startedAt = Date.now();
          elapsedSeconds = 0;
        }
        main.hidden = false;
        loading.hidden = true;
        $('#examHeadingTitle').textContent = `Examen blanc · ${questions.length} QCM`;
        $('#examHeadingCopy').textContent = `${chosenLessons.length} modules sélectionnés · aucune correction avant la fin.`;
        clock = window.setInterval(updateTimer, 1000);
        updateTimer();
        if (savedAttempt?.phase === 'results' && savedAttempt.results.length === questions.length) {
          renderResults();
        } else {
          renderQuestion();
          if (savedAttempt?.phase === 'grading') void gradeExam();
        }
        if (!savedAttempt) saveAttemptState();
      } catch (error) {
        setPageMessage('Impossible de préparer cet examen', error?.message || 'Une erreur est survenue pendant le chargement des QCM.');
      }
    })();
    try { await initPromise; }
    finally { initPromise = null; }
  }

  function navigationStart() {
    const maxStart = Math.max(0, questions.length - 10);
    return Math.min(Math.max(0, index - 4), maxStart);
  }

  function renderQuestion() {
    const question = questions[index];
    if (!question) return;
    const picked = choices.get(question.id) || [];
    const percent = Math.round(((index + 1) / questions.length) * 100);
    const navStart = navigationStart();
    const last = index === questions.length - 1;
    panel.innerHTML = `
      <div class="exam-question-head"><span class="exam-module-tag" title="${escapeHtml(question.module)}">${escapeHtml(question.module)}</span><span class="exam-count">Question ${index + 1} / ${questions.length}</span></div>
      <div class="exam-progress" role="progressbar" aria-label="Progression de l’examen" aria-valuemin="0" aria-valuemax="${questions.length}" aria-valuenow="${index + 1}"><span style="width:${percent}%"></span></div>
      <h2 class="exam-question">${escapeHtml(question.text)}</h2>
      <div class="exam-answer-list" role="group" aria-label="${question.multiple ? 'Choisis une ou plusieurs réponses' : 'Choisis une réponse'}">${question.options.map((option, optionIndex) => `<button class="exam-answer${picked.includes(optionIndex) ? ' selected' : ''}" type="button" data-option="${optionIndex}" aria-pressed="${picked.includes(optionIndex)}"><span class="exam-letter">${LETTERS[optionIndex]}</span><span>${escapeHtml(option)}</span></button>`).join('')}</div>
      <div class="exam-actions"><span class="exam-selection-hint">${question.multiple ? 'Plusieurs réponses possibles.' : 'Une seule réponse.'} Les réponses restent masquées jusqu’à la fin.</span><div class="exam-actions-right"><button class="btn" id="examPrevious" type="button" ${index === 0 ? 'disabled' : ''}>← Précédent</button><button class="btn primary" id="examNext" type="button">${last ? 'Remettre ma copie ✓' : 'Suivante →'}</button></div></div>
      <nav class="exam-navigation" aria-label="Navigation des questions"><button class="exam-nav-arrow" id="examNavPrevious" type="button" aria-label="Questions précédentes" ${navStart === 0 ? 'disabled' : ''}>‹</button><div class="exam-nav-strip">${questions.slice(navStart, navStart + 10).map((item, offset) => { const questionIndex = navStart + offset; return `<button class="exam-nav-number${choices.has(item.id) ? ' answered' : ''}${questionIndex === index ? ' current' : ''}" type="button" data-question-index="${questionIndex}" aria-label="Question ${questionIndex + 1}${choices.has(item.id) ? ', répondue' : ', sans réponse'}" aria-current="${questionIndex === index ? 'step' : 'false'}">${questionIndex + 1}</button>`; }).join('')}</div><button class="exam-nav-arrow" id="examNavNext" type="button" aria-label="Questions suivantes" ${navStart + 10 >= questions.length ? 'disabled' : ''}>›</button></nav>`;

    panel.querySelectorAll('[data-option]').forEach(button => {
      button.addEventListener('click', () => {
        const optionIndex = Number(button.dataset.option);
        const current = choices.get(question.id) || [];
        const updated = question.multiple
          ? (current.includes(optionIndex) ? current.filter(value => value !== optionIndex) : [...current, optionIndex].sort((a, b) => a - b))
          : [optionIndex];
        if (updated.length) choices.set(question.id, updated);
        else choices.delete(question.id);
        renderQuestion();
      });
    });
    $('#examPrevious').addEventListener('click', () => { if (index > 0) { index--; renderQuestion(); } });
    $('#examNext').addEventListener('click', () => {
      if (last) void confirmSubmission();
      else { index++; renderQuestion(); }
    });
    $('#examNavPrevious').addEventListener('click', () => { index = Math.max(0, navStart - 1); renderQuestion(); });
    $('#examNavNext').addEventListener('click', () => { index = Math.min(questions.length - 1, navStart + 10); renderQuestion(); });
    panel.querySelectorAll('[data-question-index]').forEach(button => button.addEventListener('click', () => { index = Number(button.dataset.questionIndex); renderQuestion(); }));
    saveAttemptState();
  }

  async function confirmSubmission() {
    const unanswered = questions.length - choices.size;
    const message = unanswered
      ? `Il reste ${unanswered} question${unanswered > 1 ? 's' : ''} sans réponse. Les questions vides compteront comme incorrectes. Remettre la copie ?`
      : 'Remettre la copie et afficher la note ainsi que le corrigé ?';
    if (!window.confirm(message)) return;
    if (!window.DLMED_AUTH?.isAuthorized() || !await window.DLMED_AUTH.ensureActiveSession()) return;
    elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    startedAt = 0;
    window.clearInterval(clock);
    clock = 0;
    updateTimer();
    saveAttemptState('grading');
    await gradeExam();
  }

  async function gradeExam() {
    if (grading) return;
    grading = true;
    results = [];
    main.hidden = false;
    panel.innerHTML = `<div class="exam-message"><span class="exam-pill">Correction sécurisée</span><h1>Ta copie est remise</h1><p id="gradingStatus">Correction des réponses… 0 / ${questions.length}</p><div class="exam-progress"><span id="gradingProgress" style="width:0%"></span></div></div>`;
    const corrections = new Array(questions.length);
    let cursor = 0;
    let completed = 0;
    let failure = null;
    async function worker() {
      while (cursor < questions.length && !failure) {
        const questionIndex = cursor++;
        const question = questions[questionIndex];
        const selectedIndexes = choices.get(question.id) || [];
        const optionMap = Array.isArray(question.optionMap) ? question.optionMap : LETTERS;
        const selectedLetters = selectedIndexes.map(optionIndex => optionMap[optionIndex]).filter(Boolean);
        try {
          const response = await window.DLMED_DATA.grade(question.id, selectedLetters.length ? selectedLetters : ['A']);
          corrections[questionIndex] = {
            question,
            selectedIndexes,
            correctIndexes: (response.correct_options || []).map(letter => optionMap.findIndex(value => String(value).toUpperCase() === String(letter).toUpperCase())).filter(optionIndex => optionIndex >= 0),
            explanation: response.explanation || '',
            correct: selectedIndexes.length > 0 && response.correct === true
          };
          completed++;
          const statusNode = $('#gradingStatus');
          const progressNode = $('#gradingProgress');
          if (statusNode) statusNode.textContent = `Correction des réponses… ${completed} / ${questions.length}`;
          if (progressNode) progressNode.style.width = `${Math.round(completed / questions.length * 100)}%`;
        } catch (error) {
          failure = error;
        }
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(3, questions.length) }, () => worker()));
      if (!window.DLMED_AUTH?.isAuthorized()) return;
      if (failure) throw failure;
      if (!await window.DLMED_AUTH.ensureActiveSession()) throw new Error('Ta session n’est plus active. Reconnecte-toi avant de consulter le corrigé.');
      results = corrections;
      saveAttemptState('results');
      renderResults();
    } catch (error) {
      if (!window.DLMED_AUTH?.isAuthorized()) return;
      const detail = error?.message || 'La correction n’a pas abouti. Vérifie ta connexion puis réessaie.';
      panel.innerHTML = `<div class="exam-message"><span class="exam-pill">Copie conservée</span><h1>Correction en attente</h1><p>${escapeHtml(detail)}</p><button class="btn primary" id="retryExamGrade" type="button">Réessayer la correction</button></div>`;
      $('#retryExamGrade').addEventListener('click', () => void gradeExam());
    } finally {
      grading = false;
    }
  }

  function gptPrompt(result) {
    const question = result.question;
    const selected = result.selectedIndexes.length ? result.selectedIndexes.map(optionIndex => `${LETTERS[optionIndex]}. ${question.options[optionIndex]}`).join('\n') : 'Aucune réponse';
    const correct = result.correctIndexes.map(optionIndex => `${LETTERS[optionIndex]}. ${question.options[optionIndex]}`).join('\n');
    return `Je révise un QCM de médecine. Explique-moi en français pourquoi ma réponse est correcte ou incorrecte, puis résume le point à retenir.\n\nQuestion : ${question.text}\n${question.options.map((option, optionIndex) => `${LETTERS[optionIndex]}. ${option}`).join('\n')}\n\nMa réponse : ${selected}\nRéponse correcte : ${correct}\nExplication du cours : ${result.explanation}`;
  }

  function renderResults() {
    window.clearInterval(clock);
    clock = 0;
    const correctCount = results.filter(result => result.correct).length;
    const score = (correctCount * 20 / questions.length).toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    const percent = Math.round(correctCount / questions.length * 100);
    const wrongCount = questions.length - correctCount;
    panel.innerHTML = `
      <section class="result-hero"><div><span class="exam-pill">Copie corrigée</span><h1>Examen terminé</h1><p>Tu as obtenu ${percent}% de bonnes réponses. Ouvre chaque question pour revoir les choix et l’explication.</p></div><div class="result-score"><strong>${score}/20</strong><span>NOTE FINALE</span></div></section>
      <div class="result-stats"><span class="result-stat"><strong>${correctCount}</strong> correctes</span><span class="result-stat"><strong>${wrongCount}</strong> à revoir</span><span class="result-stat"><strong>${questions.length}</strong> QCM</span><span class="result-stat"><strong>${formatTime(elapsedSeconds)}</strong> temps</span></div>
      <div class="review-heading"><h2>Corrigé détaillé</h2><span class="quiet">Clique une question pour la revoir</span></div>
      <div class="result-retry-error" id="examReviewError" hidden>Impossible de vérifier à nouveau la session. Reconnecte-toi pour ouvrir les explications.</div>
      <div class="review-list">${results.map((result, resultIndex) => {
        const statusClass = result.correct ? 'is-correct' : result.selectedIndexes.length ? 'is-wrong' : 'is-unanswered';
        const label = result.correct ? 'Correcte' : result.selectedIndexes.length ? 'Incorrecte' : 'Sans réponse';
        return `<article class="review-item ${statusClass}" data-result-index="${resultIndex}"><button class="review-toggle" type="button" aria-expanded="false"><span class="review-status-icon" aria-hidden="true">${result.correct ? '✓' : result.selectedIndexes.length ? '×' : '–'}</span><span class="review-toggle-copy"><strong>Question ${resultIndex + 1} · ${escapeHtml(result.question.module)}</strong><small>${escapeHtml(result.question.text)}</small></span><span class="review-result-label">${label}</span><span class="review-chevron" aria-hidden="true">⌄</span></button><div class="review-detail" hidden><p class="review-question">${escapeHtml(result.question.text)}</p><div class="review-options">${result.question.options.map((option, optionIndex) => {
          const correct = result.correctIndexes.includes(optionIndex);
          const selected = result.selectedIndexes.includes(optionIndex);
          const stateClass = correct ? 'is-answer-correct' : selected ? 'is-answer-wrong' : '';
          const marker = correct ? '✓ Réponse correcte' : selected ? 'Votre réponse' : '';
          return `<div class="review-option ${stateClass}"><span class="exam-letter">${LETTERS[optionIndex]}</span><span>${escapeHtml(option)}${marker ? `<strong> · ${marker}</strong>` : ''}</span></div>`;
        }).join('')}</div><div class="review-explanation"><strong>Explication</strong><br>${escapeHtml(result.explanation || 'Aucune explication enregistrée pour cette question.')}</div><div class="review-footer-actions"><button class="btn ask-exam-gpt" type="button">✨ Comprendre avec ChatGPT</button></div></div></article>`;
      }).join('')}</div>`;
    panel.querySelectorAll('.review-toggle').forEach(button => button.addEventListener('click', () => {
      const article = button.closest('.review-item');
      const detail = article.querySelector('.review-detail');
      const open = article.classList.toggle('open');
      button.setAttribute('aria-expanded', String(open));
      detail.hidden = !open;
    }));
    panel.querySelectorAll('.ask-exam-gpt').forEach(button => button.addEventListener('click', () => {
      const result = results[Number(button.closest('.review-item').dataset.resultIndex)];
      const opened = window.open(`https://chatgpt.com/?q=${encodeURIComponent(gptPrompt(result))}`, '_blank', 'noopener,noreferrer');
      if (!opened) button.textContent = 'Autorise les fenêtres surgissantes pour ouvrir ChatGPT';
    }));
  }

  function clearExam() {
    window.clearInterval(clock);
    clock = 0;
    startedAt = 0;
    elapsedSeconds = 0;
    questions = [];
    choices.clear();
    results = [];
    if (attemptStorageKey) {
      try { sessionStorage.removeItem(attemptStorageKey); } catch (_) {}
    }
    timer.textContent = '⏱ 00:00';
    panel.replaceChildren();
    main.hidden = true;
    loading.hidden = false;
    loading.querySelector('span').textContent = 'Ta session est terminée…';
  }

  window.addEventListener('dlmed:auth-locked', clearExam);
  window.addEventListener('dlmed:auth-authorized', () => { void initialize(); });
  window.DLMED_AUTH?.authReady?.then(() => { if (window.DLMED_AUTH.isAuthorized()) void initialize(); });

  document.querySelectorAll('[data-theme-value]').forEach(button => button.addEventListener('click', () => {
    const theme = button.dataset.themeValue === 'night' ? 'night' : 'day';
    document.documentElement.dataset.theme = theme;
    document.querySelectorAll('[data-theme-value]').forEach(item => item.setAttribute('aria-pressed', String(item.dataset.themeValue === theme)));
    try { localStorage.setItem('dlmed-theme', theme); } catch (_) {}
  }));
  document.querySelectorAll('[data-theme-value]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.themeValue === (document.documentElement.dataset.theme || 'day'))));

})();
