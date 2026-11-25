(() => {
  'use strict';

  const $ = selector => document.querySelector(selector);
  const app = $('#testApp');
  const loading = $('#authLoading');
  const catalogView = $('#catalogView');
  const runnerView = $('#runnerView');
  const resultsView = $('#resultsView');
  const questionCard = $('#questionCard');
  const client = window.DLMED_SUPABASE;
  const attemptPrefix = 'dlmed-test-attempt-v2:';
  const optionLetters = ['A', 'B', 'C', 'D', 'E'];
  let tests = [];
  let activeTest = null;
  let answers = Object.create(null);
  let questionIndex = 0;
  let startedAt = 0;
  let clockId = 0;
  let bootPromise = null;
  let booted = false;
  let gradeResult = null;

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);

  function letterFor(index) {
    return optionLetters[index] || '';
  }

  function normalizeCatalogRow(row) {
    const testNumber = Number(row.test_number);
    const count = Number(row.question_count);
    if (!Number.isInteger(testNumber) || !Number.isInteger(count) || count < 1) return null;
    return {
      id: String(testNumber),
      testNumber,
      title: String(row.title || ('Examen ' + String(testNumber).padStart(2, '0'))),
      subject: 'UEI 1',
      description: String(row.description || ''),
      questionCount: count,
      questions: []
    };
  }

  function normalizeQuestionRow(row) {
    const source = Array.isArray(row.options) ? row.options : [];
    const byLetter = new Map(source.map(option => [
      String(option?.letter || '').toUpperCase(),
      String(option?.text || '')
    ]));
    const options = optionLetters.map(letter => byLetter.get(letter) || '');
    if (!row.id || !row.question || options.some(option => !option)) {
      throw new Error('Le contenu d’une question est incomplet.');
    }
    return {
      id: String(row.id),
      questionNumber: Number(row.question_number),
      section: String(row.section || ''),
      type: String(row.question_type || 'QCM'),
      text: String(row.question),
      options
    };
  }

  async function fetchCatalog() {
    if (!client) throw new Error('Supabase indisponible.');
    const { data, error } = await client
      .from('dlmed_tests')
      .select('test_number,title,description,question_count')
      .eq('is_published', true)
      .order('test_number', { ascending: true });
    if (error) throw error;
    return (Array.isArray(data) ? data : []).map(normalizeCatalogRow).filter(Boolean);
  }

  async function fetchQuestions(test) {
    const { data, error } = await client
      .from('dlmed_test_questions')
      .select('id,question_number,section,question_type,question,options')
      .eq('test_number', test.testNumber)
      .order('question_number', { ascending: true });
    if (error) throw error;
    const questions = (Array.isArray(data) ? data : []).map(normalizeQuestionRow);
    if (questions.length !== test.questionCount) {
      throw new Error('Le nombre de questions chargé ne correspond pas à cette épreuve.');
    }
    return questions;
  }

  function savedRecord(test) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(attemptPrefix + test.id) || 'null');
      if (!saved || saved.testId !== test.id || !['in-progress', 'finished'].includes(saved.phase)) return null;
      return saved;
    } catch (_) {
      return null;
    }
  }

  function savedAttempt(test) {
    const saved = savedRecord(test);
    if (!saved) return null;
    const restored = Object.create(null);
    const source = saved.answers && typeof saved.answers === 'object' ? saved.answers : {};
    test.questions.forEach(question => {
      const selected = Array.isArray(source[question.id])
        ? source[question.id].filter(index => Number.isInteger(index) && index >= 0 && index < question.options.length)
        : [];
      if (selected.length) restored[question.id] = [...new Set(selected)].sort((a, b) => a - b);
    });
    return {
      phase: saved.phase,
      answers: restored,
      questionIndex: Math.min(Math.max(Number(saved.questionIndex) || 0, 0), test.questions.length - 1),
      startedAt: Number(saved.startedAt) || Date.now(),
      finishedAt: Number(saved.finishedAt) || 0
    };
  }

  function storeAttempt(phase = 'in-progress', finishedAt = 0) {
    if (!activeTest) return;
    try {
      sessionStorage.setItem(attemptPrefix + activeTest.id, JSON.stringify({
        testId: activeTest.id,
        phase,
        answers,
        questionIndex,
        startedAt,
        finishedAt
      }));
    } catch (_) {}
  }

  function formatTime(seconds) {
    const safe = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const remaining = safe % 60;
    return hours
      ? String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0') + ':' + String(remaining).padStart(2, '0')
      : String(minutes).padStart(2, '0') + ':' + String(remaining).padStart(2, '0');
  }

  function elapsedSeconds() {
    return startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;
  }

  function updateClock() {
    $('#runnerTimer').textContent = '⏱ ' + formatTime(elapsedSeconds());
  }

  function toast(message) {
    const node = $('#toast');
    node.textContent = message;
    node.classList.add('show');
    window.clearTimeout(toast.timer);
    toast.timer = window.setTimeout(() => node.classList.remove('show'), 2600);
  }

  function setUrl(testId = '') {
    const url = new URL(window.location.href);
    if (testId) url.searchParams.set('test', testId);
    else url.searchParams.delete('test');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }

  function renderCatalog() {
    const catalog = $('#testCatalog');
    const empty = $('#testEmpty');
    $('#testCount').textContent = tests.length + (tests.length === 1 ? ' test disponible' : ' tests disponibles');
    empty.hidden = tests.length > 0;
    catalog.innerHTML = tests.map((test, index) => {
      const saved = savedRecord(test);
      const action = saved?.phase === 'finished' ? 'Voir ma correction'
        : saved?.phase === 'in-progress' ? 'Reprendre le test' : 'Commencer';
      const number = String(index + 1).padStart(2, '0');
      const description = test.description || test.subject;
      return '<article class="test-card"><div class="test-card-top"><span class="test-number">' + number +
        '</span><span class="test-count">' + test.questionCount + ' questions</span></div><h3>' +
        escapeHtml(test.title) + '</h3><p>' + escapeHtml(description) +
        '</p><button class="btn primary" type="button" data-start-test="' + escapeHtml(test.id) +
        '">' + action + ' →</button></article>';
    }).join('');
    catalog.querySelectorAll('[data-start-test]').forEach(button => button.addEventListener('click', () => {
      const test = tests.find(item => item.id === button.dataset.startTest);
      if (test) void startTest(test);
    }));
  }

  function showView(view) {
    catalogView.hidden = view !== 'catalog';
    runnerView.hidden = view !== 'runner';
    resultsView.hidden = view !== 'results';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function setLoading(message, visible = true) {
    const label = loading.querySelector('span');
    if (label) label.textContent = message;
    loading.hidden = !visible;
  }

  async function startTest(test, fresh = false) {
    if (!window.DLMED_AUTH?.isAuthorized?.() || !await window.DLMED_AUTH.ensureActiveSession()) return;
    window.clearInterval(clockId);
    setLoading('Chargement de l’épreuve…');
    try {
      if (fresh) {
        try { sessionStorage.removeItem(attemptPrefix + test.id); } catch (_) {}
      }
      activeTest = test;
      activeTest.questions = await fetchQuestions(test);
      gradeResult = null;
      const saved = fresh ? null : savedAttempt(test);
      answers = saved?.answers || Object.create(null);
      questionIndex = saved?.questionIndex || 0;
      startedAt = saved?.startedAt || Date.now();
      setUrl(test.id);
      setLoading('', false);
      app.hidden = false;
      if (saved?.phase === 'finished') {
        await loadCorrection(saved.finishedAt);
        return;
      }
      $('#runnerTestNumber').textContent = 'TEST ' + String(tests.indexOf(test) + 1).padStart(2, '0');
      $('#runnerTitle').textContent = test.title;
      $('#runnerCopy').textContent = test.subject + ' · ' + test.questionCount + ' questions · correction à la fin';
      $('#unansweredNotice').hidden = true;
      showView('runner');
      renderQuestion();
      updateClock();
      clockId = window.setInterval(updateClock, 1000);
      storeAttempt();
    } catch (_) {
      setLoading('', false);
      app.hidden = false;
      showView('catalog');
      toast('Impossible de charger cette épreuve depuis Supabase. Vérifie ta connexion puis réessaie.');
    }
  }

  function allowsMultiple(question) {
    if (/réponses multiples/i.test(question.type)) return true;
    return /plusieurs réponses|cochez les propositions|quelles propositions sont exactes|quels éléments sont exacts|sélectionnez toutes/i.test(question.text);
  }

  function renderQuestion() {
    if (!activeTest) return;
    const question = activeTest.questions[questionIndex];
    if (!question) return;
    const selected = answers[question.id] || [];
    const multiple = allowsMultiple(question);
    const answeredCount = activeTest.questions.filter(item => (answers[item.id] || []).length > 0).length;
    const progress = Math.round((questionIndex + 1) / activeTest.questions.length * 100);
    $('#progressFill').style.width = progress + '%';
    $('.progress-track').setAttribute('aria-valuenow', String(progress));
    questionCard.innerHTML =
      '<div class="question-top"><span>' + escapeHtml(question.section || activeTest.subject) +
      '</span><span>Question ' + (questionIndex + 1) + ' / ' + activeTest.questions.length +
      ' · ' + answeredCount + ' répondue(s)</span></div><h2 class="question-text">' +
      escapeHtml(question.text) + '</h2><div class="answer-list" role="group" aria-label="' +
      (multiple ? 'Plusieurs réponses possibles' : 'Choisis une réponse') + '">' +
      question.options.map((option, index) => '<button class="answer-option' +
        (selected.includes(index) ? ' selected' : '') + '" type="button" data-option="' + index +
        '" aria-pressed="' + selected.includes(index) + '"><span class="answer-letter">' +
        letterFor(index) + '</span><span>' + escapeHtml(option) + '</span></button>').join('') +
      '</div><div class="question-actions"><span class="question-hint">' +
      (multiple ? 'Plusieurs réponses possibles.' : 'Une seule réponse.') +
      ' Le corrigé reste masqué jusqu’à la fin.</span><div class="action-group"><button class="btn" id="questionPrevious" type="button" ' +
      (questionIndex === 0 ? 'disabled' : '') + '>← Précédente</button><button class="btn primary" id="questionNext" type="button">' +
      (questionIndex === activeTest.questions.length - 1 ? 'Terminer et corriger ✓' : 'Suivante →') +
      '</button></div></div>';

    questionCard.querySelectorAll('[data-option]').forEach(button => button.addEventListener('click', () => {
      const index = Number(button.dataset.option);
      const current = answers[question.id] || [];
      if (multiple) {
        answers[question.id] = current.includes(index)
          ? current.filter(value => value !== index)
          : [...current, index].sort((a, b) => a - b);
      } else {
        answers[question.id] = [index];
      }
      $('#unansweredNotice').hidden = true;
      storeAttempt();
      renderQuestion();
    }));
    $('#questionPrevious').addEventListener('click', () => moveQuestion(-1));
    $('#questionNext').addEventListener('click', () => {
      if (questionIndex < activeTest.questions.length - 1) moveQuestion(1);
      else void finishTest();
    });
    $('#questionNav').innerHTML = activeTest.questions.map((item, index) => {
      const answered = (answers[item.id] || []).length > 0;
      return '<button type="button" class="' + (answered ? 'answered' : '') +
        (index === questionIndex ? ' current' : '') + '" data-question-index="' + index +
        '" aria-label="Question ' + (index + 1) + (answered ? ', répondue' : ', sans réponse') +
        '" aria-current="' + (index === questionIndex ? 'step' : 'false') + '">' + (index + 1) + '</button>';
    }).join('');
    $('#questionNav').querySelectorAll('[data-question-index]').forEach(button => button.addEventListener('click', () => {
      questionIndex = Number(button.dataset.questionIndex);
      $('#unansweredNotice').hidden = true;
      storeAttempt();
      renderQuestion();
    }));
  }

  function moveQuestion(amount) {
    if (!activeTest) return;
    questionIndex = Math.min(activeTest.questions.length - 1, Math.max(0, questionIndex + amount));
    $('#unansweredNotice').hidden = true;
    storeAttempt();
    renderQuestion();
  }

  async function requestCorrection() {
    if (!client || !activeTest) throw new Error('Supabase indisponible.');
    if (!window.DLMED_AUTH?.isAuthorized?.() || !await window.DLMED_AUTH.ensureActiveSession()) {
      throw new Error('Session inactive.');
    }
    const submission = activeTest.questions.map(question => ({
      question_id: Number(question.id),
      selected_options: (answers[question.id] || []).map(letterFor)
    }));
    const { data, error } = await client.rpc('dlmed_grade_test', {
      p_test_number: activeTest.testNumber,
      p_answers: submission
    });
    if (error) throw error;
    if (!data || !Array.isArray(data.results) || data.results.length !== activeTest.questionCount) {
      throw new Error('Correction Supabase incomplète.');
    }
    return data;
  }

  async function finishTest() {
    if (!activeTest || !window.DLMED_AUTH?.isAuthorized?.() || !await window.DLMED_AUTH.ensureActiveSession()) return;
    const unanswered = activeTest.questions.findIndex(question => !(answers[question.id] || []).length);
    if (unanswered >= 0) {
      questionIndex = unanswered;
      const notice = $('#unansweredNotice');
      notice.textContent = 'Il reste des questions sans réponse. Réponds à la question ' +
        (unanswered + 1) + ' pour remettre le test complet.';
      notice.hidden = false;
      storeAttempt();
      renderQuestion();
      notice.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    setLoading('Envoi de la copie et chargement du corrigé…');
    try {
      gradeResult = await requestCorrection();
      const finishedAt = Date.now();
      storeAttempt('finished', finishedAt);
      window.clearInterval(clockId);
      setLoading('', false);
      renderResults(finishedAt);
    } catch (_) {
      setLoading('', false);
      toast('La correction Supabase n’a pas répondu. Tes réponses sont conservées : réessaie.');
    }
  }

  async function loadCorrection(finishedAt = Date.now()) {
    setLoading('Récupération de la correction sécurisée…');
    try {
      gradeResult = await requestCorrection();
      setLoading('', false);
      renderResults(finishedAt || Date.now());
    } catch (_) {
      setLoading('', false);
      showView('runner');
      renderQuestion();
      toast('Impossible de récupérer la correction. Vérifie ta session et réessaie.');
    }
  }

  function renderResults(finishedAt = Date.now()) {
    if (!activeTest || !gradeResult) return;
    window.clearInterval(clockId);
    const correctCount = Number(gradeResult.correct_count) || 0;
    const percent = Math.round(correctCount / activeTest.questions.length * 100);
    const score = Number(gradeResult.score).toFixed(1).replace('.', ',');
    const duration = formatTime(Math.max(0, Math.floor(((finishedAt || Date.now()) - startedAt) / 1000)));
    const gradeById = new Map(gradeResult.results.map(result => [String(result.question_id), result]));
    const review = activeTest.questions.map((question, index) => {
      const result = gradeById.get(question.id);
      const selected = result?.selected_options || [];
      const correctOptions = result?.correct_options || [];
      const correct = result?.correct === true;
      const selectedLetters = selected.length ? selected.join(', ') : 'Aucune réponse';
      const correctLetters = correctOptions.join(', ');
      const options = question.options.map((option, optionIndex) => {
        const letter = letterFor(optionIndex);
        const isKey = correctOptions.includes(letter);
        const isWrongPick = selected.includes(letter) && !isKey;
        const classes = (isKey ? ' is-answer-correct' : '') + (isWrongPick ? ' is-answer-wrong' : '');
        const marker = isKey ? ' · Réponse correcte' : isWrongPick ? ' · Ton choix' : '';
        return '<div class="review-option' + classes + '"><b>' + letter + '</b><span>' +
          escapeHtml(option + marker) + '</span></div>';
      }).join('');
      const explanation = escapeHtml(result?.explanation || 'Aucune explication détaillée n’a été fournie.');
      const reference = result?.reference ? '<br><br><strong>Référence</strong><br>' + escapeHtml(result.reference) : '';
      return '<details class="review-item ' + (correct ? 'is-correct' : 'is-wrong') +
        '"><summary><span class="review-status">' + (correct ? '✓' : '!') +
        '</span><span class="review-summary"><strong>Question ' + (index + 1) + ' · ' +
        escapeHtml(question.text) + '</strong><small>Ta réponse : ' + escapeHtml(selectedLetters) +
        ' · Corrigé : ' + escapeHtml(correctLetters) + '</small></span><span class="review-result-label">' +
        (correct ? 'Correcte' : 'À revoir') + '</span></summary><div class="review-detail"><p class="review-question">' +
        escapeHtml(question.text) + '</p><div class="review-options">' + options +
        '</div><div class="review-explanation"><strong>Correction</strong><br>' + explanation + reference +
        '</div><button class="btn review-ai" type="button" data-ai-review="' + index +
        '">✨ Vérifier avec ChatGPT</button></div></details>';
    }).join('');

    resultsView.innerHTML =
      '<section class="result-hero"><div><span class="test-pill">TEST TERMINÉ</span><h1>Ta copie est corrigée</h1><p>' +
      correctCount + ' bonne(s) réponse(s) sur ' + activeTest.questions.length +
      '. Ouvre une question pour voir le corrigé et comprendre tes erreurs.</p></div><div class="result-score" style="--score:' +
      percent + '"><div class="result-score-content"><strong>' + score +
      '/20</strong><span>NOTE</span></div></div></section><div class="result-stats"><span class="result-stat"><strong>' +
      percent + '%</strong> de réussite</span><span class="result-stat"><strong>' +
      (activeTest.questions.length - correctCount) + '</strong> à revoir</span><span class="result-stat"><strong>' +
      duration + '</strong> de durée</span></div><div class="result-actions"><button class="btn" id="otherTests" type="button">← Autres tests</button>' +
      '<button class="btn primary" id="retakeTest" type="button">↻ Refaire ce test</button></div>' +
      '<h2 class="review-title">Correction détaillée</h2><div class="review-list">' + review +
      '</div><p class="fine-print">La note et le corrigé proviennent de Supabase. ChatGPT peut donner un second avis pédagogique ; son avis ne modifie pas la note.</p>';
    showView('results');
    $('#otherTests').addEventListener('click', backToCatalog);
    $('#retakeTest').addEventListener('click', () => void startTest(activeTest, true));
    resultsView.querySelectorAll('[data-ai-review]').forEach(button =>
      button.addEventListener('click', () => void askChatGPT(Number(button.dataset.aiReview), button)));
  }

  async function askChatGPT(index, button) {
    const question = activeTest?.questions[index];
    const correction = gradeResult?.results?.find(result => String(result.question_id) === question?.id);
    if (!question || !correction) return;
    const opened = window.open('about:blank', '_blank');
    if (!opened) {
      toast('Autorise les fenêtres surgissantes pour ouvrir ChatGPT.');
      return;
    }
    opened.opener = null;
    if (!window.DLMED_AUTH?.isAuthorized?.() || !await window.DLMED_AUTH.ensureActiveSession()) {
      opened.close();
      return;
    }
    const prompt = [
      'Vérifie indépendamment cette correction de QCM médical à des fins pédagogiques.',
      'Question : ' + question.text,
      'Propositions : ' + question.options.map((option, optionIndex) => letterFor(optionIndex) + '. ' + option).join(' | '),
      'Corrigé officiel fourni : ' + correction.correct_options.join(', '),
      'Choix de l’étudiant : ' + (correction.selected_options.join(', ') || 'aucun'),
      'Explication fournie : ' + (correction.explanation || 'aucune'),
      'Dis si le corrigé semble correct, explique brièvement pourquoi et indique clairement toute incertitude. N’invente pas de référence.'
    ].join('\n');
    opened.location.href = 'https://chatgpt.com/?q=' + encodeURIComponent(prompt);
    button.textContent = 'ChatGPT est ouvert';
  }

  function backToCatalog() {
    window.clearInterval(clockId);
    activeTest = null;
    gradeResult = null;
    setUrl();
    showView('catalog');
    renderCatalog();
  }

  $('#leaveTest').addEventListener('click', backToCatalog);

  const savedTheme = document.documentElement.dataset.theme === 'night' ? 'night' : 'day';
  document.querySelectorAll('[data-theme-value]').forEach(button =>
    button.setAttribute('aria-pressed', String(button.dataset.themeValue === savedTheme)));
  document.querySelectorAll('[data-theme-value]').forEach(button => button.addEventListener('click', () => {
    const theme = button.dataset.themeValue === 'night' ? 'night' : 'day';
    document.documentElement.dataset.theme = theme;
    document.querySelectorAll('[data-theme-value]').forEach(choice =>
      choice.setAttribute('aria-pressed', String(choice.dataset.themeValue === theme)));
    try { localStorage.setItem('dlmed-theme', theme); } catch (_) {}
  }));

  async function boot() {
    if (booted || bootPromise) return bootPromise;
    bootPromise = (async () => {
      try {
        await (window.DLMED_AUTH?.authReady || Promise.resolve());
        if (!window.DLMED_AUTH?.isAuthorized?.()) { setLoading('', false); return; }
        if (!await window.DLMED_AUTH.ensureActiveSession()) { setLoading('', false); return; }
        tests = await fetchCatalog();
        setLoading('', false);
        app.hidden = false;
        booted = true;
        renderCatalog();
        if (!tests.length) {
          $('#testCount').textContent = 'Aucune épreuve publiée';
          $('#testEmpty').hidden = false;
          $('#testEmpty').querySelector('h2').textContent = 'Aucune épreuve disponible';
          $('#testEmpty').querySelector('p').textContent = 'Les examens apparaîtront ici dès leur publication dans Supabase.';
        }
        const requestedId = new URL(window.location.href).searchParams.get('test');
        const requestedTest = tests.find(test => test.id === requestedId);
        if (requestedTest && savedRecord(requestedTest)) void startTest(requestedTest);
      } catch (_) {
        setLoading('', false);
        app.hidden = false;
        $('#testCount').textContent = 'Impossible de charger les épreuves.';
        $('#testEmpty').hidden = false;
        $('#testEmpty').querySelector('h2').textContent = 'Connexion à Supabase impossible';
        $('#testEmpty').querySelector('p').textContent = 'Vérifie ta connexion ou ta session, puis réessaie.';
      } finally {
        bootPromise = null;
      }
    })();
    return bootPromise;
  }

  window.addEventListener('dlmed:auth-authorized', () => void boot());
  void boot();
})();
